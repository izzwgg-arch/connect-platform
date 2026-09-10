"use client";

import { LOCAL_DEV_EMAIL, LOCAL_DEV_PASSWORD } from "@connect/shared";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LoginThemeToggle } from "../../components/LoginThemeToggle";
import { ApiError, apiPost, getPortalApiBaseUrl } from "../../services/apiClient";
import { applyPortalPermissionsFromLogin } from "../../services/portalPermissionHydration";
import { writeAuthToken } from "../../services/session";
import { clearStaleVisualQaSession } from "../../services/visualQaMode";
import { isLocalhostDev } from "../../lib/localDev";
import { TurnstileWidget, TURNSTILE_SITE_KEY } from "../../components/TurnstileWidget";
import {
  classifyLoginResponse,
  isSubmittableMfaCode,
  looksLikeRecoveryCodeInput,
  mfaChallengeErrorMessage,
  normalizeMfaCodeInput,
  otpChannelLabel,
  safeNextPath,
  securityPageDestination,
  type ClassifiedLogin,
  type LoginApiResponse,
  type OtpChallengeState,
  GOOGLE_LOGIN_START_PATH,
  googleLoginErrorMessage,
} from "../../lib/mfaLogin";
import type { Permission } from "../../types/app";

/**
 * Sign-in has two steps when the account has two-step verification turned on:
 * password → the api answers `mfaChallengeRequired` with a 5-minute pre-auth
 * token → we ask for the 6-digit code (or a recovery code) → POST
 * /auth/mfa/challenge → the ordinary session. Accounts without it never see
 * step two: the response is exactly what it was before MFA existed.
 *
 * Per-tenant sign-in code (2FA-by-code, v2 2026-09-08): password → the api
 * answers `otpChallengeRequired` → the person picks TEXT or EMAIL (both shown
 * with the masked registered destination) → POST /auth/otp/send → we ask for
 * the 6-digit code → POST /auth/otp/verify → the ordinary session. The code is
 * asked once per sign-in; the session lasts until they sign out. There is no
 * "remember this device" and nothing expires on a clock.
 *
 * ⛔ The pre-auth token stays in component state. It is NOT a session and must
 * never go through writeAuthToken — see lib/mfaLogin.ts.
 */
type OtpStep = OtpChallengeState & { expiresAt: number };

type OtpSendResponse = {
  ok: boolean;
  channel: string;
  channels: string[];
  destinations?: Record<string, string>;
  destination: string;
  sent: boolean;
  reason?: string;
  expiresInSeconds: number;
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showLocalDevSignIn, setShowLocalDevSignIn] = useState(false);
  // Step two.
  const [challenge, setChallenge] = useState<{ preAuthToken: string; expiresAt: number } | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const codeRef = useRef<HTMLInputElement | null>(null);
  // Per-tenant sign-in code (2FA-by-code): choose text or email, then the code.
  // Same pre-auth-token rule as MFA.
  const [otp, setOtp] = useState<OtpStep | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [otpNotice, setOtpNotice] = useState("");
  const otpRef = useRef<HTMLInputElement | null>(null);
  // Cloudflare Turnstile token (empty when the widget is not configured).
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileReset, setTurnstileReset] = useState(0);

  useEffect(() => {
    clearStaleVisualQaSession();
    if (isLocalhostDev()) setShowLocalDevSignIn(true);
  }, []);

  // Sign in with Google (2026-09-10): the api's callback lands here with either a
  // one-shot handoff (`g`) or a reason (`google_error`). Both are taken off the
  // URL immediately — a handoff in the address bar is a replayable secret, and a
  // stale error must not reappear on the next visit — and the handoff is traded
  // for the ORDINARY login body, so the 2FA screens below apply unchanged.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const handoff = params.get("g");
    const googleError = params.get("google_error");
    if (!handoff && !googleError) return;
    params.delete("g");
    params.delete("google_error");
    const clean = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    window.history.replaceState(window.history.state, "", clean);
    if (googleError) {
      setError(googleLoginErrorMessage(googleError));
      return;
    }
    void loginWithGoogleHandoff(String(handoff));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (challenge) codeRef.current?.focus();
  }, [challenge]);
  useEffect(() => {
    if (otp && !otp.awaitingChannel) otpRef.current?.focus();
  }, [otp]);

  function completeSignIn(session: Extract<ClassifiedLogin, { kind: "session" }>) {
    writeAuthToken(session.token);
    applyPortalPermissionsFromLogin(session.portalPermissionSet as Permission[] | undefined);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("cc-portal-permissions-saved"));
    }
    const next = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("next") : null;
    const landing = safeNextPath(next);
    // GRACE mode: a role that must have two-step verification, not enrolled yet.
    // Nothing is refused — they are signed in — but they land on the security
    // page with a "Not now" link that takes them where they were going.
    const dest = session.mfaEnrollmentRequired ? securityPageDestination(landing) : landing;
    router.replace(dest);
    // Embedded browsers (e.g. Cursor Simple Browser) sometimes ignore client-side routing.
    window.setTimeout(() => {
      if (typeof window !== "undefined" && window.location.pathname === "/login") {
        window.location.assign(dest);
      }
    }, 400);
  }

  /**
   * ONE reader for every door's login body (password, Google): a challenge
   * becomes its screen, a session signs the person in. The two doors answer
   * the identical shape (the api shares the post-credential chain), so this is
   * the only place the portal decides what a login body means.
   */
  function applyLoginResponse(res: LoginApiResponse) {
    const classified = classifyLoginResponse(res);
    if (classified.kind === "failed") {
      setError(classified.error);
      setTurnstileReset((k) => k + 1);
      return;
    }
    if (classified.kind === "mfa_challenge") {
      setChallenge({ preAuthToken: classified.preAuthToken, expiresAt: Date.now() + classified.expiresInSeconds * 1000 });
      setCode("");
      setUseRecovery(false);
      return;
    }
    if (classified.kind === "otp_challenge") {
      const { kind: _kind, ...state } = classified;
      setOtp({ ...state, expiresAt: Date.now() + classified.expiresInSeconds * 1000 });
      setOtpCode("");
      // With a choice to make there is nothing to say yet. When the api sent
      // straight away (one channel possible) an "already_sent" is not a
      // failure: a code we sent moments ago is still good, so we deliberately
      // did not send a second one.
      setOtpNotice(classified.awaitingChannel ? "" : otpSendNotice(classified));
      return;
    }
    completeSignIn(classified);
  }

  /** Where the Google button sends the browser: the api's start route, carrying where they were going. */
  function googleStartHref(): string {
    const next = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("next") : null;
    const landing = safeNextPath(next);
    return `${getPortalApiBaseUrl()}${GOOGLE_LOGIN_START_PATH}?next=${encodeURIComponent(landing)}`;
  }

  /** Trade the one-shot handoff from the Google callback for the login body. */
  async function loginWithGoogleHandoff(handoff: string) {
    setError("");
    setLoading(true);
    try {
      const res = await apiPost<LoginApiResponse>("/auth/google/complete", { code: handoff });
      applyLoginResponse(res);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string; message?: string } | null;
        if (e.status === 403 && body?.error === "account_disabled") {
          setError(googleLoginErrorMessage("disabled"));
          return;
        }
        setError(String(body?.message || googleLoginErrorMessage("expired")));
        return;
      }
      setError(googleLoginErrorMessage("google_failed"));
    } finally {
      setLoading(false);
    }
  }

  /** Plain English for a send that did not send — never a bare slug. */
  function otpSendNotice(step: Pick<OtpChallengeState, "sent" | "reason" | "channel" | "destination">): string {
    if (step.sent) return "";
    if (step.reason === "already_sent") return `We already sent a code by ${otpChannelLabel(step.channel)} to ${step.destination}. Enter it below, or choose "Send it again".`;
    if (step.reason === "send_limit") return `You have asked for a code too many times. The one we sent by ${otpChannelLabel(step.channel)} to ${step.destination} still works — or start over in ten minutes.`;
    return "We could not send the code. Try again, or use the other method if one is offered.";
  }

  async function loginWithCredentials(loginEmail: string, loginPassword: string) {
    setError("");
    setLoading(true);
    try {
      const res = await apiPost<LoginApiResponse>("/auth/login", {
        email: loginEmail,
        password: loginPassword,
        ...(turnstileToken ? { turnstileToken } : {}),
      });
      applyLoginResponse(res);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        if (e.status === 401) {
          setError(
            isLocalhostDev()
              ? "Invalid email or password on localhost. This is not production — use the local dev account (see terminal output from pnpm bootstrap:local). Default: imwog@gmail.com with password LocalDev2026!"
              : "Invalid email or password.",
          );
          return;
        }
        if (e.status === 429) {
          setError(
            "Too many login attempts. Wait 15 minutes, restart the API dev server, or use the local dev password (LocalDev2026!) after pnpm bootstrap:local.",
          );
          return;
        }
        const errCode = String((e.body as { error?: string } | null)?.error || "");
        if (errCode.startsWith("human_check_")) {
          setError(String((e.body as { message?: string } | null)?.message || "Please complete the security check and try again."));
          setTurnstileToken("");
          setTurnstileReset((k) => k + 1);
          return;
        }
        if (e.status >= 500) {
          const detail = String((e.body as { message?: string } | null)?.message || e.message || "").trim();
          setError(
            detail
              ? `Server error: ${detail}`
              : "Server error (500). Check the API terminal: Postgres running, apps/api/.env has DATABASE_URL, migrations applied.",
          );
          return;
        }
        const code = String((e.body as { error?: string } | null)?.error || e.message || "Login failed");
        setError(code);
        return;
      }
      const raw = String((e as Error)?.message || "Login failed");
      const looksLikeHtml = /<!DOCTYPE|Expected JSON from API/i.test(raw);
      setError(
        looksLikeHtml
          ? "Cannot reach the Connect API (got HTML instead of JSON). Start the API (pnpm --filter @connect/api dev) and ensure port 3001 is free — another app may be using it. Restart the portal dev server after fixing."
          : raw,
      );
    } finally {
      setLoading(false);
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    const trimmed = normalizeMfaCodeInput(code);
    if (!isSubmittableMfaCode(trimmed)) {
      setError(useRecovery
        ? "A recovery code is 10 letters and digits, like ABCDE-FGHJK."
        : "Enter the 6-digit code from your authenticator app.");
      return;
    }
    if (Date.now() > challenge.expiresAt) {
      setChallenge(null);
      setError("That sign-in step timed out. Enter your email and password again.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await apiPost<LoginApiResponse>("/auth/mfa/challenge", {
        preAuthToken: challenge.preAuthToken,
        code: trimmed,
      });
      const classified = classifyLoginResponse(res);
      if (classified.kind !== "session") {
        setError("Sign-in didn't complete. Try again.");
        return;
      }
      completeSignIn(classified);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string } | null;
        setError(mfaChallengeErrorMessage(e.status, body));
        if (body?.error === "preauth_invalid") setChallenge(null);
        return;
      }
      setError(String((e as Error)?.message || "Sign-in didn't complete. Try again."));
    } finally {
      setLoading(false);
    }
  }

  /** The dead-step exits every OTP call shares: the pre-auth token is gone → back to the password. */
  function otpStepDead() {
    setOtp(null);
    setOtpCode("");
    setOtpNotice("");
    setError("That sign-in step is no longer valid. Enter your email and password again.");
  }

  /** v2: the person picked text or email. The api sends to the REGISTERED destination for that channel. */
  async function sendOtp(channel: string) {
    if (!otp) return;
    if (Date.now() > otp.expiresAt) {
      setOtp(null);
      setError("That sign-in step timed out. Enter your email and password again.");
      return;
    }
    setError("");
    setOtpNotice("");
    setLoading(true);
    try {
      const res = await apiPost<OtpSendResponse>("/auth/otp/send", {
        preAuthToken: otp.preAuthToken,
        channel,
      });
      const next: OtpStep = {
        ...otp,
        awaitingChannel: false,
        channel: res.channel,
        channels: Array.isArray(res.channels) && res.channels.length ? res.channels : otp.channels,
        destinations: res.destinations && typeof res.destinations === "object" ? res.destinations : otp.destinations,
        destination: res.destination,
        sent: res.sent === true,
        reason: res.reason,
      };
      setOtp(next);
      setOtpCode("");
      setOtpNotice(otpSendNotice(next));
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string; channels?: string[] } | null;
        if (body?.error === "otp_channel_unavailable") {
          setOtp({ ...otp, channels: Array.isArray(body.channels) && body.channels.length ? body.channels : otp.channels });
          setError("That way of sending the code is not available for your account. Choose the other one.");
          return;
        }
        if (String(body?.error || "").startsWith("otp_")) { otpStepDead(); return; }
        setError(String(body?.error || e.message || "Could not send the code. Try again."));
        return;
      }
      setError("Could not send the code. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function submitOtp(event: React.FormEvent) {
    event.preventDefault();
    if (!otp) return;
    const trimmed = otpCode.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(trimmed)) {
      setError("Enter the 6-digit code we sent you.");
      return;
    }
    if (Date.now() > otp.expiresAt) {
      setOtp(null);
      setError("That sign-in step timed out. Enter your email and password again.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await apiPost<LoginApiResponse>("/auth/otp/verify", {
        preAuthToken: otp.preAuthToken,
        code: trimmed,
      });
      const classified = classifyLoginResponse(res);
      if (classified.kind !== "session") {
        setError("Sign-in didn’t complete. Try again.");
        return;
      }
      completeSignIn(classified);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string; attemptsRemaining?: number; reason?: string } | null;
        if (e.status === 429) { setError("Too many tries. Wait a few minutes and try again."); return; }
        if (body?.error === "otp_invalid") {
          const left = typeof body.attemptsRemaining === "number" ? body.attemptsRemaining : null;
          setError(left !== null && left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code is not right.");
          return;
        }
        if (body?.error === "otp_challenge_dead" || body?.error === "otp_session_invalid") { otpStepDead(); return; }
        setError(String(body?.error || e.message || "Sign-in didn’t complete. Try again."));
        return;
      }
      setError(String((e as Error)?.message || "Sign-in didn’t complete. Try again."));
    } finally {
      setLoading(false);
    }
  }

  async function resendOtp(channel?: string) {
    if (!otp) return;
    setError("");
    setOtpNotice("");
    setLoading(true);
    try {
      const res = await apiPost<OtpSendResponse>("/auth/otp/resend", {
        preAuthToken: otp.preAuthToken,
        ...(channel ? { channel } : {}),
      });
      setOtp({
        ...otp,
        awaitingChannel: false,
        channel: res.channel,
        channels: Array.isArray(res.channels) && res.channels.length ? res.channels : otp.channels,
        destinations: res.destinations && typeof res.destinations === "object" ? res.destinations : otp.destinations,
        destination: res.destination,
        sent: res.sent === true,
        reason: undefined,
      });
      setOtpCode("");
      setOtpNotice(res.sent ? `A new code is on its way by ${otpChannelLabel(res.channel)} to ${res.destination}.` : "We could not send the code. Try the other method, or contact support.");
      otpRef.current?.focus();
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 429) { setError("You have asked for a new code too many times. Enter your email and password again in a few minutes."); return; }
      if (e instanceof ApiError && String((e.body as { error?: string } | null)?.error || "").startsWith("otp_")) { otpStepDead(); return; }
      setError("Could not send a new code. Try again.");
    } finally {
      setLoading(false);
    }
  }

  function backToPassword() {
    setChallenge(null);
    setOtp(null);
    setOtpCode("");
    setCode("");
    setError("");
    setOtpNotice("");
    setUseRecovery(false);
    setTurnstileToken("");
    setTurnstileReset((k) => k + 1);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await loginWithCredentials(email, password);
  }

  async function devQuickSignIn() {
    setEmail(LOCAL_DEV_EMAIL);
    setPassword(LOCAL_DEV_PASSWORD);
    await loginWithCredentials(LOCAL_DEV_EMAIL, LOCAL_DEV_PASSWORD);
  }

  // v2: choose where the code goes. Both buttons show the masked REGISTERED
  // destination — the person picks a channel, never types an address.
  if (otp && otp.awaitingChannel) {
    return (
      <main className="lc-login">
        <LoginThemeToggle />
        <div className="lc-login-card">
          <img className="lc-login-logo" src="/brand/loopcom/loopcom-wordmark-560.png" alt="Loopcom" width={560} height={99} />
          <p className="lc-login-step" role="status">
            One more step. Where should we send your 6-digit sign-in code?
          </p>
          <div className="lc-login-choices" role="group" aria-label="Where to send the sign-in code">
            {otp.channels.map((c) => (
              <button
                key={c}
                type="button"
                className="lc-login-choice"
                disabled={loading}
                onClick={() => void sendOtp(c)}
                aria-label={`${c === "SMS" ? "Text me" : "Email me"} at ${otp.destinations[c] || ""}`.trim()}
              >
                <span className="lc-login-choice-icon" aria-hidden="true">
                  {c === "SMS" ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
                      <path d="M10.5 18.5h3" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="5" width="18" height="14" rx="2.5" />
                      <path d="m3.5 7 8.5 6 8.5-6" />
                    </svg>
                  )}
                </span>
                <span className="lc-login-choice-text">
                  <span>{c === "SMS" ? "Text me" : "Email me"}</span>
                  <span className="lc-login-choice-to">{otp.destinations[c] || (c === "SMS" ? "your registered mobile number" : "your registered email")}</span>
                </span>
              </button>
            ))}
          </div>
          {error ? <div className="lc-login-error" role="alert">{error}</div> : null}
          <button className="lc-login-forgot lc-login-linkbtn" type="button" onClick={backToPassword} disabled={loading}>
            Back to sign in
          </button>
        </div>
      </main>
    );
  }

  if (otp) {
    const via = otpChannelLabel(otp.channel);
    const other = otp.channels.find((c) => c !== otp.channel);
    return (
      <main className="lc-login">
        <LoginThemeToggle />
        <form className="lc-login-card" onSubmit={submitOtp}>
          <img className="lc-login-logo" src="/brand/loopcom/loopcom-wordmark-560.png" alt="Loopcom" width={560} height={99} />
          <p className="lc-login-step" role="status">
            {otp.sent
              ? `We sent a 6-digit code by ${via} to ${otp.destination}. Enter it to finish signing in.`
              : otp.reason === "already_sent" || otp.reason === "send_limit"
                ? `Enter the 6-digit code we sent by ${via} to ${otp.destination}.`
                : `We could not send your code by ${via}.`}
          </p>
          <label className="lc-login-field">
            <span className="lc-login-label">Sign-in code</span>
            <input
              ref={otpRef}
              className="lc-login-input lc-login-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              placeholder="123 456"
              maxLength={7}
              aria-label="Sign-in code"
            />
          </label>
          {otpNotice ? <div className="lc-login-step" role="status">{otpNotice}</div> : null}
          {error ? <div className="lc-login-error" role="alert">{error}</div> : null}
          <button className="lc-login-submit" type="submit" disabled={loading}>
            {loading ? "Checking..." : "Verify and sign in"}
          </button>
          <button className="lc-login-ghost" type="button" disabled={loading} onClick={() => void resendOtp()}>
            Send it again
          </button>
          {other ? (
            <button className="lc-login-ghost" type="button" disabled={loading} onClick={() => void resendOtp(other)}>
              {other === "SMS" ? `Text me instead${otp.destinations.SMS ? ` (${otp.destinations.SMS})` : ""}` : `Email me instead${otp.destinations.EMAIL ? ` (${otp.destinations.EMAIL})` : ""}`}
            </button>
          ) : null}
          <button className="lc-login-forgot lc-login-linkbtn" type="button" onClick={backToPassword} disabled={loading}>
            Back to sign in
          </button>
        </form>
      </main>
    );
  }

  if (challenge) {
    return (
      <main className="lc-login">
        <LoginThemeToggle />
        <form className="lc-login-card" onSubmit={submitCode}>
          <img
            className="lc-login-logo"
            src="/brand/loopcom/loopcom-wordmark-560.png"
            alt="Loopcom"
            width={560}
            height={99}
          />
          <p className="lc-login-step" role="status">
            {useRecovery
              ? "Enter one of the recovery codes you saved when you turned on two-step verification."
              : "Two-step verification is on for this account. Enter the 6-digit code from your authenticator app."}
          </p>
          <label className="lc-login-field">
            <span className="lc-login-label">{useRecovery ? "Recovery code" : "Verification code"}</span>
            <input
              ref={codeRef}
              className="lc-login-input lc-login-code"
              type="text"
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              autoCapitalize={useRecovery ? "characters" : "off"}
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={useRecovery ? "ABCDE-FGHJK" : "123 456"}
              maxLength={useRecovery ? 12 : 7}
              aria-label={useRecovery ? "Recovery code" : "Verification code"}
            />
          </label>
          {error ? <div className="lc-login-error" role="alert">{error}</div> : null}
          <button className="lc-login-submit" type="submit" disabled={loading}>
            {loading ? "Checking..." : "Verify and sign in"}
          </button>
          <button
            className="lc-login-ghost"
            type="button"
            disabled={loading}
            onClick={() => { setUseRecovery((v) => !v); setError(""); setCode(""); codeRef.current?.focus(); }}
          >
            {useRecovery ? "Use my authenticator app instead" : "Use a recovery code"}
          </button>
          <button className="lc-login-forgot lc-login-linkbtn" type="button" onClick={backToPassword} disabled={loading}>
            Back to sign in
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="lc-login">
      <LoginThemeToggle />
      <form className="lc-login-card" onSubmit={submit}>
        {/* Signal Core wordmark. Transparent PNG, one file for both themes —
            there is deliberately no light-mode variant. See
            docs/brand/loopcom/README.md before swapping this asset. */}
        <img
          className="lc-login-logo"
          src="/brand/loopcom/loopcom-wordmark-560.png"
          alt="Loopcom"
          width={560}
          height={99}
        />
        <label className="lc-login-field">
          <span className="lc-login-label">Email</span>
          <input
            className="lc-login-input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </label>
        <label className="lc-login-field">
          <span className="lc-login-label">Password</span>
          <input
            className="lc-login-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </label>
        {TURNSTILE_SITE_KEY ? <TurnstileWidget onToken={setTurnstileToken} resetKey={turnstileReset} /> : null}
        {error ? <div className="lc-login-error" role="alert">{error}</div> : null}
        <button className="lc-login-submit" type="submit" disabled={loading}>
          {loading ? "Signing in..." : "Sign in"}
        </button>
        <div className="lc-login-or" aria-hidden="true"><span>or</span></div>
        {/* Sign in with Google (2026-09-10): a plain link to the api's start route —
            a top-level navigation, no Google script on the page, no CSP change.
            Only an address that is ALREADY a Loopcom login can get in this way;
            there is no sign-up behind it. */}
        <a
          className="lc-login-google"
          href={googleStartHref()}
          aria-disabled={loading ? "true" : undefined}
          onClick={(e) => { if (loading) e.preventDefault(); }}
        >
          <svg className="lc-login-google-mark" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          <span>Sign in with Google</span>
        </a>
        {showLocalDevSignIn ? (
          <button
            className="lc-login-ghost"
            type="button"
            disabled={loading}
            onClick={() => void devQuickSignIn()}
          >
            {loading ? "Signing in..." : "Local dev sign-in"}
          </button>
        ) : null}
        <Link className="lc-login-forgot" href="/auth/password/forgot">Forgot password?</Link>
      </form>
    </main>
  );
}

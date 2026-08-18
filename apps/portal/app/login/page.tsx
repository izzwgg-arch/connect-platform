"use client";

import { LOCAL_DEV_EMAIL, LOCAL_DEV_PASSWORD } from "@connect/shared";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LoginThemeToggle } from "../../components/LoginThemeToggle";
import { ApiError, apiPost } from "../../services/apiClient";
import { applyPortalPermissionsFromLogin } from "../../services/portalPermissionHydration";
import { writeAuthToken } from "../../services/session";
import { clearStaleVisualQaSession } from "../../services/visualQaMode";
import { isLocalhostDev } from "../../lib/localDev";
import {
  classifyLoginResponse,
  isSubmittableMfaCode,
  looksLikeRecoveryCodeInput,
  mfaChallengeErrorMessage,
  normalizeMfaCodeInput,
  safeNextPath,
  securityPageDestination,
  type ClassifiedLogin,
  type LoginApiResponse,
} from "../../lib/mfaLogin";
import type { Permission } from "../../types/app";

/**
 * Sign-in has two steps when the account has two-step verification turned on:
 * password → the api answers `mfaChallengeRequired` with a 5-minute pre-auth
 * token → we ask for the 6-digit code (or a recovery code) → POST
 * /auth/mfa/challenge → the ordinary session. Accounts without it never see
 * step two: the response is exactly what it was before MFA existed.
 *
 * ⛔ The pre-auth token stays in component state. It is NOT a session and must
 * never go through writeAuthToken — see lib/mfaLogin.ts.
 */
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

  useEffect(() => {
    clearStaleVisualQaSession();
    if (isLocalhostDev()) setShowLocalDevSignIn(true);
  }, []);

  useEffect(() => {
    if (challenge) codeRef.current?.focus();
  }, [challenge]);

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

  async function loginWithCredentials(loginEmail: string, loginPassword: string) {
    setError("");
    setLoading(true);
    try {
      const res = await apiPost<LoginApiResponse>("/auth/login", {
        email: loginEmail,
        password: loginPassword,
      });
      const classified = classifyLoginResponse(res);
      if (classified.kind === "failed") {
        setError(classified.error);
        return;
      }
      if (classified.kind === "mfa_challenge") {
        setChallenge({ preAuthToken: classified.preAuthToken, expiresAt: Date.now() + classified.expiresInSeconds * 1000 });
        setCode("");
        setUseRecovery(false);
        return;
      }
      completeSignIn(classified);
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

  function backToPassword() {
    setChallenge(null);
    setCode("");
    setError("");
    setUseRecovery(false);
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
        {error ? <div className="lc-login-error" role="alert">{error}</div> : null}
        <button className="lc-login-submit" type="submit" disabled={loading}>
          {loading ? "Signing in..." : "Sign in"}
        </button>
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

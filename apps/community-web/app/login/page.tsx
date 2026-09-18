"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api, ApiError, trackEvent } from "@/lib/api";
import { applySession, useAuth } from "@/lib/auth";
import { Button, Field, Icon, useToast } from "@/components/ui";
import { OAuthButtons } from "@/components/auth/OAuthButtons";
import { passkeyLogin, passkeysSupported } from "@/components/auth/passkeys";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const { me, reload } = useAuth();
  const toast = useToast();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pk, setPk] = useState(false);
  useEffect(() => setPk(passkeysSupported()), []);
  useEffect(() => {
    if (me) router.replace(next);
  }, [me, next, router]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Read the DOM, not state: text typed before hydration is only in the form.
    const fd = new FormData(e.currentTarget);
    const identifierNow = String(fd.get("identifier") ?? identifier);
    const passwordNow = String(fd.get("password") ?? password);
    const totpNow = String(fd.get("totp") ?? totp);
    setBusy(true);
    setError(null);
    try {
      const body = await api("/auth/login", { body: { identifier: identifierNow, password: passwordNow, totp: needTotp ? totpNow : undefined }, auth: false });
      applySession(body);
      trackEvent("login");
      const m = await reload();
      router.replace(m && !m.person.onboardingDone ? "/welcome" : next);
    } catch (err) {
      const e2 = err as ApiError;
      if (e2.code === "mfa_required") setNeedTotp(true);
      else setError(e2.message);
    } finally {
      setBusy(false);
    }
  }

  async function usePasskey() {
    setBusy(true);
    setError(null);
    try {
      const body = await passkeyLogin(identifier || undefined);
      applySession(body);
      await reload();
      router.replace(next);
    } catch (err) {
      setError((err as Error).message || "Passkey sign-in didn't complete.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="authcard" onSubmit={submit} noValidate>
        <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        <div style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: 18 }}>Sign in to Loopcom</h1>
          <p className="dim sm">One Loopcom ID for Community, your phone system and the apps.</p>
        </div>
        {pk ? (
          <Button kind="" wide icon="key" onClick={usePasskey} disabled={busy} data-testid="login-passkey">
            Use a passkey
          </Button>
        ) : null}
        {pk ? <div className="or">or</div> : null}
        <Field label="Email or mobile number" htmlFor="l-id">
          <input id="l-id" name="identifier" className="in" autoComplete="username webauthn" defaultValue={identifier} onChange={(e) => setIdentifier(e.target.value)} required data-testid="login-identifier" />
        </Field>
        <Field label="Password" htmlFor="l-pw">
          <input id="l-pw" name="password" className="in" type="password" autoComplete="current-password" defaultValue={password} onChange={(e) => setPassword(e.target.value)} required data-testid="login-password" />
        </Field>
        {needTotp ? (
          <Field label="Authenticator code" htmlFor="l-totp" help="Six digits from your authenticator app.">
            <input id="l-totp" name="totp" className="in" inputMode="numeric" autoComplete="one-time-code" defaultValue={totp} onChange={(e) => setTotp(e.target.value)} autoFocus data-testid="login-totp" />
          </Field>
        ) : null}
        {error ? <div className="chip bad" role="alert" style={{ justifySelf: "start" }}>{error}</div> : null}
        <div className="row sm" style={{ justifyContent: "space-between" }}>
          <span />
          <Link href="/forgot-password">Forgot password?</Link>
        </div>
        <Button kind="p" wide type="submit" loading={busy} data-testid="login-submit">
          Sign in
        </Button>
        <div className="or">or continue with</div>
        <OAuthButtons mode="login" next={next} onError={setError} />
        <Link href="/sso/loopcom" className="btn w" data-testid="login-loopcom">
          <Icon name="link" /> Sign in with Loopcom
        </Link>
        <p className="sm dim" style={{ textAlign: "center" }}>
          New here? <Link href="/join" style={{ textDecoration: "underline" }}>Create your Loopcom ID</Link> — free, no phone service needed.
        </p>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

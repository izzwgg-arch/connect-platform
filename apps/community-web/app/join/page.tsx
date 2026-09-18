"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, trackEvent } from "@/lib/api";
import { applySession, useAuth } from "@/lib/auth";
import { Button, Field, Icon } from "@/components/ui";
import { OAuthButtons } from "@/components/auth/OAuthButtons";

function strength(pw: string): { pct: number; label: string } {
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const pct = Math.min(100, score * 20);
  return { pct, label: pw.length < 10 ? "Use at least 10 characters." : score >= 4 ? "Strong." : "Add a number or symbol to make it stronger." };
}

export default function JoinPage() {
  const router = useRouter();
  const { reload } = useAuth();
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", phone: "", password: "", tos: false });
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // A submit before hydration would be a plain GET — the button waits for React.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const s = strength(f.password);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!f.firstName.trim()) fe.firstName = "Enter your first name.";
    if (!f.lastName.trim()) fe.lastName = "Enter your last name.";
    if (!f.email.trim() && !f.phone.trim()) fe.email = "Add an email or a mobile number so we can verify it's you.";
    if (f.password.length < 10) fe.password = "Use at least 10 characters.";
    if (!f.tos) fe.tos = "Please agree to the terms to continue.";
    setFieldErr(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setError(null);
    try {
      const body = await api("/auth/register", { body: { firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim() || undefined, phone: f.phone.trim() || undefined, password: f.password }, auth: false });
      applySession(body);
      trackEvent("signup");
      await reload();
      router.replace("/welcome");
    } catch (err) {
      const e2 = err as ApiError;
      if (e2.code === "email_is_loopcom_account") setError(e2.message);
      else if (e2.code === "email_taken") setFieldErr({ email: e2.message });
      else if (e2.code === "phone_taken" || e2.code === "phone_invalid") setFieldErr({ phone: e2.message });
      else if (e2.code === "password_weak") setFieldErr({ password: e2.message });
      else setError(e2.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="authcard" onSubmit={submit} noValidate>
        <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        <div style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: 18 }}>Create your Loopcom ID</h1>
          <p className="dim sm">Free. Takes a minute. You can add your business afterwards.</p>
        </div>
        <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <Field label="First name" htmlFor="r-fn" error={fieldErr.firstName}>
              <input id="r-fn" className={`in ${fieldErr.firstName ? "err" : ""}`} autoComplete="given-name" value={f.firstName} onChange={set("firstName")} data-testid="join-first" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Last name" htmlFor="r-ln" error={fieldErr.lastName}>
              <input id="r-ln" className={`in ${fieldErr.lastName ? "err" : ""}`} autoComplete="family-name" value={f.lastName} onChange={set("lastName")} data-testid="join-last" />
            </Field>
          </div>
        </div>
        <Field label="Work email" htmlFor="r-em" help="We'll send a 6-digit code to confirm it." error={fieldErr.email}>
          <input id="r-em" className={`in ${fieldErr.email ? "err" : ""}`} type="email" autoComplete="email" value={f.email} onChange={set("email")} data-testid="join-email" />
        </Field>
        <Field label="Mobile number (optional)" htmlFor="r-ph" help="Lets people who already have your number find you." error={fieldErr.phone}>
          <input id="r-ph" className={`in ${fieldErr.phone ? "err" : ""}`} type="tel" autoComplete="tel" value={f.phone} onChange={set("phone")} data-testid="join-phone" />
        </Field>
        <Field label="Password" htmlFor="r-pw" error={fieldErr.password} help={f.password ? s.label : "At least 10 characters."}>
          <input id="r-pw" className={`in ${fieldErr.password ? "err" : ""}`} type="password" autoComplete="new-password" value={f.password} onChange={set("password")} data-testid="join-password" />
          {f.password ? (
            <div className="prog" style={{ marginTop: 6 }}>
              <i style={{ width: `${s.pct}%`, background: s.pct >= 80 ? "var(--success)" : undefined }} />
            </div>
          ) : null}
        </Field>
        <div className="field">
          <label className="row sm" style={{ alignItems: "flex-start", gap: 8 }}>
            <input type="checkbox" id="r-tos" checked={f.tos} onChange={set("tos")} style={{ marginTop: 3, accentColor: "var(--accent)" }} data-testid="join-tos" />
            <span className="dim">
              I agree to the <Link href="/legal/terms">Terms</Link> and <Link href="/legal/privacy">Privacy policy</Link>. Loopcom never infers religion, health or politics from what you do here.
            </span>
          </label>
          {fieldErr.tos ? <span className="error" role="alert">{fieldErr.tos}</span> : null}
        </div>
        {error ? (
          <div className="chip bad" role="alert" style={{ justifySelf: "start", whiteSpace: "normal" }}>
            {error} {error.includes("Loopcom") ? <Link href="/sso/loopcom">Sign in with Loopcom</Link> : null}
          </div>
        ) : null}
        <Button kind="p" wide type="submit" loading={busy} disabled={!ready} data-testid="join-submit">
          Continue <Icon name="arrow" />
        </Button>
        <div className="or">or</div>
        <OAuthButtons mode="join" next="/welcome" onError={setError} />
        <p className="sm dim" style={{ textAlign: "center" }}>
          Already a Loopcom customer? <Link href="/sso/loopcom">Sign in with Loopcom</Link>. Have a Loopcom ID? <Link href="/login">Sign in</Link>.
        </p>
      </form>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { Button, Field, useToast } from "@/components/ui";

function Inner() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const token = params.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("Those passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await api("/auth/password/reset", { body: { token, password }, auth: false });
      toast("Password changed. Sign in with the new one.");
      router.replace("/login");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!token) return <div className="auth"><div className="authcard"><b>This reset link is missing its token.</b><Link href="/forgot-password">Request a new one</Link></div></div>;
  return (
    <div className="auth">
      <form className="authcard" onSubmit={submit}>
        <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        <h1 style={{ fontSize: 18, textAlign: "center" }}>Choose a new password</h1>
        <Field label="New password" htmlFor="rp-pw" help="At least 10 characters.">
          <input id="rp-pw" className="in" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="reset-password" />
        </Field>
        <Field label="Confirm password" htmlFor="rp-pw2">
          <input id="rp-pw2" className="in" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required data-testid="reset-confirm" />
        </Field>
        {error ? <div className="chip bad" role="alert">{error}</div> : null}
        <Button kind="p" wide type="submit" loading={busy} data-testid="reset-submit">Change password</Button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}

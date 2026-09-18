"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button, Field } from "@/components/ui";

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/password/forgot", { body: { identifier }, auth: false });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth">
      <form className="authcard" onSubmit={submit}>
        <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        <div style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: 18 }}>Reset your password</h1>
          <p className="dim sm">Enter the email or mobile number on your Loopcom ID.</p>
        </div>
        {done ? (
          <div className="card tight" role="status">
            <b>If that account exists, a reset link is on its way.</b>
            <p className="sm dim">It's valid for 30 minutes. Didn't get it? Check spam, or try the other contact method.</p>
          </div>
        ) : (
          <>
            <Field label="Email or mobile number" htmlFor="f-id">
              <input id="f-id" className="in" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required autoComplete="username" data-testid="forgot-identifier" />
            </Field>
            {error ? <div className="chip bad" role="alert">{error}</div> : null}
            <Button kind="p" wide type="submit" loading={busy} data-testid="forgot-submit">Send reset link</Button>
          </>
        )}
        <p className="sm dim" style={{ textAlign: "center" }}><Link href="/login">Back to sign in</Link></p>
      </form>
    </div>
  );
}

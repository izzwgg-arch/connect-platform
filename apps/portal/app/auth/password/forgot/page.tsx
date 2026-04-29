"use client";

import Link from "next/link";
import { useState } from "react";
import { apiPost } from "../../../../services/apiClient";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      await apiPost("/auth/password/forgot", { email });
      setSent(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="stack" style={{ minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <form className="panel stack" onSubmit={submit} style={{ width: "min(460px, 94vw)", padding: 28 }}>
        <h2>Reset your password</h2>
        <p className="muted">Enter your email. If an account exists, we will send a reset link.</p>
        <label className="stack"><span className="muted">Email</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label>
        {sent ? <div className="chip success">If an account exists, a reset email has been sent.</div> : null}
        <button className="btn" disabled={loading || !email}>{loading ? "Sending..." : "Send Reset Link"}</button>
        <Link className="muted" href="/login">Back to login</Link>
      </form>
    </main>
  );
}

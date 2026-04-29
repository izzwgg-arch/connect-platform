"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost } from "../../../../services/apiClient";

function passwordScore(password: string): number {
  return [
    password.length >= 10,
    /[a-z]/.test(password) && /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
}

export default function ResetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [valid, setValid] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const score = useMemo(() => passwordScore(password), [password]);

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("token") || "";
    setToken(raw);
    if (!raw) {
      setMessage("Reset link is missing a token.");
      return;
    }
    apiGet<{ email: string }>(`/auth/password/reset/validate?token=${encodeURIComponent(raw)}`)
      .then((r) => { setValid(true); setEmail(r.email); })
      .catch((e: any) => setMessage(e?.message || "Reset link is invalid or expired."));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      await apiPost("/auth/password/reset", { token, password, confirmPassword });
      setMessage("Password reset. Redirecting to login...");
      setTimeout(() => router.replace("/login"), 900);
    } catch (e: any) {
      setMessage(e?.message || "Could not reset password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="stack" style={{ minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <form className="panel stack" onSubmit={submit} style={{ width: "min(500px, 94vw)", padding: 28 }}>
        <h2>Choose a new password</h2>
        <p className="muted">{valid ? `Resetting password for ${email}` : "Validating reset link..."}</p>
        <label className="stack"><span className="muted">New password</span><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
        <label className="stack"><span className="muted">Confirm password</span><input className="input" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" /></label>
        <div className="muted">Strength: {"●".repeat(score)}{"○".repeat(4 - score)}</div>
        {message ? <div className={message.includes("Redirecting") ? "chip success" : "chip danger"}>{message}</div> : null}
        <button className="btn" disabled={loading || !valid || score < 3 || password !== confirmPassword}>{loading ? "Saving..." : "Reset Password"}</button>
      </form>
    </main>
  );
}

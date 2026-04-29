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

export default function AcceptInvitePage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [info, setInfo] = useState<{ email: string; name: string; tenantName: string; extension: string | null } | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const score = useMemo(() => passwordScore(password), [password]);

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("token") || "";
    setToken(raw);
    if (!raw) {
      setMessage("Invite link is missing a token.");
      return;
    }
    apiGet<{ email: string; name: string; tenantName: string; extension: string | null }>(`/auth/invite/validate?token=${encodeURIComponent(raw)}`)
      .then(setInfo)
      .catch((e: any) => setMessage(e?.message || "Invite link is invalid or expired."));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    setLoading(true);
    try {
      await apiPost("/auth/invite/accept", { token, password, confirmPassword });
      setMessage("Password created. Redirecting to login...");
      setTimeout(() => router.replace("/login"), 900);
    } catch (e: any) {
      setMessage(e?.message || "Could not create password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="stack" style={{ minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <form className="panel stack" onSubmit={submit} style={{ width: "min(500px, 94vw)", padding: 28 }}>
        <h2>Create your Connect password</h2>
        {info ? <p className="muted">Welcome {info.name}. Your account is for {info.tenantName}{info.extension ? `, extension ${info.extension}` : ""}.</p> : <p className="muted">Validating invite...</p>}
        <label className="stack"><span className="muted">Password</span><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
        <label className="stack"><span className="muted">Confirm password</span><input className="input" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" /></label>
        <div className="muted">Strength: {"●".repeat(score)}{"○".repeat(4 - score)} Use 10+ characters with mixed case, number, and symbol.</div>
        {message ? <div className={message.includes("Redirecting") ? "chip success" : "chip danger"}>{message}</div> : null}
        <button className="btn" disabled={loading || !info || score < 3 || password !== confirmPassword}>{loading ? "Saving..." : "Create Password"}</button>
      </form>
    </main>
  );
}

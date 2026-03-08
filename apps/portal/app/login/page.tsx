"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiPost } from "../../services/apiClient";
import { writeAuthToken } from "../../services/session";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await apiPost<{ token?: string; error?: string }>("/auth/login", { email, password });
      const token = String(res?.token || "");
      if (!token) {
        setError(String(res?.error || "Login failed"));
        return;
      }
      writeAuthToken(token);
      const next = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("next") : null;
      router.replace(next ? decodeURIComponent(next) : "/dashboard");
    } catch (e: any) {
      setError(e?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="stack" style={{ minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: "24px" }}>
      <form className="panel stack" onSubmit={submit} style={{ width: "min(440px, 92vw)" }}>
        <h2>Connect Communications</h2>
        <p className="muted">Sign in to access your telecom workspace.</p>
        <label className="stack">
          <span className="muted">Email</span>
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </label>
        <label className="stack">
          <span className="muted">Password</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </label>
        {error ? <div className="chip danger">{error}</div> : null}
        <button className="btn" type="submit" disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button>
      </form>
    </main>
  );
}

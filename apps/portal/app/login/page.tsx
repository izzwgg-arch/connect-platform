"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { ApiError, apiPost } from "../../services/apiClient";
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
      const dest = next ? decodeURIComponent(next) : "/dashboard";
      router.replace(dest);
      // Embedded browsers (e.g. Cursor Simple Browser) sometimes ignore client-side routing.
      window.setTimeout(() => {
        if (typeof window !== "undefined" && window.location.pathname === "/login") {
          window.location.assign(dest);
        }
      }, 400);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        if (e.status === 401) {
          const onLocalhost =
            typeof window !== "undefined" &&
            /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(window.location.host);
          setError(
            onLocalhost
              ? "Invalid email or password on localhost. This is not production — use the local dev account (see terminal output from pnpm bootstrap:local). Default: imwog@gmail.com or imwogg@gmail.com with password LocalDev2026!"
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
          ? "Cannot reach the API. Start it on port 3001 (e.g. pnpm --filter @connect/api dev) and restart the portal dev server."
          : raw,
      );
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
        <Link className="muted" href="/auth/password/forgot" style={{ textAlign: "center" }}>Forgot password?</Link>
      </form>
    </main>
  );
}

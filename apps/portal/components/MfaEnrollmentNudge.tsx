"use client";
/**
 * "Your role requires two-step verification" — one line at the top of the
 * dashboard, ONLY for a signed-in person whose role is on MFA_REQUIRED_ROLES
 * and who has not enrolled. Everyone else renders nothing (not even a wrapper —
 * every DOM node inside .console-shell costs ~70 ms of style recalc, CLAUDE.md).
 *
 * Why this exists as well as the sign-in redirect: sessions never expire, so an
 * administrator who is already signed in will not pass through /login for a
 * long time. This is how GRACE mode reaches them.
 *
 * Reads GET /auth/mfa/status once per mount; a failure shows nothing.
 * Dismissal is per browser tab (sessionStorage), so it comes back next time —
 * it is a prompt, not a nag, and not a wall.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiGet, hasBrowserAuthToken } from "../services/apiClient";

const DISMISS_KEY = "cc-mfa-nudge-dismissed";

export function MfaEnrollmentNudge() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!hasBrowserAuthToken()) return;
    try {
      if (window.sessionStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* storage blocked — just show it */
    }
    let cancelled = false;
    void apiGet<{ enrollmentRequired?: boolean; enabled?: boolean }>("/auth/mfa/status")
      .then((s) => {
        if (!cancelled && s?.enrollmentRequired === true && s?.enabled !== true) setShow(true);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  if (!show) return null;
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 14,
        padding: "10px 14px",
        borderRadius: 10,
        border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)",
        background: "color-mix(in srgb, var(--warning) 12%, transparent)",
        color: "var(--text)",
        fontSize: 13.5,
      }}
    >
      <span>
        Your role requires two-step verification. It takes about a minute.{" "}
        <Link href="/account/security?setup=1" style={{ color: "var(--accent)", fontWeight: 600 }}>Set it up now</Link>
      </span>
      <button
        type="button"
        className="btn ghost"
        style={{ fontSize: 12 }}
        onClick={() => {
          try { window.sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
          setShow(false);
        }}
      >
        Not now
      </button>
    </div>
  );
}

"use client";

import { useEffect, useRef } from "react";
import { TURNSTILE_SCRIPT_BASE, TURNSTILE_SCRIPT_SRC } from "../lib/turnstileScript";

/**
 * Cloudflare Turnstile on the sign-in form. Renders NOTHING when
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset — the api decides whether a token is
 * required (apps/api/src/turnstile.ts: off / observe / enforce), so an un-keyed
 * portal build simply sends no token. The script is Cloudflare's; the vhost
 * CSP allows https://challenges.cloudflare.com in script-src, frame-src and
 * connect-src. The site key is public by design; the secret never reaches the
 * browser.
 */
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
  }
}

export const TURNSTILE_SITE_KEY: string = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "").trim();
// Both come from ONE place so app/login/layout.tsx can preload byte-identically.
const SCRIPT_BASE = TURNSTILE_SCRIPT_BASE;
const SCRIPT_SRC = TURNSTILE_SCRIPT_SRC;

export function TurnstileWidget({ onToken, resetKey }: { onToken: (token: string) => void; resetKey?: number }) {
  const holder = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || typeof window === "undefined" || !holder.current) return;
    let cancelled = false;
    const render = () => {
      if (cancelled || !holder.current || !window.turnstile) return;
      if (widgetId.current) {
        try { window.turnstile.remove(widgetId.current); } catch { /* ignore */ }
      }
      widgetId.current = window.turnstile.render(holder.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: "auto",
        callback: (t: string) => onToken(t),
        "expired-callback": () => onToken(""),
        "error-callback": () => onToken(""),
      });
    };
    if (window.turnstile) {
      render();
    } else {
      const existing = document.querySelector<HTMLScriptElement>(`script[src^="${SCRIPT_BASE}"]`);
      const script = existing ?? document.createElement("script");
      script.addEventListener("load", render, { once: true });
      if (!existing) {
        script.src = SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    }
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        try { window.turnstile.remove(widgetId.current); } catch { /* ignore */ }
        widgetId.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={holder} className="lc-login-turnstile" aria-label="Security check" />;
}

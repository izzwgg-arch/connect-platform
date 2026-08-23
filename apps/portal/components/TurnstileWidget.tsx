"use client";

import { useEffect, useRef, useState } from "react";
import { TURNSTILE_SCRIPT_BASE, TURNSTILE_SCRIPT_SRC } from "../lib/turnstileScript";

/**
 * The widget's theme follows the PORTAL's own light/dark state, not the OS.
 * `useAppContext` is the single theme authority and writes `<html data-theme>`
 * ("light" | "dark"), which the LoginThemeToggle flips. ⛔ Read that attribute,
 * NOT `prefers-color-scheme` (the OS setting), or the check-in box would show
 * light on a dark page whenever the visitor's OS disagreed with their in-app
 * choice — the exact OS-vs-app-theme mismatch this codebase keeps hitting.
 */
function readPortalTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

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
  const [theme, setTheme] = useState<"light" | "dark">(() => readPortalTheme());

  // Follow the portal's own theme: re-read `<html data-theme>` whenever the
  // LoginThemeToggle (or the in-app toggle) flips it, so the widget re-renders
  // in the matching light/dark skin.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    setTheme(readPortalTheme());
    const obs = new MutationObserver(() => setTheme(readPortalTheme()));
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

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
        theme,
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
  }, [resetKey, theme]);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={holder} className="lc-login-turnstile" aria-label="Security check" />;
}

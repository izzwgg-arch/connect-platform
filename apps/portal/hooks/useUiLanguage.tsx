"use client";

// ── Yiddish interface ────────────────────────────────────────────────────────
//
// One hook + one toggle, dropped onto the screens a customer actually uses
// (billing, workspace, and the PBX pages — IVR Studio, IVR routing, music on
// hold). Admin screens are deliberately left in English; nobody outside the
// business sees them.
//
// The rules this enforces, because getting them wrong is worse than having no
// Yiddish at all:
//
//   • Yiddish Labs does the translating. Nothing else does. If a phrase hasn't
//     been translated yet, the screen shows ENGLISH — never a guess, never a
//     machine-written stand-in. A half-Yiddish screen is honest; a wrong
//     Yiddish screen is not.
//   • A page load never waits on a translation. It asks only for what is
//     already cached and gets it in milliseconds. Warming is a separate,
//     super-admin action that spends credits.
//   • The toggle only appears when the customer was set up for Yiddish AND
//     this person is allowed to use it.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../services/apiClient";

type Lang = "en" | "yi";

interface Ctx {
  lang: Lang;
  available: boolean;
  ready: boolean;
  setLang: (l: Lang) => void;
  /** Translate one phrase. Falls back to the English it was given. */
  t: (english: string) => string;
  /** Register phrases this screen needs, so they can be fetched in one batch. */
  register: (phrases: string[]) => void;
}

const LanguageContext = createContext<Ctx | null>(null);

/** Session-scoped memo so switching pages doesn't refetch the same phrases. */
const memo = new Map<string, string>();

export function UiLanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  const [available, setAvailable] = useState(false);
  const [ready, setReady] = useState(false);
  const [, forceRender] = useState(0);
  const pending = useRef<Set<string>>(new Set());
  const inFlight = useRef(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await apiGet<{ uiLanguage: Lang; available: boolean }>("/me/language");
        if (dead) return;
        setAvailable(!!r.available);
        setLangState(r.uiLanguage === "yi" && r.available ? "yi" : "en");
      } catch {
        // Not signed in yet, or the call failed — stay English, show nothing.
      } finally {
        if (!dead) setReady(true);
      }
    })();
    return () => { dead = true; };
  }, []);

  const flush = useCallback(async () => {
    if (inFlight.current || lang !== "yi") return;
    const want = Array.from(pending.current).filter((p) => !memo.has(p));
    if (want.length === 0) return;
    inFlight.current = true;
    try {
      // warm is NOT requested: cache-only, so the customer never waits.
      const r = await apiPost<{ translations: Record<string, string> }>("/ui/translate", { strings: want.slice(0, 400) });
      for (const [en, yi] of Object.entries(r.translations || {})) {
        if (yi && yi.trim()) memo.set(en, yi);
      }
      forceRender((n) => n + 1);
    } catch {
      // Leave everything in English. Deliberately silent — a translation
      // outage must not put an error in front of someone using their phone
      // system.
    } finally { inFlight.current = false; }
  }, [lang]);

  useEffect(() => { if (lang === "yi") void flush(); }, [lang, flush]);

  const register = useCallback((phrases: string[]) => {
    let added = false;
    for (const p of phrases) {
      const s = (p ?? "").trim();
      if (s && !pending.current.has(s)) { pending.current.add(s); added = true; }
    }
    if (added && lang === "yi") void flush();
  }, [lang, flush]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    // Remembered server-side so it follows the person to their phone and to
    // the assistant, not just this browser.
    void apiPatch("/me/language", { uiLanguage: l }).catch(() => {});
  }, []);

  const t = useCallback((english: string) => {
    if (lang !== "yi") return english;
    return memo.get((english ?? "").trim()) ?? english;
  }, [lang]);

  const value = useMemo<Ctx>(() => ({ lang, available, ready, setLang, t, register }), [lang, available, ready, setLang, t, register]);

  return (
    <LanguageContext.Provider value={value}>
      <div dir={lang === "yi" ? "rtl" : "ltr"} data-ui-lang={lang}>{children}</div>
    </LanguageContext.Provider>
  );
}

/**
 * Use inside a screen. Pass the phrases the screen shows so they're fetched
 * in one batch on mount.
 *
 * Safe outside the provider: returns a pass-through that always renders
 * English, so a screen can adopt this without depending on where it's mounted.
 */
export function useUiLanguage(phrases: string[] = []) {
  const ctx = useContext(LanguageContext);
  const registered = useRef(false);
  const register = ctx?.register;

  useEffect(() => {
    if (registered.current || !register || phrases.length === 0) return;
    registered.current = true;
    register(phrases);
  }, [register, phrases]);

  if (!ctx) {
    return { lang: "en" as Lang, available: false, ready: true, setLang: () => {}, t: (s: string) => s };
  }
  const { lang, available, ready, setLang, t } = ctx;
  return { lang, available, ready, setLang, t };
}

/** The switch itself. Renders nothing unless Yiddish is genuinely on offer. */
export function LanguageToggle({ className }: { className?: string }) {
  const ctx = useContext(LanguageContext);
  if (!ctx || !ctx.ready || !ctx.available) return null;
  const yi = ctx.lang === "yi";
  return (
    <>
      <button
        type="button"
        className={`ui-lang-toggle${yi ? " on" : ""}${className ? ` ${className}` : ""}`}
        onClick={() => ctx.setLang(yi ? "en" : "yi")}
        aria-label={yi ? "Show in English" : "ווײַז אויף ייִדיש"}
        title={yi ? "Show in English" : "Show in Yiddish"}
      >
        <span aria-hidden>{yi ? "A" : "א"}</span>
        {yi ? "English" : "ייִדיש"}
      </button>
      <style jsx global>{`
        .ui-lang-toggle{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:12.5px;font-weight:640;
          border:1px solid rgba(109,75,216,.32);background:rgba(109,75,216,.10);color:#6d4bd8;
          border-radius:999px;padding:6px 13px;cursor:pointer;transition:.14s;white-space:nowrap}
        .ui-lang-toggle:hover{filter:brightness(1.05)}
        .ui-lang-toggle.on{background:#6d4bd8;color:#fff;border-color:#6d4bd8}
        .ui-lang-toggle span[aria-hidden]{font-weight:800;font-size:13.5px;line-height:1}
        :root[data-theme="dark"] .ui-lang-toggle{border-color:rgba(167,139,250,.4);background:rgba(167,139,250,.14);color:#a78bfa}
        :root[data-theme="dark"] .ui-lang-toggle.on{background:#a78bfa;color:#141b2d;border-color:#a78bfa}
        [data-ui-lang="yi"]{text-align:start}
      `}</style>
    </>
  );
}

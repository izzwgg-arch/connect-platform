/**
 * ONE voice-diagnostics session per browser window, shared by every reporter.
 *
 * Before 2026-09-03 the portal opened TWO `VoiceClientSession`s per window —
 * `DesktopUpdateNotice` at boot (carrying the shell version) and `useSipPhone`
 * lazily on the first answered call — so a person's events were split across
 * two rows on /admin/call-timeline. Every client-side reporter now comes
 * through here and reuses the id `DesktopUpdateNotice` stored, or mints one.
 *
 * ⛔ Never call the api from here while signed out: a 401 stream on a public
 * page is how an office auto-bans itself at nginx (2026-08-04). Every path
 * resolves to `null` without a token.
 */
import { apiPost, hasBrowserAuthToken } from "../services/apiClient";

/** Shared with components/DesktopUpdateNotice.tsx — the same key on purpose. */
export const VOICE_DIAG_SESSION_KEY = "cc-desktop-shell-diag-session";

let pending: Promise<string | null> | null = null;

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(VOICE_DIAG_SESSION_KEY);
  } catch {
    return null;
  }
}

function store(id: string): void {
  try {
    window.sessionStorage.setItem(VOICE_DIAG_SESSION_KEY, id);
  } catch {
    /* storage disabled — the id lives for this module's lifetime only */
  }
}

/**
 * The client version, read the same way nginx identifies the fleet: the shell
 * puts `Loopcom/<ver>` (or `Connect/<ver>` before the rebrand) in the UA. A
 * plain browser reports `web`.
 */
export function clientAppVersion(): string {
  if (typeof navigator === "undefined") return "web";
  const m = /(?:Loopcom|Connect)\/([\w.-]+)/.exec(navigator.userAgent || "");
  return m ? `desktop-${m[1]}`.slice(0, 64) : "web";
}

/**
 * Resolve (or open) this window's diagnostics session. Cached: concurrent
 * callers share one in-flight request; a failure clears the cache so the next
 * caller retries instead of being stuck on a rejected promise forever.
 */
export function ensureVoiceDiagSession(): Promise<string | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (!hasBrowserAuthToken()) return Promise.resolve(null);
  const stored = readStored();
  if (stored) return Promise.resolve(stored);
  if (!pending) {
    pending = apiPost<{ sessionId?: string }>("/voice/diag/session/start", {
      platform: "WEB",
      appVersion: clientAppVersion(),
    })
      .then((r) => {
        const id = r?.sessionId ?? null;
        if (id) store(id);
        else pending = null;
        return id;
      })
      .catch(() => {
        pending = null;
        return null;
      });
  }
  return pending;
}

/** Test seam. */
export function __resetVoiceDiagSessionForTests(): void {
  pending = null;
}

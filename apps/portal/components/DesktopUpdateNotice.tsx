"use client";

import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { apiPost } from "../services/apiClient";
import { useOptionalSipPhone } from "../hooks/useSipPhone";

/**
 * In-app auto-update surface for the desktop app.
 *
 * The desktop shell (Electron) downloads updates in the background and exposes
 * its updater state over `window.connectDesktop.updates`. This module gives the
 * portal two things:
 *   - `useDesktopUpdate()` — live updater state (null in the browser and in
 *     desktop builds too old to have the bridge).
 *   - `<DesktopUpdateToast />` — a dismissible "New Update — Install" notice.
 *     One click applies the downloaded update and restarts the app; no manual
 *     uninstall/re-download.
 */

export type DesktopUpdateState = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "uptodate" | "error";
  installedVersion: string;
  version?: string;
  percent?: number;
  error?: string;
};

type UpdatesBridge = {
  getState: () => Promise<DesktopUpdateState>;
  install: () => Promise<boolean>;
  onState: (listener: (state: DesktopUpdateState) => void) => () => void;
};

function updatesBridge(): UpdatesBridge | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { connectDesktop?: { updates?: UpdatesBridge } }).connectDesktop?.updates;
  return api ?? null;
}

export function useDesktopUpdate(): DesktopUpdateState | null {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    const api = updatesBridge();
    if (!api) return;
    let mounted = true;
    api.getState().then((s) => { if (mounted) setState(s); }).catch(() => undefined);
    const off = api.onState((s) => setState(s));
    return () => { mounted = false; off(); };
  }, []);
  return state;
}

/** Apply the downloaded update now (restarts the app). Safe no-op elsewhere. */
export function installDesktopUpdate(): void {
  void updatesBridge()?.install().catch(() => undefined);
}

/**
 * Desktop install census beacon. Reports which desktop-shell version this
 * logged-in user runs by (re)starting a voice-diag client session with
 * appVersion "desktop-<shellVersion>" — an EXISTING api endpoint, so the
 * census is a plain DB query (VoiceClientSession where appVersion LIKE
 * 'desktop-%') instead of nginx-log detective work. Shells older than 0.1.5
 * have no updates bridge and report "desktop-pre-0.1.5". Browser tabs report
 * nothing. Full window only, so the mini pop-out doesn't double-count.
 */
const SHELL_SESSION_KEY = "cc-desktop-shell-diag-session";

export function DesktopShellBeacon() {
  useEffect(() => {
    const cd = (window as unknown as {
      connectDesktop?: { isDesktop?: boolean; windowKind?: string; updates?: { getState: () => Promise<DesktopUpdateState> } };
    }).connectDesktop;
    if (!cd?.isDesktop) return;
    if (cd.windowKind && cd.windowKind !== "full") return;
    let stopped = false;
    const report = async () => {
      let version = "pre-0.1.5";
      try {
        const state = await cd.updates?.getState();
        if (state?.installedVersion) version = state.installedVersion;
      } catch { /* old shell without the bridge */ }
      try {
        const prior = sessionStorage.getItem(SHELL_SESSION_KEY) || undefined;
        const res = await apiPost<{ sessionId?: string }>("/voice/diag/session/start", {
          ...(prior ? { sessionId: prior } : {}),
          platform: "WEB",
          appVersion: `desktop-${version}`.slice(0, 64),
        });
        if (!stopped && res?.sessionId) sessionStorage.setItem(SHELL_SESSION_KEY, res.sessionId);
      } catch { /* logged out or offline — the next interval retries */ }
    };
    void report();
    // Long-lived office machines stay open for weeks — refresh the census row
    // twice a day so lastSeenAt reflects reality.
    const timer = setInterval(() => void report(), 12 * 60 * 60 * 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  return null;
}

/**
 * Portal-deploy reload notice — the missing half of the update story.
 *
 * DesktopUpdateToast above covers updates to the desktop SHELL (the Electron
 * binary). But the shell loads the HOSTED portal, so a portal deploy changes
 * what the app should be running without any shell event firing — and an
 * already-open window keeps the stale bundle until someone reloads it
 * (2026-08-10: a deployed dialer fix reached nobody because every office
 * window predated it). This component polls GET /version (every 5 minutes and
 * on window focus); when the build id changes from the one captured at load,
 * it shows a reload notice. Mounted in app/providers.tsx so EVERY portal
 * surface gets it: full window, mini-dialer pop-out, and browser tabs.
 *
 * Deliberately passive — never auto-reloads. A reload tears down the SIP
 * softphone, so mid-call it would drop a live call; the human picks the moment.
 */
const RELOAD_DISMISS_PREFIX = "cc-portal-reload-dismissed.";
const RELOAD_BROADCAST_KEY = "cc-portal-reload-broadcast";
const VERSION_POLL_MS = 5 * 60 * 1000;
/** A broadcast older than this is stale (a leftover key from a past session). */
const BROADCAST_FRESH_MS = 60_000;

/**
 * Has this browser profile already acted on `buildId`?
 *
 * ⛔ Written when the user clicks Reload, BEFORE the reload runs — that is what
 * stops the notice nagging "again and again" (Izzy, 2026-08-20). Previously only
 * the ✕ was recorded, so if a reload did not land the new bundle for ANY reason
 * (an Electron window served from cache, a failed fetch, an offline blip) the
 * notice came straight back on the next 5-minute poll, forever, with the Reload
 * button visibly not working. Recording the acknowledgement makes the notice
 * appear at most ONCE per deploy per profile, whatever the reload does.
 */
function isBuildAcknowledged(buildId: string): boolean {
  try {
    return localStorage.getItem(RELOAD_DISMISS_PREFIX + buildId) === "1";
  } catch {
    return false;
  }
}

function acknowledgeBuild(buildId: string): void {
  try {
    localStorage.setItem(RELOAD_DISMISS_PREFIX + buildId, "1");
  } catch {
    /* private mode / storage disabled — worst case the notice shows again */
  }
}

/** True in the pop-out mini dialer, whose window is far too narrow for the card. */
function isMiniDialerWindow(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.pathname.startsWith("/desktop/mini-dialer")) return true;
  const kind = (window as unknown as { connectDesktop?: { windowKind?: string } })
    .connectDesktop?.windowKind;
  return kind === "mini";
}

/**
 * Shared update state for both reload surfaces (the full-window card and the
 * mini dialer's thin strip). Returns null while there is nothing to show.
 */
export function usePortalUpdate(): {
  newBuildId: string;
  dismiss: () => void;
  reloadEverything: () => void;
} | null {
  // Set to the NEW build id once a mismatch is seen; null = up to date.
  const [newBuildId, setNewBuildId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // ⛔ Optional on purpose — this is chrome, and a missing provider must never
  // take down the whole app. It is used ONLY to refuse an auto-reload mid-call.
  const phone = useOptionalSipPhone();
  const busy = phone ? phone.callState !== "idle" && phone.callState !== "ended" : false;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const pendingRef = useRef<string | null>(null);
  pendingRef.current = newBuildId;

  useEffect(() => {
    // Baseline = first successful fetch after load, i.e. the build this window
    // is (approximately) running. No inlined client build id needed.
    let baseline: string | null = null;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch("/version", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { buildId?: string };
        const id = String(data?.buildId || "").trim();
        if (!id || id === "dev" || stopped) return;
        if (baseline === null) { baseline = id; return; }
        if (id !== baseline) setNewBuildId(id);
      } catch {
        /* offline or mid-deploy — the next poll retries */
      }
    };
    void check();
    const timer = setInterval(() => void check(), VERSION_POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, []);

  // ── One click reloads every Connect window ────────────────────────────────
  // The desktop app runs the mini dialer, the full window and the phone engine
  // as separate BrowserWindows; reloading one leaves the others on the old
  // bundle. Same-origin windows share localStorage and DO receive each other's
  // `storage` events (the same mechanism sign-in already uses), so no desktop
  // shell change — and therefore no installer release — is needed.
  //
  // ⛔⛔ A RELOAD TEARS DOWN THE SIP SOFTPHONE. A window only ever auto-reloads
  // itself when it is IDLE. A window on a call (including a proxy window
  // mirroring the engine's call) ignores the broadcast and keeps showing its own
  // notice, so the person finishes the call and reloads when they choose. The
  // window where the button was actually pressed is the user's own explicit
  // choice and is not second-guessed.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== RELOAD_BROADCAST_KEY || !e.newValue) return;
      // Only act on a fresh broadcast, and only if THIS window is behind.
      // Already on the new build → pendingRef is null → no reload, so a stray
      // or replayed broadcast can never start a reload loop.
      if (!pendingRef.current) return;
      if (busyRef.current) return;
      let ts = 0;
      try { ts = Number((JSON.parse(e.newValue) as { at?: number })?.at ?? 0); } catch { return; }
      if (!Number.isFinite(ts) || Date.now() - ts > BROADCAST_FRESH_MS) return;
      acknowledgeBuild(pendingRef.current);
      window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Remember a dismissal per build id — the notice re-arms on the NEXT deploy.
  // Read synchronously-ish here AND at first render below, so an already-acted-on
  // build never flashes the notice for a frame.
  useEffect(() => {
    if (!newBuildId) return;
    setDismissed(isBuildAcknowledged(newBuildId));
  }, [newBuildId]);

  if (!newBuildId || dismissed || isBuildAcknowledged(newBuildId)) return null;

  const dismiss = () => {
    setDismissed(true);
    acknowledgeBuild(newBuildId);
  };

  const reloadEverything = () => {
    // Record BEFORE reloading — see isBuildAcknowledged. This is what makes the
    // notice appear at most once per deploy even if the reload misbehaves.
    acknowledgeBuild(newBuildId);
    try {
      localStorage.setItem(
        RELOAD_BROADCAST_KEY,
        JSON.stringify({ buildId: newBuildId, at: Date.now() }),
      );
    } catch {
      /* storage disabled — this window still reloads, the others just won't */
    }
    window.location.reload();
  };

  return { newBuildId, dismiss, reloadEverything };
}

/**
 * The mini dialer's own thin update strip.
 *
 * ⛔ Rendered INSIDE `.mini-shell` (a flex column) as its last child, NOT as a
 * fixed overlay — the pop-out is a small fixed-size window and a floating bar
 * would sit on top of the dialpad and the call buttons. As a flex child it
 * simply takes 28px off the bottom and covers nothing.
 * Izzy, 2026-08-20: "a thin, small 'Reload Connect was updated' banner".
 */
export function MiniDialerReloadBar() {
  const update = usePortalUpdate();
  if (!update) return null;
  return (
    <div
      role="status"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 28,
        padding: "0 8px",
        borderTop: "1px solid rgba(59,130,246,.35)",
        background: "rgba(59,130,246,.12)",
        fontSize: 11.5,
        // The mini dialer defines its own palette; inherit it rather than the
        // portal's, or the strip is invisible in mini light mode.
        color: "var(--mn-text, #f0f4ff)",
      }}
    >
      <RefreshCw size={12} style={{ color: "#3b82f6", flexShrink: 0 }} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        Connect was updated
      </span>
      <button
        type="button"
        onClick={update.reloadEverything}
        style={{
          flexShrink: 0,
          border: "none",
          borderRadius: 7,
          padding: "3px 10px",
          fontSize: 11.5,
          fontWeight: 700,
          cursor: "pointer",
          background: "#3b82f6",
          color: "#fff",
        }}
      >
        Reload
      </button>
      <button
        type="button"
        aria-label="Dismiss reload notice"
        onClick={update.dismiss}
        style={{
          flexShrink: 0,
          border: "none",
          background: "transparent",
          color: "inherit",
          opacity: 0.55,
          cursor: "pointer",
          padding: 2,
          display: "flex",
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function PortalReloadNotice() {
  const update = usePortalUpdate();
  const [isMini, setIsMini] = useState(false);
  useEffect(() => { setIsMini(isMiniDialerWindow()); }, []);

  // ⛔ The mini dialer renders its own in-layout strip (MiniDialerReloadBar);
  // this floating card would bury its dialpad. Two surfaces, never both.
  if (!update || isMini) return null;
  const { dismiss, reloadEverything } = update;

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        right: 18,
        bottom: 18,
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderRadius: 14,
        border: "1px solid rgba(59,130,246,.35)",
        background: "var(--surface-2, #0b1830)",
        boxShadow: "0 12px 32px rgba(0,0,0,.35)",
        maxWidth: 360,
      }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(59,130,246,.15)",
          color: "#3b82f6",
          flexShrink: 0,
        }}
      >
        <RefreshCw size={17} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Connect was updated</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          Reload to get the latest version. If you&apos;re on a call, finish it first.
        </div>
      </div>
      <button
        type="button"
        onClick={reloadEverything}
        style={{
          flexShrink: 0,
          border: "none",
          borderRadius: 10,
          padding: "8px 14px",
          fontSize: 12.5,
          fontWeight: 700,
          cursor: "pointer",
          background: "#3b82f6",
          color: "#fff",
        }}
      >
        Reload
      </button>
      <button
        type="button"
        aria-label="Dismiss reload notice"
        onClick={dismiss}
        style={{
          flexShrink: 0,
          border: "none",
          background: "transparent",
          color: "inherit",
          opacity: 0.6,
          cursor: "pointer",
          padding: 4,
          display: "flex",
        }}
      >
        <X size={15} />
      </button>
    </div>
  );
}

const DISMISS_KEY_PREFIX = "cc-update-toast-dismissed.";

export function DesktopUpdateToast() {
  const update = useDesktopUpdate();
  const [dismissed, setDismissed] = useState(false);

  const version = update?.version ?? "";
  const ready = update?.status === "downloaded";

  // Re-arm the toast for each new version; remember a dismissal per version.
  useEffect(() => {
    if (!ready || !version) return;
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY_PREFIX + version) === "1");
    } catch {
      setDismissed(false);
    }
  }, [ready, version]);

  if (!ready || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY_PREFIX + version, "1"); } catch { /* ignore */ }
  };

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        right: 18,
        bottom: 18,
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderRadius: 14,
        border: "1px solid rgba(34,197,94,.35)",
        background: "var(--surface-2, #0b1830)",
        boxShadow: "0 12px 32px rgba(0,0,0,.35)",
        maxWidth: 360,
      }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(34,197,94,.15)",
          color: "#22c55e",
          flexShrink: 0,
        }}
      >
        <Download size={17} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>New update ready</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          Connect {version ? `v${version}` : ""} has been downloaded. Install and restart now?
        </div>
      </div>
      <button
        type="button"
        onClick={() => installDesktopUpdate()}
        style={{
          flexShrink: 0,
          border: "none",
          borderRadius: 10,
          padding: "8px 14px",
          fontSize: 12.5,
          fontWeight: 700,
          cursor: "pointer",
          background: "#22c55e",
          color: "#04120a",
        }}
      >
        Install
      </button>
      <button
        type="button"
        aria-label="Dismiss update notice"
        onClick={dismiss}
        style={{
          flexShrink: 0,
          border: "none",
          background: "transparent",
          color: "inherit",
          opacity: 0.6,
          cursor: "pointer",
          padding: 4,
          display: "flex",
        }}
      >
        <X size={15} />
      </button>
    </div>
  );
}

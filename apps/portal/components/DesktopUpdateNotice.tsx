"use client";

import { useEffect, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { apiPost } from "../services/apiClient";

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
const VERSION_POLL_MS = 5 * 60 * 1000;

export function PortalReloadNotice() {
  // Set to the NEW build id once a mismatch is seen; null = up to date.
  const [newBuildId, setNewBuildId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

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

  // Remember a dismissal per build id — the notice re-arms on the NEXT deploy.
  useEffect(() => {
    if (!newBuildId) return;
    try {
      setDismissed(localStorage.getItem(RELOAD_DISMISS_PREFIX + newBuildId) === "1");
    } catch {
      setDismissed(false);
    }
  }, [newBuildId]);

  if (!newBuildId || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(RELOAD_DISMISS_PREFIX + newBuildId, "1"); } catch { /* ignore */ }
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
        onClick={() => window.location.reload()}
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

"use client";

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

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

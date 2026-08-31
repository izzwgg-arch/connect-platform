export type DesktopWindowKind = "full" | "mini" | "phone-engine";

export type DesktopSettings = {
  alwaysOnTop: boolean;
  startOnLogin: boolean;
  openMinimizedToTray: boolean;
  openMiniOnStartup: boolean;
  minimizeToTray: boolean;
  selectedMicDeviceId?: string;
  selectedSpeakerDeviceId?: string;
  miniBounds: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
  /**
   * The always-on-top floating AI Coworker bubble. ⛔ OFF by default: an existing
   * customer's update must not silently sprout a new floating window. Opt-in from
   * the tray. `coworkerWidgetPosition` is re-validated against the current displays
   * at every launch (a monitor may have been unplugged) — see widgetGeometry.ts.
   */
  coworkerWidgetEnabled?: boolean;
  coworkerWidgetPosition?: { x: number; y: number };
};

/** Auto-update lifecycle state, broadcast to renderers for the in-app "Install" UX. */
export type DesktopUpdateState = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "uptodate" | "error";
  installedVersion: string;
  /** Version of the update being offered/downloaded (when known). */
  version?: string;
  /** Download progress 0–100 while status === "downloading". */
  percent?: number;
  error?: string;
};

export type PhoneEngineEnvelope =
  | {
      type: "state";
      payload: unknown;
    }
  | {
      type: "event";
      event: string;
      payload?: unknown;
    };

export type PhoneEngineCommand = {
  command: string;
  args: unknown[];
};

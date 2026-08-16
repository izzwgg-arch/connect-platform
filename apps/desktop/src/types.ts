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

/**
 * A screen the customer can share. `id` is what gets handed to getDisplayMedia.
 * The whole list is offered rather than auto-picking, because "which screen"
 * is the customer's decision on a multi-monitor setup.
 */
export type DesktopScreenSource = {
  id: string;
  name: string;
  /** data: URI of a still, so the customer can see what they are about to share. */
  thumbnailDataUrl: string;
  isScreen: boolean;
};

/**
 * What the machine says about itself, stamped onto the session so the audit row
 * names a computer and not just a person.
 */
export type DesktopMachineInfo = {
  hostname: string;
  platform: string;
  release: string;
  appVersion: string;
  username: string;
};

export type RemoteSupportBannerState = {
  visible: boolean;
  supportName?: string;
  controlGranted?: boolean;
};

export type LanScanHost = {
  ip: string;
  mac: string;
  respondedOnHttp?: boolean;
};

export type LanScanOutcome = {
  subnet: string | null;
  hostsSeen: number;
  hosts: LanScanHost[];
  outcome: "ok" | "partial" | "failed";
  note?: string;
};

/**
 * ⛔ "coworker-widget" is the 64px bubble and "coworker-chat" is the popover it
 * opens. Both are PASSIVE windows to the portal (anything that is not "full"): they
 * never run a SIP phone, never redirect to /login, and wait for the main window's
 * token. The portal's useSipPhone treats "coworker-chat" as a proxy window for that
 * reason — a chat popover must never register a second phone.
 */
export type DesktopWindowKind = "full" | "mini" | "phone-engine" | "coworker-widget" | "coworker-chat";

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
  /**
   * Remote support: whether this installation will answer a request to share
   * its screen. ⛔⛔ OFF BY DEFAULT, AND THAT IS THE WHOLE FLEET-SAFETY STORY.
   *
   * The portal decides remote support exists by asking whether the desktop
   * bridge exposes a `remoteSupport` key (RemoteSupportConsent.tsx). The moment
   * it does, that screen starts polling `/remote-support/pending` every five
   * seconds for EVERY signed-in user — so exposing it unconditionally would
   * switch customer-wide polling on with a single desktop release, silently.
   *
   * So the preload only publishes the key when this is on, and it is opt-in from
   * the tray. An update therefore changes nothing for anybody who has not asked
   * for it, and whether remote support becomes a standard part of the customer
   * app stays a decision somebody makes on purpose rather than a side effect of
   * shipping this code.
   *
   * ⛔ Read at window creation and passed to the preload as a launch argument,
   * so a change takes effect at the next app start — see webPreferences() in
   * main.ts. Toggling it does NOT reload the window on purpose: a reload tears
   * down the SIP phone, and a support tool must never be able to drop a call.
   */
  remoteSupportEnabled?: boolean;
};

/**
 * ── Remote support ──────────────────────────────────────────────────────
 * The shapes the renderer and the main process exchange. Lifted unchanged from
 * the desktop-support app so the portal, which was written against them and is
 * already deployed, needs no change at all.
 */

/** A screen or window the customer could share. */
export type DesktopScreenSource = {
  id: string;
  name: string;
  /** data: URI of a still, so the customer sees what they are about to share. */
  thumbnailDataUrl: string;
  isScreen: boolean;
};

/** What the machine says about itself, stamped onto the session for the audit row. */
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

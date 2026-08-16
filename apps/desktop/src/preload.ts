import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopMachineInfo,
  DesktopScreenSource,
  DesktopSettings,
  DesktopUpdateState,
  DesktopWindowKind,
  LanScanOutcome,
  PhoneEngineCommand,
  PhoneEngineEnvelope,
  RemoteSupportBannerState,
} from "./types";

function windowKind(): DesktopWindowKind | undefined {
  const arg = process.argv.find((item) => item.startsWith("--connect-window-kind="));
  return arg?.split("=")[1] as DesktopWindowKind | undefined;
}

const desktopApi = {
  isDesktop: true,
  platform: process.platform,
  windowKind: windowKind(),

  window: {
    openMini: () => ipcRenderer.invoke("desktop:open-mini"),
    openFull: (route?: string) => ipcRenderer.invoke("desktop:open-full", route ?? null),
    expandToFull: (route?: string) => ipcRenderer.invoke("desktop:expand-full", route ?? null),
    closeMini: () => ipcRenderer.invoke("desktop:close-mini"),
    minimize: () => ipcRenderer.invoke("desktop:minimize"),
    toggleAlwaysOnTop: () => ipcRenderer.invoke("desktop:toggle-always-on-top"),
    getSettings: () => ipcRenderer.invoke("desktop:get-settings") as Promise<DesktopSettings>,
    updateSettings: (patch: Partial<DesktopSettings>) =>
      ipcRenderer.invoke("desktop:update-settings", patch) as Promise<DesktopSettings>,
    onSettings: (listener: (settings: DesktopSettings) => void) => {
      const wrapped = (_: unknown, settings: DesktopSettings) => listener(settings);
      ipcRenderer.on("desktop:settings", wrapped);
      return () => ipcRenderer.removeListener("desktop:settings", wrapped);
    },
    // Theme sync: the pop-out mini window lives in a separate BrowserWindow and does
    // not reliably share the portal's theme (an earlier localStorage/cc-theme attempt
    // was abandoned). The FULL window pushes its current theme here; main forwards it
    // to the mini so the pop-out follows the portal's light/dark mode.
    setMiniTheme: (theme: "dark" | "light") => ipcRenderer.invoke("desktop:set-mini-theme", theme),
    onMiniTheme: (listener: (theme: "dark" | "light") => void) => {
      const wrapped = (_: unknown, theme: "dark" | "light") => listener(theme);
      ipcRenderer.on("desktop:mini-theme", wrapped);
      return () => ipcRenderer.removeListener("desktop:mini-theme", wrapped);
    },
  },

  phone: {
    sendFromEngine: (envelope: PhoneEngineEnvelope) => ipcRenderer.send("phone:engine-event", envelope),
    sendCommand: (command: PhoneEngineCommand) => ipcRenderer.invoke("phone:command", command),
    onEngineEvent: (listener: (envelope: PhoneEngineEnvelope) => void) => {
      const wrapped = (_: unknown, envelope: PhoneEngineEnvelope) => listener(envelope);
      ipcRenderer.on("phone:engine-event", wrapped);
      return () => ipcRenderer.removeListener("phone:engine-event", wrapped);
    },
    onCommand: (listener: (command: PhoneEngineCommand) => void) => {
      const wrapped = (_: unknown, command: PhoneEngineCommand) => listener(command);
      ipcRenderer.on("phone:command", wrapped);
      return () => ipcRenderer.removeListener("phone:command", wrapped);
    },
  },

  notifications: {
    show: (payload: { kind: string; title: string; body?: string; route?: string }) =>
      ipcRenderer.invoke("desktop:notification", payload),
  },

  /**
   * Remote support. The portal page drives all of this — it already holds the
   * signed-in session, so authentication and networking stay in the renderer
   * and the main process only does the things a web page cannot: capture the
   * screen, move the real mouse, and keep a banner on top of everything.
   *
   * ⛔ NOTHING HERE STARTS ON ITS OWN. Every call below is the result of the
   * customer answering a prompt. There is no method that begins sharing
   * without one, and there must never be.
   */
  remoteSupport: {
    /** Screens the customer could share, with thumbnails so they can choose. */
    listScreens: () => ipcRenderer.invoke("remote-support:list-screens") as Promise<DesktopScreenSource[]>,
    /** Hostname/OS/app version, stamped onto the session for the audit trail. */
    machineInfo: () => ipcRenderer.invoke("remote-support:machine-info") as Promise<DesktopMachineInfo>,

    /**
     * Which screen the customer chose. ⛔ Must be called BEFORE getDisplayMedia,
     * or Electron picks one for them — which on a two-monitor machine means
     * sharing whichever one it likes, possibly the one with their email open.
     */
    setScreen: (sourceId: string) =>
      ipcRenderer.invoke("remote-support:set-screen", sourceId) as Promise<void>,

    /**
     * Turn on input injection for a live session.
     *
     * ⛔ The main process starts the helper ONLY on this call and refuses if
     * the renderer has not first shown that control was granted. Resolves
     * false when injection is unavailable (not Windows, helper blocked), which
     * the caller must surface — a control session where nothing moves is worse
     * than an honest "controlling is not available on this computer".
     */
    enableControl: (sessionId: string) =>
      ipcRenderer.invoke("remote-support:enable-control", sessionId) as Promise<boolean>,
    disableControl: () => ipcRenderer.invoke("remote-support:disable-control") as Promise<void>,
    /** One input event from the support side. Silently ignored unless control is live. */
    sendInput: (command: unknown) => ipcRenderer.send("remote-support:input", command),

    /** The always-visible "your screen is being shared" band. */
    setBanner: (state: RemoteSupportBannerState) =>
      ipcRenderer.invoke("remote-support:set-banner", state) as Promise<void>,
    /** Fired when the customer presses Stop on the banner. */
    onStopRequested: (listener: () => void) => {
      const wrapped = () => listener();
      ipcRenderer.on("remote-support:stop-requested", wrapped);
      return () => ipcRenderer.removeListener("remote-support:stop-requested", wrapped);
    },
  },

  /**
   * Desk-phone discovery on the customer's own network.
   * ⛔ Explicitly invoked only — there is deliberately no scheduled variant.
   */
  lanScan: {
    run: () => ipcRenderer.invoke("lan-scan:run") as Promise<LanScanOutcome>,
    subnets: () => ipcRenderer.invoke("lan-scan:subnets") as Promise<string[]>,
  },

  // In-app auto-update: the portal sidebar's "Install" item uses this to show
  // a "New Update" notice and apply the update with one click (no manual
  // uninstall/re-download).
  updates: {
    getState: () => ipcRenderer.invoke("desktop:update-get-state") as Promise<DesktopUpdateState>,
    /** Applies a fully-downloaded update (restarts the app). Resolves false if not ready yet. */
    install: () => ipcRenderer.invoke("desktop:update-install") as Promise<boolean>,
    onState: (listener: (state: DesktopUpdateState) => void) => {
      const wrapped = (_: unknown, state: DesktopUpdateState) => listener(state);
      ipcRenderer.on("desktop:update-state", wrapped);
      return () => ipcRenderer.removeListener("desktop:update-state", wrapped);
    },
  },
};

contextBridge.exposeInMainWorld("connectDesktop", desktopApi);

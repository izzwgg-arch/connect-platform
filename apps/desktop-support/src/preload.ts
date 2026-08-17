import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopMachineInfo,
  DesktopScreenSource,
  LanScanOutcome,
  RemoteSupportBannerState,
} from "./types";

/**
 * The Loopcom Support bridge.
 *
 * ⛔ IT IS EXPOSED UNDER THE SAME NAME AS THE CONNECT APP'S BRIDGE
 * (`connectDesktop`) ON PURPOSE, because the portal is the same portal and its
 * remote-support code looks for `connectDesktop.remoteSupport`. The two apps
 * never run the same page at the same time, and the Connect app deliberately
 * does NOT expose a `remoteSupport` key — which is exactly what the portal uses
 * to decide whether any of this is available. If you ever add `remoteSupport`
 * to the Connect app's preload, every customer starts polling for support
 * requests.
 *
 * ⛔ Nothing here starts on its own. Every call is the result of the customer
 * answering a prompt.
 */
/** A listener registration that does nothing but still returns an unsubscribe. */
const noopSubscribe = (_listener: unknown) => () => { /* nothing to unsubscribe */ };

const supportApi = {
  isDesktop: true,
  /** How the portal tells this app apart from the Connect desktop app. */
  isSupportApp: true,
  platform: process.platform,

  /**
   * ⛔ MUST BE "full". The portal treats any other value as a passive
   * secondary window (the mini dialer) and changes how AuthGate and the
   * notification bridge behave.
   */
  windowKind: "full" as const,

  /**
   * ⛔ EVERYTHING BELOW IS A STUB AND ALL OF IT IS LOAD-BEARING.
   *
   * Setting `isDesktop: true` tells the portal it is running inside the Connect
   * desktop app, and the portal then calls parts of this bridge WITHOUT
   * optional chaining — `connectDesktop.phone.sendFromEngine(...)`,
   * `connectDesktop.window.getSettings()`. With those keys missing the page
   * throws a TypeError while mounting, React tears the tree down, and the login
   * form silently stops working: the page still renders, the button still
   * clicks, and no request is ever sent. That looked exactly like a network or
   * password problem and was neither — 359 GETs left the app and not one POST.
   *
   * So this app must present the SAME SHAPE as the Connect bridge even though
   * it implements almost none of it. ⛔ Every `onX` must return an unsubscribe
   * function, because callers use it directly as a React effect cleanup — a
   * bare `undefined` throws on unmount instead of on mount.
   *
   * ⛔ If the Connect app's preload ever gains a key, add a stub here too.
   */
  window: {
    openMini: async () => undefined,
    openFull: async () => undefined,
    expandToFull: async () => undefined,
    closeMini: async () => undefined,
    minimize: () => ipcRenderer.invoke("support:minimize"),
    toggleAlwaysOnTop: async () => undefined,
    // Shape-compatible defaults; nothing in this app reads them back.
    getSettings: async () => ({
      alwaysOnTop: false,
      startOnLogin: false,
      openMinimizedToTray: false,
      openMiniOnStartup: false,
      minimizeToTray: false,
      miniBounds: { width: 360, height: 640 },
    }),
    updateSettings: async (patch: unknown) => patch,
    onSettings: noopSubscribe,
    setMiniTheme: async () => undefined,
    onMiniTheme: noopSubscribe,
  },

  /**
   * The softphone. Deliberately inert — this is a support tool and has no
   * business registering a second SIP endpoint against the same extension as
   * the user's real Connect app.
   */
  phone: {
    sendFromEngine: () => undefined,
    sendCommand: async () => undefined,
    onEngineEvent: noopSubscribe,
    onCommand: noopSubscribe,
  },

  notifications: {
    show: (payload: { kind: string; title: string; body?: string; route?: string }) =>
      ipcRenderer.invoke("support:notification", payload),
  },

  /** No auto-updater in this build, so it is permanently "up to date". */
  updates: {
    getState: async () => ({ status: "uptodate" as const, installedVersion: "0.0.1" }),
    install: async () => false,
    onState: noopSubscribe,
  },

  remoteSupport: {
    listScreens: () => ipcRenderer.invoke("remote-support:list-screens") as Promise<DesktopScreenSource[]>,
    machineInfo: () => ipcRenderer.invoke("remote-support:machine-info") as Promise<DesktopMachineInfo>,

    /**
     * ⛔ Must be called BEFORE getDisplayMedia, or Electron picks a screen for
     * the customer — which on a two-monitor machine can share the wrong one.
     */
    setScreen: (sourceId: string) =>
      ipcRenderer.invoke("remote-support:set-screen", sourceId) as Promise<void>,

    /**
     * Starts input injection. Resolves false when it is unavailable, which the
     * caller must surface — a control session where nothing moves reads as a
     * broken product rather than an honest limitation.
     */
    enableControl: (sessionId: string) =>
      ipcRenderer.invoke("remote-support:enable-control", sessionId) as Promise<boolean>,
    disableControl: () => ipcRenderer.invoke("remote-support:disable-control") as Promise<void>,
    sendInput: (command: unknown) => ipcRenderer.send("remote-support:input", command),

    setBanner: (state: RemoteSupportBannerState) =>
      ipcRenderer.invoke("remote-support:set-banner", state) as Promise<void>,
    onStopRequested: (listener: () => void) => {
      const wrapped = () => listener();
      ipcRenderer.on("remote-support:stop-requested", wrapped);
      return () => ipcRenderer.removeListener("remote-support:stop-requested", wrapped);
    },
  },

  /** ⛔ Explicitly invoked only — there is deliberately no scheduled variant. */
  lanScan: {
    run: () => ipcRenderer.invoke("lan-scan:run") as Promise<LanScanOutcome>,
    subnets: () => ipcRenderer.invoke("lan-scan:subnets") as Promise<string[]>,
  },
};

contextBridge.exposeInMainWorld("connectDesktop", supportApi);

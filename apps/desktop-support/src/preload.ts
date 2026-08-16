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
const supportApi = {
  isDesktop: true,
  /** How the portal tells this app apart from the Connect desktop app. */
  isSupportApp: true,
  platform: process.platform,

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

import { contextBridge, ipcRenderer } from "electron";
import type { DesktopSettings, DesktopUpdateState, DesktopWindowKind, PhoneEngineCommand, PhoneEngineEnvelope } from "./types";

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

  // Desk phone setup. ⛔ There is deliberately no way to name a URL, a host or a
  // command here: `run` takes an operation from a fixed allowlist that the main
  // process validates again on arrival. A password is handed over ONCE by reference
  // and is never readable back.
  phoneSetup: {
    run: (request: unknown) => ipcRenderer.invoke("phoneSetup:run", request),
    rememberCredential: (ref: string, username: string, password: string) =>
      ipcRenderer.invoke("phoneSetup:store-credential", { ref, username, password }),
    forgetCredentials: () => ipcRenderer.invoke("phoneSetup:forget-credentials"),
  },

  notifications: {
    show: (payload: { kind: string; title: string; body?: string; route?: string }) =>
      ipcRenderer.invoke("desktop:notification", payload),
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

// ── Floating Coworker widget bridge ───────────────────────────────────
// ⛔ Exposed to EVERY renderer but only meaningful in the tiny frameless bubble
// window (coworkerWidget.html). It carries exactly two verbs: "the bubble was
// clicked, open the chat" and "tell me when the badge state changes". There is no
// data in, no privileged capability — the same dumb-hands posture as phoneSetup.
const coworkerWidgetApi = {
  openChat: () => ipcRenderer.send("coworker-widget:open-chat"),
  onBadge: (listener: (state: "none" | "unread" | "working") => void) => {
    const wrapped = (_: unknown, state: "none" | "unread" | "working") => listener(state);
    ipcRenderer.on("coworker-widget:badge", wrapped);
    return () => ipcRenderer.removeListener("coworker-widget:badge", wrapped);
  },
};

contextBridge.exposeInMainWorld("coworkerWidget", coworkerWidgetApi);

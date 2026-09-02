import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopMachineInfo,
  DesktopScreenSource,
  DesktopSettings,
  DesktopUpdateState,
  DesktopWindowKind,
  PhoneEngineCommand,
  PhoneEngineEnvelope,
  RemoteDesktopIdentity,
  RemoteSupportBannerState,
} from "./types";

function windowKind(): DesktopWindowKind | undefined {
  const arg = process.argv.find((item) => item.startsWith("--connect-window-kind="));
  return arg?.split("=")[1] as DesktopWindowKind | undefined;
}

/**
 * ⛔⛔ THE FLEET GATE. Whether this window publishes the `remoteSupport` key at
 * all.
 *
 * The portal's RemoteSupportConsent is mounted for every signed-in user, and it
 * decides whether remote support exists by looking for exactly this key. Publish
 * it unconditionally and every customer's app begins polling for support
 * requests every five seconds the day this ships.
 *
 * So it is published only when main.ts passed the launch argument, which it does
 * only when the user turned remote support on in the tray. Default off means an
 * update changes nothing for anybody, and the customer-wide decision stays a
 * decision.
 *
 * ⛔ Read from argv rather than by asking the main process, because the key must
 * be present or absent at the moment the bridge is built — a promise resolved
 * later cannot make a key that the portal already looked for and did not find.
 */
function remoteSupportEnabled(): boolean {
  return process.argv.includes("--connect-remote-support=1");
}

/**
 * ⛔⛔ THE SECOND FLEET GATE (Remote Desktop, 2026-09-02). Same shape, same
 * reasoning: the portal's RemoteDesktopHost decides the feature exists by
 * looking for `connectDesktop.remoteDesktop`, and once it finds it the machine
 * registers itself and polls for connections every five seconds. So the key is
 * published only behind the launch argument main.ts passes when the owner
 * switched Remote Desktop on for THIS computer. Off = ABSENT, never a stub.
 */
function remoteDesktopEnabled(): boolean {
  return process.argv.includes("--connect-remote-desktop=1");
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

/**
 * Remote support — the three things a web page cannot do for itself.
 *
 * ⛔ Nothing here starts on its own. Every call is the result of the customer
 * having answered the consent prompt: the portal asks for screens to show them
 * in the dialog, and everything after that needs a session id the server only
 * issues once they pressed Allow.
 *
 * ⛔ `sendInput` is a `send`, not an `invoke`, on purpose — it is the hot path
 * during control and must not build a promise per mouse move. The main process
 * re-validates every command and drops anything that does not name the session
 * control was granted for.
 */
const remoteSupportApi = {
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
};

/**
 * Remote Desktop SETUP — always published. Setting a username and password,
 * naming the computer and flipping the switch are things the person at THIS
 * machine does before the feature exists for it, so they cannot sit behind the
 * gate. None of them shares anything: no screen, no input, no network polling.
 */
const remoteDesktopSetupApi = {
  identity: () => ipcRenderer.invoke("remote-desktop:identity") as Promise<RemoteDesktopIdentity>,
  setLogin: (username: string, password: string) =>
    ipcRenderer.invoke("remote-desktop:set-login", { username, password }) as Promise<
      { ok: true; login: RemoteDesktopIdentity["login"] } | { ok: false; reason: string; message: string }
    >,
  clearLogin: () => ipcRenderer.invoke("remote-desktop:clear-login") as Promise<{ ok: boolean }>,
  setEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("remote-desktop:set-enabled", enabled) as Promise<{ ok: boolean; enabled: boolean; message?: string }>,
  setName: (name: string) => ipcRenderer.invoke("remote-desktop:set-name", name) as Promise<{ ok: boolean; name: string }>,
  reportConnectId: (connectId: string) => ipcRenderer.invoke("remote-desktop:report-connect-id", connectId) as Promise<{ ok: boolean }>,
  lockState: () => ipcRenderer.invoke("remote-desktop:lock-state") as Promise<boolean>,
  onLockChanged: (listener: (locked: boolean) => void) => {
    const wrapped = (_: unknown, locked: boolean) => listener(locked);
    ipcRenderer.on("remote-desktop:lock-changed", wrapped);
    return () => ipcRenderer.removeListener("remote-desktop:lock-changed", wrapped);
  },
};

/**
 * Remote Desktop HOST — this computer being reached. Behind the gate. Screen
 * enumeration, input injection and the banner are the remote-support handlers,
 * reused; the two new verbs are the login check (credentials stay in main) and
 * whether a session's capture may include the computer's sound.
 */
const remoteDesktopHostApi = {
  listScreens: remoteSupportApi.listScreens,
  setScreen: remoteSupportApi.setScreen,
  machineInfo: remoteSupportApi.machineInfo,
  enableControl: remoteSupportApi.enableControl,
  disableControl: remoteSupportApi.disableControl,
  sendInput: remoteSupportApi.sendInput,
  setBanner: remoteSupportApi.setBanner,
  onStopRequested: remoteSupportApi.onStopRequested,
  /** The banner's yes/no to a mid-session ask. */
  onBannerAnswer: (listener: (answer: { capability: string; allow: boolean }) => void) => {
    const wrapped = (_: unknown, answer: { capability: string; allow: boolean }) => listener(answer);
    ipcRenderer.on("remote-support:banner-answer", wrapped);
    return () => ipcRenderer.removeListener("remote-support:banner-answer", wrapped);
  },
  /** ⛔ The verdict only. The hash never crosses this bridge. */
  verifyLogin: (username: string, password: string) =>
    ipcRenderer.invoke("remote-desktop:verify-login", { username, password }) as Promise<
      { ok: boolean; attemptsLeft: number; lockedForMs: number; reason?: string }
    >,
  allowAudio: (sessionId: string, allow: boolean) =>
    ipcRenderer.invoke("remote-desktop:allow-audio", { sessionId, allow }) as Promise<{ ok: boolean }>,
};

contextBridge.exposeInMainWorld(
  "connectDesktop",
  // ⛔ Each key is ABSENT, not empty, when its feature is off. The portal tests
  // for `bridge?.remoteSupport?.listScreens` / `bridge?.remoteDesktop?.listScreens`,
  // so an object of no-ops would pass that test and start the polling these
  // gates exist to prevent. Setup is always present: it polls nothing.
  {
    ...desktopApi,
    remoteDesktopSetup: remoteDesktopSetupApi,
    ...(remoteSupportEnabled() ? { remoteSupport: remoteSupportApi } : {}),
    ...(remoteDesktopEnabled() ? { remoteDesktop: remoteDesktopHostApi } : {}),
  },
);

// ── Floating Coworker widget bridge ───────────────────────────────────
// ⛔ Exposed to EVERY renderer but only meaningful in the tiny frameless bubble
// window (coworkerWidget.html). It carries exactly two verbs: "the bubble was
// clicked, open the chat" and "tell me when the badge state changes". There is no
// data in, no privileged capability — the same dumb-hands posture as phoneSetup.
const coworkerWidgetApi = {
  openChat: () => ipcRenderer.send("coworker-widget:open-chat"),
  /** The docked assistant's Minimize button: hide the chat popover. */
  closeChat: () => ipcRenderer.send("coworker-widget:close-chat"),
  // ⛔ The drag is driven by the MAIN process reading the real cursor. The
  // renderer only says "pressed", "still held", "released" — it sends no
  // coordinates, so it cannot put the window anywhere. A press that never travels
  // is a click, decided in widgetGeometry.isClick, and opens the chat.
  dragStart: () => ipcRenderer.send("coworker-widget:drag-start"),
  dragMove: () => ipcRenderer.send("coworker-widget:drag-move"),
  dragEnd: () => ipcRenderer.send("coworker-widget:drag-end"),
  onBadge: (listener: (state: "none" | "unread" | "working") => void) => {
    const wrapped = (_: unknown, state: "none" | "unread" | "working") => listener(state);
    ipcRenderer.on("coworker-widget:badge", wrapped);
    return () => ipcRenderer.removeListener("coworker-widget:badge", wrapped);
  },
};

contextBridge.exposeInMainWorld("coworkerWidget", coworkerWidgetApi);

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerMonitor, powerSaveBlocker, session, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { DesktopSettings, PhoneEngineCommand, PhoneEngineEnvelope } from "./types";
import { initAutoUpdater, checkForUpdatesInteractive, getUpdateState, onUpdateStateChange, installDownloadedUpdate } from "./updater";

// Chromium blocks media playback in windows the user has never interacted with.
// The FULL window runs the real SIP phone and plays the ringtone — but users who
// live in the mini pop-out (app starts minimized to tray) never click the full
// window, so its ringtone .play() was silently rejected: "phone never rings on
// this machine, everything else works". Disable the gesture requirement.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const DEFAULT_MINI_BOUNDS: DesktopSettings["miniBounds"] = { width: 360, height: 640 };

const DEFAULT_SETTINGS: DesktopSettings = {
  alwaysOnTop: false,
  startOnLogin: true,
  openMinimizedToTray: true,
  openMiniOnStartup: false,
  minimizeToTray: true,
  miniBounds: DEFAULT_MINI_BOUNDS,
};

const portalUrl = (process.env.CONNECT_PORTAL_URL || "https://app.connectcomunications.com").replace(/\/$/, "");
const preloadPath = path.join(__dirname, "preload.js");
const iconPath = path.join(__dirname, "..", "assets", "icon.png");

let fullWindow: BrowserWindow | null = null;
let miniWindow: BrowserWindow | null = null;
let phoneEngineWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let settings: DesktopSettings = DEFAULT_SETTINGS;
let latestPhoneStateEnvelope: PhoneEngineEnvelope | null = null;
// When the last phone-state envelope arrived (main-process clock). A frozen renderer
// cannot update this, so a "call active" state older than a couple of minutes is stale
// evidence, not a reason to skip recovery.
let lastPhoneStateAt = 0;
// Last theme the full portal window reported. Forwarded to the mini pop-out so it
// follows the portal's light/dark mode. Defaults to dark (the mini's base palette).
let miniTheme: "dark" | "light" = "dark";
// Power-save blocker held for the duration of a call so Windows never suspends the
// app or throttles the CPU mid-call (another source of choppy desktop audio).
let callPowerSaveBlockerId: number | null = null;
function setCallAudioKeepAlive(active: boolean): void {
  try {
    if (active) {
      if (callPowerSaveBlockerId === null || !powerSaveBlocker.isStarted(callPowerSaveBlockerId)) {
        callPowerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
        diag("audio", "power-save blocker started for call");
      }
    } else if (callPowerSaveBlockerId !== null) {
      if (powerSaveBlocker.isStarted(callPowerSaveBlockerId)) powerSaveBlocker.stop(callPowerSaveBlockerId);
      callPowerSaveBlockerId = null;
      diag("audio", "power-save blocker released");
    }
  } catch (err) {
    diag("audio", `power-save blocker error: ${String(err)}`);
  }
}

// ── Diagnostic file logging ───────────────────────────────────────────
// The desktop app shipped with no logs, so failures in the hidden phone-engine
// window were invisible. Capture each window's console + renderer crashes to a
// rotating file under userData/logs so calls are always recorded.
let logStream: fs.WriteStream | null = null;
function logDir(): string {
  return path.join(app.getPath("userData"), "logs");
}
function diag(tag: string, message: string): void {
  try {
    logStream?.write(`[${new Date().toISOString()}] [${tag}] ${message}\n`);
  } catch {
    /* never let logging throw */
  }
}
function initLogging(): void {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const file = path.join(logDir(), "connect.log");
    try {
      if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + ".1");
    } catch {
      /* no existing log yet */
    }
    logStream = fs.createWriteStream(file, { flags: "a" });
    diag("main", `=== log start v${app.getVersion()} ${process.platform} ===`);
  } catch {
    /* never let logging break startup */
  }
}
function attachConsoleCapture(win: BrowserWindow, tag: string): void {
  try {
    // Electron changed the console-message signature across majors. Old:
    // (event, level, message, line, sourceId). New (>=37): a single details
    // object { level, message, lineNumber, sourceId }. Handle both.
    win.webContents.on("console-message", (...args: unknown[]) => {
      let level: unknown, message = "", sourceId = "", line: unknown = "";
      if (args.length >= 3) {
        level = args[1];
        message = String(args[2] ?? "");
        line = args[3] ?? "";
        sourceId = String(args[4] ?? "");
      } else {
        const d = (args[0] ?? {}) as Record<string, unknown>;
        level = d.level;
        message = String(d.message ?? "");
        line = d.lineNumber ?? "";
        sourceId = String(d.sourceId ?? "");
      }
      diag(tag, `console.${String(level)}: ${message}${sourceId ? ` @${sourceId}:${String(line)}` : ""}`);
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      diag(tag, `render-process-gone: ${details.reason} exit=${details.exitCode}`);
    });
  } catch {
    /* ignore capture wiring failures */
  }
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettings(): DesktopSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(next: DesktopSettings): void {
  settings = next;
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  applyLoginSettings();
  for (const win of [fullWindow, miniWindow, phoneEngineWindow]) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send("desktop:settings", settings);
  }
}

function applyLoginSettings(): void {
  app.setLoginItemSettings({
    openAtLogin: settings.startOnLogin,
    openAsHidden: settings.openMinimizedToTray,
  });
}

function shouldStartHidden(): boolean {
  if (!settings.openMinimizedToTray) return false;
  if (process.argv.some((arg) => arg === "--hidden" || arg === "--background" || arg === "--minimized")) {
    return true;
  }
  const loginSettings = app.getLoginItemSettings();
  return Boolean(loginSettings.wasOpenedAsHidden);
}

function loadPortal(win: BrowserWindow, route = "/"): void {
  const url = new URL(route, portalUrl);
  url.searchParams.set("desktop", "1");
  win.loadURL(url.toString());
  win.webContents.once("did-finish-load", () => {
    if (!latestPhoneStateEnvelope || win.isDestroyed()) return;
    win.webContents.send("phone:engine-event", latestPhoneStateEnvelope);
  });
}

function webPreferences(windowKind: string) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    // CRITICAL for call audio: the SIP phone/WebRTC runs in the FULL window, which
    // normally sits hidden behind the mini pop-out or minimized to the tray. Chromium
    // throttles hidden/occluded windows by default (clamps timers, starves media
    // processing) — that is what makes desktop call audio choppy/breaking-up while the
    // web and mobile apps are fine. Disable throttling so audio keeps full CPU when hidden.
    backgroundThrottling: false,
    additionalArguments: [`--connect-window-kind=${windowKind}`],
  };
}

function createAppIcon(size?: number) {
  const icon = nativeImage.createFromPath(iconPath);
  return size ? icon.resize({ width: size, height: size }) : icon;
}

function createFullWindow(show = true): BrowserWindow {
  if (fullWindow && !fullWindow.isDestroyed()) {
    if (show) {
      fullWindow.show();
      fullWindow.focus();
    }
    return fullWindow;
  }

  fullWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show,
    title: "Connect",
    backgroundColor: "#07111f",
    icon: iconPath,
    webPreferences: webPreferences("full"),
  });

  attachConsoleCapture(fullWindow, "full");

  fullWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  fullWindow.on("close", (event) => {
    if (isQuitting || !settings.minimizeToTray) return;
    event.preventDefault();
    fullWindow?.hide();
  });

  loadPortal(fullWindow, "/");
  return fullWindow;
}

function createMiniWindow(show = true): BrowserWindow {
  if (miniWindow && !miniWindow.isDestroyed()) {
    if (show) {
      miniWindow.show();
      miniWindow.focus();
    }
    return miniWindow;
  }

  miniWindow = new BrowserWindow({
    width: settings.miniBounds.width,
    height: settings.miniBounds.height,
    x: settings.miniBounds.x,
    y: settings.miniBounds.y,
    minWidth: 320,
    minHeight: 560,
    show: false,
    title: "Connect Mini Dialer",
    frame: false,
    resizable: true,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: "#07111f",
    icon: iconPath,
    webPreferences: webPreferences("mini"),
  });

  miniWindow.once("ready-to-show", () => {
    if (!show || !miniWindow || miniWindow.isDestroyed()) return;
    miniWindow.show();
    miniWindow.focus();
  });

  miniWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    miniWindow?.hide();
  });

  const persistBounds = () => {
    if (!miniWindow || miniWindow.isDestroyed()) return;
    const bounds = miniWindow.getBounds();
    writeSettings({
      ...settings,
      miniBounds: {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
      },
    });
  };
  miniWindow.on("resize", persistBounds);
  miniWindow.on("move", persistBounds);

  // Start on the correct theme (query param avoids a light/dark flash on open) and
  // re-assert it once loaded, so the pop-out matches the portal's current mode.
  miniWindow.webContents.on("did-finish-load", () => {
    if (!miniWindow || miniWindow.isDestroyed()) return;
    miniWindow.webContents.send("desktop:mini-theme", miniTheme);
  });
  // Cache-bust the mini route: Electron's HTTP cache otherwise serves a stale
  // mini-dialer HTML across relaunches, so freshly deployed portal fixes wouldn't
  // appear without a manual hard-reload. A unique param forces a fresh fetch.
  loadPortal(miniWindow, `/desktop/mini-dialer?miniTheme=${miniTheme}&_cb=${Date.now()}`);
  return miniWindow;
}

function createPhoneEngineWindow(): BrowserWindow {
  if (phoneEngineWindow && !phoneEngineWindow.isDestroyed()) return phoneEngineWindow;

  phoneEngineWindow = new BrowserWindow({
    width: 420,
    height: 620,
    show: false,
    title: "Connect Phone Engine",
    backgroundColor: "#07111f",
    icon: iconPath,
    webPreferences: webPreferences("phone-engine"),
  });

  attachConsoleCapture(phoneEngineWindow, "phone-engine");
  loadPortal(phoneEngineWindow, "/desktop/phone-engine");
  return phoneEngineWindow;
}

function showMiniForIncomingCall(): void {
  const win = createMiniWindow(true);
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  if (!settings.alwaysOnTop) {
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.setAlwaysOnTop(false);
    }, 1500);
  }
}

function rebuildTray(): void {
  if (!tray) {
    tray = new Tray(createAppIcon(16));
    tray.setToolTip("Connect");
  }

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Connect", click: () => createFullWindow(true) },
    { label: "Open Mini Dialer", click: () => createMiniWindow(true) },
    {
      label: settings.alwaysOnTop ? "Turn Off Always On Top" : "Keep Mini Dialer On Top",
      click: () => toggleAlwaysOnTop(),
    },
    { type: "separator" },
    { label: "Check for Updates…", click: () => checkForUpdatesInteractive() },
    { type: "separator" },
    {
      label: "Quit Connect",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));

  tray.on("double-click", () => createFullWindow(true));
}

function toggleAlwaysOnTop(): DesktopSettings {
  const next = { ...settings, alwaysOnTop: !settings.alwaysOnTop };
  miniWindow?.setAlwaysOnTop(next.alwaysOnTop);
  writeSettings(next);
  rebuildTray();
  return settings;
}

function sendPhoneEventToRenderers(envelope: PhoneEngineEnvelope): void {
  for (const win of [fullWindow, miniWindow]) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send("phone:engine-event", envelope);
  }
}

function registerIpc(): void {
  // In-app update UX: the portal sidebar shows "New Update — Install"; these
  // two handlers let it read the updater state and trigger the one-click
  // install (quitAndInstall) once the download is complete.
  ipcMain.handle("desktop:update-get-state", () => getUpdateState());
  ipcMain.handle("desktop:update-install", () => installDownloadedUpdate());
  ipcMain.handle("desktop:open-mini", () => createMiniWindow(true).id);
  ipcMain.handle("desktop:open-full", (_event, route?: string | null) => {
    const win = createFullWindow(true);
    if (route) loadPortal(win, route);
    return win.id;
  });
  ipcMain.handle("desktop:expand-full", (_event, route?: string | null) => {
    miniWindow?.hide();
    const win = createFullWindow(true);
    if (route) loadPortal(win, route);
    return win.id;
  });
  ipcMain.handle("desktop:close-mini", () => {
    miniWindow?.hide();
  });
  ipcMain.handle("desktop:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle("desktop:toggle-always-on-top", () => toggleAlwaysOnTop());
  ipcMain.handle("desktop:set-mini-theme", (_event, theme: "dark" | "light") => {
    miniTheme = theme === "light" ? "light" : "dark";
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.webContents.send("desktop:mini-theme", miniTheme);
    }
    return miniTheme;
  });
  ipcMain.handle("desktop:get-settings", () => settings);
  ipcMain.handle("desktop:update-settings", (_event, patch: Partial<DesktopSettings>) => {
    writeSettings({ ...settings, ...patch });
    rebuildTray();
    return settings;
  });
  ipcMain.handle("desktop:notification", (_event, payload: { kind: string; title: string; body?: string; route?: string }) => {
    if (!Notification.isSupported()) return false;
    const note = new Notification({ title: payload.title, body: payload.body || "", icon: iconPath });
    note.on("click", () => {
      if (payload.kind === "incoming-call") showMiniForIncomingCall();
      else if (payload.route) createFullWindow(true) && loadPortal(createFullWindow(true), payload.route);
    });
    note.show();
    return true;
  });

  ipcMain.on("phone:engine-event", (_event, envelope: PhoneEngineEnvelope) => {
    if (envelope.type === "state") {
      latestPhoneStateEnvelope = envelope;
      lastPhoneStateAt = Date.now();
    }
    sendPhoneEventToRenderers(envelope);
    if (envelope.type === "state") {
      const state = envelope.payload as { callState?: string; callDirection?: string; ringingSessionIds?: unknown[]; remoteParty?: string | null };
      // Hold a power-save blocker for the whole call (ringing/dialing/connected) so
      // Windows never suspends the app or throttles the CPU mid-call.
      const callActive = state.callState === "ringing" || state.callState === "dialing" || state.callState === "connected"
        || (Array.isArray(state.ringingSessionIds) && state.ringingSessionIds.length > 0);
      setCallAudioKeepAlive(callActive);
      // Only react to genuinely inbound ringing — never for outbound calls where
      // the remote phone is ringing (callDirection === "outbound").
      const isInboundRing =
        (state.callState === "ringing" && state.callDirection !== "outbound") ||
        (Array.isArray(state.ringingSessionIds) && state.ringingSessionIds.length > 0);
      if (isInboundRing) {
        // Single incoming-call surface: just the pop-out mini dialer. (The
        // duplicate "Incoming call" notification was removed so a call no longer
        // produces multiple popups.)
        showMiniForIncomingCall();
      }
    }
  });

  ipcMain.handle("phone:command", (_event, command: PhoneEngineCommand) => {
    // Single-phone model: the main (full) window runs the ONE SIP phone; the mini
    // pop-out is a proxy. All commands (from either surface) go to the full window.
    // We no longer spawn a hidden phone-engine window - that second phone was the
    // source of the double-ring and the answer landing on the wrong leg.
    const target = (fullWindow && !fullWindow.isDestroyed()) ? fullWindow : createFullWindow(false);
    target.webContents.send("phone:command", command);
    return true;
  });
}

// ── SIP-engine liveness: heartbeat + hard recovery ─────────────────────
// Root cause of "registered → yellow forever until app restart" (diagnosed 2026-07-14):
// Windows/Chromium can FREEZE the hidden full window's renderer outright (native window
// occlusion tracking + EcoQoS/Modern Standby), not just throttle it. When that happens
// every in-renderer defence — CRLF keepalive, liveness watchdog, reconnect backoff,
// even telemetry — stops with it, the WSS socket dies, and nothing ever reconnects.
// A frozen renderer cannot heal itself, so the MAIN process (which is never frozen)
// pings the SIP window every 30 s with a trivial executeJavaScript. Three consecutive
// unanswered pings (~90 s) ⇒ webContents.reload(), which rebuilds the portal and
// re-registers. Reload is skipped only while a call is plausibly active on FRESH state.
let heartbeatMisses = 0;
let heartbeatBusy = false;
function startSipEngineHeartbeat(): void {
  setInterval(async () => {
    const win = fullWindow;
    if (!win || win.isDestroyed() || win.webContents.isLoading()) return;
    if (heartbeatBusy) return; // previous ping still in flight; its own timeout scores the miss
    heartbeatBusy = true;
    const alive = await Promise.race([
      win.webContents.executeJavaScript("1", true).then(() => true).catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    heartbeatBusy = false;
    if (win.isDestroyed()) return;
    if (alive) {
      if (heartbeatMisses > 0) diag("heartbeat", `SIP window responsive again after ${heartbeatMisses} miss(es)`);
      heartbeatMisses = 0;
      return;
    }
    heartbeatMisses += 1;
    diag("heartbeat", `SIP window unresponsive (miss ${heartbeatMisses}/3)`);
    if (heartbeatMisses < 3) return;
    const state = (latestPhoneStateEnvelope?.payload ?? {}) as { callState?: string; ringingSessionIds?: unknown[] };
    const callActive = state.callState === "ringing" || state.callState === "dialing" || state.callState === "connected"
      || (Array.isArray(state.ringingSessionIds) && state.ringingSessionIds.length > 0);
    if (callActive && Date.now() - lastPhoneStateAt < 120_000) {
      diag("heartbeat", "holding reload: call state is active and fresh");
      return;
    }
    heartbeatMisses = 0;
    diag("heartbeat", "reloading frozen SIP window");
    try {
      win.webContents.reload();
    } catch (err) {
      diag("heartbeat", `reload failed: ${String(err)}`);
    }
  }, 30_000);
}

// ── Keep call audio smooth when the window is hidden/occluded ──────────
// backgroundThrottling:false (per-window, above) stops timer throttling, but Chromium
// separately lowers a renderer's process priority when it's hidden or occluded, which
// starves the WebRTC audio thread and makes desktop call audio choppy. These switches
// (must be set before app ready) keep the renderer at full priority so audio stays
// smooth even with the full window behind the mini or minimized to the tray.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-timer-throttling");
// The switches above only address PRIORITY/throttling. Chromium's native window
// occlusion tracker separately marks a fully covered/minimized window as hidden and
// can freeze its renderer entirely (and IntensiveWakeUpThrottling clamps its timers
// to once a minute). Either one silently kills the SIP engine's keepalive/watchdog
// loop — the diagnosed cause of permanent yellow. Disable both features outright.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion,IntensiveWakeUpThrottling");

// ── Single-instance lock ──────────────────────────────────────────────
// Without this, every launch (startOnLogin, a manual re-open, or the relaunch
// after an asar reship) spawns a SEPARATE Connect process. Each process has its
// own mini-window singleton, so each one opens its OWN mini dialer on an incoming
// call — that is the "multiple dialers on every call" bug. Enforce exactly one
// running instance: a second launch just focuses the existing window and exits.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const existing =
      fullWindow && !fullWindow.isDestroyed()
        ? fullWindow
        : miniWindow && !miniWindow.isDestroyed()
          ? miniWindow
          : null;
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    } else {
      createFullWindow(true);
    }
  });

  app.whenReady().then(async () => {
  initLogging();
  app.setAppUserModelId("com.connectcommunications.desktop");
  settings = readSettings();
  applyLoginSettings();
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media" || permission === "notifications");
  });
  // Flush the HTTP cache on startup so freshly deployed portal code is picked up.
  // This clears ONLY the network cache — cookies and localStorage are untouched, so
  // the user stays signed in. (Electron was otherwise serving a stale mini-dialer
  // document across relaunches even with a cache-busting URL param.)
  try { await session.defaultSession.clearCache(); } catch { /* non-fatal */ }
  registerIpc();
  rebuildTray();
  // Hold an app-suspension power-save blocker for the app's entire lifetime — not just
  // during calls. A softphone must stay registered to RECEIVE calls, and Modern
  // Standby/EcoQoS otherwise suspends the idle app exactly when it looks least busy.
  try {
    const id = powerSaveBlocker.start("prevent-app-suspension");
    diag("main", `lifetime app-suspension blocker started (id ${id})`);
  } catch (err) {
    diag("main", `lifetime power-save blocker failed: ${String(err)}`);
  }
  // Single-phone model: the full window is the one SIP phone; no separate hidden
  // phone-engine window (removing the second phone / double-ring).
  createFullWindow(!shouldStartHidden());
  if (settings.openMiniOnStartup) createMiniWindow(true);
  // In-app auto-update: check the feed on launch (and periodically), download in
  // the background, and prompt the user to restart when an update is ready.
  initAutoUpdater(diag);
  // Fan updater state out to every window so the portal's "New Update" notice
  // stays live (badge, download %, Install button) without polling.
  onUpdateStateChange((state) => {
    for (const win of [fullWindow, miniWindow]) {
      if (!win || win.isDestroyed()) continue;
      win.webContents.send("desktop:update-state", state);
    }
  });
  startSipEngineHeartbeat();
  // After sleep/resume the renderer may be alive but its socket long dead; nudge the
  // portal's own reconnect path immediately instead of waiting for its next timer.
  powerMonitor.on("resume", () => {
    diag("power", "system resumed — nudging SIP reconnect");
    const win = fullWindow;
    if (!win || win.isDestroyed() || win.webContents.isLoading()) return;
    win.webContents.executeJavaScript("window.dispatchEvent(new Event('online')); 1", true).catch(() => { /* heartbeat will catch a frozen renderer */ });
  });

  app.on("activate", () => createFullWindow(true));
  });
}

app.on("window-all-closed", () => {
  if (isQuitting) app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
});

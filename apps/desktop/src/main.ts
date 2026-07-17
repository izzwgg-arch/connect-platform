import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { DesktopSettings, PhoneEngineCommand, PhoneEngineEnvelope } from "./types";
import { checkForUpdatesInteractive, initAutoUpdater } from "./updater";

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
// Last theme the full portal window reported. Forwarded to the mini pop-out so it
// follows the portal's light/dark mode. Defaults to dark (the mini's base palette).
let miniTheme: "dark" | "light" = "dark";

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
  loadPortal(miniWindow, `/desktop/mini-dialer?miniTheme=${miniTheme}`);
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
    { label: "Check for Updates\u2026", click: () => checkForUpdatesInteractive() },
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
    if (envelope.type === "state") latestPhoneStateEnvelope = envelope;
    sendPhoneEventToRenderers(envelope);
    if (envelope.type === "state") {
      const state = envelope.payload as { callState?: string; callDirection?: string; ringingSessionIds?: unknown[]; remoteParty?: string | null };
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

  app.whenReady().then(() => {
  initLogging();
  app.setAppUserModelId("com.connectcommunications.desktop");
  settings = readSettings();
  applyLoginSettings();
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media" || permission === "notifications");
  });
  registerIpc();
  rebuildTray();
  // Single-phone model: the full window is the one SIP phone; no separate hidden
  // phone-engine window (removing the second phone / double-ring).
  createFullWindow(!shouldStartHidden());
  if (settings.openMiniOnStartup) createMiniWindow(true);
  // In-app auto-update: check the feed on launch (and periodically), download in
  // the background, and prompt the user to restart when an update is ready.
  initAutoUpdater(diag);

  app.on("activate", () => createFullWindow(true));
  });
}

app.on("window-all-closed", () => {
  if (isQuitting) app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
});

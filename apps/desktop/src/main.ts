import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { DesktopSettings, PhoneEngineCommand, PhoneEngineEnvelope } from "./types";

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

  loadPortal(miniWindow, "/desktop/mini-dialer");
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
      const state = envelope.payload as { callState?: string; ringingSessionIds?: unknown[]; remoteParty?: string | null };
      if (state.callState === "ringing" || (Array.isArray(state.ringingSessionIds) && state.ringingSessionIds.length > 0)) {
        showMiniForIncomingCall();
        if (Notification.isSupported()) {
          const note = new Notification({
            title: "Incoming call",
            body: state.remoteParty ? String(state.remoteParty) : "Connect call",
            icon: iconPath,
          });
          note.on("click", showMiniForIncomingCall);
          note.show();
        }
      }
    }
  });

  ipcMain.handle("phone:command", (_event, command: PhoneEngineCommand) => {
    // The full window now runs LocalSipPhoneProvider directly (like the web app).
    // Send commands there first; fall back to phone-engine window if full isn't open.
    const target = (fullWindow && !fullWindow.isDestroyed()) ? fullWindow : createPhoneEngineWindow();
    target.webContents.send("phone:command", command);
    return true;
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId("com.connectcommunications.desktop");
  settings = readSettings();
  applyLoginSettings();
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media" || permission === "notifications");
  });
  registerIpc();
  rebuildTray();
  createPhoneEngineWindow();
  createFullWindow(!shouldStartHidden());
  if (settings.openMiniOnStartup) createMiniWindow(true);

  app.on("activate", () => createFullWindow(true));
});

app.on("window-all-closed", () => {
  if (isQuitting) app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
});

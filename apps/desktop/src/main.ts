import { execFileSync } from "node:child_process";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker, safeStorage, session, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { DesktopSettings, PhoneEngineCommand, PhoneEngineEnvelope } from "./types";
import { buildWindowsToastXml, type DesktopNotificationPayload } from "./notificationToast";
import { brandedUserAgent } from "./userAgent";
import { initAutoUpdater, checkForUpdatesInteractive, getUpdateState, onUpdateStateChange, installDownloadedUpdate } from "./updater";
import { registerPhoneSetup } from "./phoneSetup/mainWiring";
import { iconFileForTheme, installThemeIconWatcher, resolveDark } from "./themeIcon";

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
const assetPath = (file: string) => path.join(__dirname, "..", "assets", file);

// ⛔ ON WINDOWS THIS MUST BE THE .ico, NOT THE .png. A single-resolution PNG
// forces Windows to downscale one 512px image for the 16px taskbar and the 32px
// title bar, and the Loopcom mark is thin glowing strokes — it turns to a smudge.
// ⛔ THEME-AWARE (Izzy, 2026-08-23): dark mode -> navy-2a (icon-dark.*), light
// mode -> blue-2b (icon.*). The mapping lives in themeIcon.ts; this resolves the
// CURRENT file every time it is called, so tray and window icons follow the OS
// toggle instantly. The exe-embedded icon (Start menu, pins) stays blue-2b —
// Windows reads one .ico out of the executable and no theme-aware form exists.
/**
 * ⛔ Windows' SystemUsesLightTheme — the theme of the TASKBAR the icon sits on.
 * nativeTheme reports the APPS theme, and the two differ under Windows' custom
 * mode (found live: system dark, apps light showed the wrong icon). Read the
 * registry directly; null on any failure so the caller falls back to nativeTheme.
 */
function readSystemDark(): boolean | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("reg", [
      "query", "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
      "/v", "SystemUsesLightTheme",
    ], { encoding: "utf8", timeout: 3000, windowsHide: true });
    const m = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(out);
    if (!m) return null;
    return parseInt(m[1], 16) === 0; // 0 = system is dark
  } catch {
    return null;
  }
}

const iconPath = (): string => assetPath(iconFileForTheme(resolveDark({ nativeTheme, readSystemDark })));

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
// follows the portal's light/dark mode. Defaults to LIGHT — the portal's own
// default (dark is opt-in), so a fresh launch's mini matches the app instead of
// opening dark until the full window's portal pushes (Izzy, 2026-08-27). The
// portal side also arbitrates every push against localStorage "cc-theme", so a
// stale value here can no longer flip a user's mini either way.
let miniTheme: "dark" | "light" = "light";
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

/** Right-click Cut/Copy/Paste. Electron shows NO context menu unless the shell
 *  builds one, so the PC app shipped with right-click doing nothing at all —
 *  "Cannot right click in the PC app (Copy, Paste)" on the trainer's sheet,
 *  twice. Roles only (no custom handlers): the OS performs the edit, so this
 *  cannot read or log clipboard contents. */
function attachEditContextMenu(win: BrowserWindow): void {
  try {
    win.webContents.on("context-menu", (_e, params) => {
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (params.isEditable) {
        items.push(
          { role: "cut", enabled: params.editFlags.canCut },
          { role: "copy", enabled: params.editFlags.canCopy },
          { role: "paste", enabled: params.editFlags.canPaste },
          { type: "separator" },
          { role: "selectAll" },
        );
      } else if (params.selectionText.trim()) {
        items.push({ role: "copy" }, { type: "separator" }, { role: "selectAll" });
      }
      if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: win });
    });
  } catch {
    /* a broken context menu must never break the window */
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
  const icon = nativeImage.createFromPath(iconPath());
  // An unreadable/missing icon file yields an EMPTY nativeImage, and Electron
  // silently falls back to its own atom for an empty one — the exact outcome this
  // whole pass exists to end. Say so loudly instead of shipping a blank icon.
  if (icon.isEmpty()) diag("icon", `icon asset is empty or missing: ${iconPath()}`);
  // Resizing an .ico picks the closest embedded frame, so the 16px tray icon comes
  // from the 16px render rather than a downscaled 256.
  return size ? icon.resize({ width: size, height: size }) : icon;
}

/**
 * ⛔ THE RUNTIME HALF OF THE "the icon keeps disappearing" FIX.
 *
 * The real fix is in the build: `signAndEditExecutable: true` embeds the icon into
 * the .exe, so Windows resolves the right icon even when no window exists (see
 * scripts/verify-built-icon.ts). This is belt to that braces. Windows re-reads a
 * window's icon when the button is recreated — after a restore from the tray, a
 * DPI change, or an explorer.exe restart — and an Electron window that was created
 * with an icon it could not load keeps the empty one forever. Re-asserting on every
 * show/restore costs nothing and cannot be defeated by a stale cache.
 */
function pinWindowIcon(win: BrowserWindow): void {
  const apply = () => {
    if (win.isDestroyed()) return;
    const icon = createAppIcon();
    if (!icon.isEmpty()) win.setIcon(icon);
  };
  apply();
  win.on("show", apply);
  win.on("restore", apply);
  win.on("focus", apply);
  // ⛔⛔ THE TASKBAR BUTTON IS CREATED A BEAT AFTER THE WINDOW FIRST PAINTS, and a
  // setIcon that lands before that button exists is silently lost — Windows draws
  // the generic "document" icon and never refreshes it. Found live on Izzy's
  // machine (2026-08-23): the window reported valid HICONs (WM_GETICON non-zero)
  // yet the taskbar stayed blank. Re-assert on a short ladder after the first show
  // so the WM_SETICON reliably reaches the button once it is real. Cheap, idempotent.
  win.once("show", () => {
    for (const ms of [120, 400, 1200]) setTimeout(apply, ms);
  });
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
    title: "Loopcom",
    backgroundColor: "#07111f",
    icon: iconPath(),
    webPreferences: webPreferences("full"),
  });

  pinWindowIcon(fullWindow);
  attachConsoleCapture(fullWindow, "full");
  attachEditContextMenu(fullWindow);

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
    title: "Loopcom Mini Dialer",
    frame: false,
    resizable: true,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: "#07111f",
    icon: iconPath(),
    webPreferences: webPreferences("mini"),
  });

  pinWindowIcon(miniWindow);

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
  attachEditContextMenu(miniWindow);
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
    title: "Loopcom Phone Engine",
    backgroundColor: "#07111f",
    icon: iconPath(),
    webPreferences: webPreferences("phone-engine"),
  });

  pinWindowIcon(phoneEngineWindow);
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
    tray.setToolTip("Loopcom");
  }

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Loopcom", click: () => createFullWindow(true) },
    { label: "Open Mini Dialer", click: () => createMiniWindow(true) },
    {
      label: settings.alwaysOnTop ? "Turn Off Always On Top" : "Keep Mini Dialer On Top",
      click: () => toggleAlwaysOnTop(),
    },
    { type: "separator" },
    { label: "Check for Updates…", click: () => checkForUpdatesInteractive() },
    { type: "separator" },
    {
      label: "Quit Loopcom",
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

function showDesktopNotification(payload: DesktopNotificationPayload): boolean {
  if (!Notification.isSupported()) return false;

  const onClick = () => {
    if (payload.kind === "incoming-call") {
      showMiniForIncomingCall();
      return;
    }
    const win = createFullWindow(true);
    if (payload.route) loadPortal(win, payload.route);
  };

  // No `icon`: on Windows that is what draws the oversized inline image, and with
  // none Windows uses the app's own registered icon small at the top-left, which
  // is the layout we want anyway. This is also the win32 fallback below.
  const showPlain = () => {
    const note = new Notification({ title: payload.title, body: payload.body || "" });
    note.on("click", onClick);
    note.show();
  };

  if (process.platform !== "win32") {
    showPlain();
    return true;
  }

  try {
    const note = new Notification({ toastXml: buildWindowsToastXml(payload) });
    note.on("click", onClick);
    // A toast whose XML Windows refuses never appears at all, and a customer would
    // simply stop being told about voicemail with nothing in any log. Fall back to
    // the plain notification so the message always lands.
    note.on("failed", (_event, error) => {
      diag("notification", `toast failed (${payload.kind}): ${String(error)} — falling back to plain`);
      showPlain();
    });
    note.show();
    return true;
  } catch (err) {
    diag("notification", `toast threw (${payload.kind}): ${String(err)} — falling back to plain`);
    showPlain();
    return true;
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
  ipcMain.handle("desktop:notification", (_event, payload: DesktopNotificationPayload) => showDesktopNotification(payload));

  // Desk phone setup. ⛔ ONE channel, one allowlisted operation shape - the renderer
  // loads the hosted portal, so anything it can express is something a compromised
  // server could express too. Credentials live behind a reference in the OS keystore
  // and never cross this boundary.
  registerPhoneSetup({ ipcMain, safeStorage });

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
  // ⛔ THIS STRING MUST KEEP MATCHING `build.appId` IN package.json, AND MUST NOT
  // BE REBRANDED. Windows uses the AppUserModelID to decide which taskbar button
  // a window belongs to, which pinned entry it maps to, and which Start Menu
  // shortcut a toast notification is attributed to. electron-builder stamps the
  // appId onto the shortcut it creates; if this drifts from that, Windows cannot
  // resolve the app's identity and falls back to generic chrome — the taskbar
  // ungroups, pinning breaks, and notifications lose their name and icon. The
  // Connect->Loopcom rebrand changed the DISPLAY name (productName, shortcutName)
  // and deliberately left this identifier alone.
  app.setAppUserModelId("com.connectcommunications.desktop");
  // Before ANY window is created, or the first load goes out announcing Electron.
  try {
    const branded = brandedUserAgent(app.userAgentFallback, app.getVersion());
    app.userAgentFallback = branded;
    diag("main", `user agent: ${branded}`);
  } catch (err) {
    diag("main", `could not brand the user agent: ${String(err)}`);
  }
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
  // ⛔ The icon follows the OS light/dark toggle from this moment on: the watcher
  // fires once now and again on every nativeTheme "updated", swapping the tray
  // image and every live window's icon. Instantaneous — Chromium watches the
  // registry key, no polling, no restart.
  installThemeIconWatcher({
    nativeTheme,
    readSystemDark,
    log: (line) => diag("icon", line),
    applyIcons: () => {
      try {
        if (tray && !tray.isDestroyed()) tray.setImage(createAppIcon(16));
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue;
          const icon = createAppIcon();
          if (!icon.isEmpty()) win.setIcon(icon);
        }
      } catch (err) {
        diag("icon", `theme icon apply failed: ${String(err)}`);
      }
    },
  });
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

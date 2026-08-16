/**
 * Loopcom Support — the test build.
 *
 * ⛔ THIS IS NOT THE CONNECT APP. It is a separate program with its own
 * identity, its own settings folder and NO auto-updater, so that remote support
 * can be installed on a couple of machines and proven before it goes anywhere
 * near a customer's phone system. Installing this does not touch, upgrade or
 * replace Connect.
 *
 * It is deliberately much smaller than the Connect shell: one window, no tray,
 * no mini dialer, no SIP phone, no updater. It loads the same hosted portal and
 * supplies the three things a web page cannot do — enumerate real screens,
 * drive the real mouse and keyboard, and keep a banner above every other
 * window.
 */
import { app, BrowserWindow, desktopCapturer, Menu, session, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { registerRemoteSupportIpc, stopRemoteSupport, getPreferredSourceId } from "./remoteSupport/mainWiring";

const portalUrl = (process.env.CONNECT_PORTAL_URL || "https://app.connectcomunications.com").replace(/\/$/, "");
const preloadPath = path.join(__dirname, "preload.js");
const iconPath = path.join(__dirname, "..", "assets", "icon.png");

let mainWindow: BrowserWindow | null = null;

// ── Logging ─────────────────────────────────────────────────────────────────
// This is a test build whose whole purpose is finding out what goes wrong, so
// it logs more freely than the Connect app does. Its own folder, so nothing
// here can confuse a Connect diagnosis.
let logStream: fs.WriteStream | null = null;

function diag(tag: string, message: string): void {
  try {
    const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`;
    logStream?.write(line);
    console.log(line.trimEnd());
  } catch {
    /* never let logging throw */
  }
}

function initLogging(): void {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "support.log");
    try {
      if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no existing log yet */
    }
    logStream = fs.createWriteStream(file, { flags: "a" });
    diag("main", `=== Loopcom Support v${app.getVersion()} on ${process.platform} ===`);
    diag("main", `portal: ${portalUrl}`);
    diag("main", `logs:   ${dir}`);
  } catch {
    /* never let logging break startup */
  }
}

function createWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Loopcom Support",
    backgroundColor: "#07111f",
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.on("console-message", (...args: unknown[]) => {
    // Electron changed this signature across majors; handle both shapes.
    const d = (args[0] ?? {}) as Record<string, unknown>;
    const message = args.length >= 3 ? String(args[2] ?? "") : String(d.message ?? "");
    diag("renderer", message.slice(0, 500));
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    diag("renderer", `render-process-gone: ${details.reason} exit=${details.exitCode}`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    stopRemoteSupport();
    mainWindow = null;
  });

  // Right-click Cut/Copy/Paste — Electron shows no context menu unless the
  // shell builds one, and signing in needs a paste.
  mainWindow.webContents.on("context-menu", (_e, params) => {
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
    if (items.length > 0 && mainWindow) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

  const url = new URL("/", portalUrl);
  url.searchParams.set("desktop", "1");
  url.searchParams.set("support", "1");
  mainWindow.loadURL(url.toString());
  return mainWindow;
}

app.whenReady().then(() => {
  initLogging();
  app.setAppUserModelId("com.connectcommunications.supporttools");

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media" || permission === "notifications");
  });

  // ⛔ WITHOUT THIS, SCREEN SHARING SILENTLY DOES NOT WORK. Electron does not
  // implement getDisplayMedia on its own — the call hangs or rejects in the
  // renderer with nothing useful in the console. This is the single easiest
  // piece to leave out and then spend an afternoon debugging in the portal,
  // where the bug is not.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen", "window"] })
        .then((sources) => {
          const wanted = (request as any)?.preferredDisplaySurface;
          const chosen =
            sources.find((s) => s.id === getPreferredSourceId()) ||
            sources.find((s) => s.id === wanted) ||
            sources.find((s) => s.id.startsWith("screen:")) ||
            sources[0];
          if (!chosen) {
            diag("capture", "no screen sources available — refusing rather than sending a black frame");
            callback({ video: undefined, audio: undefined });
            return;
          }
          diag("capture", `sharing source ${chosen.id} (${chosen.name})`);
          // Audio is never captured: support needs to see the screen, not
          // listen to the room the customer is sitting in.
          callback({ video: chosen, audio: undefined });
        })
        .catch((err) => {
          diag("capture", `getSources failed: ${String(err)}`);
          callback({ video: undefined, audio: undefined });
        });
    },
    { useSystemPicker: false },
  );

  registerRemoteSupportIpc({
    onStopRequested: () => {
      diag("remote-support", "customer pressed Stop on the banner");
      stopRemoteSupport();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("remote-support:stop-requested");
      }
    },
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopRemoteSupport();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // ⛔ Tear down the input helper and the banner on the way out. Leaving a
  // helper process alive after the app has gone is something on a customer's
  // machine that can move their mouse and that nothing is watching.
  stopRemoteSupport();
});

/**
 * Main-process half of remote support.
 *
 * The split is deliberate: the portal page in the renderer already holds the
 * signed-in session, so it owns authentication, signalling and the peer
 * connection. This module does only the three things a web page cannot —
 * enumerate real screens, drive the real mouse and keyboard, and keep a band on
 * top of every other window saying what is happening.
 *
 * ⛔ NOTHING IN HERE STARTS BY ITSELF. Every entry point is the consequence of
 * the customer having answered a prompt. There is no timer, no autostart, and
 * no code path that begins capturing or injecting without a session id that the
 * renderer obtained by the customer saying yes.
 */
import { BrowserWindow, desktopCapturer, ipcMain, screen, app } from "electron";
import os from "node:os";
import path from "node:path";
import type { DesktopMachineInfo, DesktopScreenSource, RemoteSupportBannerState } from "../types";
import {
  PowerShellInputInjector,
  helperScriptPath,
  inputInjectionSupported,
  sanitizeCommand,
} from "./inputInjector";
import { localScannableSubnets, scanLan } from "./lanScan";

let injector: PowerShellInputInjector | null = null;
/** The session control was enabled for. Input for any other session is dropped. */
let controllingSessionId: string | null = null;
let bannerWindow: BrowserWindow | null = null;

/**
 * The screen the customer chose in the consent dialog.
 *
 * ⛔ Read by the display-media handler in main.ts. Without it, Electron would
 * pick a screen for them — which on a multi-monitor machine means sharing the
 * wrong one, and possibly the one with their personal email open.
 */
let preferredSourceId: string | null = null;

export function getPreferredSourceId(): string | null {
  return preferredSourceId;
}

/** Everything torn down together, so no state can outlive a session. */
export function stopRemoteSupport(): void {
  injector?.stop();
  injector = null;
  controllingSessionId = null;
  preferredSourceId = null;
  closeBanner();
}

function closeBanner(): void {
  if (bannerWindow && !bannerWindow.isDestroyed()) {
    bannerWindow.destroy();
  }
  bannerWindow = null;
}

/**
 * The banner.
 *
 * ⛔ THIS IS A SAFETY FEATURE, NOT DECORATION. The customer must be able to see,
 * at every moment and without switching windows, that their screen is being
 * watched and whether the other person can also type. It is always-on-top,
 * visible on every virtual desktop, and shown on all workspaces. It is
 * deliberately not closable except by the Stop button, which ends the session.
 */
function showBanner(state: RemoteSupportBannerState): void {
  if (!state.visible) {
    closeBanner();
    return;
  }

  if (bannerWindow && !bannerWindow.isDestroyed()) {
    bannerWindow.webContents.send("banner:update", state);
    return;
  }

  const primary = screen.getPrimaryDisplay();
  const width = Math.min(560, primary.workAreaSize.width - 40);

  bannerWindow = new BrowserWindow({
    width,
    height: 60,
    x: Math.round(primary.workArea.x + (primary.workAreaSize.width - width) / 2),
    y: primary.workArea.y + 12,
    frame: false,
    transparent: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // ⛔ Focusable on purpose. A non-focusable window on Windows does not
    // reliably receive clicks, and a Stop button that sometimes ignores the
    // customer is worse than no button at all.
    focusable: true,
    backgroundColor: "#7f1d1d",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "bannerPreload.js"),
    },
  });

  // "screen-saver" is the highest level available and keeps the band above
  // full-screen applications — a banner that a maximised window can cover is
  // not a banner.
  bannerWindow.setAlwaysOnTop(true, "screen-saver");
  bannerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  bannerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bannerHtml(state))}`);
}

function bannerHtml(state: RemoteSupportBannerState): string {
  const who = state.supportName ? escapeHtml(state.supportName) : "Loopcom support";
  const what = state.controlGranted
    ? `${who} can see and control your screen`
    : `${who} can see your screen`;
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;font-family:Segoe UI,system-ui,sans-serif;}
  body{display:flex;align-items:center;gap:12px;padding:0 14px;background:#7f1d1d;color:#fff;
       border:2px solid #fca5a5;border-radius:10px;box-sizing:border-box;-webkit-app-region:drag;}
  .dot{width:10px;height:10px;border-radius:50%;background:#fca5a5;flex:none;
       animation:pulse 1.6s ease-in-out infinite;}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .text{flex:1;font-size:13px;line-height:1.3;}
  .sub{opacity:.85;font-size:11px;}
  button{-webkit-app-region:no-drag;background:#fff;color:#7f1d1d;border:0;border-radius:6px;
         padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;}
  button:hover{background:#fee2e2;}
</style>
<div class="dot"></div>
<div class="text"><div id="what">${what}</div><div class="sub">You can stop this at any time.</div></div>
<button id="stop">Stop sharing</button>
<script>
  // connectBanner comes from bannerPreload.js. Guarded so that if the preload
  // ever failed to load, the button is visibly broken rather than silently
  // doing nothing — a Stop button that appears to work and does not is the
  // worst possible failure for this particular window.
  var btn = document.getElementById('stop');
  if (window.connectBanner) {
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Stopping…';
      window.connectBanner.stop();
    });
    window.connectBanner.onUpdate(function (state) {
      document.getElementById('what').textContent =
        (state && state.supportName ? state.supportName : 'Loopcom support') +
        (state && state.controlGranted ? ' can see and control your screen' : ' can see your screen');
    });
  } else {
    btn.textContent = 'Stop unavailable';
    btn.disabled = true;
  }
</script>`;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

export function registerRemoteSupportIpc(options: {
  /** Called when the customer presses Stop on the banner. */
  onStopRequested: () => void;
}): void {
  /**
   * Screens available to share. Thumbnails are included so the customer sees
   * exactly what they are about to reveal before they agree to it.
   */
  ipcMain.handle("remote-support:list-screens", async (): Promise<DesktopScreenSource[]> => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnailDataUrl: s.thumbnail?.toDataURL?.() || "",
      isScreen: s.id.startsWith("screen:"),
    }));
  });

  /**
   * Which screen the customer picked. Set before capture starts; cleared when
   * the session ends so a later session can never inherit an old choice.
   */
  ipcMain.handle("remote-support:set-screen", (_event, sourceId: unknown) => {
    preferredSourceId = String(sourceId || "") || null;
  });

  ipcMain.handle("remote-support:machine-info", (): DesktopMachineInfo => ({
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    appVersion: app.getVersion(),
    username: os.userInfo().username,
  }));

  /**
   * Start input injection.
   *
   * ⛔ Returns false rather than throwing when injection is unavailable, and
   * the caller MUST surface that. A control session where nothing moves reads
   * to both people as a broken product; "controlling is not available on this
   * computer" is a fact somebody can act on.
   */
  ipcMain.handle("remote-support:enable-control", (_event, sessionId: unknown): boolean => {
    const id = String(sessionId || "");
    if (!id) return false;
    if (!inputInjectionSupported()) return false;

    if (injector && controllingSessionId === id) return injector.available;

    // Never leave a previous session's helper running.
    injector?.stop();
    injector = new PowerShellInputInjector(helperScriptPath(app.getPath("userData")));
    const started = injector.start(() => {
      // If the helper dies mid-session, control is over. Fail closed and let
      // the renderer notice rather than silently dropping every event.
      controllingSessionId = null;
      injector = null;
    });
    controllingSessionId = started ? id : null;
    return started;
  });

  ipcMain.handle("remote-support:disable-control", () => {
    injector?.stop();
    injector = null;
    controllingSessionId = null;
  });

  /**
   * One input event.
   *
   * ⛔ Three gates, and all three matter: control must be enabled, the event
   * must name the session control was enabled for, and the payload must survive
   * sanitising. The session check is what stops a stale renderer from a finished
   * session still moving the mouse.
   */
  ipcMain.on("remote-support:input", (_event, raw: unknown) => {
    if (!injector || !controllingSessionId) return;
    const envelope = (raw ?? {}) as Record<string, unknown>;
    if (String(envelope.sessionId || "") !== controllingSessionId) return;

    const command = sanitizeCommand(envelope.command);
    if (!command) return;
    injector.send(command);
  });

  ipcMain.handle("remote-support:set-banner", (_event, state: RemoteSupportBannerState) => {
    showBanner(state || { visible: false });
  });

  // The banner's Stop button posts here through its own tiny bridge.
  ipcMain.on("remote-support:banner-stop", () => {
    options.onStopRequested();
  });

  // ── LAN phone discovery ───────────────────────────────────────────────────
  ipcMain.handle("lan-scan:subnets", () => localScannableSubnets());
  ipcMain.handle("lan-scan:run", async () => {
    try {
      return await scanLan();
    } catch (err) {
      // Honest failure beats an empty list that reads as "no phones here".
      return {
        subnet: null,
        hostsSeen: 0,
        hosts: [],
        outcome: "failed" as const,
        note: `The scan could not run: ${(err as Error)?.message || "unknown error"}`,
      };
    }
  });
}

/** Exposed for the app's own shutdown path. */
export function remoteSupportIsControlling(): boolean {
  return Boolean(injector && controllingSessionId);
}

export { helperScriptPath, path };

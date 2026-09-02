/**
 * Main-process half of remote support, inside the app customers actually have.
 *
 * Lifted from `apps/desktop-support` — a second Electron app that was built to
 * prove this and was never shipped. Nothing about the mechanism changed in the
 * move; what changed is where it lives, and therefore what else is in the
 * process with it. Two things were deliberately NOT carried over:
 *
 *   - the LAN scanner, because this app already has one under `phoneSetup/`
 *     and two scanners in one process is two answers to the same question;
 *   - the `support:minimize` / `support:notification` stubs, which existed only
 *     because that app had no real window or notification handling. This one
 *     does, and they are registered in main.ts.
 *
 * The split with the renderer is unchanged and is the reason this file is
 * small: the portal page already holds the signed-in session, so it owns
 * authentication, signalling and the peer connection. This module does only the
 * three things a web page cannot — enumerate real screens, drive the real mouse
 * and keyboard, and keep a band on top of every other window saying what is
 * happening.
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
  ElevatedInputInjector,
  elevatedHelperScriptPath,
  type InputInjector,
  helperScriptPath,
  inputInjectionSupported,
  sanitizeCommand,
} from "./inputInjector";

let injector: InputInjector | null = null;
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
    // The desktop-mode ask adds a second row; give it room rather than clipping it.
    try {
      const [w] = bannerWindow.getSize();
      bannerWindow.setSize(w, state.ask ? 108 : 60);
    } catch { /* window going away */ }
    return;
  }

  const primary = screen.getPrimaryDisplay();
  const width = Math.min(state.mode === "desktop" ? 640 : 560, primary.workAreaSize.width - 40);

  bannerWindow = new BrowserWindow({
    width,
    height: state.ask ? 108 : 60,
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

/**
 * The sentence the banner shows.
 *
 * Support mode: "<who> can see (and control) your screen". Desktop mode
 * (2026-09-02): "<who> is connected from <where>", with the audio routing
 * beside it, because the person at the machine may be the owner's own family and
 * "sound → their computer" is the fact that explains the silence.
 */
function bannerSentence(state: RemoteSupportBannerState): { what: string; sub: string } {
  const who = state.supportName ? escapeHtml(state.supportName) : (state.mode === "desktop" ? "Someone" : "Loopcom support");
  if (state.mode === "desktop") {
    const from = state.fromLabel ? ` from ${escapeHtml(state.fromLabel)}` : "";
    const what = `${who} is connected${from}`;
    const bits = [state.controlGranted ? "view and control" : "view only"];
    if (state.audioNote) bits.push(escapeHtml(state.audioNote));
    return { what, sub: bits.join(" · ") };
  }
  return {
    what: state.controlGranted ? `${who} can see and control your screen` : `${who} can see your screen`,
    sub: "You can stop this at any time.",
  };
}

function bannerHtml(state: RemoteSupportBannerState): string {
  const { what, sub } = bannerSentence(state);
  const stopLabel = state.mode === "desktop" ? "Stop" : "Stop sharing";
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;font-family:Segoe UI,system-ui,sans-serif;}
  body{display:flex;flex-direction:column;justify-content:center;gap:8px;padding:0 14px;background:#7f1d1d;color:#fff;
       border:2px solid #fca5a5;border-radius:10px;box-sizing:border-box;-webkit-app-region:drag;}
  .row{display:flex;align-items:center;gap:12px;}
  .ask{display:none;align-items:center;gap:10px;background:rgba(255,255,255,.1);border-radius:8px;padding:6px 10px;font-size:12.5px;}
  .ask.on{display:flex;}
  .ask span{flex:1;}
  .ask button{padding:5px 11px;}
  .ask .yes{background:#22a8ff;color:#fff;}
  .dot{width:10px;height:10px;border-radius:50%;background:#fca5a5;flex:none;
       animation:pulse 1.6s ease-in-out infinite;}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .text{flex:1;font-size:13px;line-height:1.3;}
  .sub{opacity:.85;font-size:11px;}
  button{-webkit-app-region:no-drag;background:#fff;color:#7f1d1d;border:0;border-radius:6px;
         padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;}
  button:hover{background:#fee2e2;}
</style>
<div class="row">
  <div class="dot"></div>
  <div class="text"><div id="what">${what}</div><div class="sub" id="sub">${sub}</div></div>
  <button id="stop">${stopLabel}</button>
</div>
<div class="ask" id="ask"><span id="askText"></span><button id="no">No</button><button id="yes" class="yes">Yes, allow</button></div>
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
    var askCap = null;
    document.getElementById('no').addEventListener('click', function () { if (askCap) window.connectBanner.answer(askCap, false); askCap = null; document.getElementById('ask').className = 'ask'; });
    document.getElementById('yes').addEventListener('click', function () { if (askCap) window.connectBanner.answer(askCap, true); askCap = null; document.getElementById('ask').className = 'ask'; });
    window.connectBanner.onUpdate(function (state) {
      state = state || {};
      var who = state.supportName ? state.supportName : (state.mode === 'desktop' ? 'Someone' : 'Loopcom support');
      if (state.mode === 'desktop') {
        document.getElementById('what').textContent = who + ' is connected' + (state.fromLabel ? ' from ' + state.fromLabel : '');
        var bits = [state.controlGranted ? 'view and control' : 'view only'];
        if (state.audioNote) bits.push(state.audioNote);
        document.getElementById('sub').textContent = bits.join(' · ');
        btn.textContent = 'Stop';
      } else {
        document.getElementById('what').textContent = who + (state.controlGranted ? ' can see and control your screen' : ' can see your screen');
        document.getElementById('sub').textContent = 'You can stop this at any time.';
      }
      // ⛔ "No" is a real, equal button. Nothing is granted unless Yes is pressed.
      if (state.ask && state.ask.capability) {
        askCap = String(state.ask.capability);
        document.getElementById('askText').textContent = state.ask.text || 'They are asking for more access.';
        document.getElementById('ask').className = 'ask on';
      } else {
        askCap = null;
        document.getElementById('ask').className = 'ask';
      }
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
  /** Diagnostics sink. Optional so an older main.ts keeps compiling. */
  log?: (line: string) => void;
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
    const plainInjector = new PowerShellInputInjector(helperScriptPath(app.getPath("userData")));
    injector = plainInjector;
    const started = plainInjector.start((reason) => {
      // If the helper dies mid-session, control is over. Fail closed and let
      // the renderer notice rather than silently dropping every event. The
      // reason carries the helper's last stderr, which is how "antivirus killed
      // it" is told apart from "it crashed" after the fact.
      options.log?.(`input helper stopped: ${reason}`);
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
   * Administrator access (2026-09-02): swap the input helper for one started
   * through Windows' own elevation prompt, so the technician can act on
   * elevated windows. Resolves true only once the customer has accepted the
   * UAC prompt and the elevated helper is really taking commands.
   *
   * ⛔ Only for the session control is ALREADY enabled for. Elevation is an
   * upgrade of a consented control session, never a way to obtain control.
   * ⛔ The plain helper is stopped only AFTER the elevated one is up — a
   * declined prompt must leave ordinary control exactly as it was.
   */
  ipcMain.handle("remote-support:enable-elevated-control", async (_event, sessionId: unknown): Promise<boolean> => {
    const id = String(sessionId || "");
    if (!id || !inputInjectionSupported()) return false;
    if (!injector || controllingSessionId !== id) return false;
    if (injector instanceof ElevatedInputInjector) return injector.available;

    const elevated = new ElevatedInputInjector(elevatedHelperScriptPath(app.getPath("userData")));
    const ok = await elevated.start((reason) => {
      options.log?.(`elevated input helper stopped: ${reason}`);
      // Fail closed: when the elevated helper dies, control is over for this
      // session. The technician sees their clicks stop and asks again.
      if (injector === elevated) {
        injector = null;
        controllingSessionId = null;
      }
    });
    if (!ok) {
      options.log?.("elevated input helper did not start (prompt declined or timed out)");
      return false;
    }
    const plain = injector;
    injector = elevated;
    try { plain?.stop(); } catch { /* already gone */ }
    options.log?.("input helper is elevated for this session");
    return true;
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

  // The banner's yes/no answer to a mid-session ask (Remote Desktop). Forwarded
  // to every window; the one that owns the session turns it into the server
  // call. Carries only a capability name and a boolean.
  ipcMain.on("remote-support:banner-answer", (_event, raw: unknown) => {
    const body = (raw ?? {}) as { capability?: unknown; allow?: unknown };
    const payload = { capability: String(body.capability || "").slice(0, 32), allow: body.allow === true };
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send("remote-support:banner-answer", payload); } catch { /* going away */ }
    }
  });
}

/** Exposed for the app's own shutdown path. */
export function remoteSupportIsControlling(): boolean {
  return Boolean(injector && controllingSessionId);
}

/**
 * The always-on-top floating Coworker bubble — Electron wiring.
 *
 * ⛔ ADDITIVE AND FAILURE-ISOLATED. This module owns ONE small frameless window and
 * a handful of IPC handlers. Everything it does is wrapped so that a fault here can
 * never take down the phone: `createCoworkerWidget` is called inside a try/catch in
 * main.ts, and every handler swallows its own errors to a diag line. The calling
 * app is priority #1; a decorative bubble is not allowed to threaten it.
 *
 * ⛔ ALL GEOMETRY LIVES IN widgetGeometry.ts (pure, tested). This file only turns
 * those decisions into Electron calls. No click-vs-drag maths, no clamp maths here.
 */

import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow as BW, IpcMain, Screen, App } from "electron";
import {
  WIDGET_SIZE, CHAT_WIDTH, CHAT_HEIGHT,
  resolveStartPosition, chatPositionFor, type Point, type Rect,
} from "./widgetGeometry";

export type WidgetBadge = "none" | "unread" | "working";

export type WidgetDeps = {
  BrowserWindow: typeof BW;
  ipcMain: IpcMain;
  screen: Screen;
  app: App;
  assetPath: (file: string) => string;
  preloadPath: string;
  /** Open the full portal on a route (reuses the existing main-process helper). */
  openFullRoute: (route: string) => void;
  /** Read/write the widget's saved position + enabled flag via desktop settings. */
  getSaved: () => { position?: Point | null; enabled?: boolean };
  setSaved: (next: { position?: Point; enabled?: boolean }) => void;
  log: (line: string) => void;
};

/** The portal route the chat panel loads — the EXISTING assistant, not a new one. */
const CHAT_ROUTE = "/assistant?widget=1";

let widgetWindow: BW | null = null;
let chatWindow: BW | null = null;
let deps: WidgetDeps | null = null;

function primaryWorkArea(): Rect {
  const wa = deps!.screen.getPrimaryDisplay().workArea;
  return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
}
function allWorkAreas(): Rect[] {
  return deps!.screen.getAllDisplays().map((d) => ({ x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height }));
}

/**
 * Create (or reveal) the floating bubble. Safe to call repeatedly.
 *
 * ⛔ Returns null and logs rather than throwing on any failure — the caller in
 * main.ts must never have to guard a phone-critical boot path against this.
 */
export function createCoworkerWidget(d: WidgetDeps): BW | null {
  deps = d;
  try {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.show();
      return widgetWindow;
    }

    const saved = d.getSaved();
    if (saved.enabled === false) return null; // user switched it off

    const start = resolveStartPosition(saved.position ?? null, primaryWorkArea(), allWorkAreas());

    widgetWindow = new d.BrowserWindow({
      width: WIDGET_SIZE,
      height: WIDGET_SIZE,
      x: start.x,
      y: start.y,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true, // it lives on top of everything, not in the taskbar
      alwaysOnTop: true,
      // ⛔ focusable STAYS TRUE, deliberately. `focusable: false` is the obvious
      // choice for a passive bubble and it breaks the thing the bubble is for:
      // on Windows a non-focusable window does not reliably receive the drag that
      // `-webkit-app-region: drag` depends on, so the user could not move it.
      //
      // The "never steal focus" requirement is about BACKGROUND WORK, not about a
      // button the user deliberately clicks. That property is preserved by
      // showInactive() below — the bubble appears, and returns after a restart,
      // without ever pulling focus off what the user is typing into.
      focusable: true,
      hasShadow: false,
      webPreferences: {
        preload: d.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // A 64px decorative window has no reason to keep full CPU when hidden.
        backgroundThrottling: true,
        additionalArguments: ["--connect-window-kind=coworker-widget"],
      },
    });

    // Float above ordinary always-on-top windows (like the mini dialer) so the
    // bubble is reachable, but never over a fullscreen app's own UI.
    widgetWindow.setAlwaysOnTop(true, "floating");
    widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

    const html = d.assetPath("coworkerWidget.html");
    if (!fs.existsSync(html)) {
      d.log(`coworker widget asset missing: ${html}`);
      widgetWindow.destroy();
      widgetWindow = null;
      return null;
    }
    widgetWindow.loadFile(html);
    // ⛔ showInactive, not show — appear without taking focus from the user's work.
    widgetWindow.once("ready-to-show", () => widgetWindow?.showInactive());

    // Persist the position when the user finishes dragging it.
    const persist = () => {
      if (!widgetWindow || widgetWindow.isDestroyed()) return;
      const [x, y] = widgetWindow.getPosition();
      d.setSaved({ position: { x, y } });
    };
    widgetWindow.on("moved", persist);

    widgetWindow.on("closed", () => {
      widgetWindow = null;
    });

    return widgetWindow;
  } catch (err) {
    d.log(`coworker widget failed to create: ${String(err)}`);
    return null;
  }
}

/** Open the compact chat panel anchored to the bubble. */
function openChatPanel(): void {
  const d = deps;
  if (!d) return;
  try {
    // Prefer the compact anchored panel. If it already exists, just focus it.
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show();
      chatWindow.focus();
      return;
    }

    const widgetPos: Point = widgetWindow && !widgetWindow.isDestroyed()
      ? (() => { const [x, y] = widgetWindow!.getPosition(); return { x, y }; })()
      : { x: primaryWorkArea().x + primaryWorkArea().width - WIDGET_SIZE - 24, y: primaryWorkArea().y + 100 };

    const at = chatPositionFor(widgetPos, primaryWorkArea());

    chatWindow = new d.BrowserWindow({
      width: CHAT_WIDTH,
      height: CHAT_HEIGHT,
      x: at.x,
      y: at.y,
      frame: false,
      resizable: true,
      minWidth: 340,
      minHeight: 420,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: "Loopcom Coworker",
      backgroundColor: "#07111f",
      webPreferences: {
        preload: d.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // loads the hosted portal, same posture as the mini window
        backgroundThrottling: false,
        additionalArguments: ["--connect-window-kind=coworker-chat"],
      },
    });

    chatWindow.setAlwaysOnTop(true, "floating");
    // ⛔ Load the EXISTING portal assistant. This is not a second chatbot; it is the
    // same agent the /assistant page uses, in a compact frame.
    const url = new URL(CHAT_ROUTE, portalOrigin(d));
    url.searchParams.set("desktop", "1");
    chatWindow.loadURL(url.toString());

    // Any link the assistant tries to open in a new window goes to the OS browser,
    // never a nested Electron window (matches the full window's handler).
    chatWindow.webContents.setWindowOpenHandler(({ url: target }) => {
      try { require("electron").shell.openExternal(target); } catch { /* ignore */ }
      return { action: "deny" };
    });

    // Close on blur so it behaves like a popover, not a second app window. ⛔ but
    // NOT while devtools is open (that would make debugging impossible).
    chatWindow.on("blur", () => {
      if (chatWindow && !chatWindow.isDestroyed() && !chatWindow.webContents.isDevToolsOpened()) {
        chatWindow.hide();
      }
    });
    chatWindow.on("closed", () => { chatWindow = null; });
  } catch (err) {
    d.log(`coworker chat panel failed: ${String(err)}`);
    // ⛔ Fall back to the full portal assistant rather than leaving a dead click.
    try { d.openFullRoute("/assistant"); } catch { /* nothing more we can do */ }
  }
}

function portalOrigin(d: WidgetDeps): string {
  // Mirror main.ts's portalUrl resolution without importing it (keeps this module
  // free of a circular dependency on main).
  return (process.env.CONNECT_PORTAL_URL || "https://app.connectcomunications.com").replace(/\/$/, "");
}

/** Push a badge state to the bubble (unread reply, working, or clear). */
export function setWidgetBadge(state: WidgetBadge): void {
  try {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.webContents.send("coworker-widget:badge", state);
    }
  } catch (err) {
    deps?.log(`coworker widget badge failed: ${String(err)}`);
  }
}

export function destroyCoworkerWidget(): void {
  try {
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.destroy();
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.destroy();
  } catch { /* teardown is best-effort */ }
  chatWindow = null;
  widgetWindow = null;
}

export function isCoworkerWidgetOpen(): boolean {
  return Boolean(widgetWindow && !widgetWindow.isDestroyed());
}

/**
 * Register the widget's IPC once, at startup. ⛔ Idempotent-safe: the caller guards
 * against double registration, and every handler is wrapped.
 */
export function registerCoworkerWidgetIpc(d: WidgetDeps): void {
  deps = d;
  d.ipcMain.on("coworker-widget:open-chat", () => {
    try { openChatPanel(); } catch (err) { d.log(`open-chat failed: ${String(err)}`); }
  });
  d.ipcMain.handle("coworker-widget:set-enabled", (_e, enabled: boolean) => {
    try {
      d.setSaved({ enabled: !!enabled });
      if (enabled) createCoworkerWidget(d);
      else destroyCoworkerWidget();
      return { ok: true, enabled: !!enabled };
    } catch (err) {
      d.log(`set-enabled failed: ${String(err)}`);
      return { ok: false };
    }
  });
  d.ipcMain.handle("coworker-widget:is-open", () => isCoworkerWidgetOpen());
}

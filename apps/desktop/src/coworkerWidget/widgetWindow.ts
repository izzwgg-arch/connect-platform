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
 *
 * ⛔⛔ THE DRAG IS DRIVEN FROM HERE, NOT BY `-webkit-app-region: drag` — and that is
 * the whole reason the first build of this bubble was DEAD (2026-09-02). On Windows
 * an element marked as an app-region drag handle is handled by the OS as the window
 * caption: the renderer never receives its mousedown/mouseup, so the click-vs-drag
 * JS in the bubble never ran and a click opened nothing. It DID drag (the saved
 * position on Izzy's machine proved it), which is exactly what made it look like a
 * click-handler bug rather than what it was.
 *
 * Now the bubble's renderer reports pointer down / up over IPC, and this module
 * reads the REAL cursor from `screen.getCursorScreenPoint()` on a timer (never a
 * coordinate the renderer sends — a transparent window at a fractional DPR can
 * disagree with the OS by a pixel or two) and moves the window itself. A press
 * that never travels past the slop radius is a click and opens the chat.
 */

import fs from "node:fs";
import type { BrowserWindow as BW, IpcMain, Screen, App } from "electron";
import {
  WIDGET_SIZE, CHAT_WIDTH, CHAT_HEIGHT,
  resolveStartPosition, chatPositionFor, beginDrag, dragTo, isClick, workAreaContaining,
  type Point, type Rect, type DragSession,
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
  /**
   * Capture a window's console + renderer crashes into the diag log. Optional so
   * tests can omit it; main.ts passes its attachConsoleCapture. Without it, "the
   * widget does nothing" is undiagnosable from the log — the dead first build
   * produced ZERO coworker lines, because success and a swallowed click both log
   * nothing.
   */
  attachDiag?: (win: BW, tag: string) => void;
};

/**
 * The portal route the chat panel loads.
 *
 * ⛔ `/desktop/coworker`, NOT `/assistant`. `/assistant` is the OWNER CONSOLE
 * (provider self-tests, model picker, capability list — SUPER_ADMIN's screen), and it
 * renders inside the full console shell with a sidebar, which in a 400px popover is
 * unusable. `/desktop/coworker` is the customer-facing assistant (the same
 * FloatingAssistant panel every portal page carries) docked to fill the window, and
 * it lives under `/desktop/` so the portal treats the window as a passive desktop
 * window: no login redirect, no second SIP phone, waits for the main window's token.
 */
export const CHAT_ROUTE = "/desktop/coworker";

/**
 * A bubble click that lands within this many ms of the chat window HIDING ON BLUR
 * is the click that caused the blur — the user pressed the bubble to close the chat.
 * Without this, every click on the bubble while the chat is open would hide it
 * (blur) and immediately re-show it (click), so the chat could never be closed
 * from the bubble.
 */
export const BLUR_CLICK_GRACE_MS = 400;

/** How often the main process re-reads the cursor while the bubble is held. */
const DRAG_TICK_MS = 16;
/** A press held longer than this with no release is abandoned, never a leak. */
const DRAG_MAX_MS = 30_000;

let widgetWindow: BW | null = null;
let chatWindow: BW | null = null;
let deps: WidgetDeps | null = null;
let drag: DragSession | null = null;
let dragTimer: ReturnType<typeof setInterval> | null = null;
let dragStartedAt = 0;
let chatHiddenByBlurAt = 0;

function primaryWorkArea(): Rect {
  const wa = deps!.screen.getPrimaryDisplay().workArea;
  return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
}
function allWorkAreas(): Rect[] {
  return deps!.screen.getAllDisplays().map((d) => ({ x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height }));
}
function cursor(): Point {
  const p = deps!.screen.getCursorScreenPoint();
  return { x: p.x, y: p.y };
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
      // focusable stays true: a button the user deliberately presses may take focus.
      // The "never steal focus" requirement is about BACKGROUND WORK, and that is
      // preserved by showInactive() below — the bubble appears, and returns after a
      // restart, without pulling focus off what the user is typing into.
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
    d.attachDiag?.(widgetWindow, "coworker-widget");

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

    widgetWindow.on("closed", () => {
      widgetWindow = null;
      stopDragTimer();
      drag = null;
    });

    d.log(`bubble shown at ${start.x},${start.y}`);
    return widgetWindow;
  } catch (err) {
    d.log(`coworker widget failed to create: ${String(err)}`);
    return null;
  }
}

// ── Drag, driven by the main process ──────────────────────────────────

function stopDragTimer(): void {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
}

function onDragStart(): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const [x, y] = widgetWindow.getPosition();
  drag = beginDrag({ x, y }, cursor());
  dragStartedAt = Date.now();
  stopDragTimer();
  // ⛔ A timer, not a dependency on the renderer's pointermove: once the window is
  // moving under the pointer the renderer's client coordinates barely change, so
  // it may see few or no move events. The main process reads the cursor itself.
  dragTimer = setInterval(() => {
    try {
      if (!drag) { stopDragTimer(); return; }
      if (Date.now() - dragStartedAt > DRAG_MAX_MS) {
        deps?.log("drag abandoned after 30s with no release");
        onDragEnd();
        return;
      }
      onDragMove();
    } catch (err) {
      deps?.log(`drag tick failed: ${String(err)}`);
      stopDragTimer();
    }
  }, DRAG_TICK_MS);
}

function onDragMove(): void {
  if (!drag || !widgetWindow || widgetWindow.isDestroyed()) return;
  const now = cursor();
  // Nothing to do until the press has really travelled — a click must not nudge.
  if (isClick(drag.startCursor, now)) return;
  // Clamp to the display the CURSOR is on, so the bubble can be carried across
  // monitors instead of being pinned to the primary screen's work area.
  const wa = workAreaContaining(now, allWorkAreas(), primaryWorkArea());
  const next = dragTo(drag.origin, drag.grabOffset, now, wa);
  const [cx, cy] = widgetWindow.getPosition();
  if (cx !== next.x || cy !== next.y) widgetWindow.setPosition(next.x, next.y, false);
}

function onDragEnd(): void {
  const session = drag;
  drag = null;
  stopDragTimer();
  if (!session || !widgetWindow || widgetWindow.isDestroyed()) return;
  const end = cursor();
  if (isClick(session.startCursor, end)) {
    toggleChatPanel();
    return;
  }
  // A real drag: settle exactly where the last tick put it, and remember it.
  const [x, y] = widgetWindow.getPosition();
  deps?.setSaved({ position: { x, y } });
  deps?.log(`bubble moved to ${x},${y}`);
}

// ── The chat panel ────────────────────────────────────────────────────

function chatIsShowing(): boolean {
  return Boolean(chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible());
}

/** Bubble click: open the chat, or close it if it is the thing that was open. */
function toggleChatPanel(): void {
  const d = deps;
  if (!d) return;
  try {
    if (chatIsShowing()) {
      hideChatPanel();
      return;
    }
    // The click that hides an open chat arrives AFTER the blur that hid it. Treat
    // that click as "close", not "open again".
    if (Date.now() - chatHiddenByBlurAt < BLUR_CLICK_GRACE_MS) {
      d.log("bubble click closed the chat");
      return;
    }
    openChatPanel();
  } catch (err) {
    d.log(`toggle chat failed: ${String(err)}`);
  }
}

function hideChatPanel(): void {
  try {
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.hide();
  } catch (err) {
    deps?.log(`hide chat failed: ${String(err)}`);
  }
}

/** Open the compact chat panel anchored to the bubble. */
function openChatPanel(): void {
  const d = deps;
  if (!d) return;
  try {
    // Prefer the compact anchored panel. If it already exists, just show it.
    if (chatWindow && !chatWindow.isDestroyed()) {
      placeChatBesideBubble(chatWindow);
      chatWindow.show();
      chatWindow.focus();
      // Logged too: the first live run showed one "opened" and three "closed"
      // lines because re-shows were silent, which read like the toggle was broken.
      d.log("chat panel shown again");
      return;
    }

    const at = chatAnchor();

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
      show: false,
      webPreferences: {
        preload: d.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // loads the hosted portal, same posture as the mini window
        backgroundThrottling: false,
        additionalArguments: ["--connect-window-kind=coworker-chat"],
      },
    });
    d.attachDiag?.(chatWindow, "coworker-chat");

    chatWindow.setAlwaysOnTop(true, "floating");
    // ⛔ Load the customer assistant docked into this window (see CHAT_ROUTE). This
    // is not a second chatbot; it is the same agent the portal's corner bubble opens.
    const url = new URL(CHAT_ROUTE, portalOrigin());
    chatWindow.loadURL(url.toString());
    chatWindow.once("ready-to-show", () => {
      if (!chatWindow || chatWindow.isDestroyed()) return;
      chatWindow.show();
      chatWindow.focus();
    });

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
        chatHiddenByBlurAt = Date.now();
        chatWindow.hide();
      }
    });
    chatWindow.on("closed", () => { chatWindow = null; });
    d.log("chat panel opened");
  } catch (err) {
    d.log(`coworker chat panel failed: ${String(err)}`);
    // ⛔ Fall back to the full portal on the same route rather than leaving a dead click.
    try { d.openFullRoute(CHAT_ROUTE); } catch { /* nothing more we can do */ }
  }
}

function chatAnchor(): Point {
  const widgetPos: Point = widgetWindow && !widgetWindow.isDestroyed()
    ? (() => { const [x, y] = widgetWindow!.getPosition(); return { x, y }; })()
    : { x: primaryWorkArea().x + primaryWorkArea().width - WIDGET_SIZE - 24, y: primaryWorkArea().y + 100 };
  const wa = workAreaContaining(widgetPos, allWorkAreas(), primaryWorkArea());
  return chatPositionFor(widgetPos, wa);
}

/** A re-shown chat follows the bubble to wherever it was dragged since. */
function placeChatBesideBubble(win: BW): void {
  try {
    const at = chatAnchor();
    win.setPosition(at.x, at.y, false);
  } catch (err) {
    deps?.log(`chat reposition failed: ${String(err)}`);
  }
}

function portalOrigin(): string {
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
  stopDragTimer();
  drag = null;
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
  d.ipcMain.on("coworker-widget:close-chat", () => {
    try { hideChatPanel(); } catch (err) { d.log(`close-chat failed: ${String(err)}`); }
  });
  d.ipcMain.on("coworker-widget:drag-start", () => {
    try { onDragStart(); } catch (err) { d.log(`drag-start failed: ${String(err)}`); }
  });
  d.ipcMain.on("coworker-widget:drag-move", () => {
    try { onDragMove(); } catch (err) { d.log(`drag-move failed: ${String(err)}`); }
  });
  d.ipcMain.on("coworker-widget:drag-end", () => {
    try { onDragEnd(); } catch (err) { d.log(`drag-end failed: ${String(err)}`); }
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

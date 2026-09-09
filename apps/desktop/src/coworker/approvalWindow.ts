/**
 * The approval prompt and the Connections window — the two local pages the
 * Coworker shows, both packaged with the app (assets/*.html) so they need no
 * portal deploy and work offline.
 *
 * ⛔ THE APPROVAL WINDOW IS THE ONLY PLACE A "yes" COMES FROM. It is a small
 * always-on-top window the main process creates, with a preload bridge that
 * carries exactly two verbs back: approve / deny, bound to the call id it was
 * shown for. The hosted portal page cannot approve on the person's behalf, and
 * neither can the server. Keyboard: Enter = Allow, Esc = Don't allow.
 *
 * ⛔ It is shown with showInactive() when the person is typing elsewhere? No —
 * an approval is a question TO the person, so it may take focus; but it never
 * moves the mouse, never types, and closes itself on an answer, a cancel, or
 * the 5-minute timeout.
 */
import type { BrowserWindow as BW, IpcMain, Screen } from "electron";
import fs from "node:fs";
import type { ApprovalRequest } from "./runtime";
import type { Point, Rect } from "../coworkerWidget/widgetGeometry";

export type ApprovalDeps = {
  BrowserWindow: typeof BW;
  ipcMain: IpcMain;
  screen: Screen;
  assetPath: (file: string) => string;
  preloadPath: string;
  log: (line: string) => void;
  attachDiag?: (win: BW, tag: string) => void;
  /** The chat panel's bounds while it is showing — the prompt lands beside it, on ITS display. */
  anchor?: () => Rect | null;
  /** Fired after every answer, close, cancel or timeout — main hands the chat its focus back. */
  onSettled?: (r: { callId: string; approved: boolean; how: string }) => void;
};

export const APPROVAL_WIDTH = 460;
export const APPROVAL_HEIGHT = 360;
const APPROVAL_GAP = 12;

/**
 * Where the approval prompt goes. ⛔ Pure, tested.
 *
 * Beside the chat panel when it is showing: to its LEFT (the bubble's home is the
 * bottom-right corner, so the room is on the left), bottom-aligned with it; to the
 * right when the left has no room; over its centre when neither side has room.
 * Always fully inside the work area. With no chat panel showing: the bottom-right
 * corner of the work area, 24px in. Before this the prompt always went to the
 * primary display's corner — ON TOP of the chat it was asking about, and on the
 * wrong monitor when the bubble lived on a second screen.
 */
export function approvalPositionFor(anchor: Rect | null, workArea: Rect, size: { width: number; height: number } = { width: APPROVAL_WIDTH, height: APPROVAL_HEIGHT }): Point {
  const clamp = (p: Point): Point => ({
    x: Math.round(Math.min(Math.max(p.x, workArea.x), Math.max(workArea.x, workArea.x + workArea.width - size.width))),
    y: Math.round(Math.min(Math.max(p.y, workArea.y), Math.max(workArea.y, workArea.y + workArea.height - size.height))),
  });
  if (!anchor) return clamp({ x: workArea.x + workArea.width - size.width - 24, y: workArea.y + workArea.height - size.height - 24 });
  const y = anchor.y + anchor.height - size.height;
  const left = anchor.x - size.width - APPROVAL_GAP;
  if (left >= workArea.x) return clamp({ x: left, y });
  const right = anchor.x + anchor.width + APPROVAL_GAP;
  if (right + size.width <= workArea.x + workArea.width) return clamp({ x: right, y });
  return clamp({ x: anchor.x + (anchor.width - size.width) / 2, y: anchor.y + (anchor.height - size.height) / 2 });
}

type Pending = { req: ApprovalRequest; resolve: (r: { approved: boolean; how: string }) => void; win: BW };

let deps: ApprovalDeps | null = null;
const pending = new Map<string, Pending>();

export function registerApprovalIpc(d: ApprovalDeps): void {
  deps = d;
  d.ipcMain.handle("coworker-approval:get", (event) => {
    const win = d.BrowserWindow.fromWebContents(event.sender);
    for (const p of pending.values()) if (p.win === win) return { callId: p.req.callId, title: p.req.title, what: p.req.what, why: p.req.why, domains: p.req.domains, risk: p.req.risk, tool: p.req.tool };
    return null;
  });
  d.ipcMain.on("coworker-approval:answer", (event, payload: { callId?: unknown; approved?: unknown }) => {
    try {
      const win = d.BrowserWindow.fromWebContents(event.sender);
      const callId = typeof payload?.callId === "string" ? payload.callId : "";
      const p = pending.get(callId);
      // ⛔ The answer must come from the window that asked, for the call it asked about.
      if (!p || p.win !== win) { d.log(`approval: answer ignored (unknown call ${callId.slice(0, 8)} or wrong window)`); return; }
      settle(callId, { approved: payload.approved === true, how: payload.approved === true ? "approved_in_window" : "denied_in_window" });
    } catch (err) { d.log(`approval: answer failed ${String(err)}`); }
  });
}

function settle(callId: string, r: { approved: boolean; how: string }) {
  const p = pending.get(callId);
  if (!p) return;
  pending.delete(callId);
  deps?.log(`approval: ${p.req.tool} → ${r.how}`);
  try { if (!p.win.isDestroyed()) p.win.destroy(); } catch { /* gone */ }
  p.resolve(r);
  try { deps?.onSettled?.({ callId, ...r }); } catch { /* the chat's focus is a courtesy, never a failure */ }
}

/** Show the prompt; resolves with the person's answer, or denied when the window is closed / the task is cancelled. */
export function askApproval(req: ApprovalRequest, signal: AbortSignal): Promise<{ approved: boolean; how: string }> {
  const d = deps;
  if (!d) return Promise.resolve({ approved: false, how: "no_ui" });
  return new Promise((resolve) => {
    try {
      const html = d.assetPath("coworkerApproval.html");
      if (!fs.existsSync(html)) { d.log("approval: asset missing"); resolve({ approved: false, how: "no_ui" }); return; }
      // Beside the chat panel, on the display the chat is on; the corner otherwise.
      const anchor = (() => { try { return d.anchor?.() ?? null; } catch { return null; } })();
      const display = anchor ? d.screen.getDisplayMatching(anchor) : d.screen.getPrimaryDisplay();
      const wa = display.workArea;
      const at = approvalPositionFor(anchor, { x: wa.x, y: wa.y, width: wa.width, height: wa.height });
      const width = APPROVAL_WIDTH; const height = APPROVAL_HEIGHT;
      const win = new d.BrowserWindow({
        width, height, x: at.x, y: at.y,
        frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: false, alwaysOnTop: true,
        title: "Loopcom Coworker — approval", backgroundColor: "#0f1a2c", show: false,
        webPreferences: { preload: d.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: ["--connect-window-kind=coworker-approval"] },
      });
      d.attachDiag?.(win, "coworker-approval");
      win.setAlwaysOnTop(true, "screen-saver");
      pending.set(req.callId, { req, resolve, win });
      win.on("closed", () => { if (pending.has(req.callId)) settle(req.callId, { approved: false, how: "window_closed" }); });
      signal.addEventListener("abort", () => settle(req.callId, { approved: false, how: "cancelled" }), { once: true });
      win.loadFile(html);
      win.once("ready-to-show", () => { try { win.show(); win.focus(); } catch { /* ignore */ } });
      d.log(`approval: shown for ${req.tool} (${req.callId.slice(0, 8)}) at ${at.x},${at.y}${anchor ? " beside the chat" : ""}`);
    } catch (err) {
      d.log(`approval: failed to show ${String(err)}`);
      resolve({ approved: false, how: "no_ui" });
    }
  });
}

export function pendingApprovals(): { callId: string; tool: string; title: string }[] {
  return [...pending.values()].map((p) => ({ callId: p.req.callId, tool: p.req.tool, title: p.req.title }));
}

/* ── the Connections / Coworker settings window ── */

let connectionsWindow: BW | null = null;

export function openConnectionsWindow(d: ApprovalDeps): BW | null {
  try {
    if (connectionsWindow && !connectionsWindow.isDestroyed()) { connectionsWindow.show(); connectionsWindow.focus(); return connectionsWindow; }
    const html = d.assetPath("coworkerConnections.html");
    if (!fs.existsSync(html)) { d.log("connections: asset missing"); return null; }
    connectionsWindow = new d.BrowserWindow({
      width: 900, height: 680, minWidth: 700, minHeight: 480, title: "Loopcom Coworker — Settings & Connections", backgroundColor: "#0f1a2c", show: false,
      webPreferences: { preload: d.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: ["--connect-window-kind=coworker-connections"] },
    });
    d.attachDiag?.(connectionsWindow, "coworker-connections");
    connectionsWindow.setMenuBarVisibility(false);
    connectionsWindow.loadFile(html);
    connectionsWindow.once("ready-to-show", () => connectionsWindow?.show());
    connectionsWindow.on("closed", () => { connectionsWindow = null; });
    return connectionsWindow;
  } catch (err) {
    d.log(`connections: failed to open ${String(err)}`);
    return null;
  }
}

export function connectionsWindowRef(): BW | null { return connectionsWindow && !connectionsWindow.isDestroyed() ? connectionsWindow : null; }

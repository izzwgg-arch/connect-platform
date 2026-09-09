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

export type ApprovalDeps = {
  BrowserWindow: typeof BW;
  ipcMain: IpcMain;
  screen: Screen;
  assetPath: (file: string) => string;
  preloadPath: string;
  log: (line: string) => void;
  attachDiag?: (win: BW, tag: string) => void;
};

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
}

/** Show the prompt; resolves with the person's answer, or denied when the window is closed / the task is cancelled. */
export function askApproval(req: ApprovalRequest, signal: AbortSignal): Promise<{ approved: boolean; how: string }> {
  const d = deps;
  if (!d) return Promise.resolve({ approved: false, how: "no_ui" });
  return new Promise((resolve) => {
    try {
      const html = d.assetPath("coworkerApproval.html");
      if (!fs.existsSync(html)) { d.log("approval: asset missing"); resolve({ approved: false, how: "no_ui" }); return; }
      const wa = d.screen.getPrimaryDisplay().workArea;
      const width = 460; const height = 360;
      const win = new d.BrowserWindow({
        width, height, x: Math.round(wa.x + wa.width - width - 24), y: Math.round(wa.y + wa.height - height - 24),
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
      d.log(`approval: shown for ${req.tool} (${req.callId.slice(0, 8)})`);
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

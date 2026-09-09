/**
 * The Coworker's hands, assembled: runtime + link + MCP host + journal +
 * approval window + the admin IPC, wired to the real app by main.ts through
 * `startCoworkerHands()`. Everything here is wrapped: a fault in the hands must
 * never reach the phone.
 *
 * ⛔ The link runs only while the app is signed in (the token comes from the
 * main window's localStorage) and the Coworker is enabled (the bubble setting or
 * the hands setting — the bubble is how people find it). The hands do not exist
 * for a signed-out app, and they stop the moment the app quits (goodbye).
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { App, BrowserWindow as BW, IpcMain, Screen, Session, Shell } from "electron";
import type { DesktopSettings, CoworkerMcpServerSetting } from "../types";
import { CoworkerRuntime } from "./runtime";
import { CoworkerBrowser } from "./runtime/browser";
import { McpManager, parseServerConfig } from "./runtime/mcp";
import { Journal } from "./runtime/journal";
import { DesktopLinkClient, type LinkState } from "./link";
import { askApproval, registerApprovalIpc, openConnectionsWindow, pendingApprovals, type ApprovalDeps } from "./approvalWindow";
import { normalizePermissions, PERMISSION_PROFILES } from "./policyCore";

export type HandsDeps = {
  app: App;
  BrowserWindow: typeof BW;
  ipcMain: IpcMain;
  screen: Screen;
  session: { fromPartition(p: string, o?: { cache?: boolean }): Session };
  shell: Shell;
  portalUrl: string;
  preloadPath: string;
  assetPath: (file: string) => string;
  getSettings: () => DesktopSettings;
  writeSettings: (next: DesktopSettings) => void;
  isCallActive: () => boolean;
  phoneState: () => Record<string, unknown> | null;
  /** The main window, to read the portal JWT from. Null when it does not exist. */
  fullWindow: () => BW | null;
  userAgent: string;
  logFile: string;
  log: (line: string) => void;
  attachDiag?: (win: BW, tag: string) => void;
  rebuildTray: () => void;
};

export type Hands = {
  link: DesktopLinkClient;
  runtime: CoworkerRuntime;
  mcp: McpManager;
  journal: Journal;
  stop: () => Promise<void>;
  openConnections: () => void;
  status: () => Record<string, unknown>;
};

export const DEFAULT_WORKSPACE_NAME = "LoopcomCoworkerAcceptance";

function workspaceFor(settings: DesktopSettings): string {
  const w = typeof settings.coworkerWorkspace === "string" && settings.coworkerWorkspace.trim() ? settings.coworkerWorkspace.trim() : path.join(os.homedir(), DEFAULT_WORKSPACE_NAME);
  return w;
}

/** The portal keeps its JWT in localStorage under one of three keys (FloatingAssistant.token()). */
export const TOKEN_SCRIPT = `(function(){ try { return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || null; } catch (e) { return null; } })()`;

export function startCoworkerHands(d: HandsDeps): Hands {
  const log = (line: string) => d.log(line);
  const settings0 = d.getSettings();
  const workspace = workspaceFor(settings0);
  for (const sub of ["", "downloads", "artifacts"]) { try { fs.mkdirSync(path.join(workspace, sub), { recursive: true }); } catch { /* the file tools report it */ } }
  const journal = new Journal(path.join(d.app.getPath("userData"), "coworker"));
  const desktopId = (() => {
    const file = path.join(d.app.getPath("userData"), "coworker", "desktop-id");
    try { const v = fs.readFileSync(file, "utf8").trim(); if (v) return v; } catch { /* first run */ }
    const id = `${os.hostname()}-${Math.random().toString(36).slice(2, 10)}`;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, id); } catch { /* fine */ }
    return id;
  })();

  const browser = new CoworkerBrowser({
    BrowserWindow: d.BrowserWindow, session: d.session,
    downloadsDir: () => path.join(workspaceFor(d.getSettings()), "downloads"),
    artifactsDir: () => path.join(workspaceFor(d.getSettings()), "artifacts"),
    userAgent: d.userAgent, log: (l) => log(`browser: ${l}`),
  });

  let link: DesktopLinkClient | null = null;
  const mcp = new McpManager((l) => log(l), () => { try { link?.announce(); } catch { /* not started */ } });

  const approvalDeps: ApprovalDeps = { BrowserWindow: d.BrowserWindow, ipcMain: d.ipcMain, screen: d.screen, assetPath: d.assetPath, preloadPath: d.preloadPath, log: (l) => log(l), attachDiag: d.attachDiag };
  registerApprovalIpc(approvalDeps);

  const permissions = () => normalizePermissions({ profile: d.getSettings().coworkerPermissions ?? "SAFE", overrides: {} });

  const runtime = new CoworkerRuntime({
    home: os.homedir(),
    workspace,
    extraRoots: () => (d.getSettings().coworkerExtraRoots ?? []).filter((r): r is string => typeof r === "string" && !!r.trim()),
    permissions,
    isCallActive: d.isCallActive,
    coworkerEnabled: () => true,
    askApproval: (req, signal) => askApproval(req, signal),
    browser, mcp, journal,
    openPath: async (p) => { const err = await d.shell.openPath(p); if (err) throw new Error(err); },
    showInFolder: (p) => d.shell.showItemInFolder(p),
    diagnostics: { portalUrl: d.portalUrl, appVersion: d.app.getVersion(), logFile: d.logFile, phoneState: d.phoneState, linkState: () => (link ? link.status() : { state: "off" }) as unknown as Record<string, unknown> },
    log: (l) => log(`runtime: ${l}`),
  });

  const manifest = () => {
    const s = d.getSettings();
    return {
      desktopId, appVersion: d.app.getVersion(), hostname: os.hostname(), os: `${os.type()} ${os.release()}`, username: os.userInfo().username,
      profile: permissions().profile, workspace: workspaceFor(s), tools: runtime.manifestTools(),
      mcpServers: mcp.status().map((m) => ({ id: m.id, name: m.name, state: m.state, tools: m.tools.length })),
    };
  };

  const getToken = async (): Promise<string | null> => {
    const win = d.fullWindow();
    if (!win || win.isDestroyed() || win.webContents.isLoading()) return null;
    try {
      const v = await Promise.race([win.webContents.executeJavaScript(TOKEN_SCRIPT, true), new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
      return typeof v === "string" && v.split(".").length === 3 ? v : null;
    } catch { return null; }
  };

  link = new DesktopLinkClient({
    portalUrl: d.portalUrl, getToken, runtime, manifest, log: (l) => log(l), userAgent: d.userAgent,
    onStateChange: (s: LinkState) => { try { d.rebuildTray(); } catch { /* ignore */ } void s; },
  }, desktopId);

  // MCP servers from settings, then the link. Neither may throw into main.
  const applyMcp = async () => {
    const configs = (d.getSettings().coworkerMcpServers ?? []).map(parseServerConfig).filter((c): c is NonNullable<typeof c> => !!c);
    await mcp.apply(configs);
  };
  void applyMcp().catch((e) => log(`mcp apply failed: ${String(e)}`)).finally(() => { try { link!.start(); } catch (e) { log(`link start failed: ${String(e)}`); } });

  /* ── admin IPC (the Connections window + read-only status for the portal) ── */
  const isLocalAdminWindow = (event: Electron.IpcMainInvokeEvent) => {
    try { const url = event.sender.getURL(); return url.startsWith("file:"); } catch { return false; }
  };
  const state = async () => {
    const s = d.getSettings();
    return {
      profile: permissions().profile,
      link: link!.status(),
      workspace: workspaceFor(s),
      appVersion: d.app.getVersion(),
      tools: runtime.manifestTools().length,
      mcp: mcp.status(),
      activeCalls: runtime.activeCalls(),
      pendingApprovals: pendingApprovals(),
      history: await journal.recent(40),
    };
  };
  d.ipcMain.handle("coworker-admin:state", async () => { try { return await state(); } catch (e) { return { error: String(e) }; } });
  d.ipcMain.handle("coworker-admin:set-profile", (event, profile: unknown) => {
    if (!isLocalAdminWindow(event)) return { ok: false, error: "not_allowed_from_this_window" };
    if (typeof profile !== "string" || !(PERMISSION_PROFILES as readonly string[]).includes(profile) || profile === "CUSTOM") return { ok: false, error: "bad_profile" };
    d.writeSettings({ ...d.getSettings(), coworkerPermissions: profile as "SAFE" | "TRUSTED" | "AUTONOMOUS" });
    log(`profile set to ${profile}`);
    link!.announce();
    return { ok: true, profile };
  });
  d.ipcMain.handle("coworker-admin:mcp", async (event, payload: { action?: unknown; id?: unknown; config?: unknown }) => {
    if (!isLocalAdminWindow(event)) return { ok: false, error: "not_allowed_from_this_window" };
    const action = String(payload?.action ?? "");
    const id = typeof payload?.id === "string" ? payload.id : "";
    const s = d.getSettings();
    const list: CoworkerMcpServerSetting[] = [...(s.coworkerMcpServers ?? [])];
    const save = (next: CoworkerMcpServerSetting[]) => d.writeSettings({ ...d.getSettings(), coworkerMcpServers: next });
    try {
      switch (action) {
        case "add": {
          const cfg = parseServerConfig({ ...(payload.config as object), enabled: true });
          if (!cfg) return { ok: false, error: "bad_config", message: "The id must be letters/digits/-/_ and the command cannot be empty." };
          if (list.some((x) => x.id === cfg.id)) return { ok: false, error: "duplicate", message: `A server with id "${cfg.id}" already exists.` };
          save([...list, cfg]);
          await applyMcp();
          return { ok: true, server: mcp.get(cfg.id)?.status() ?? null };
        }
        case "remove": save(list.filter((x) => x.id !== id)); await applyMcp(); return { ok: true };
        case "enable": case "disable": {
          const next = list.map((x) => (x.id === id ? { ...x, enabled: action === "enable" } : x));
          save(next); await applyMcp(); return { ok: true, server: mcp.get(id)?.status() ?? null };
        }
        case "connect": return { ok: true, server: await mcp.connect(id) };
        case "disconnect": return { ok: true, server: mcp.disconnect(id) };
        case "reconnect": return { ok: true, server: await mcp.reconnect(id) };
        default: return { ok: false, error: "unknown_action" };
      }
    } catch (e) {
      return { ok: false, error: "mcp_action_failed", message: String((e as Error)?.message ?? e).slice(0, 200) };
    } finally {
      link!.announce();
    }
  });
  d.ipcMain.handle("coworker-admin:relink", async () => { link!.announce(); return { ok: true, link: link!.status() }; });
  d.ipcMain.handle("coworker-admin:cancel", async () => ({ ok: true, cancelled: runtime.cancel(null) }));
  d.ipcMain.handle("coworker-admin:open-path", async (event, payload: { path?: unknown; how?: unknown }) => {
    if (!isLocalAdminWindow(event)) return { ok: false, error: "not_allowed_from_this_window" };
    const p = typeof payload?.path === "string" ? payload.path : "";
    // Only paths the journal knows as artifacts may be opened from here.
    const known = (await journal.recent(200)).artifacts.some((a) => a.artifact?.path === p);
    if (!known) return { ok: false, error: "unknown_artifact" };
    if (payload?.how === "folder") d.shell.showItemInFolder(p); else await d.shell.openPath(p);
    return { ok: true };
  });
  d.ipcMain.handle("coworker-admin:open-connections", () => { openConnectionsWindow(approvalDeps); return { ok: true }; });

  return {
    link, runtime, mcp, journal,
    stop: async () => { try { runtime.cancel(null); } catch { /* ignore */ } try { mcp.shutdown(); } catch { /* ignore */ } try { await link!.stop(); } catch { /* ignore */ } },
    openConnections: () => { openConnectionsWindow(approvalDeps); },
    status: () => ({ link: link!.status(), profile: permissions().profile, mcp: mcp.status().map((m) => ({ id: m.id, state: m.state, tools: m.tools.length })), active: runtime.activeCalls() }),
  };
}

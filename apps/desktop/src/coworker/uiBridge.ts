/**
 * The Coworker WORKSPACE's bridge to this computer — what the IDE-style chat (the
 * bubble popover and the full page, both the HOSTED portal) may ask the Loopcom app
 * to do: read the Coworker's state, switch between "Ask first" and "Full access",
 * attach a folder or a code project, switch tool families on or off, open the full
 * page, and say a task finished.
 *
 * ⛔⛔ THE PAGE IS HOSTED, SO IT IS UNTRUSTED. A compromised server can call every
 * verb here. So each verb is shaped so that calling it cannot hurt the person:
 *   - RAISING the access level (Ask first → Full access) needs a NATIVE Windows dialog
 *     answered on this computer. The page cannot answer it. Lowering never asks.
 *   - A folder is attached only from the native folder picker the person drives, or
 *     from a real drop (the path comes from Electron's webUtils in the preload — a page
 *     cannot fabricate one); a dropped folder outside the person's own profile also
 *     asks natively. No verb takes a free path to attach.
 *   - Switching a tool family OFF is always safe; switching one back ON only restores
 *     what the permission profile already allows (policy + approvals still apply).
 *   - The NEVER_AUTO floor, the hard prohibitions and the shell denylist are not
 *     reachable from here at all — they are not settings.
 *
 * ⛔ Pure helpers are exported and tested; every IPC handler is wrapped so a fault
 * here never reaches the phone.
 */
import path from "node:path";
import { promises as fsp } from "node:fs";
import type { BrowserWindow as BW, Dialog, IpcMain, IpcMainInvokeEvent } from "electron";
import type { CoworkerToolGroup, DesktopSettings } from "../types";
import { FORBIDDEN_ROOTS, normalizePath, isInsideRoot } from "./policyCore";
import { gitInstalled, isGitRepoFolder } from "./runtime/git";

export const MAX_ATTACHED_FOLDERS = 20;
export const TOOL_GROUPS: readonly CoworkerToolGroup[] = ["files", "browser", "sheets", "git", "shell", "system", "windows", "screen", "services"];
export type AccessProfile = "SAFE" | "TRUSTED" | "AUTONOMOUS";
const RANK: Record<AccessProfile, number> = { SAFE: 0, TRUSTED: 1, AUTONOMOUS: 2 };

export function isAccessProfile(v: unknown): v is AccessProfile {
  return v === "SAFE" || v === "TRUSTED" || v === "AUTONOMOUS";
}

/** Only a move UP needs the person's native confirmation. */
export function isRaise(from: AccessProfile | undefined, to: AccessProfile): boolean {
  return RANK[to] > RANK[from ?? "SAFE"];
}

/**
 * May this folder be attached at all? Absolute, local, not a drive root, not a
 * Windows system location, and not the whole Users folder.
 */
export function folderRefusal(abs: string): string | null {
  if (!path.win32.isAbsolute(abs) || /^\\\\/.test(abs)) return "Only folders on this computer's own drives can be attached.";
  const n = normalizePath(abs);
  if (!n) return "That folder's path isn't one the Coworker will use.";
  const lower = n.toLowerCase();
  if (/^[a-z]:\/?$/.test(lower)) return "A whole drive can't be attached — pick a folder inside it.";
  if (lower === "c:/users" || lower === "c:/program files" || lower === "c:/program files (x86)" || lower === "c:/programdata") return "That system folder can't be attached — pick your own folder inside it.";
  for (const bad of FORBIDDEN_ROOTS) if (lower === bad || lower.startsWith(`${bad}/`)) return "Windows system folders can't be attached.";
  return null;
}

type Folder = NonNullable<DesktopSettings["coworkerFolders"]>[number];

export function mergeFolder(list: Folder[] | undefined, entry: Folder): Folder[] {
  const key = entry.path.toLowerCase();
  const rest = (list ?? []).filter((f) => f.path.toLowerCase() !== key);
  return [entry, ...rest].slice(0, MAX_ATTACHED_FOLDERS);
}

export function groupsView(s: DesktopSettings): Record<CoworkerToolGroup, boolean> & { email: boolean } {
  const off = new Set(s.coworkerDisabledGroups ?? []);
  const view = Object.fromEntries(TOOL_GROUPS.map((g) => [g, !off.has(g)])) as Record<CoworkerToolGroup, boolean>;
  return { ...view, email: s.coworkerBlockEmail === false };
}

/** Apply a page's switch changes. Unknown keys and non-booleans are ignored. */
export function applyGroups(s: DesktopSettings, patch: unknown): DesktopSettings {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const off = new Set(s.coworkerDisabledGroups ?? []);
  for (const g of TOOL_GROUPS) {
    if (typeof p[g] !== "boolean") continue;
    if (p[g]) off.delete(g); else off.add(g);
  }
  const next: DesktopSettings = { ...s, coworkerDisabledGroups: TOOL_GROUPS.filter((g) => off.has(g)) };
  if (typeof p.email === "boolean") next.coworkerBlockEmail = !p.email;
  return next;
}

/** The hosted portal (either hostname the app is pointed at) or a packaged local page. */
export function isTrustedSenderUrl(url: string, portalUrl: string): boolean {
  if (url.startsWith("file:")) return true;
  try {
    const a = new URL(url); const b = new URL(portalUrl);
    return a.protocol === "https:" || a.hostname === "localhost" || a.hostname === "127.0.0.1" ? a.origin === b.origin : false;
  } catch { return false; }
}

export const ACCESS_DIALOG: Record<"TRUSTED" | "AUTONOMOUS", { title: string; message: string; detail: string; yes: string }> = {
  TRUSTED: {
    title: "Loopcom Coworker",
    message: "Let the Coworker make everyday changes without asking?",
    detail: "It will save and move files, make spreadsheets and use its own browser on its own.\n\nIt will still ask you before it deletes anything, runs commands, sends anything off this computer, signs in anywhere, installs software, changes system settings, or does anything while you're on a call.",
    yes: "Allow everyday changes",
  },
  AUTONOMOUS: {
    title: "Loopcom Coworker",
    message: "Give the Coworker full access on this computer?",
    detail: "It will stop asking before routine work — files, spreadsheets, its browser, commands and your connected apps.\n\nIt will STILL ask before it deletes anything, sends a web form or pushes code to a server, uses a password or sign-in, installs software or changes system settings. It never switches off security, opens remote access, or touches Windows system folders, and it waits while you're on a call.\n\nYou can switch back to \"Ask first\" at any time.",
    yes: "Give full access",
  },
};

export type UiBridgeDeps = {
  ipcMain: IpcMain;
  dialog: Pick<Dialog, "showMessageBox" | "showOpenDialog">;
  fromWebContents: (wc: Electron.WebContents) => BW | null;
  portalUrl: string;
  home: string;
  appVersion: string;
  getSettings: () => DesktopSettings;
  writeSettings: (next: DesktopSettings) => void;
  /** Re-announce the manifest (the profile or the tool list changed). */
  announce: () => void;
  linkState: () => string;
  bubbleEnabled: () => boolean;
  setBubbleEnabled: (on: boolean) => void;
  openCoworkerFull: (route: string) => void;
  openBubbleChat: () => void;
  isChatVisible: () => boolean;
  setBadge: (state: "none" | "unread" | "working") => void;
  notify: (title: string, body: string) => void;
  log: (line: string) => void;
};

export function registerCoworkerUiIpc(d: UiBridgeDeps): void {
  const trusted = (e: IpcMainInvokeEvent) => {
    try { return isTrustedSenderUrl(e.sender.getURL(), d.portalUrl); } catch { return false; }
  };
  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => Promise<unknown> | unknown) => {
    d.ipcMain.handle(channel, async (e, arg) => {
      if (!trusted(e)) return { ok: false, error: "not_allowed_from_this_window" };
      try { return await fn(e, arg); } catch (err) {
        d.log(`${channel} failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
        return { ok: false, error: "failed", message: "That didn't work. Try again." };
      }
    });
  };
  const parent = (e: IpcMainInvokeEvent) => { try { return d.fromWebContents(e.sender); } catch { return null; } };

  const state = async () => {
    const s = d.getSettings();
    return {
      ok: true,
      linked: d.linkState() === "connected",
      profile: isAccessProfile(s.coworkerPermissions) ? s.coworkerPermissions : "SAFE",
      groups: groupsView(s),
      bubble: d.bubbleEnabled(),
      folders: (s.coworkerFolders ?? []).map((f) => ({ path: f.path, name: f.name, repo: f.repo })),
      gitInstalled: await gitInstalled().catch(() => false),
      appVersion: d.appVersion,
    };
  };

  handle("coworker-ui:state", () => state());

  handle("coworker-ui:set-access", async (e, profile) => {
    if (!isAccessProfile(profile)) return { ok: false, error: "bad_profile" };
    const s = d.getSettings();
    const current = isAccessProfile(s.coworkerPermissions) ? s.coworkerPermissions : "SAFE";
    if (current === profile) return { ok: true, profile };
    if (isRaise(current, profile)) {
      const text = ACCESS_DIALOG[profile as "TRUSTED" | "AUTONOMOUS"];
      const win = parent(e);
      const opts = { type: "warning" as const, title: text.title, message: text.message, detail: text.detail, buttons: [text.yes, "Cancel"], defaultId: 1, cancelId: 1, noLink: true };
      const answer = win ? await d.dialog.showMessageBox(win, opts) : await d.dialog.showMessageBox(opts);
      if (answer.response !== 0) { d.log(`access raise to ${profile} cancelled by the person`); return { ok: false, error: "cancelled", profile: current }; }
    }
    d.writeSettings({ ...d.getSettings(), coworkerPermissions: profile });
    d.log(`access set to ${profile} from the Coworker workspace (was ${current})`);
    d.announce();
    return { ok: true, profile };
  });

  const attach = async (e: IpcMainInvokeEvent, raw: string, how: "picker" | "drop", wantRepo: boolean) => {
    const st = await fsp.stat(raw).catch(() => null);
    if (!st?.isDirectory()) return { ok: false, error: "not_a_folder", message: "That isn't a folder." };
    const real = await fsp.realpath(raw).catch(() => raw);
    const refusal = folderRefusal(real);
    if (refusal) return { ok: false, error: "refused", message: refusal };
    const repo = await isGitRepoFolder(real);
    if (wantRepo && !repo) return { ok: false, error: "not_a_repo", message: "That folder has no git history, so it isn't a code project. Attach it as a folder instead, or pick the project's top folder." };
    // ⛔ A drop outside the person's own profile asks natively: the picker already was the person choosing.
    if (how === "drop" && !isInsideRoot(real, d.home)) {
      const win = parent(e);
      const opts = { type: "question" as const, title: "Loopcom Coworker", message: `Let the Coworker use ${real}?`, detail: "It will be able to look in this folder for this and later tasks. Your permission settings still decide what it may change.", buttons: ["Allow", "Cancel"], defaultId: 1, cancelId: 1, noLink: true };
      const answer = win ? await d.dialog.showMessageBox(win, opts) : await d.dialog.showMessageBox(opts);
      if (answer.response !== 0) return { ok: false, error: "cancelled" };
    }
    const entry = { path: real, name: path.basename(real) || real, repo, addedAt: new Date().toISOString() };
    d.writeSettings({ ...d.getSettings(), coworkerFolders: mergeFolder(d.getSettings().coworkerFolders, entry) });
    d.log(`folder attached (${how}${repo ? ", code project" : ""}): ${real}`);
    return { ok: true, folder: { path: entry.path, name: entry.name, repo: entry.repo } };
  };

  handle("coworker-ui:pick-folder", async (e, arg) => {
    const wantRepo = !!(arg && typeof arg === "object" && (arg as { repo?: unknown }).repo === true);
    const win = parent(e);
    const opts = { title: wantRepo ? "Choose a code project" : "Attach a folder", buttonLabel: wantRepo ? "Use this project" : "Attach", properties: ["openDirectory" as const] };
    const picked = win ? await d.dialog.showOpenDialog(win, opts) : await d.dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, error: "cancelled" };
    return attach(e, picked.filePaths[0], "picker", wantRepo);
  });

  // ⛔ The path arrives from the PRELOAD's webUtils.getPathForFile on a File the
  // person actually dropped. The page has no way to put a string on this channel.
  handle("coworker-ui:attach-dropped", async (e, arg) => {
    const p = typeof arg === "string" ? arg : "";
    if (!p || p.length > 1000) return { ok: false, error: "not_a_folder", message: "That isn't a folder." };
    return attach(e, p, "drop", false);
  });

  handle("coworker-ui:remove-folder", (_e, arg) => {
    const p = typeof arg === "string" ? arg.toLowerCase() : "";
    const s = d.getSettings();
    d.writeSettings({ ...s, coworkerFolders: (s.coworkerFolders ?? []).filter((f) => f.path.toLowerCase() !== p) });
    return { ok: true };
  });

  handle("coworker-ui:set-groups", (_e, patch) => {
    const next = applyGroups(d.getSettings(), patch);
    d.writeSettings(next);
    d.announce();
    return { ok: true, groups: groupsView(next) };
  });

  handle("coworker-ui:set-bubble", (_e, on) => {
    if (typeof on !== "boolean") return { ok: false, error: "bad_request" };
    d.setBubbleEnabled(on);
    return { ok: true, bubble: on };
  });

  handle("coworker-ui:open-full", (_e, route) => {
    const r = typeof route === "string" && /^\/coworker(?:[?#][\w=&%.\-#]*)?$/.test(route) ? route : "/coworker";
    d.openCoworkerFull(r);
    return { ok: true };
  });

  handle("coworker-ui:open-bubble", () => { d.openBubbleChat(); return { ok: true }; });

  handle("coworker-ui:task-finished", (_e, arg) => {
    const a = (arg && typeof arg === "object" ? arg : {}) as { title?: unknown; body?: unknown; notify?: unknown };
    if (d.isChatVisible()) return { ok: true, shown: false };
    d.setBadge("unread");
    if (a.notify !== false) {
      const title = typeof a.title === "string" && a.title.trim() ? a.title.trim().slice(0, 80) : "Coworker finished a task";
      const body = typeof a.body === "string" ? a.body.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      d.notify(title, body);
    }
    return { ok: true, shown: true };
  });
}

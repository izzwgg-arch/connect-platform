/**
 * The Coworker runtime — one tool call in, one result out, with the policy
 * core, the approval prompt and the journal in between. This is the ONLY entry
 * from the desktop link into the hands.
 *
 * ⛔ THE ORDER, PER CALL: parse (name known? args an object?) → spec (declared
 * risk/domains) → decideToolCall (profile, call-in-progress, prohibitions) →
 * deny: stop, journal, answer the model with the reason → ask: show the person
 * the approval prompt, journal their answer, refuse on No/timeout → run →
 * journal outcome → answer. Nothing runs before the verdict, and a verdict of
 * deny cannot be argued with from the other end of the wire.
 *
 * ⛔ Concurrency: several calls may be in flight (the model can ask for two files
 * at once; two chats can run two tasks). Each has its own AbortSignal; a cancel
 * for a task aborts that task's calls and stops its browser/shell children.
 */
import path from "node:path";
import os from "node:os";
import type { ChildProcess } from "node:child_process";
import { decideToolCall, normalizePermissions, type PermissionSettings, type PolicyDecision } from "../policyCore";
import { findTool, TOOL_CATALOG, type CatalogTool } from "../toolCatalog";
import { fsCopy, fsDelete, fsList, fsMkdir, fsMove, fsRead, fsSearch, fsStat, fsWrite, resolveUserPath, type FsEnv } from "./fs";
import { runPowerShellChecked, checkShellScript, type ShellDeps } from "./shell";
import type { ScreenController, RunElevatedPowerShell } from "../screenControl/controller";
import type { ScreenActionName } from "../screenControl/session";
import { processes, systemInfo } from "./windows";
import { readXlsxFile, writeXlsxFile, type Sheet } from "./xlsx";
import { CoworkerBrowser } from "./browser";
import { runDiagnostics } from "./diagnostics";
import { McpManager } from "./mcp";
import { Journal } from "./journal";
import type { BrowserCompanionRuntime } from "../browserCompanion/runtime";
import { validateArgs, type CommandName } from "../browserCompanion/protocol";
import { gitBranches, gitCheckout, gitClone, gitCommit, gitDiff, gitLog, gitPull, gitPush, gitStatus } from "./git";
import { classifyShellScript, scriptTouchesProtected, scriptPathLiterals, isProtectedPath } from "../computerControl/protectedResources";
import { isWindowsTool, WINDOWS_TOOL_NAMES } from "../computerControl/windowsControl";
import { networkInfo, networkTest, serviceControl, services } from "./windows";

/** The tool family a built-in tool belongs to, for the person's on/off switches. MCP tools have none. */
export type ToolGroup = "files" | "browser" | "sheets" | "git" | "shell" | "system" | "windows" | "screen" | "services";
export function toolGroup(name: string): ToolGroup | null {
  if (name.startsWith("computer_fs_") || name === "computer_open_path" || name === "computer_artifact_register") return "files";
  if (name.startsWith("computer_chrome_") || name.startsWith("computer_browser_")) return "browser";
  if (name.startsWith("computer_xlsx_")) return "sheets";
  if (name.startsWith("computer_git_")) return "git";
  if (name === "computer_powershell") return "shell";
  if (name === "computer_system_info" || name === "computer_processes" || name === "computer_diagnostics" || name === "computer_network_info" || name === "computer_network_test") return "system";
  if (name === "computer_services" || name === "computer_service_control") return "services";
  // Layer 2 — programs and their windows (UI Automation, no cursor)
  if (name.startsWith("computer_windows_") || name === "computer_app_launch" || name === "computer_process_kill") return "windows";
  // Layer 3 — the real mouse, keyboard and pictures of the screen (begin/end ride with it)
  if (name.startsWith("computer_screen_")) return "screen";
  return null;
}

const GROUP_WORDS: Record<ToolGroup, string> = {
  files: "Files on this computer", browser: "The web browser", sheets: "Spreadsheets", git: "Code projects", shell: "Running commands", system: "Checking this computer",
  windows: "Windows programs", screen: "The mouse, keyboard and screen", services: "Windows services",
};

/** Webmail sites — the person's inbox. Blocked unless they switched Email on. */
const WEBMAIL_HOST_RE = /(^|\.)(mail\.google\.com|gmail\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|outlook\.com|mail\.yahoo\.com|mail\.aol\.com|mail\.proton\.me|mail\.protonmail\.com|mail\.zoho\.com|app\.fastmail\.com|fastmail\.com|mail\.yandex\.com|mail\.gmx\.com|navigator-bs\.gmx\.com)$|^webmail\.|^mail\./i;
export function isWebmailUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return WEBMAIL_HOST_RE.test(u.hostname) || (/(^|\.)icloud\.com$/i.test(u.hostname) && /^\/mail/i.test(u.pathname));
  } catch { return false; }
}

/** The screen/windows actions that require an already-open control session (everything but begin/end). */
const SCREEN_ACTION_TOOLS = new Set<string>([
  "computer_screen_read", "computer_screen_look", "computer_screen_click", "computer_screen_type",
  "computer_screen_key", "computer_screen_scroll", "computer_screen_move", "computer_screen_capture",
  ...WINDOWS_TOOL_NAMES,
]);
/** Everything the ask-once screen session governs (for the manifest filter and the gate). */
export function isScreenSessionTool(name: string): boolean { return name.startsWith("computer_screen_") || isWindowsTool(name); }

export type ApprovalRequest = {
  callId: string;
  taskId: string;
  tool: string;
  title: string;
  what: string;
  why: string;
  domains: readonly string[];
  risk: string;
  args: Record<string, unknown>;
};

export type RuntimeDeps = {
  home: string;
  workspace: string;
  extraRoots: () => string[];
  permissions: () => PermissionSettings;
  isCallActive: () => boolean;
  coworkerEnabled: () => boolean;
  /** Show the person a Yes/No and resolve their answer (false on timeout/close). */
  askApproval: (req: ApprovalRequest, signal: AbortSignal) => Promise<{ approved: boolean; how: string }>;
  browser: CoworkerBrowser;
  chrome?: BrowserCompanionRuntime;
  /** Drives the person's REAL desktop. Absent = screen control is not wired (tools hidden). */
  screen?: ScreenController;
  /** Runs one PowerShell script elevated (UAC). Absent = admin runs unavailable. */
  runElevatedPowerShell?: RunElevatedPowerShell;
  mcp: McpManager;
  journal: Journal;
  shellDeps?: ShellDeps;
  openPath: (p: string) => Promise<void>;
  showInFolder: (p: string) => void;
  diagnostics: { portalUrl: string; appVersion: string; logFile: string; phoneState: () => Record<string, unknown> | null; linkState: () => Record<string, unknown> };
  log: (line: string) => void;
  /** The number of calls in flight changed (0 = idle). Drives the bubble's badge; never awaited. */
  onActivity?: (active: number) => void;
  /** An approval prompt is about to be shown for this call — the link tells the agent to wait for the person. */
  onAwaitingApproval?: (call: { id: string; taskId: string; tool: string }) => void;
  /** Tool families the person switched off (Coworker settings). Read per call. */
  disabledGroups?: () => readonly string[];
  /** True = webmail sites are off limits to the Coworker's browser. Read per call. */
  blockEmail?: () => boolean;
  now?: () => number;
};

export type IncomingCall = { id: string; name: string; args: Record<string, unknown>; taskId: string; conversationId?: string; timeoutMs?: number };
export type CallOutcome = { ok: boolean; content: unknown; verdict: string; durationMs: number };

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export class CoworkerRuntime {
  private active = new Map<string, { taskId: string; name: string; abort: AbortController; children: Set<ChildProcess>; startedAt: number }>();
  private now: () => number;
  constructor(private deps: RuntimeDeps) { this.now = deps.now ?? (() => Date.now()); }

  fsEnv(): FsEnv {
    return { home: this.deps.home, workspace: this.deps.workspace, roots: [this.deps.home, this.deps.workspace, ...this.deps.extraRoots()] };
  }

  /** The manifest the desktop announces: catalogue + connected MCP tools. */
  private groupOff(name: string): ToolGroup | null {
    const g = toolGroup(name);
    if (!g) return null;
    try { return (this.deps.disabledGroups?.() ?? []).includes(g) ? g : null; } catch { return null; }
  }

  manifestTools() {
    const builtin = TOOL_CATALOG.filter(t => this.deps.chrome ? !t.name.startsWith("computer_browser_") : !t.name.startsWith("computer_chrome_")).filter((t) => this.deps.screen ? true : !isScreenSessionTool(t.name)).filter((t) => !this.groupOff(t.name)).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, category: t.spec.category, risk: t.spec.risk, domains: [...t.spec.domains], source: "builtin" as const, timeoutMs: t.spec.timeoutMs }));
    const mcp = this.deps.mcp.tools().map(({ client, tool }) => ({
      name: tool.modelName,
      description: `[${client.config.name}] ${tool.description}`.slice(0, 2000),
      parameters: { type: "object" as const, properties: (tool.inputSchema.properties as Record<string, unknown>) ?? {}, ...(Array.isArray(tool.inputSchema.required) ? { required: tool.inputSchema.required as string[] } : {}), additionalProperties: false as const },
      category: "MCP", risk: tool.spec.risk, domains: [...tool.spec.domains], source: "mcp" as const, server: client.config.id, timeoutMs: tool.spec.timeoutMs,
    }));
    return [...builtin, ...mcp];
  }

  activeCalls() { return [...this.active.values()].map((a) => ({ taskId: a.taskId, name: a.name, runningMs: this.now() - a.startedAt })); }

  private activity() { try { this.deps.onActivity?.(this.active.size); } catch { /* a badge must never break a call */ } }

  /**
   * The turn that owned this task has finished (any outcome). Nothing is aborted —
   * this only releases what the task was HOLDING. Today that is the screen-control
   * session: without it the session sits open until its idle timeout and the very
   * next task is refused `screen_busy`, which is exactly what an acceptance run
   * doing several on-screen jobs in a row hit.
   */
  async taskDone(taskId: string): Promise<void> {
    try { if (this.deps.screen?.isApprovedFor(taskId)) await this.deps.screen.end(taskId, "task_done"); } catch { /* releasing must never throw */ }
  }

  /** Cancel every call of a task (null = all). Aborts approvals, kills shell children, closes the browser. */
  cancel(taskId: string | null): number {
    let n = 0;
    for (const [id, a] of this.active) {
      if (taskId && a.taskId !== taskId) continue;
      a.abort.abort();
      for (const c of a.children) { try { if (c.pid) require("node:child_process").spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); c.kill(); } catch { /* gone */ } }
      this.active.delete(id); n++;
    }
    if (!taskId || n) this.deps.browser.cancel();
    this.deps.chrome?.cancel(taskId);
    this.activity();
    this.deps.log(`cancel task=${taskId ?? "all"} aborted=${n}`);
    return n;
  }

  async handle(call: IncomingCall): Promise<CallOutcome> {
    const startedAt = this.now();
    const abort = new AbortController();
    const rec = { taskId: call.taskId, scopeId: call.conversationId ?? call.taskId, name: call.name, abort, children: new Set<ChildProcess>(), startedAt };
    this.active.set(call.id, rec);
    this.activity();
    const finish = async (ok: boolean, content: unknown, verdict: string, outcome: "done" | "denied" | "failed" | "cancelled" | "timeout", summary?: string) => {
      this.active.delete(call.id);
      this.activity();
      const durationMs = this.now() - startedAt;
      await this.deps.journal.append({ ts: new Date().toISOString(), kind: "call", taskId: call.taskId, callId: call.id, tool: call.name, verdict, outcome, summary: summary ?? summarize(content), args: call.args, durationMs });
      this.deps.log(`call ${call.id.slice(0, 8)} ${call.name} → ${outcome} (${verdict}) ${durationMs}ms`);
      return { ok, content, verdict, durationMs };
    };
    try {
      const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
      const catalog = findTool(call.name);
      if (call.name.startsWith("computer_chrome_")) validateArgs(call.name.slice("computer_chrome_".length) as CommandName, args);
      if (this.deps.chrome && call.name.startsWith("computer_browser_")) return finish(false, {error:"legacy_browser_disabled",message:"Use the real Chrome companion tools."}, "denied", "denied");
      const mcp = catalog ? null : this.deps.mcp.find(call.name);
      if (!catalog && !mcp) return finish(false, { error: "unknown_tool", message: `This computer has no tool named ${call.name}.` }, "unknown", "denied");
      const spec = catalog ? catalog.spec : mcp!.tool.spec;

      /* ── the person's own switches, before any verdict: an agent that announced
       *    earlier (or ignores the manifest) still cannot use a family they turned off ── */
      const off = catalog ? this.groupOff(call.name) : null;
      if (off) {
        const message = `${GROUP_WORDS[off]} is switched off in the Coworker's settings on this computer.`;
        return finish(false, { error: "switched_off", denied: true, group: off, message }, "switched_off", "denied", message);
      }
      if ((call.name === "computer_chrome_open" || call.name === "computer_browser_open" || call.name === "computer_browser_download") && isWebmailUrl(args.url)) {
        let blocked = true;
        try { blocked = this.deps.blockEmail ? this.deps.blockEmail() : true; } catch { blocked = true; }
        if (blocked) {
          const message = "Email is switched off in the Coworker's settings, so it won't open your inbox. Turn Email on in Coworker settings to allow it.";
          return finish(false, { error: "switched_off", denied: true, group: "email", message }, "switched_off", "denied", message);
        }
      }

      /* ── screen control: the per-machine opt-in, and the ask-once-then-flow gate ──
       *    begin() faces the policy ask (alwaysRequireApproval); once the person has
       *    approved it for THIS task, the action tools flow without re-asking (Izzy's
       *    chosen autonomy). The risky sub-actions (delete/pay/send/admin) are separate
       *    tools and still ask through the ordinary gate. A screen action with no open
       *    approved session is refused outright — the mouse never moves by surprise. */
      let screenPreApproved = false;
      if (isScreenSessionTool(call.name)) {
        const sc = this.deps.screen;
        if (!sc) return finish(false, { error: "screen_control_unavailable", denied: true, message: "This computer cannot control its own screen from the Coworker." }, "screen_control_unavailable", "denied");
        if (call.name === "computer_screen_begin" && !sc.isEnabled()) {
          const message = "Screen control is turned off. Turn on “Let the Coworker control the screen” in the Coworker's settings on this computer first.";
          return finish(false, { error: "screen_control_off", denied: true, message }, "screen_control_off", "denied", message);
        }
        if (SCREEN_ACTION_TOOLS.has(call.name)) {
          if (!sc.isApprovedFor(call.taskId)) {
            const message = "Nothing is being controlled on the screen yet. Call computer_screen_begin first — the person approves once, then program and screen actions run without asking again.";
            return finish(false, { error: "screen_not_started", denied: true, message }, "screen_not_started", "denied", message);
          }
          // ⛔ The pre-approval satisfies desktop.active's ask ONLY. A tool that is
          // destructive / alwaysRequireApproval (process kill) still asks on its own.
          screenPreApproved = !(spec.destructive || spec.alwaysRequireApproval === true);
        }
      }

      /* ── PowerShell: the script decides the risk (READ_ONLY / MODIFY / HIGH_RISK),
       *    elevation raises it further, and the cross-tool policy applies BEFORE the
       *    verdict — a protected resource or a path outside the fence is refused
       *    whatever the profile says, exactly as the file tools would refuse it. ── */
      let effSpec = spec;
      if (call.name === "computer_powershell") {
        const script = typeof args.script === "string" ? args.script : "";
        const prot = scriptTouchesProtected(script);
        if (!prot.ok) return finish(false, { error: prot.error, denied: true, message: prot.message }, prot.error, "denied", prot.message);
        for (const lit of scriptPathLiterals(script)) {
          const r = await resolveUserPath(lit, this.fsEnv());
          if (!r.ok && r.error !== "not_found") {
            const message = `The script mentions ${lit}, which is outside the folders the Coworker may use — the same fence the file tools have. ${r.message ?? ""}`.trim();
            return finish(false, { error: `path_fence:${r.error}`, denied: true, message }, `path_fence:${r.error}`, "denied", message);
          }
        }
        const cls = classifyShellScript(script);
        if (args.elevated === true) effSpec = { ...spec, risk: "HIGH", alwaysRequireApproval: true };
        else if (cls.class === "READ_ONLY") effSpec = { ...spec, risk: "READ_ONLY", domains: ["diagnostics"] };
        else if (cls.class === "HIGH_RISK") effSpec = { ...spec, risk: "HIGH", alwaysRequireApproval: true };
        (args as Record<string, unknown>).__shellClass = cls.class;
      }
      if (call.name === "computer_service_control" && args.elevated === true) {
        effSpec = { ...spec, risk: "HIGH", alwaysRequireApproval: true };
      }

      /* ── cross-tool policy for the program tools: a protected path handed to a
       *    program (open it in Notepad, upload it) is refused HERE, in the boundary,
       *    not only in the façade behind the controller ── */
      if (call.name === "computer_app_launch" || call.name === "computer_windows_set_value" || call.name === "computer_chrome_upload" || call.name === "computer_open_path") {
        const candidates: string[] = [];
        for (const k of ["app", "args", "value", "text", "path"]) { const v = args[k]; if (typeof v === "string" && v.trim()) { candidates.push(v.trim()); candidates.push(...v.split(/\s+/)); } }
        for (const raw of candidates) {
          const lit = raw.replace(/^["']|["']$/g, "");
          const v = isProtectedPath(lit);
          if (v.protected && /[\\/]/.test(lit)) {
            const message = `The Coworker will not point a program at ${lit} — it is a place where passwords or keys are kept, and that is refused for every tool.`;
            return finish(false, { error: "protected_resource", denied: true, message }, "protected_resource", "denied", message);
          }
        }
      }

      /* ── the verdict ── */
      const decision = decideToolCall({ spec: effSpec, permissions: normalizePermissions(this.deps.permissions()), provenance: "user", approved: screenPreApproved || undefined, callInProgress: this.deps.isCallActive(), coworkerEnabled: this.deps.coworkerEnabled() });
      if (decision.verdict === "deny") {
        return finish(false, { error: decision.code, denied: true, message: decision.message, domains: decision.domains }, decision.code, "denied", decision.message);
      }
      let chromeAuthorization: string | undefined;
      if (decision.verdict === "ask") {
        await this.deps.journal.append({ ts: new Date().toISOString(), kind: "call", taskId: call.taskId, callId: call.id, tool: call.name, verdict: decision.code, outcome: "asked", args, summary: decision.message });
        const req = this.approvalText(call, catalog ?? null, mcp?.tool.name ?? null, args, decision);
        if (this.deps.chrome && call.name.startsWith("computer_chrome_") && catalog?.spec.alwaysRequireApproval) {
          const prepared = await this.deps.chrome.prepare(call.name.slice("computer_chrome_".length) as CommandName,args,call.taskId,abort.signal,rec.scopeId);
          if (prepared.ok !== true || typeof prepared.authorization !== "string") return finish(false,prepared,"browser_prepare_failed","failed");
          chromeAuthorization = prepared.authorization;
          req.what = `Chrome action: ${call.name.slice("computer_chrome_".length)}\nExact arguments: ${JSON.stringify(args)}\nObserved page and target (untrusted page data): ${JSON.stringify(prepared.description)}\nApprove only if this matches your request. A changed page requires a new approval.`;
        }
        try { this.deps.onAwaitingApproval?.({ id: call.id, taskId: call.taskId, tool: call.name }); } catch { /* the agent's deadline is a courtesy; the prompt shows regardless */ }
        let approvalTimer: ReturnType<typeof setTimeout> | null = null;
        const answer = await Promise.race([
          this.deps.askApproval(req, abort.signal),
          new Promise<{ approved: false; how: string }>((r) => { approvalTimer = setTimeout(() => r({ approved: false, how: "timeout" }), APPROVAL_TIMEOUT_MS); }),
        ]).finally(() => { if (approvalTimer) clearTimeout(approvalTimer); });
        if (abort.signal.aborted) return finish(false, { error: "task_cancelled", message: "The person cancelled the task." }, decision.code, "cancelled");
        if (!answer.approved) {
          const message = answer.how === "timeout" ? "The person did not answer the approval prompt in time, so this did not run." : "The person said No to this action, so it did not run. Do not try to achieve the same thing another way.";
          return finish(false, { error: "needs_approval", approved: false, denied: true, message, domains: decision.domains }, `${decision.code}:${answer.how}`, "denied", message);
        }
        await this.deps.journal.append({ ts: new Date().toISOString(), kind: "call", taskId: call.taskId, callId: call.id, tool: call.name, verdict: decision.code, outcome: "approved", summary: `approved (${answer.how})` });
      }
      if (abort.signal.aborted) return finish(false, { error: "task_cancelled", message: "The person cancelled the task." }, decision.code, "cancelled");

      /* ── run ── */
      const result = mcp
        ? await mcp.client.callTool(mcp.tool.name, args, Math.min(call.timeoutMs ?? 120_000, 10 * 60 * 1000))
        : this.deps.chrome && chromeAuthorization
          ? await (async()=>{const content=await this.deps.chrome!.execute(call.name.slice("computer_chrome_".length) as CommandName,args,call.taskId,abort.signal,rec.scopeId,chromeAuthorization);return {ok:content.ok!==false,content};})()
        : await this.runBuiltin(catalog!, args, rec, abort.signal);
      if (abort.signal.aborted) return finish(false, { error: "task_cancelled", message: "The person cancelled the task; the call may have partly run.", partial: result.content }, decision.code, "cancelled");
      const ok = result.ok !== false && !(result.content && typeof result.content === "object" && (result.content as { ok?: boolean }).ok === false);
      return finish(ok, result.content, decision.verdict === "allow" ? decision.code : "approved_by_user", ok ? "done" : "failed");
    } catch (e: any) {
      const message = String(e?.message ?? e).slice(0, 300);
      return finish(false, { error: "tool_threw", message }, "error", "failed", message);
    }
  }

  private approvalText(call: IncomingCall, catalog: CatalogTool | null, mcpTool: string | null, args: Record<string, unknown>, decision: PolicyDecision): ApprovalRequest {
    const short = (v: unknown, n = 160) => { const s = typeof v === "string" ? v : JSON.stringify(v ?? ""); return s.length > n ? `${s.slice(0, n)}…` : s; };
    let what: string;
    switch (call.name) {
      case "computer_fs_write": what = `Write the file ${short(args.path)} (${Buffer.byteLength(String(args.content ?? ""), "utf8")} bytes${args.append ? ", appending" : ""}).`; break;
      case "computer_fs_mkdir": what = `Create the folder ${short(args.path)}.`; break;
      case "computer_fs_move": what = `Move ${short(args.from)} to ${short(args.to)}.`; break;
      case "computer_fs_copy": what = `Copy ${short(args.from)} to ${short(args.to)}.`; break;
      case "computer_fs_delete": what = `DELETE ${short(args.path)}${args.recursive ? " and everything inside it" : ""}. This cannot be undone.`; break;
      case "computer_powershell": what = `${args.elevated === true ? "Run this PowerShell script AS ADMINISTRATOR (Windows will ask you to confirm too):" : args.__shellClass === "HIGH_RISK" ? "Run this PowerShell script (Loopcom rates it HIGH RISK):" : "Run this PowerShell script:"}\n${short(args.script, 600)}`; break;
      case "computer_service_control": what = `${String(args.action ?? "change").toUpperCase()} the Windows service “${short(args.name, 80)}”${args.elevated === true ? " as administrator (Windows will ask you to confirm too)" : ""}.`; break;
      case "computer_process_kill": what = `END the program ${short(args.name ?? `pid ${args.pid}`, 80)} on this computer. Unsaved work in it would be lost.`; break;
      case "computer_screen_begin": what = `Control your screen — move the mouse and type on your real desktop:\n${short(args.reason, 240)}\nA blue frame will show while it works; press Escape to take back the screen any time.`; break;
      case "computer_browser_open": what = `Open ${short(args.url)} in the Coworker's own background browser.`; break;
      case "computer_browser_download": what = `Download ${short(args.url ?? args.text ?? args.selector)} into the workspace downloads folder.`; break;
      case "computer_browser_submit": what = `Submit the form on ${this.deps.browser.currentUrl() ?? "the current page"}.`; break;
      case "computer_xlsx_write": what = `Create the spreadsheet ${short(args.path)}.`; break;
      case "computer_git_commit": what = `Save a checkpoint of the changes in ${short(args.repo)} with the note: ${short(args.message, 200)}`; break;
      case "computer_git_checkout": what = `${args.create === true ? "Create and switch to" : "Switch"} the project ${short(args.repo)} ${args.create === true ? "" : "to "}branch ${short(args.branch, 80)}.`; break;
      case "computer_git_pull": what = `Get the latest changes from the server for ${short(args.repo)}.`; break;
      case "computer_git_push": what = `SEND the saved changes in ${short(args.repo)} to the server (${short(args.remote ?? "origin", 40)}). This sends code off this computer.`; break;
      case "computer_git_clone": what = `Download the project ${short(args.url)} into ${short(args.into ?? "the coworker workspace")}.`; break;
      default: what = mcpTool ? `Call "${mcpTool}" on MCP server ${call.name.split("_")[1] ?? ""} with ${short(args, 300)}` : `${catalog?.description ?? call.name}\nArguments: ${short(args, 300)}`;
    }
    return {
      callId: call.id, taskId: call.taskId, tool: call.name,
      title: catalog ? titleFor(call.name) : "Use an MCP tool?",
      what, why: decision.message, domains: decision.domains, risk: catalog?.spec.risk ?? "LOW", args,
    };
  }

  private async runBuiltin(tool: CatalogTool, args: Record<string, unknown>, rec: { taskId: string; scopeId: string; children: Set<ChildProcess> }, signal: AbortSignal): Promise<{ ok: boolean; content: unknown }> {
    const env = this.fsEnv();
    const wrap = (content: unknown) => ({ ok: !(content && typeof content === "object" && (content as { ok?: boolean }).ok === false), content });
    switch (tool.name) {
      case "computer_chrome_tabs":
      case "computer_chrome_open":
      case "computer_chrome_read":
      case "computer_chrome_act":
      case "computer_chrome_download":
      case "computer_chrome_upload":
      case "computer_chrome_screenshot":
      case "computer_chrome_wait":
      case "computer_chrome_close":
        return wrap(this.deps.chrome ? await this.deps.chrome.execute(tool.name.slice("computer_chrome_".length) as CommandName, args, rec.taskId, signal, rec.scopeId) : {ok:false,error:"chrome_companion_unavailable"});
      case "computer_workspace": return wrap({
        ok: true, workspace: this.deps.workspace, downloads: path.join(this.deps.workspace, "downloads"), artifacts: path.join(this.deps.workspace, "artifacts"),
        home: this.deps.home, desktop: path.join(this.deps.home, "Desktop"), documents: path.join(this.deps.home, "Documents"), userDownloads: path.join(this.deps.home, "Downloads"),
        hostname: os.hostname(), username: os.userInfo().username, profile: normalizePermissions(this.deps.permissions()).profile, allowedRoots: env.roots,
        note: "Relative paths in the file tools resolve against the workspace.",
      });
      case "computer_fs_list": return wrap(await fsList(args, env));
      case "computer_fs_stat": return wrap(await fsStat(args, env));
      case "computer_fs_read": return wrap(await fsRead(args, env));
      case "computer_fs_search": return wrap(await fsSearch(args, env));
      case "computer_fs_mkdir": return wrap(await fsMkdir(args, env));
      case "computer_fs_write": return wrap(await fsWrite(args, env));
      case "computer_fs_move": return wrap(await fsMove(args, env));
      case "computer_fs_copy": return wrap(await fsCopy(args, env));
      case "computer_fs_delete": return wrap(await fsDelete(args, env));
      case "computer_open_path": {
        const r = await resolveUserPath(args.path, env, { mustExist: true });
        if (!r.ok) return wrap(r);
        const st = await require("node:fs").promises.stat(r.abs);
        if (st.isDirectory()) { const err = await this.deps.openPath(r.abs).then(() => "", (e: Error) => e.message); return wrap(err ? { ok: false, error: "open_failed", message: err } : { ok: true, opened: r.abs, kind: "folder" }); }
        this.deps.showInFolder(r.abs);
        return wrap({ ok: true, opened: r.abs, kind: "file", note: "Shown selected inside its folder in Explorer." });
      }
      case "computer_xlsx_write": {
        const r = await resolveUserPath(args.path, env);
        if (!r.ok) return wrap(r);
        if (!/\.xlsx$/i.test(r.abs)) return wrap({ ok: false, error: "bad_extension", message: "The path must end in .xlsx." });
        // Rows may arrive as arrays or as objects ({vendor, amount}) — objects are
        // laid out in header order when the first row is a header, else by key order.
        const sheets = Array.isArray(args.sheets) ? (args.sheets as Sheet[]).filter((s) => s && Array.isArray(s.rows)).map((s) => {
          const header = Array.isArray(s.rows[0]) ? (s.rows[0] as unknown[]).map((h) => String(h ?? "")) : null;
          const rows = s.rows.slice(0, 50_000).map((row) => {
            if (Array.isArray(row)) return row.slice(0, 500);
            if (row && typeof row === "object") {
              const o = row as Record<string, unknown>;
              if (header && header.some((h) => h in o)) return header.map((h) => o[h] as never);
              return Object.values(o).slice(0, 500) as never[];
            }
            return [];
          });
          return { name: String(s.name ?? "Sheet"), rows };
        }) : [];
        if (!sheets.length) return wrap({ ok: false, error: "no_sheets", message: "sheets must contain at least one sheet with rows." });
        const emptyRows = sheets.reduce((n, s) => n + s.rows.filter((row) => !row.some((v) => v !== null && v !== undefined && v !== "")).length, 0);
        const dataRows = sheets.reduce((n, s) => n + s.rows.length, 0);
        if (dataRows > 0 && emptyRows >= Math.max(2, dataRows / 2)) {
          return wrap({ ok: false, error: "rows_mostly_empty", emptyRows, totalRows: dataRows, message: `${emptyRows} of ${dataRows} rows are empty. Put the real values in the rows (read the source files first) — a spreadsheet of placeholders is not what the person asked for.` });
        }
        await require("node:fs").promises.mkdir(path.dirname(r.abs), { recursive: true });
        const bytes = await writeXlsxFile(r.abs, sheets);
        const back = await readXlsxFile(r.abs, 5).catch(() => null);
        return wrap({ ok: true, path: r.abs, bytes, sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length })), emptyRows, verifiedReadback: !!back && back.sheets.length === sheets.length, note: "Verify with computer_xlsx_read if the contents matter." });
      }
      case "computer_xlsx_read": {
        const r = await resolveUserPath(args.path, env, { mustExist: true });
        if (!r.ok) return wrap(r);
        try { const wb = await readXlsxFile(r.abs, Math.min(Math.max(1, Number(args.maxRows) || 2000), 5000)); return wrap({ ok: true, path: r.abs, ...wb }); }
        catch (e: any) { return wrap({ ok: false, error: "xlsx_unreadable", message: `Could not read that workbook (${String(e?.message ?? e).slice(0, 100)}).` }); }
      }
      case "computer_system_info": return wrap(await systemInfo(this.deps.shellDeps));
      case "computer_processes": return wrap(await processes(args, this.deps.shellDeps));
      case "computer_powershell": {
        // Administrator run (UAC) — the denylist still applies; elevation just runs
        // through the elevated helper instead of the ordinary child process.
        if (args.elevated === true) {
          const script = typeof args.script === "string" ? args.script : "";
          if (!script.trim()) return wrap({ ok: false, error: "empty_script", message: "script is required." });
          const chk = checkShellScript(script);
          if (!chk.ok) return wrap(chk);
          if (!this.deps.runElevatedPowerShell) return wrap({ ok: false, error: "elevation_unavailable", message: "Running as administrator isn't available on this computer." });
          const r = await this.deps.runElevatedPowerShell(script, { timeoutSec: typeof args.timeoutSec === "number" ? args.timeoutSec : undefined, signal });
          return wrap(signal.aborted ? { ...r, ok: false, error: "task_cancelled" } : r);
        }
        const cwdArg = typeof args.cwd === "string" && args.cwd.trim() ? await resolveUserPath(args.cwd, env, { mustExist: true }) : null;
        if (cwdArg && !cwdArg.ok) return wrap(cwdArg);
        const r = await runPowerShellChecked({ ...args, cwd: cwdArg ? cwdArg.abs : undefined }, { defaultCwd: this.deps.workspace, deps: this.deps.shellDeps, onSpawn: (child) => { rec.children.add(child); child.once("exit", () => rec.children.delete(child)); } });
        return wrap(signal.aborted ? { ...r, ok: false, error: "task_cancelled" } : { ...r, classification: args.__shellClass ?? "MODIFY" });
      }
      case "computer_services": return wrap(await services(args, this.deps.shellDeps));
      case "computer_service_control": {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        const action = args.action === "start" || args.action === "stop" || args.action === "restart" ? args.action : null;
        if (!name || !action) return wrap({ ok: false, error: "bad_args", message: "name and action (start|stop|restart) are required." });
        if (/^(?:WinDefend|MpsSvc|wscsvc|SecurityHealthService|Sense|WdNisSvc|BFE|EventLog|RpcSs|DcomLaunch|LSM|Winmgmt|CryptSvc|TrustedInstaller|wuauserv|Loopcom\w*)$/i.test(name)) {
          return wrap({ ok: false, error: "protected_service", message: `The Coworker will not change the ${name} service — it is part of Windows security or Loopcom itself.` });
        }
        if (args.elevated === true) {
          if (!this.deps.runElevatedPowerShell) return wrap({ ok: false, error: "elevation_unavailable", message: "Running as administrator isn't available on this computer." });
          const verb = action === "restart" ? "Restart-Service" : action === "start" ? "Start-Service" : "Stop-Service";
          const r = await this.deps.runElevatedPowerShell(`${verb} -Name ${JSON.stringify(name)} -ErrorAction Stop; Get-Service -Name ${JSON.stringify(name)} | Select-Object Name,Status,StartType | ConvertTo-Json -Compress`, { timeoutSec: 90, signal });
          return wrap(signal.aborted ? { ...r, ok: false, error: "task_cancelled" } : { ...r, name, action, elevated: true });
        }
        return wrap(await serviceControl(name, action, this.deps.shellDeps));
      }
      case "computer_network_info": return wrap(await networkInfo(this.deps.shellDeps));
      case "computer_network_test": return wrap(await networkTest(args, this.deps.shellDeps));
      case "computer_app_launch":
      case "computer_process_kill":
      case "computer_windows_list":
      case "computer_windows_find":
      case "computer_windows_activate":
      case "computer_windows_close":
      case "computer_windows_minimize":
      case "computer_windows_controls":
      case "computer_windows_find_control":
      case "computer_windows_wait_for_control":
      case "computer_windows_invoke":
      case "computer_windows_set_value":
      case "computer_windows_get_value":
      case "computer_windows_select":
      case "computer_windows_toggle":
      case "computer_windows_expand":
      case "computer_windows_collapse":
      case "computer_windows_scroll":
      case "computer_windows_focus":
      case "computer_windows_menu": {
        const sc = this.deps.screen;
        if (!sc || !sc.windows) return wrap({ ok: false, error: "screen_control_unavailable", message: "This computer cannot control its programs from the Coworker." });
        if (isWindowsTool(tool.name)) return wrap(await sc.windows(rec.taskId, tool.name, args));
        return wrap({ ok: false, error: "not_implemented" });
      }
      case "computer_screen_begin": return wrap(this.deps.screen ? await this.deps.screen.begin(rec.taskId, typeof args.reason === "string" ? args.reason : "", signal) : { ok: false, error: "screen_control_unavailable" });
      case "computer_screen_read": return wrap(this.deps.screen ? await this.deps.screen.read(rec.taskId, args) : { ok: false, error: "screen_control_unavailable" });
      case "computer_screen_look": return wrap(this.deps.screen ? await this.deps.screen.look(rec.taskId, args) : { ok: false, error: "screen_control_unavailable" });
      case "computer_screen_click":
      case "computer_screen_type":
      case "computer_screen_key":
      case "computer_screen_scroll":
      case "computer_screen_move": return wrap(this.deps.screen ? await this.deps.screen.act(rec.taskId, tool.name as ScreenActionName, args) : { ok: false, error: "screen_control_unavailable" });
      case "computer_screen_capture": {
        let saveAs: string | undefined;
        if (typeof args.saveAs === "string" && args.saveAs.trim()) { const r = await resolveUserPath(args.saveAs, env); if (!r.ok) return wrap(r); saveAs = r.abs; }
        return wrap(this.deps.screen ? await this.deps.screen.capture(rec.taskId, saveAs) : { ok: false, error: "screen_control_unavailable" });
      }
      case "computer_screen_end": return wrap(this.deps.screen ? await this.deps.screen.end(rec.taskId) : { ok: true, ended: true });
      case "computer_browser_open": return wrap(await this.deps.browser.open(args));
      case "computer_browser_read": return wrap(await this.deps.browser.read(args));
      case "computer_browser_click": return wrap(await this.deps.browser.click(args));
      case "computer_browser_fill": return wrap(await this.deps.browser.fill(args));
      case "computer_browser_select": return wrap(await this.deps.browser.select(args));
      case "computer_browser_check": return wrap(await this.deps.browser.check(args));
      case "computer_browser_submit": return wrap(await this.deps.browser.submit(args));
      case "computer_browser_download": {
        let saveAs: string | null = null;
        if (typeof args.saveAs === "string" && args.saveAs.trim()) { const r = await resolveUserPath(args.saveAs, env); if (!r.ok) return wrap(r); saveAs = r.abs; }
        return wrap(await this.deps.browser.download({ ...args, saveAs }));
      }
      case "computer_browser_screenshot": {
        let saveAs: string | undefined;
        if (typeof args.saveAs === "string" && args.saveAs.trim()) { const r = await resolveUserPath(args.saveAs, env); if (!r.ok) return wrap(r); saveAs = r.abs; }
        return wrap(await this.deps.browser.screenshot(saveAs));
      }
      case "computer_browser_wait": return wrap(await this.deps.browser.wait(args));
      case "computer_browser_close": return wrap(this.deps.browser.close());
      case "computer_git_status":
      case "computer_git_log":
      case "computer_git_diff":
      case "computer_git_branches":
      case "computer_git_commit":
      case "computer_git_checkout":
      case "computer_git_pull":
      case "computer_git_push":
      case "computer_git_clone": {
        const gitDeps = { onSpawn: (child: ChildProcess) => { rec.children.add(child); child.once("exit", () => rec.children.delete(child)); } };
        const run = {
          computer_git_status: gitStatus, computer_git_log: gitLog, computer_git_diff: gitDiff, computer_git_branches: gitBranches,
          computer_git_commit: gitCommit, computer_git_checkout: gitCheckout, computer_git_pull: gitPull, computer_git_push: gitPush, computer_git_clone: gitClone,
        }[tool.name as "computer_git_status"];
        const out = await run(args, env, gitDeps);
        return wrap(signal.aborted ? { ...(out as object), ok: false, error: "task_cancelled" } : out);
      }
      case "computer_diagnostics": return wrap(await runDiagnostics({ ...this.deps.diagnostics, shell: this.deps.shellDeps, computerControl: this.deps.screen?.health ? () => this.deps.screen!.health!() : undefined }, args.sections));
      case "computer_mcp_servers": return wrap({ ok: true, servers: this.deps.mcp.status() });
      case "computer_task_history": {
        const j = await this.deps.journal.recent(Math.min(Math.max(1, Number(args.limit) || 30), 200));
        return wrap({ ok: true, calls: j.calls.map((c) => ({ at: c.ts, tool: c.tool, outcome: c.outcome, verdict: c.verdict, summary: c.summary, taskId: c.taskId, durationMs: c.durationMs })), artifacts: j.artifacts.map((a) => a.artifact) });
      }
      case "computer_artifact_register": {
        const r = await resolveUserPath(args.path, env, { mustExist: true });
        if (!r.ok) return wrap(r);
        const st = await require("node:fs").promises.stat(r.abs);
        const label = typeof args.label === "string" && args.label.trim() ? args.label.trim().slice(0, 120) : path.basename(r.abs);
        await this.deps.journal.append({ ts: new Date().toISOString(), kind: "artifact", taskId: "artifact", artifact: { path: r.abs, label, sizeBytes: st.size } });
        return wrap({ ok: true, registered: { path: r.abs, label, sizeBytes: st.size } });
      }
      default: return wrap({ ok: false, error: "not_implemented", message: `${tool.name} is in the catalogue but has no implementation.` });
    }
  }
}

function titleFor(name: string): string {
  if (name.startsWith("computer_fs_delete")) return "Delete on this computer?";
  if (name.startsWith("computer_fs_")) return "Change a file on this computer?";
  if (name === "computer_xlsx_write") return "Create a spreadsheet?";
  if (name === "computer_git_push") return "Send code off this computer?";
  if (name.startsWith("computer_git_")) return "Change a code project?";
  if (name === "computer_screen_begin") return "Let the Coworker control your screen?";
  if (name === "computer_powershell") return "Run PowerShell on this computer?";
  if (name === "computer_service_control") return "Change a Windows service?";
  if (name === "computer_process_kill") return "End a program?";
  if (name.startsWith("computer_browser_download")) return "Download a file?";
  if (name.startsWith("computer_browser_submit")) return "Submit a web form?";
  if (name.startsWith("computer_browser_")) return "Use the Coworker browser?";
  return "Let the Coworker do this?";
}

function summarize(content: unknown): string {
  if (!content || typeof content !== "object") return String(content ?? "").slice(0, 200);
  const c = content as Record<string, unknown>;
  const keys = ["message", "summary", "path", "to", "url", "title", "error"].filter((k) => typeof c[k] === "string");
  return keys.map((k) => `${k}=${String(c[k]).slice(0, 120)}`).join(" ").slice(0, 300);
}

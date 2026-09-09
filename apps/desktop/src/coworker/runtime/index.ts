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
import { runPowerShellChecked, type ShellDeps } from "./shell";
import { processes, systemInfo } from "./windows";
import { readXlsxFile, writeXlsxFile, type Sheet } from "./xlsx";
import { CoworkerBrowser } from "./browser";
import { runDiagnostics } from "./diagnostics";
import { McpManager } from "./mcp";
import { Journal } from "./journal";

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
  mcp: McpManager;
  journal: Journal;
  shellDeps?: ShellDeps;
  openPath: (p: string) => Promise<void>;
  showInFolder: (p: string) => void;
  diagnostics: { portalUrl: string; appVersion: string; logFile: string; phoneState: () => Record<string, unknown> | null; linkState: () => Record<string, unknown> };
  log: (line: string) => void;
  now?: () => number;
};

export type IncomingCall = { id: string; name: string; args: Record<string, unknown>; taskId: string; timeoutMs?: number };
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
  manifestTools() {
    const builtin = TOOL_CATALOG.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, category: t.spec.category, risk: t.spec.risk, domains: [...t.spec.domains], source: "builtin" as const, timeoutMs: t.spec.timeoutMs }));
    const mcp = this.deps.mcp.tools().map(({ client, tool }) => ({
      name: tool.modelName,
      description: `[${client.config.name}] ${tool.description}`.slice(0, 2000),
      parameters: { type: "object" as const, properties: (tool.inputSchema.properties as Record<string, unknown>) ?? {}, ...(Array.isArray(tool.inputSchema.required) ? { required: tool.inputSchema.required as string[] } : {}), additionalProperties: false as const },
      category: "MCP", risk: tool.spec.risk, domains: [...tool.spec.domains], source: "mcp" as const, server: client.config.id, timeoutMs: tool.spec.timeoutMs,
    }));
    return [...builtin, ...mcp];
  }

  activeCalls() { return [...this.active.values()].map((a) => ({ taskId: a.taskId, name: a.name, runningMs: this.now() - a.startedAt })); }

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
    this.deps.log(`cancel task=${taskId ?? "all"} aborted=${n}`);
    return n;
  }

  async handle(call: IncomingCall): Promise<CallOutcome> {
    const startedAt = this.now();
    const abort = new AbortController();
    const rec = { taskId: call.taskId, name: call.name, abort, children: new Set<ChildProcess>(), startedAt };
    this.active.set(call.id, rec);
    const finish = async (ok: boolean, content: unknown, verdict: string, outcome: "done" | "denied" | "failed" | "cancelled" | "timeout", summary?: string) => {
      this.active.delete(call.id);
      const durationMs = this.now() - startedAt;
      await this.deps.journal.append({ ts: new Date().toISOString(), kind: "call", taskId: call.taskId, callId: call.id, tool: call.name, verdict, outcome, summary: summary ?? summarize(content), args: call.args, durationMs });
      this.deps.log(`call ${call.id.slice(0, 8)} ${call.name} → ${outcome} (${verdict}) ${durationMs}ms`);
      return { ok, content, verdict, durationMs };
    };
    try {
      const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
      const catalog = findTool(call.name);
      const mcp = catalog ? null : this.deps.mcp.find(call.name);
      if (!catalog && !mcp) return finish(false, { error: "unknown_tool", message: `This computer has no tool named ${call.name}.` }, "unknown", "denied");
      const spec = catalog ? catalog.spec : mcp!.tool.spec;

      /* ── the verdict ── */
      const decision = decideToolCall({ spec, permissions: normalizePermissions(this.deps.permissions()), provenance: "user", callInProgress: this.deps.isCallActive(), coworkerEnabled: this.deps.coworkerEnabled() });
      if (decision.verdict === "deny") {
        return finish(false, { error: decision.code, denied: true, message: decision.message, domains: decision.domains }, decision.code, "denied", decision.message);
      }
      if (decision.verdict === "ask") {
        await this.deps.journal.append({ ts: new Date().toISOString(), kind: "call", taskId: call.taskId, callId: call.id, tool: call.name, verdict: decision.code, outcome: "asked", args, summary: decision.message });
        const req = this.approvalText(call, catalog ?? null, mcp?.tool.name ?? null, args, decision);
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
      case "computer_powershell": what = `Run this PowerShell script:\n${short(args.script, 600)}`; break;
      case "computer_browser_open": what = `Open ${short(args.url)} in the Coworker's own background browser.`; break;
      case "computer_browser_download": what = `Download ${short(args.url ?? args.text ?? args.selector)} into the workspace downloads folder.`; break;
      case "computer_browser_submit": what = `Submit the form on ${this.deps.browser.currentUrl() ?? "the current page"}.`; break;
      case "computer_xlsx_write": what = `Create the spreadsheet ${short(args.path)}.`; break;
      default: what = mcpTool ? `Call "${mcpTool}" on MCP server ${call.name.split("_")[1] ?? ""} with ${short(args, 300)}` : `${catalog?.description ?? call.name}\nArguments: ${short(args, 300)}`;
    }
    return {
      callId: call.id, taskId: call.taskId, tool: call.name,
      title: catalog ? titleFor(call.name) : "Use an MCP tool?",
      what, why: decision.message, domains: decision.domains, risk: catalog?.spec.risk ?? "LOW", args,
    };
  }

  private async runBuiltin(tool: CatalogTool, args: Record<string, unknown>, rec: { children: Set<ChildProcess> }, signal: AbortSignal): Promise<{ ok: boolean; content: unknown }> {
    const env = this.fsEnv();
    const wrap = (content: unknown) => ({ ok: !(content && typeof content === "object" && (content as { ok?: boolean }).ok === false), content });
    switch (tool.name) {
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
        const cwdArg = typeof args.cwd === "string" && args.cwd.trim() ? await resolveUserPath(args.cwd, env, { mustExist: true }) : null;
        if (cwdArg && !cwdArg.ok) return wrap(cwdArg);
        const r = await runPowerShellChecked({ ...args, cwd: cwdArg ? cwdArg.abs : undefined }, { defaultCwd: this.deps.workspace, deps: this.deps.shellDeps, onSpawn: (child) => { rec.children.add(child); child.once("exit", () => rec.children.delete(child)); } });
        return wrap(signal.aborted ? { ...r, ok: false, error: "task_cancelled" } : r);
      }
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
      case "computer_diagnostics": return wrap(await runDiagnostics({ ...this.deps.diagnostics, shell: this.deps.shellDeps }, args.sections));
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
  if (name === "computer_powershell") return "Run PowerShell on this computer?";
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

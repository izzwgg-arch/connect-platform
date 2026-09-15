/**
 * Plain-English step labels for the Coworker's live activity feed.
 *
 * ⛔ NO CODE ON SCREEN (Izzy, 2026-09-15: "No code, though"). A tool call is shown
 * as "Files · Looking in your Downloads folder", never as `computer_fs_list
 * {"path":…}`. Arguments are read only to name the THING being worked on — a
 * folder, a file, a website — and a PowerShell script is never echoed.
 *
 * ⛔ Pure. No I/O. Every string here is what a customer reads.
 */
import type { StepKind, StepResource, StepState } from "./activity";

export type StepDescription = { kind: StepKind; label: string; resource?: StepResource };
export type StepOutcome = { state: Exclude<StepState, "running" | "waiting">; label?: string; detail: string[]; changed?: string; resource?: StepResource };

const s = (v: unknown): string => (typeof v === "string" ? v : "");

/** Last segment of a Windows or POSIX path, never the whole path. */
export function baseName(p: unknown): string {
  const raw = s(p).trim().replace(/[\\/]+$/, "");
  if (!raw) return "";
  const parts = raw.split(/[\\/]/);
  return parts[parts.length - 1] || raw;
}

/** "your Downloads folder" for the well-known folders, otherwise "the Invoices folder". */
export function folderPhrase(p: unknown): string {
  const b = baseName(p);
  if (!b) return "your workspace";
  if (/^(downloads|desktop|documents|pictures|music|videos)$/i.test(b)) return `your ${b[0].toUpperCase()}${b.slice(1).toLowerCase()} folder`;
  if (/^[a-z]:$/i.test(b)) return `the ${b.toUpperCase()} drive`;
  return `the ${b} folder`;
}

export function hostOf(url: unknown): string {
  try { return new URL(s(url)).hostname.replace(/^www\./, ""); } catch { return s(url).slice(0, 60) || "a website"; }
}

function humanize(name: string): string {
  return name.replace(/^mcp_[a-z0-9]+_/, "").replace(/^computer_/, "").replace(/_/g, " ").trim() || "a tool";
}

export function describeStep(name: string, args: Record<string, unknown> = {}): StepDescription {
  const path = s(args.path);
  const file = baseName(path);
  switch (name) {
    /* ── orientation & files ── */
    case "computer_workspace": return { kind: "files", label: "Checking where your folders are" };
    case "computer_fs_list": return { kind: "files", label: `Looking in ${folderPhrase(path)}`, resource: { kind: "folder", title: path || "Workspace" } };
    case "computer_fs_stat": return { kind: "files", label: `Checking ${file || "a file"}`, resource: { kind: "file", title: path } };
    case "computer_fs_read": return { kind: "files", label: `Reading ${file || "a file"}`, resource: { kind: "file", title: path } };
    case "computer_fs_search": return { kind: "files", label: `Searching ${folderPhrase(path)}${s(args.pattern) && s(args.pattern) !== "*" ? ` for ${s(args.pattern)}` : ""}`, resource: { kind: "folder", title: path } };
    case "computer_fs_mkdir": return { kind: "files", label: `Creating the folder ${file || "a folder"}`, resource: { kind: "folder", title: path } };
    case "computer_fs_write": return { kind: "files", label: `${args.append === true ? "Adding to" : "Saving"} ${file || "a file"}`, resource: { kind: "file", title: path } };
    case "computer_fs_move": return { kind: "files", label: `Moving ${baseName(args.from) || "a file"} to ${folderPhraseOrName(args.to)}`, resource: { kind: "file", title: s(args.to) } };
    case "computer_fs_copy": return { kind: "files", label: `Copying ${baseName(args.from) || "a file"} to ${folderPhraseOrName(args.to)}`, resource: { kind: "file", title: s(args.to) } };
    case "computer_fs_delete": return { kind: "files", label: `Deleting ${file || "a file"}`, resource: { kind: "file", title: path } };
    case "computer_open_path": return { kind: "files", label: `Showing you ${file || "the result"}`, resource: { kind: "file", title: path } };
    /* ── spreadsheets ── */
    case "computer_xlsx_write": return { kind: "sheet", label: `Making the spreadsheet ${file || ""}`.trim(), resource: { kind: "sheet", title: path } };
    case "computer_xlsx_read": return { kind: "sheet", label: `Reading the spreadsheet ${file || ""}`.trim(), resource: { kind: "sheet", title: path } };
    /* ── this computer ── */
    case "computer_system_info": return { kind: "system", label: "Checking this computer", resource: { kind: "system", title: "This computer" } };
    case "computer_processes": return { kind: "system", label: "Looking at the programs that are running" };
    case "computer_powershell": return { kind: "shell", label: "Running a command on this computer" };
    case "computer_diagnostics": return { kind: "system", label: "Running a checkup on this computer", resource: { kind: "system", title: "Checkup" } };
    case "computer_mcp_servers": return { kind: "mcp", label: "Checking your connected apps" };
    case "computer_task_history": return { kind: "think", label: "Looking at what I did earlier" };
    case "computer_artifact_register": return { kind: "files", label: `Saving ${file || "the result"} to your results`, resource: { kind: "file", title: path } };
    /* ── the Coworker's browser (real Chrome profile, or the hidden fallback) ── */
    case "computer_chrome_tabs": return { kind: "web", label: "Checking the pages it has open" };
    case "computer_chrome_open":
    case "computer_browser_open": return { kind: "web", label: `Opening ${hostOf(args.url)}`, resource: { kind: "web", title: hostOf(args.url) } };
    case "computer_chrome_read":
    case "computer_browser_read": return { kind: "web", label: s(args.query) ? `Looking for “${s(args.query).slice(0, 40)}” on the page` : "Reading the page" };
    case "computer_chrome_act": return { kind: "web", label: chromeActLabel(args) };
    case "computer_browser_click": return { kind: "web", label: s(args.text) ? `Clicking “${s(args.text).slice(0, 40)}”` : "Clicking on the page" };
    case "computer_browser_fill": return { kind: "web", label: s(args.label) ? `Filling in ${s(args.label).slice(0, 40)}` : "Filling in a field" };
    case "computer_browser_select": return { kind: "web", label: s(args.option) ? `Choosing “${s(args.option).slice(0, 40)}”` : "Choosing an option" };
    case "computer_browser_check": return { kind: "web", label: args.checked === false ? "Unticking a box" : "Ticking a box" };
    case "computer_browser_submit": return { kind: "web", label: "Sending the form" };
    case "computer_chrome_download":
    case "computer_browser_download": return { kind: "web", label: "Downloading a file" };
    case "computer_chrome_upload": return { kind: "web", label: `Uploading ${file || "a file"}` };
    case "computer_chrome_screenshot":
    case "computer_browser_screenshot": return { kind: "web", label: "Taking a picture of the page" };
    case "computer_chrome_wait":
    case "computer_browser_wait": return { kind: "web", label: "Waiting for the page" };
    case "computer_chrome_close":
    case "computer_browser_close": return { kind: "web", label: "Closing the page" };
    /* ── code folders (git) ── */
    case "computer_git_status": return { kind: "git", label: `Checking what changed in ${repoName(args)}`, resource: { kind: "repo", title: s(args.repo) } };
    case "computer_git_log": return { kind: "git", label: `Reading the history of ${repoName(args)}`, resource: { kind: "repo", title: s(args.repo) } };
    case "computer_git_diff": return { kind: "git", label: `Looking at the changes in ${repoName(args)}`, resource: { kind: "repo", title: s(args.repo) } };
    case "computer_git_branches": return { kind: "git", label: `Checking the branches of ${repoName(args)}`, resource: { kind: "repo", title: s(args.repo) } };
    case "computer_git_commit": return { kind: "git", label: `Saving a checkpoint in ${repoName(args)}`, resource: { kind: "repo", title: s(args.repo) } };
    case "computer_git_checkout": return { kind: "git", label: `Switching ${repoName(args)} to ${s(args.branch).slice(0, 40) || "another branch"}`, resource: { kind: "repo", title: s(args.repo) } };
    case "computer_git_pull": return { kind: "git", label: `Getting the latest changes for ${repoName(args)}`, resource: { kind: "repo", title: s(args.repo) } };
    case "computer_git_push": return { kind: "git", label: `Sending ${repoName(args)}'s changes up`, resource: { kind: "repo", title: s(args.repo) } };
    case "computer_git_clone": return { kind: "git", label: `Downloading the project ${hostRepo(args.url)}`, resource: { kind: "repo", title: hostRepo(args.url) } };
    /* ── the phone system & account (platform tools) ── */
    case "extension_status": return { kind: "phone", label: s(args.extension) ? `Checking extension ${s(args.extension)}` : "Checking your extensions", resource: { kind: "phone", title: "Extensions" } };
    case "call_history": return { kind: "phone", label: s(args.extension) ? `Looking at recent calls for extension ${s(args.extension)}` : "Looking at your recent calls", resource: { kind: "phone", title: "Call history" } };
    case "voicemails": return { kind: "phone", label: "Checking your voicemail", resource: { kind: "phone", title: "Voicemail" } };
    case "call_quality": return { kind: "phone", label: "Checking call quality", resource: { kind: "phone", title: "Call quality" } };
    case "port_status": return { kind: "phone", label: "Checking your number transfer" };
    case "list_contacts": return { kind: "phone", label: "Looking up your contacts" };
    case "account_setup_info": return { kind: "account", label: "Looking at your account" };
    case "prepare_add_extension": return { kind: "account", label: "Preparing a new extension" };
    case "prepare_enable_sms": return { kind: "account", label: "Preparing texting for your number" };
    case "search_phone_numbers": return { kind: "phone", label: "Searching for available phone numbers" };
    case "prepare_add_phone_number": return { kind: "account", label: "Preparing a new phone number" };
    case "prepare_permission_grant": return { kind: "account", label: "Preparing a permission change" };
    case "my_requests": return { kind: "account", label: "Checking your requests" };
    case "mark_my_chats_read": return { kind: "account", label: "Marking your chats as read" };
    case "cancel_my_requests": return { kind: "account", label: "Cancelling your requests" };
    case "coworker_task": return { kind: "files", label: "Preparing a task for your computer" };
    case "my_computer_tasks": return { kind: "think", label: "Checking tasks on your computer" };
    case "investigate": return { kind: "think", label: "Looking it up in the records" };
    case "read_file": return { kind: "think", label: "Reading a system file" };
    case "list_files": return { kind: "think", label: "Looking through system files" };
    case "run_command": return { kind: "think", label: "Checking the server" };
    case "browse": return { kind: "web", label: "Opening a Loopcom page" };
    case "ask_person": return { kind: "ask", label: "Asking you a question" };
    default:
      if (name.startsWith("mcp_")) {
        const server = name.split("_")[1] ?? "";
        return { kind: "mcp", label: `Using ${server ? `${server}: ` : ""}${humanize(name)}` };
      }
      return { kind: "think", label: `Using ${humanize(name)}` };
  }
}

function folderPhraseOrName(p: unknown): string {
  const b = baseName(p);
  return b && /\.[a-z0-9]{1,6}$/i.test(b) ? b : folderPhrase(p);
}

function repoName(args: Record<string, unknown>): string {
  return baseName(args.repo) || "the project";
}

function hostRepo(url: unknown): string {
  const u = s(url);
  const m = /([^/:]+?)(?:\.git)?\/?$/.exec(u);
  return m?.[1] || "a project";
}

function chromeActLabel(args: Record<string, unknown>): string {
  const v = s(args.value).slice(0, 40);
  switch (s(args.action)) {
    case "click": return "Clicking on the page";
    case "fill": return v ? "Typing into a field" : "Filling in a field";
    case "select": return v ? `Choosing “${v}”` : "Choosing an option";
    case "check": return args.checked === false ? "Unticking a box" : "Ticking a box";
    case "scroll": return "Scrolling the page";
    case "hover": return "Pointing at something on the page";
    case "focus": return "Selecting a field";
    case "submit": return "Sending the form";
    default: return "Working on the page";
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const bytes = (n: unknown): string => {
  const b = typeof n === "number" && Number.isFinite(n) ? n : 0;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} bytes`;
};

/**
 * Turn a tool's result into what the step shows when it finishes. Denials,
 * cancellations and the person's own "No" read as exactly that, in their words.
 */
export function summarizeResult(name: string, ok: boolean, content: unknown): StepOutcome {
  const c = (content && typeof content === "object" ? content : {}) as Record<string, any>;
  const error = typeof c.error === "string" ? c.error : "";
  const msg = typeof c.message === "string" ? c.message : "";

  if (error === "needs_approval" && (c.denied || c.approved === false)) {
    return { state: "denied", detail: [/in time/i.test(msg) ? "Nobody answered the approval box in time, so this didn't run." : "You said no, so this didn't run."] };
  }
  if (error === "task_cancelled") return { state: "cancelled", detail: ["Stopped before this finished."] };
  if (error === "desktop_not_connected") return { state: "failed", detail: ["The Loopcom app on your computer isn't connected."] };
  if (error === "desktop_timeout") return { state: "failed", detail: ["Your computer didn't finish this in time."] };
  if (error === "switched_off") return { state: "denied", detail: [msg || "This is switched off in Coworker settings."] };
  if (c.denied === true || error === "domain_denied" || error.startsWith("prohibited:") || error === "deferred_during_call") {
    return { state: "denied", detail: [msg || "Your Coworker settings don't allow this."] };
  }
  if (!ok || c.ok === false) {
    return { state: "failed", detail: [msg ? plain(msg) : "This didn't work."] };
  }

  switch (name) {
    case "computer_fs_list": {
      const entries: any[] = Array.isArray(c.entries) ? c.entries : [];
      const folders = entries.filter((e) => e?.kind === "folder").length;
      const files = entries.length - folders;
      return { state: "done", detail: [entries.length ? `Found ${count(files, "file")} and ${count(folders, "folder")}${c.truncated ? " (list cut short)" : ""}` : "The folder is empty"] };
    }
    case "computer_fs_search": return { state: "done", detail: [`Found ${count(Number(c.count) || 0, "match", "matches")}${c.truncated ? " (list cut short)" : ""}`] };
    case "computer_fs_stat": return { state: "done", detail: [c.exists === false ? "It doesn't exist" : `${c.kind === "folder" ? "Folder" : "File"}${c.kind === "file" ? `, ${bytes(c.sizeBytes)}` : ""}`] };
    case "computer_fs_read": return { state: "done", detail: [c.binary ? `Not a text file (${bytes(c.sizeBytes)})` : `Read ${count(Number(c.returnedChars) || 0, "character")}${c.truncated ? " so far" : ""}`] };
    case "computer_fs_mkdir": return { state: "done", detail: [c.created === false ? "The folder was already there" : "Folder created"], ...(c.created === false ? {} : { changed: "1 folder created" }) };
    case "computer_fs_write": return { state: "done", detail: [`${c.mode === "appended" ? "Added" : "Saved"} ${bytes(c.bytesWritten)}`], changed: `${baseName(c.path) || "1 file"} ${c.mode === "created" ? "created" : "updated"}` };
    case "computer_fs_move": return { state: "done", detail: [`Now at ${baseName(c.to) || "its new place"}`], changed: `${baseName(c.from) || "1 item"} moved` };
    case "computer_fs_copy": return { state: "done", detail: [`Copied${c.bytes ? ` ${bytes(c.bytes)}` : ""}`], changed: `${baseName(c.to) || "1 item"} copied` };
    case "computer_fs_delete": return { state: "done", detail: ["Deleted"], changed: `${baseName(c.path) || "1 item"} deleted` };
    case "computer_xlsx_write": {
      const sheets: any[] = Array.isArray(c.sheets) ? c.sheets : [];
      const rows = sheets.reduce((n, sh) => n + (Number(sh?.rows) || 0), 0);
      return { state: "done", detail: [`${count(sheets.length, "sheet")}, ${count(rows, "row")}`], changed: `${baseName(c.path) || "Spreadsheet"} created`, resource: { kind: "sheet", title: s(c.path) } };
    }
    case "computer_xlsx_read": {
      const sheets: any[] = Array.isArray(c.sheets) ? c.sheets : [];
      const rows = sheets.reduce((n, sh) => n + (Array.isArray(sh?.rows) ? sh.rows.length : 0), 0);
      return { state: "done", detail: [`${count(sheets.length, "sheet")}, ${count(rows, "row")}`] };
    }
    case "computer_chrome_open":
    case "computer_browser_open": return { state: "done", detail: [s(c.title) ? `Opened “${s(c.title).slice(0, 80)}”` : "Page opened"], resource: { kind: "web", title: s(c.title) || hostOf(c.url) } };
    case "computer_chrome_download":
    case "computer_browser_download": return { state: "done", detail: [`Saved ${baseName(c.path) || "the file"}${c.sizeBytes ? ` (${bytes(c.sizeBytes)})` : ""}`], changed: `${baseName(c.path) || "1 file"} downloaded` };
    case "computer_git_commit": return { state: "done", detail: [s(c.summary) || "Checkpoint saved"], changed: "1 checkpoint saved" };
    case "computer_git_push": return { state: "done", detail: [s(c.summary) || "Changes sent"], changed: "Changes sent up" };
    case "computer_git_pull": return { state: "done", detail: [s(c.summary) || "Up to date"] };
    case "computer_git_clone": return { state: "done", detail: [s(c.summary) || "Project downloaded"], changed: `${baseName(c.path) || "Project"} downloaded` };
    case "computer_git_checkout": return { state: "done", detail: [s(c.summary) || "Switched"] };
    case "computer_git_status":
    case "computer_git_log":
    case "computer_git_diff":
    case "computer_git_branches": return { state: "done", detail: [s(c.summary) || "Done"] };
    case "computer_diagnostics": {
      const checks: any[] = Array.isArray(c.checks) ? c.checks : [];
      const bad = checks.filter((k) => k?.status === "fail").length;
      const warn = checks.filter((k) => k?.status === "warn").length;
      return { state: "done", detail: [checks.length ? `${count(checks.length, "check")}: ${bad} failed, ${warn} to look at` : "Checkup finished"] };
    }
    default: {
      const firstList = ["entries", "items", "results", "matches", "files", "calls", "rows", "messages", "voicemails", "extensions", "contacts", "numbers", "buckets"]
        .map((k) => (Array.isArray(c[k]) ? { k, n: c[k].length } : null)).find(Boolean);
      if (firstList) return { state: "done", detail: [`Found ${count(firstList.n, firstList.k.replace(/s$/, ""))}`] };
      if (typeof c.summary === "string" && c.summary.length <= 200) return { state: "done", detail: [plain(c.summary)] };
      return { state: "done", detail: [] };
    }
  }
}

/** Strip anything code-shaped from a message before a customer reads it. */
export function plain(text: string): string {
  return String(text ?? "")
    .replace(/`+/g, "")
    .replace(/\b(?:computer|mcp)_[a-z0-9_]+\b/g, "that step")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

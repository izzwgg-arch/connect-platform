/**
 * The Coworker's hands — the catalogue the desktop announces to the agent.
 *
 * ⛔ EVERY TOOL DECLARES ITS OWN RISK AND DOMAINS, and policyCore.decideToolCall
 * judges the call from THAT declaration (never from the model's wording). A tool
 * that forgets to declare is a compile error, not a default of "probably fine".
 *
 * ⛔ The model sees `name`, `description` and `parameters`; the runtime maps the
 * name to an implementation in runtime/. Adding a tool means adding it HERE (so the
 * agent learns of it) and in runtime/index.ts (so it can run); the test proves the
 * two lists match.
 *
 * ⛔ Pure. No fs, no Electron.
 */
import type { CoworkerToolSpec, PermissionDomain, RiskLevel, ToolCategory } from "./policyCore";
import { CHROME_TOOLS } from "./browserCompanion/catalog";

export type JsonSchema = { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: false };

export type CatalogTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
  spec: CoworkerToolSpec;
};

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });

function spec(name: string, category: ToolCategory, risk: RiskLevel, domains: PermissionDomain[], o: Partial<CoworkerToolSpec> = {}): CoworkerToolSpec {
  return {
    name, description: name, category, risk, domains,
    destructive: false, networked: category === "BROWSER" || category === "MCP", exfiltrationCapable: false,
    timeoutMs: 60_000, maxRetries: 0, ...o,
  };
}

const PATH_NOTE = "Absolute Windows path (C:\\Users\\...\\file.txt) or a path relative to the coworker workspace.";

export const TOOL_CATALOG: readonly CatalogTool[] = [
  ...CHROME_TOOLS,
  /* ── orientation ── */
  {
    name: "computer_workspace",
    description: "Where things are on this computer: the coworker test workspace, the person's home, Desktop, Documents and Downloads folders, the workspace downloads folder the browser saves into, the hostname and the current permission profile. Call this first when a request mentions the workspace or a well-known folder.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    spec: spec("computer_workspace", "FILESYSTEM", "READ_ONLY", ["files.read"], { timeoutMs: 10_000 }),
  },
  /* ── filesystem ── */
  {
    name: "computer_fs_list",
    description: "List a folder: names, kind (file/folder), sizes and modified times. Optionally recursive (depth-limited). Use it to verify what exists before and after you change something.",
    parameters: { type: "object", properties: { path: str(PATH_NOTE), recursive: bool("Include subfolders (max depth 6). Default false."), maxEntries: num("Cap on entries returned (default 500, max 5000).") }, required: ["path"], additionalProperties: false },
    spec: spec("computer_fs_list", "FILESYSTEM", "READ_ONLY", ["files.read"]),
  },
  {
    name: "computer_fs_stat",
    description: "Does a file or folder exist, and what is it: kind, size in bytes, created/modified times, full resolved path. The cheapest way to verify a side effect.",
    parameters: { type: "object", properties: { path: str(PATH_NOTE) }, required: ["path"], additionalProperties: false },
    spec: spec("computer_fs_stat", "FILESYSTEM", "READ_ONLY", ["files.read"], { timeoutMs: 10_000 }),
  },
  {
    name: "computer_fs_read",
    description: "Read a text file (txt, csv, json, md, log, html, xml…) and return its contents (cut at maxChars, default 20000; says so when cut). A binary file returns its size and type instead. For .xlsx use computer_xlsx_read.",
    parameters: { type: "object", properties: { path: str(PATH_NOTE), maxChars: num("Characters to return (default 20000, max 100000)."), offset: num("Character offset to start from, for long files.") }, required: ["path"], additionalProperties: false },
    spec: spec("computer_fs_read", "FILESYSTEM", "READ_ONLY", ["files.read"]),
  },
  {
    name: "computer_fs_search",
    description: "Find files by name pattern under a folder, recursively: e.g. pattern '*.txt' or 'invoice*.csv'. Returns full paths, sizes and modified times.",
    parameters: { type: "object", properties: { path: str("Folder to search. " + PATH_NOTE), pattern: str("Glob on the file name: * and ? wildcards, case-insensitive. Default '*'."), maxResults: num("Default 200, max 2000."), includeFolders: bool("Also return folders whose name matches. Default false.") }, required: ["path"], additionalProperties: false },
    spec: spec("computer_fs_search", "FILESYSTEM", "READ_ONLY", ["files.read"], { timeoutMs: 120_000 }),
  },
  {
    name: "computer_fs_mkdir",
    description: "Create a folder (and any missing parents). Succeeds if it already exists and says so.",
    parameters: { type: "object", properties: { path: str(PATH_NOTE) }, required: ["path"], additionalProperties: false },
    spec: spec("computer_fs_mkdir", "FILESYSTEM", "LOW", ["files.read", "files.write"], { timeoutMs: 15_000 }),
  },
  {
    name: "computer_fs_write",
    description: "Write a text file (create or overwrite; or append). Creates the parent folder if needed. Returns the resolved path and byte count — still verify with computer_fs_stat or computer_fs_read when it matters.",
    parameters: { type: "object", properties: { path: str(PATH_NOTE), content: str("The text to write (UTF-8)."), append: bool("Append instead of overwrite. Default false."), overwrite: bool("Allow replacing an existing file. Default true; pass false to refuse if it exists.") }, required: ["path", "content"], additionalProperties: false },
    spec: spec("computer_fs_write", "FILESYSTEM", "LOW", ["files.read", "files.write"], { timeoutMs: 30_000 }),
  },
  {
    name: "computer_fs_move",
    description: "Move or rename a file or folder. The destination may be a new name in the same folder or a path in another folder. Never overwrites: fails if the destination exists.",
    parameters: { type: "object", properties: { from: str(PATH_NOTE), to: str("Destination path or new name. " + PATH_NOTE) }, required: ["from", "to"], additionalProperties: false },
    spec: spec("computer_fs_move", "FILESYSTEM", "LOW", ["files.read", "files.write"], { timeoutMs: 60_000 }),
  },
  {
    name: "computer_fs_copy",
    description: "Copy a file (or a folder, recursively) to a new path or into a folder. Never overwrites: fails if the destination exists. Returns both paths and the byte count copied.",
    parameters: { type: "object", properties: { from: str(PATH_NOTE), to: str("Destination file path, or an existing folder to copy into. " + PATH_NOTE) }, required: ["from", "to"], additionalProperties: false },
    spec: spec("computer_fs_copy", "FILESYSTEM", "LOW", ["files.read", "files.write"], { timeoutMs: 120_000 }),
  },
  {
    name: "computer_fs_delete",
    description: "Delete a file or an EMPTY folder (recursive:true for a folder with contents). This cannot be undone, so the person is always asked first. Only use it when they explicitly asked for a deletion.",
    parameters: { type: "object", properties: { path: str(PATH_NOTE), recursive: bool("Delete a folder and everything in it. Default false.") }, required: ["path"], additionalProperties: false },
    spec: spec("computer_fs_delete", "FILESYSTEM", "DESTRUCTIVE", ["files.read", "files.delete"], { destructive: true, timeoutMs: 60_000 }),
  },
  {
    name: "computer_open_path",
    description: "Show a file or folder to the person: opens the folder in Windows Explorer (a file is shown selected inside its folder; nothing is executed). Use after creating results they asked to see.",
    parameters: { type: "object", properties: { path: str(PATH_NOTE) }, required: ["path"], additionalProperties: false },
    spec: spec("computer_open_path", "WINDOWS", "LOW", ["files.read"], { timeoutMs: 10_000 }),
  },
  /* ── spreadsheets ── */
  {
    name: "computer_xlsx_write",
    description: "Create a real Excel workbook (.xlsx) from rows. Each sheet is a name plus a 2-D array of cell values (strings or numbers; first row is usually the header; a string starting with '=' is a formula, e.g. '=SUM(D2:D4)'). Put the REAL values in the rows — read the source files first and fill every data row; a sheet of empty placeholder rows is refused. Use this when the person asks for a spreadsheet or Excel file; use computer_fs_write with CSV text when they ask for a CSV.",
    parameters: { type: "object", properties: { path: str("Destination .xlsx path. " + PATH_NOTE), sheets: { type: "array", description: "One or more sheets.", items: { type: "object", properties: { name: { type: "string" }, rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "null"] } } } }, required: ["name", "rows"] } } }, required: ["path", "sheets"], additionalProperties: false },
    spec: spec("computer_xlsx_write", "FILESYSTEM", "LOW", ["files.read", "files.write"], { timeoutMs: 60_000 }),
  },
  {
    name: "computer_xlsx_read",
    description: "Read an Excel workbook (.xlsx): every sheet's rows as text/number cells (capped at 2000 rows per sheet).",
    parameters: { type: "object", properties: { path: str(PATH_NOTE), maxRows: num("Rows per sheet (default 2000).") }, required: ["path"], additionalProperties: false },
    spec: spec("computer_xlsx_read", "FILESYSTEM", "READ_ONLY", ["files.read"], { timeoutMs: 60_000 }),
  },
  /* ── Windows ── */
  {
    name: "computer_system_info",
    description: "Facts about this computer, measured now: Windows edition/version/build, uptime since last boot, CPU count and load, memory total/free/used, every fixed drive's free and total space, hostname, signed-in Windows user. Changes nothing.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    spec: spec("computer_system_info", "WINDOWS", "READ_ONLY", ["diagnostics"], { timeoutMs: 30_000 }),
  },
  {
    name: "computer_processes",
    description: "Running processes, sorted by memory (default) or CPU time: name, PID, working-set memory, CPU seconds. Filter by name to find a specific program (e.g. 'Loopcom'). Changes nothing.",
    parameters: { type: "object", properties: { sortBy: { type: "string", enum: ["memory", "cpu"], description: "Default memory." }, limit: num("Default 10, max 200."), nameFilter: str("Case-insensitive substring of the process name.") }, additionalProperties: false },
    spec: spec("computer_processes", "WINDOWS", "READ_ONLY", ["diagnostics"], { timeoutMs: 30_000 }),
  },
  {
    name: "computer_services",
    description: "Windows services: list them (name, display name, status, start type) or query one by name. Changes nothing. Use it for 'is service X running?' before any restart.",
    parameters: { type: "object", properties: { name: str("Service name or display name to query (optional; substring match)."), status: { type: "string", enum: ["running", "stopped", "all"], description: "Filter for the list. Default all." }, limit: num("Default 50, max 300.") }, additionalProperties: false },
    spec: spec("computer_services", "WINDOWS", "READ_ONLY", ["diagnostics"], { timeoutMs: 30_000 }),
  },
  {
    name: "computer_service_control",
    description: "Start, stop or restart ONE Windows service by name. Always asks the person first (it changes the computer), and Windows may additionally require administrator rights — if it does, the result says so and you can retry with elevated:true. Never used for Loopcom's own security, Defender or the firewall.",
    parameters: { type: "object", properties: { name: str("The service name (e.g. Spooler)."), action: { type: "string", enum: ["start", "stop", "restart"] }, elevated: bool("Run through the Windows administrator prompt (the person clicks Yes). Default false.") }, required: ["name", "action"], additionalProperties: false },
    spec: spec("computer_service_control", "WINDOWS", "HIGH", ["windows.services"], { alwaysRequireApproval: true, timeoutMs: 120_000 }),
  },
  {
    name: "computer_network_info",
    description: "This computer's network, measured now: adapters with IPv4/IPv6 and status, default gateway, DNS servers, whether a VPN adapter is up, the system proxy, and the route to the internet. Changes nothing.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    spec: spec("computer_network_info", "NETWORK", "READ_ONLY", ["diagnostics"], { timeoutMs: 40_000 }),
  },
  {
    name: "computer_network_test",
    description: "Test connectivity from this computer to a host: DNS resolution, TCP connect to a port (default 443), and ping latency / packet loss / jitter over a few probes. Changes nothing. Use computer_diagnostics for the full Loopcom checkup.",
    parameters: { type: "object", properties: { host: str("Hostname or IP."), port: num("TCP port to try (default 443; 0 = skip)."), count: num("Ping probes (default 4, max 10).") }, required: ["host"], additionalProperties: false },
    spec: spec("computer_network_test", "NETWORK", "READ_ONLY", ["diagnostics"], { networked: true, timeoutMs: 60_000 }),
  },
  {
    name: "computer_powershell",
    description: "Run ONE PowerShell script on this computer and return stdout, stderr and the exit code (output cut at 30000 characters; default timeout 60 s, max 600). Prefer the specific file/system tools when one does the job. Never use it to change security, services, network settings or install software — such commands are refused. Loopcom classifies each script: READ-ONLY scripts (only Get-/Test-/Measure-style commands, no writes) run without asking; scripts that MODIFY follow the person's permission profile; HIGH-RISK shapes always ask. Any file path in the script is fenced exactly like the file tools (the person's own folders only, never password/key stores). Pass elevated:true to run AS ADMINISTRATOR — Windows shows its own prompt and the person clicks Yes; every elevated run is always approved by the person first, and the same refusals still apply.",
    parameters: { type: "object", properties: { script: str("The PowerShell code to run."), timeoutSec: num("Seconds before the script is killed (default 60, max 600)."), cwd: str("Working directory (default: the coworker workspace)."), elevated: bool("Run as administrator (Windows UAC prompt, the person clicks Yes). Default false.") }, required: ["script"], additionalProperties: false },
    spec: spec("computer_powershell", "SHELL", "MEDIUM", ["shell"], { timeoutMs: 600_000 }),
  },
  /* ── browser (the Coworker's own hidden Chromium; never the person's Chrome) ── */
  {
    name: "computer_browser_open",
    description: "Open a URL in the Coworker's own background browser (a separate profile; the person's own browser and mouse are untouched). Returns the final URL, title and a short page summary. Follow with computer_browser_read for the full content.",
    parameters: { type: "object", properties: { url: str("http(s) URL. 'localhost' addresses are allowed.") }, required: ["url"], additionalProperties: false },
    spec: spec("computer_browser_open", "BROWSER", "LOW", ["browser"], { networked: true, timeoutMs: 90_000 }),
  },
  {
    name: "computer_browser_read",
    description: "Read the current page in the Coworker browser: URL, title, headings, visible text (cut at maxChars), links, and every form control with a CSS selector you can pass to the other browser tools (label, name, type, current value, options for selects). Read after every navigation and after every submit.",
    parameters: { type: "object", properties: { maxChars: num("Visible text cap (default 15000, max 60000)."), selector: str("Only read inside this CSS selector.") }, additionalProperties: false },
    spec: spec("computer_browser_read", "BROWSER", "READ_ONLY", ["browser"], { networked: true, timeoutMs: 60_000 }),
  },
  {
    name: "computer_browser_click",
    description: "Click an element in the Coworker browser: by CSS selector, or by its visible text / label (buttons, links, checkboxes). Waits for the page to settle and returns the new URL/title.",
    parameters: { type: "object", properties: { selector: str("CSS selector from computer_browser_read."), text: str("Visible text of the element to click (exact or contained, case-insensitive).") }, additionalProperties: false },
    spec: spec("computer_browser_click", "BROWSER", "LOW", ["browser"], { networked: true, timeoutMs: 60_000 }),
  },
  {
    name: "computer_browser_fill",
    description: "Type a value into a text field / textarea in the Coworker browser, identified by CSS selector or by its label / name / placeholder. Replaces the existing value.",
    parameters: { type: "object", properties: { selector: str("CSS selector."), label: str("Field label, name, id or placeholder text."), value: str("Text to enter.") }, required: ["value"], additionalProperties: false },
    spec: spec("computer_browser_fill", "BROWSER", "LOW", ["browser"], { networked: true, timeoutMs: 30_000 }),
  },
  {
    name: "computer_browser_select",
    description: "Choose an option in a dropdown (<select>) in the Coworker browser, by option text or value. Identify the dropdown by CSS selector or label/name.",
    parameters: { type: "object", properties: { selector: str("CSS selector."), label: str("Dropdown label, name or id."), option: str("Option text or value to choose.") }, required: ["option"], additionalProperties: false },
    spec: spec("computer_browser_select", "BROWSER", "LOW", ["browser"], { networked: true, timeoutMs: 30_000 }),
  },
  {
    name: "computer_browser_check",
    description: "Tick or untick a checkbox / radio in the Coworker browser, by CSS selector or label.",
    parameters: { type: "object", properties: { selector: str("CSS selector."), label: str("Checkbox label, name or id."), checked: bool("true to tick, false to untick. Default true.") }, additionalProperties: false },
    spec: spec("computer_browser_check", "BROWSER", "LOW", ["browser"], { networked: true, timeoutMs: 30_000 }),
  },
  {
    name: "computer_browser_submit",
    description: "Submit a form in the Coworker browser (the form containing the given selector, or the first form) and wait for the result page. Then read the page to confirm what the site says.",
    parameters: { type: "object", properties: { selector: str("CSS selector of the form or of any control inside it. Default: the first form.") }, additionalProperties: false },
    spec: spec("computer_browser_submit", "BROWSER", "MEDIUM", ["browser", "external.post"], { networked: true, exfiltrationCapable: true, timeoutMs: 60_000 }),
  },
  {
    name: "computer_browser_download",
    description: "Download a file with the Coworker browser — by URL, or by clicking a link/button (selector or text) on the current page — into the workspace downloads folder (or saveAs path). Returns the saved file's path and size; then read it with the file tools.",
    parameters: { type: "object", properties: { url: str("Direct URL to download."), selector: str("CSS selector of the link/button to click instead."), text: str("Visible text of the link/button to click instead."), saveAs: str("Optional destination path. " + PATH_NOTE) }, additionalProperties: false },
    spec: spec("computer_browser_download", "BROWSER", "LOW", ["browser", "browser.download", "files.write"], { networked: true, timeoutMs: 180_000 }),
  },
  {
    name: "computer_browser_screenshot",
    description: "Save a PNG screenshot of the current Coworker browser page (into the workspace artifacts folder, or saveAs) and return its path.",
    parameters: { type: "object", properties: { saveAs: str("Optional destination .png path. " + PATH_NOTE) }, additionalProperties: false },
    spec: spec("computer_browser_screenshot", "BROWSER", "READ_ONLY", ["browser", "files.write"], { networked: true, timeoutMs: 30_000 }),
  },
  {
    name: "computer_browser_wait",
    description: "Wait in the Coworker browser: a number of milliseconds, or until a CSS selector appears (up to timeoutMs).",
    parameters: { type: "object", properties: { ms: num("Milliseconds to wait (max 30000)."), selector: str("Wait until this CSS selector exists."), timeoutMs: num("Max wait for the selector (default 15000).") }, additionalProperties: false },
    spec: spec("computer_browser_wait", "BROWSER", "READ_ONLY", ["browser"], { networked: true, timeoutMs: 45_000 }),
  },
  {
    name: "computer_browser_close",
    description: "Close the Coworker browser page (frees its resources). Nothing else changes.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    spec: spec("computer_browser_close", "BROWSER", "READ_ONLY", ["browser"], { timeoutMs: 10_000 }),
  },
  /* ── code folders (git) — run as git with an argument array, never a shell ── */
  {
    name: "computer_git_status",
    description: "What changed in a code project (a folder with git version history): changed, new and conflicted files, the current branch, and how far it is ahead of or behind the server. Changes nothing.",
    parameters: { type: "object", properties: { repo: str("The project folder. " + PATH_NOTE) }, required: ["repo"], additionalProperties: false },
    spec: spec("computer_git_status", "FILESYSTEM", "READ_ONLY", ["files.read"], { timeoutMs: 60_000 }),
  },
  {
    name: "computer_git_log",
    description: "The project's saved checkpoints (commit history), newest first: short id, author, date and note. Optionally only the history of one file inside the project. Changes nothing.",
    parameters: { type: "object", properties: { repo: str("The project folder. " + PATH_NOTE), limit: num("How many checkpoints (default 20, max 200)."), path: str("Optional file inside the project, to see only its history.") }, required: ["repo"], additionalProperties: false },
    spec: spec("computer_git_log", "FILESYSTEM", "READ_ONLY", ["files.read"], { timeoutMs: 60_000 }),
  },
  {
    name: "computer_git_diff",
    description: "The exact unsaved changes in a project: which files, how many lines added and removed, and the changed lines themselves (cut at maxChars). staged:true shows only changes already gathered for the next checkpoint. Changes nothing.",
    parameters: { type: "object", properties: { repo: str("The project folder. " + PATH_NOTE), staged: bool("Only changes already staged. Default false."), maxChars: num("Cap on the changed lines returned (default 20000, max 40000).") }, required: ["repo"], additionalProperties: false },
    spec: spec("computer_git_diff", "FILESYSTEM", "READ_ONLY", ["files.read"], { timeoutMs: 60_000 }),
  },
  {
    name: "computer_git_branches",
    description: "The project's branches (local and on the server), which one is being worked on, and when each last changed. Changes nothing.",
    parameters: { type: "object", properties: { repo: str("The project folder. " + PATH_NOTE) }, required: ["repo"], additionalProperties: false },
    spec: spec("computer_git_branches", "FILESYSTEM", "READ_ONLY", ["files.read"], { timeoutMs: 60_000 }),
  },
  {
    name: "computer_git_commit",
    description: "Save a checkpoint (commit) of the project's current changes with a short note. By default every change in the project is included; includeAll:false saves only what is already staged. Verify with computer_git_log afterwards.",
    parameters: { type: "object", properties: { repo: str("The project folder. " + PATH_NOTE), message: str("A short note describing the checkpoint."), includeAll: bool("Include every change in the project (default true).") }, required: ["repo", "message"], additionalProperties: false },
    spec: spec("computer_git_commit", "FILESYSTEM", "LOW", ["files.read", "files.write"], { timeoutMs: 120_000 }),
  },
  {
    name: "computer_git_checkout",
    description: "Switch the project to another branch, or create a new branch and switch to it (create:true). Refuses when unsaved changes would be overwritten.",
    parameters: { type: "object", properties: { repo: str("The project folder. " + PATH_NOTE), branch: str("Branch name, e.g. 'main' or 'fix/invoice-total'."), create: bool("Create the branch first. Default false.") }, required: ["repo", "branch"], additionalProperties: false },
    spec: spec("computer_git_checkout", "FILESYSTEM", "LOW", ["files.write"], { timeoutMs: 120_000 }),
  },
  {
    name: "computer_git_pull",
    description: "Get the latest changes for the current branch from the server (fast-forward only — it never merges on its own). Needs Git on this computer to be signed in to that server already.",
    parameters: { type: "object", properties: { repo: str("The project folder. " + PATH_NOTE) }, required: ["repo"], additionalProperties: false },
    spec: spec("computer_git_pull", "NETWORK", "MEDIUM", ["files.write"], { networked: true, timeoutMs: 10 * 60_000 }),
  },
  {
    name: "computer_git_push",
    description: "Send the current branch's saved checkpoints to the server (default remote 'origin'). This sends code off the computer, so the person is always asked first. Needs Git on this computer to be signed in to that server already.",
    parameters: { type: "object", properties: { repo: str("The project folder. " + PATH_NOTE), remote: str("Remote name. Default 'origin'.") }, required: ["repo"], additionalProperties: false },
    spec: spec("computer_git_push", "NETWORK", "MEDIUM", ["files.read", "external.post"], { networked: true, exfiltrationCapable: true, alwaysRequireApproval: true, timeoutMs: 10 * 60_000 }),
  },
  {
    name: "computer_git_clone",
    description: "Download a project from an https:// or git@ address into a new folder (default: a folder named after the project inside the coworker workspace). Refuses to download over something that already exists.",
    parameters: { type: "object", properties: { url: str("The project's https:// or git@ address."), into: str("Optional new folder to download into. " + PATH_NOTE) }, required: ["url"], additionalProperties: false },
    spec: spec("computer_git_clone", "NETWORK", "MEDIUM", ["files.write"], { networked: true, timeoutMs: 10 * 60_000 }),
  },
  /* ── screen control (the person's REAL desktop; buttons-first via UI Automation, cursor as fallback) ── */
  {
    name: "computer_screen_begin",
    description: "Start working with the programs on the person's actual desktop: open apps, press their real buttons, fill their fields, read their screens. Required before ANY computer_windows_* / computer_app_launch / computer_screen_* call. The person approves ONCE per task; a blue Loopcom frame then lights every edge and they can stop any time with Escape. Use it when a task needs a Windows program (Notepad, Calculator, QuickBooks Desktop, Settings…); do NOT use it for things a file, PowerShell or system tool does directly (creating a folder is computer_fs_mkdir, never Explorer clicks).",
    parameters: { type: "object", properties: { reason: str("One short sentence, in plain English, saying what you will do on their screen — shown to the person on the approval and the status strip.") }, required: ["reason"], additionalProperties: false },
    spec: spec("computer_screen_begin", "COMPUTER_USE", "MEDIUM", ["desktop.active"], { alwaysRequireApproval: true, timeoutMs: 6 * 60_000 }),
  },
  {
    name: "computer_screen_read",
    description: "Same as computer_windows_controls for the window in front (kept for compatibility): the window title and each control with its ref, type, name, value/checked state and what it can do. No cursor moves. Prefer computer_windows_controls, which can name the window.",
    parameters: { type: "object", properties: { window: str("Optional window title (or part) or hwnd. Default: the window in front."), maxControls: num("Cap on controls returned (default 120, max 400).") }, additionalProperties: false },
    spec: spec("computer_screen_read", "COMPUTER_USE", "READ_ONLY", ["desktop.active"], { timeoutMs: 30_000 }),
  },
  {
    name: "computer_screen_click",
    description: "Click at a POSITION on the person's screen with the real mouse — the LAST resort, after computer_windows_invoke (by ref, no cursor) could not reach the control and computer_screen_look showed you where it is. Give a target ref/name to invoke it instead (no cursor). Positions are 0..1 fractions of the whole screen, or pixels with unit 'px' (as computer_screen_look describes for a window picture). After a positional click, LOOK again and confirm the expected change before the next click; if nothing changed, do not click again blindly — reinspect. Only works after computer_screen_begin.",
    parameters: { type: "object", properties: { target: str("Ref (from computer_windows_controls) or exact visible name of a control — invokes it with NO cursor movement. Preferred over x/y."), x: num("Horizontal position (0..1 fraction of the screen, or pixels with unit px)."), y: num("Vertical position (0..1 fraction, or pixels with unit px)."), unit: { type: "string", enum: ["fraction", "px"], description: "Default fraction." }, button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." }, double: bool("Double-click. Default false."), reason: str("What you expect this click to do (recorded).") }, additionalProperties: false },
    spec: spec("computer_screen_click", "COMPUTER_USE", "LOW", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_screen_type",
    description: "Type text into whatever control has keyboard focus on the person's screen (click the field first). Types the characters themselves, independent of keyboard layout. Only works after computer_screen_begin.",
    parameters: { type: "object", properties: { text: str("The text to type.") }, required: ["text"], additionalProperties: false },
    spec: spec("computer_screen_type", "COMPUTER_USE", "LOW", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_screen_key",
    description: "Press a key or a shortcut on the person's screen: a named key (enter, tab, escape, delete, up, f5…) optionally with modifiers (ctrl, shift, alt, meta), e.g. key 'a' modifiers ['ctrl'] for Select All. Only works after computer_screen_begin.",
    parameters: { type: "object", properties: { key: str("A named key or a single character."), modifiers: { type: "array", items: { type: "string", enum: ["ctrl", "shift", "alt", "meta"] }, description: "Modifiers to hold." } }, required: ["key"], additionalProperties: false },
    spec: spec("computer_screen_key", "COMPUTER_USE", "LOW", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_screen_scroll",
    description: "Scroll the person's screen at a position (x/y as 0..1 fractions), a number of notches (amount: positive up, negative down). Only works after computer_screen_begin.",
    parameters: { type: "object", properties: { x: num("0..1 fraction."), y: num("0..1 fraction."), amount: num("Notches; positive up, negative down. ±1..±10.") }, required: ["x", "y", "amount"], additionalProperties: false },
    spec: spec("computer_screen_scroll", "COMPUTER_USE", "LOW", ["desktop.active"], { timeoutMs: 15_000 }),
  },
  {
    name: "computer_screen_move",
    description: "Move the mouse pointer to a position (x/y as 0..1 fractions of the screen) without clicking — to reveal a hover menu or a tooltip. Only works after computer_screen_begin.",
    parameters: { type: "object", properties: { x: num("0..1 fraction."), y: num("0..1 fraction.") }, required: ["x", "y"], additionalProperties: false },
    spec: spec("computer_screen_move", "COMPUTER_USE", "LOW", ["desktop.active"], { timeoutMs: 10_000 }),
  },
  {
    name: "computer_screen_capture",
    description: "Save a PNG snapshot of the person's screen into the workspace artifacts folder and return its path and size. Use it to keep a record of what a step looked like. (It does not let you see pixels directly — read controls with computer_screen_read.) Only works after computer_screen_begin.",
    parameters: { type: "object", properties: { saveAs: str("Optional destination .png path. " + PATH_NOTE) }, additionalProperties: false },
    spec: spec("computer_screen_capture", "COMPUTER_USE", "READ_ONLY", ["desktop.active", "files.write"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_screen_look",
    description: "LOOK at the person's screen — returns a picture you can actually see, downscaled to fit. The FALLBACK when computer_windows_controls (the control list) isn't enough: a custom-drawn control, a canvas, a chart, an image, an unlabelled area. Prefer ONE WINDOW (window: its title) over the whole screen — it is sharper and cheaper. Also use it to VERIFY after a positional click. Only works after computer_screen_begin.",
    parameters: { type: "object", properties: { window: str("Title (or part) or hwnd of the window to picture. Default: the whole screen."), region: { type: "object", properties: { x: num("Left, px"), y: num("Top, px"), w: num("Width, px"), h: num("Height, px") }, description: "A screen region in pixels instead of a window." } }, additionalProperties: false },
    spec: spec("computer_screen_look", "COMPUTER_USE", "READ_ONLY", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_screen_end",
    description: "Stop controlling the person's screen and drop the blue frame. Always allowed; call it when the on-screen task is finished. The person can also stop at any time with Escape.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    spec: spec("computer_screen_end", "COMPUTER_USE", "READ_ONLY", [], { timeoutMs: 10_000 }),
  },
  /* ── Windows UI control (Layer 2: UI Automation — press real controls by name, NO cursor; everything needs computer_screen_begin first) ── */
  {
    name: "computer_app_launch",
    description: "Open a program on the person's computer and wait for its window: notepad, calculator, explorer (optionally with a folder path as args), paint, settings, chrome, edge, task manager, or a full path to an .exe/.lnk, or a URL scheme (ms-settings:). Returns the window that appeared (title, hwnd, process) so you can read its controls next. For a web page use the browser tools instead; for opening a FOLDER to show the person use computer_open_path.",
    parameters: { type: "object", properties: { app: str("Program name, alias, or full path."), args: str("Command-line arguments (e.g. a file or folder path to open)."), waitMs: num("How long to wait for a window (default 8000, max 30000).") }, required: ["app"], additionalProperties: false },
    spec: spec("computer_app_launch", "WINDOWS", "LOW", ["desktop.active"], { timeoutMs: 45_000 }),
  },
  {
    name: "computer_windows_list",
    description: "The windows open on the person's desktop: title, process, pid, hwnd, position, whether minimized, in front, or running as administrator (which Loopcom cannot control). Use it to find the window you need, then computer_windows_controls to read it.",
    parameters: { type: "object", properties: { filter: str("Substring of the title or process name."), includeMinimized: bool("Default true.") }, additionalProperties: false },
    spec: spec("computer_windows_list", "WINDOWS", "READ_ONLY", ["desktop.active"], { timeoutMs: 15_000 }),
  },
  {
    name: "computer_windows_find",
    description: "Find windows by title (substring), process name or pid. Same rows as computer_windows_list.",
    parameters: { type: "object", properties: { title: str("Part of the window title."), process: str("Process name, e.g. notepad."), pid: num("Process id.") }, additionalProperties: false },
    spec: spec("computer_windows_find", "WINDOWS", "READ_ONLY", ["desktop.active"], { timeoutMs: 15_000 }),
  },
  {
    name: "computer_windows_activate",
    description: "Bring a window to the front (restores it if minimized). Only needed before typing with computer_screen_type or clicking by position; computer_windows_* actions work on a window that is NOT in front.",
    parameters: { type: "object", properties: { window: str("Title (or part) or hwnd."), process: str("Process name instead of a title.") }, additionalProperties: false },
    spec: spec("computer_windows_activate", "WINDOWS", "LOW", ["desktop.active"], { timeoutMs: 15_000 }),
  },
  {
    name: "computer_windows_close",
    description: "Ask a window to close (like its X button). If the program asks about unsaved changes, the window stays and the result says so — read its controls and answer the question deliberately. Does not force-kill (use computer_process_kill for that, which asks the person).",
    parameters: { type: "object", properties: { window: str("Title (or part) or hwnd."), process: str("Process name instead of a title.") }, additionalProperties: false },
    spec: spec("computer_windows_close", "WINDOWS", "MEDIUM", ["desktop.active"], { timeoutMs: 15_000 }),
  },
  {
    name: "computer_windows_minimize",
    description: "Minimize a window to the taskbar (it keeps running).",
    parameters: { type: "object", properties: { window: str("Title (or part) or hwnd."), process: str("Process name instead of a title.") }, additionalProperties: false },
    spec: spec("computer_windows_minimize", "WINDOWS", "LOW", ["desktop.active"], { timeoutMs: 15_000 }),
  },
  {
    name: "computer_windows_controls",
    description: "Read a window's controls as a structured list you act on: for each control its ref (e.g. e3_12), type (Button, Edit, Document, CheckBox, RadioButton, ComboBox, ListItem, MenuItem, TabItem, TreeItem, Hyperlink, Slider, DataItem…), name, id, current value / checked / selected / expanded state, and `can` (invoke, value, toggle, select, expand, scroll, text). No cursor moves and the window need not be in front. Read again after anything changes — refs from an old read may be stale. Documents (editors, web pages) are listed as one control with their text; pass deep:true to descend into them.",
    parameters: { type: "object", properties: { window: str("Title (or part) or hwnd. Default: the window in front."), process: str("Process name instead of a title."), maxControls: num("Default 150, max 600."), all: bool("Include decorative/unnamed controls too. Default false."), includeOffscreen: bool("Include controls scrolled out of view. Default false."), deep: bool("Descend into Document controls (web pages, rich editors). Default false.") }, additionalProperties: false },
    spec: spec("computer_windows_controls", "WINDOWS", "READ_ONLY", ["desktop.active"], { timeoutMs: 30_000 }),
  },
  {
    name: "computer_windows_find_control",
    description: "Find controls in a window by exact name, name substring (contains), automation id, and/or type — faster than reading everything when you know what you are looking for. Returns refs to act on.",
    parameters: { type: "object", properties: { window: str("Title (or part) or hwnd. Default: the window in front."), process: str("Process name instead of a title."), name: str("Exact visible name (case-insensitive)."), contains: str("Substring of the name."), id: str("The control's automation id."), type: str("Control type, e.g. Button, Edit, MenuItem."), max: num("Default 20.") }, additionalProperties: false },
    spec: spec("computer_windows_find_control", "WINDOWS", "READ_ONLY", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_windows_wait_for_control",
    description: "Wait until a control appears in a window (a dialog opening, a page loading) — by name, contains, id or type — up to timeoutMs. Returns found:true with the control, or found:false.",
    parameters: { type: "object", properties: { window: str("Title (or part) or hwnd. Default: the window in front."), process: str("Process name instead of a title."), name: str("Exact visible name."), contains: str("Substring of the name."), id: str("Automation id."), type: str("Control type."), timeoutMs: num("Default 5000, max 60000.") }, additionalProperties: false },
    spec: spec("computer_windows_wait_for_control", "WINDOWS", "READ_ONLY", ["desktop.active"], { timeoutMs: 70_000 }),
  },
  {
    name: "computer_windows_invoke",
    description: "Press a control (button, menu item, hyperlink, list item, tab…) by its ref or exact name — through UI Automation, NO cursor movement, the person's mouse never jumps. Returns the control's state afterwards and which window is in front, so you can confirm it worked. Use computer_windows_toggle for checkboxes and computer_windows_select for lists/combos/tabs.",
    parameters: { type: "object", properties: { ref: str("The ref from computer_windows_controls / find_control (preferred)."), name: str("Exact visible name, if you have no ref."), window: str("Window title/hwnd when using name."), type: str("Control type to disambiguate a name.") }, additionalProperties: false },
    spec: spec("computer_windows_invoke", "WINDOWS", "LOW", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_windows_set_value",
    description: "Put text into an editable control (Edit, Document, ComboBox text) by ref or exact name — sets the value directly when the program allows it, otherwise focuses the control and types. The value is READ BACK and `verified` tells you whether it matches. Never used for passwords (the person types those). Use append:true to add to the end instead of replacing.",
    parameters: { type: "object", properties: { ref: str("The ref (preferred)."), name: str("Exact visible name, if you have no ref."), window: str("Window title/hwnd when using name."), value: str("The text to set."), append: bool("Append instead of replace. Default false.") }, required: ["value"], additionalProperties: false },
    spec: spec("computer_windows_set_value", "WINDOWS", "LOW", ["desktop.active"], { timeoutMs: 40_000 }),
  },
  {
    name: "computer_windows_get_value",
    description: "Read a control's current text/value and state (checked, selected, expanded, enabled) by ref or exact name — the way to VERIFY after you changed something. Password fields report password:true and no text.",
    parameters: { type: "object", properties: { ref: str("The ref (preferred)."), name: str("Exact visible name, if you have no ref."), window: str("Window title/hwnd when using name."), maxChars: num("Default 4000, max 20000.") }, additionalProperties: false },
    spec: spec("computer_windows_get_value", "WINDOWS", "READ_ONLY", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_windows_select",
    description: "Select an item: a tab, a list item, a radio button, a tree item, or an item INSIDE a combo box / list by giving item (its visible text). Opens and closes the combo box itself. Returns the control's state afterwards.",
    parameters: { type: "object", properties: { ref: str("The ref of the item, or of the container when giving item."), name: str("Exact visible name, if you have no ref."), window: str("Window title/hwnd when using name."), item: str("The visible text of the item to choose inside a combo box / list / tree.") }, additionalProperties: false },
    spec: spec("computer_windows_select", "WINDOWS", "LOW", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_windows_toggle",
    description: "Tick or untick a checkbox / toggle switch by ref or exact name. Give checked:true|false for a definite state (it will not flip the wrong way), or omit to flip. Returns the resulting checked state.",
    parameters: { type: "object", properties: { ref: str("The ref (preferred)."), name: str("Exact visible name, if you have no ref."), window: str("Window title/hwnd when using name."), checked: bool("The state you want. Omit to flip.") }, additionalProperties: false },
    spec: spec("computer_windows_toggle", "WINDOWS", "LOW", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_windows_expand",
    description: "Expand a collapsible control (a tree node, a menu, a combo box, a section) by ref or exact name.",
    parameters: { type: "object", properties: { ref: str("The ref (preferred)."), name: str("Exact visible name."), window: str("Window title/hwnd when using name.") }, additionalProperties: false },
    spec: spec("computer_windows_expand", "WINDOWS", "LOW", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_windows_collapse",
    description: "Collapse an expanded control by ref or exact name.",
    parameters: { type: "object", properties: { ref: str("The ref (preferred)."), name: str("Exact visible name."), window: str("Window title/hwnd when using name.") }, additionalProperties: false },
    spec: spec("computer_windows_collapse", "WINDOWS", "LOW", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_windows_scroll",
    description: "Scroll a scrollable control (a list, a document, a page) by ref or exact name, a number of steps in a direction. Uses the control's own scroll support when it has it (no cursor), the mouse wheel otherwise.",
    parameters: { type: "object", properties: { ref: str("The ref (preferred)."), name: str("Exact visible name."), window: str("Window title/hwnd when using name."), direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Default down." }, amount: num("Steps (default 3, max 50).") }, additionalProperties: false },
    spec: spec("computer_windows_scroll", "WINDOWS", "LOW", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_windows_focus",
    description: "Give keyboard focus to a control by ref or exact name (before computer_screen_key, for example).",
    parameters: { type: "object", properties: { ref: str("The ref (preferred)."), name: str("Exact visible name."), window: str("Window title/hwnd when using name.") }, additionalProperties: false },
    spec: spec("computer_windows_focus", "WINDOWS", "LOW", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_windows_menu",
    description: "Open a menu path in a window, e.g. path ['File', 'Save as'] — finds and presses each item in turn (menus that open in their own popup are handled). Then read the window in front (a dialog usually) with computer_windows_controls.",
    parameters: { type: "object", properties: { window: str("Title (or part) or hwnd of the window with the menu."), process: str("Process name instead of a title."), path: { type: "array", items: { type: "string" }, description: "Menu item names from the top level down (max 6)." } }, required: ["path"], additionalProperties: false },
    spec: spec("computer_windows_menu", "WINDOWS", "LOW", ["desktop.active"], { timeoutMs: 60_000 }),
  },
  {
    name: "computer_process_kill",
    description: "End a program by pid or process name (asks the person first, and tries a polite close before force). Windows' own processes and Loopcom itself are never ended.",
    parameters: { type: "object", properties: { pid: num("Process id."), name: str("Process name, e.g. notepad.") }, additionalProperties: false },
    spec: spec("computer_process_kill", "WINDOWS", "HIGH", ["desktop.active"], { destructive: true, alwaysRequireApproval: true, timeoutMs: 30_000 }),
  },
  /* ── diagnostics ── */
  {
    name: "computer_diagnostics",
    description: "Run the complete Loopcom diagnostic on this computer and return measurements with a status per check: Loopcom processes and app version, phone (SIP) registration state, reachability of the Loopcom servers, DNS, network interfaces and default gateway, latency/packet loss/jitter to the gateway and to Loopcom, STUN reachability, VPN/proxy indicators, audio input/output devices, CPU, memory, disk, recent app log errors and recent Windows system errors. Measures only — changes nothing. Report unknowns as unknown.",
    parameters: { type: "object", properties: { sections: { type: "array", items: { type: "string" }, description: "Optional subset: processes, phone, backend, dns, network, latency, stun, vpn, audio, resources, logs, events, computerControl. Default all." } }, additionalProperties: false },
    spec: spec("computer_diagnostics", "DIAGNOSTIC", "READ_ONLY", ["diagnostics"], { networked: true, timeoutMs: 180_000 }),
  },
  /* ── MCP ── */
  {
    name: "computer_mcp_servers",
    description: "The MCP servers configured in the Loopcom app on this computer, their connection state and the tools each exposes. Their tools are named mcp_<server>_<tool> in your tool list when connected.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    spec: spec("computer_mcp_servers", "MCP", "READ_ONLY", ["mcp"], { timeoutMs: 15_000 }),
  },
  /* ── tasks & artifacts ── */
  {
    name: "computer_task_history",
    description: "What the Coworker has done on this computer recently: each tool call with its outcome (done, denied, failed, cancelled), and the artifacts (files) produced. Use before answering 'did it finish?' or 'what did you do?'.",
    parameters: { type: "object", properties: { limit: num("Default 30, max 200.") }, additionalProperties: false },
    spec: spec("computer_task_history", "LOOPCOM_NATIVE", "READ_ONLY", ["files.read"], { timeoutMs: 10_000 }),
  },
  {
    name: "computer_artifact_register",
    description: "Mark a file you produced as a result artifact of this task (it appears in the Coworker's task list with Open / Show in folder). Call it for the final outputs the person asked for.",
    parameters: { type: "object", properties: { path: str(PATH_NOTE), label: str("Short label, e.g. 'Invoice summary (CSV)'.") }, required: ["path"], additionalProperties: false },
    spec: spec("computer_artifact_register", "LOOPCOM_NATIVE", "READ_ONLY", ["files.read"], { timeoutMs: 10_000 }),
  },
];

export const TOOL_NAMES: readonly string[] = TOOL_CATALOG.map((t) => t.name);
export function findTool(name: string): CatalogTool | undefined {
  return TOOL_CATALOG.find((t) => t.name === name);
}

/** The MCP tool spec the policy judges: networked, MCP domain, never destructive by declaration alone. */
export function mcpToolSpec(modelName: string, serverId: string, tool: string, annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }): CoworkerToolSpec {
  const destructive = annotations?.destructiveHint === true && annotations?.readOnlyHint !== true;
  return {
    name: modelName,
    description: `${serverId}:${tool}`,
    category: "MCP",
    risk: destructive ? "HIGH" : annotations?.readOnlyHint ? "READ_ONLY" : "LOW",
    domains: ["mcp"],
    destructive,
    networked: true,
    exfiltrationCapable: false,
    timeoutMs: 120_000,
    maxRetries: 0,
  };
}

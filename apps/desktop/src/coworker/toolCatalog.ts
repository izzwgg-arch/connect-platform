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
    name: "computer_powershell",
    description: "Run ONE PowerShell script on this computer and return stdout, stderr and the exit code (output cut at 30000 characters; default timeout 60 s, max 600). Prefer the specific file/system tools when one does the job. Never use it to change security, services, network settings or install software — such commands are refused. The person's permission profile may require their approval for every run.",
    parameters: { type: "object", properties: { script: str("The PowerShell code to run."), timeoutSec: num("Seconds before the script is killed (default 60, max 600)."), cwd: str("Working directory (default: the coworker workspace).") }, required: ["script"], additionalProperties: false },
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
  /* ── diagnostics ── */
  {
    name: "computer_diagnostics",
    description: "Run the complete Loopcom diagnostic on this computer and return measurements with a status per check: Loopcom processes and app version, phone (SIP) registration state, reachability of the Loopcom servers, DNS, network interfaces and default gateway, latency/packet loss/jitter to the gateway and to Loopcom, STUN reachability, VPN/proxy indicators, audio input/output devices, CPU, memory, disk, recent app log errors and recent Windows system errors. Measures only — changes nothing. Report unknowns as unknown.",
    parameters: { type: "object", properties: { sections: { type: "array", items: { type: "string" }, description: "Optional subset: processes, phone, backend, dns, network, latency, stun, vpn, audio, resources, logs, events. Default all." } }, additionalProperties: false },
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

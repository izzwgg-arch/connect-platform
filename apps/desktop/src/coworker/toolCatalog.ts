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
    name: "computer_powershell",
    description: "Run ONE PowerShell script on this computer and return stdout, stderr and the exit code (output cut at 30000 characters; default timeout 60 s, max 600). Prefer the specific file/system tools when one does the job. Never use it to change security, services, network settings or install software — such commands are refused. The person's permission profile may require their approval for every run. Pass elevated:true to run AS ADMINISTRATOR — Windows shows its own prompt and the person clicks Yes; every elevated run is always approved by the person first, and the same refusals still apply.",
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
    description: "Start controlling the person's actual desktop screen — mouse and keyboard on their real windows, not the Coworker's own browser. Ask for this only when a task genuinely needs the live screen (an app with no file/PowerShell way to do it). The person approves once; a blue Loopcom frame then lights every edge, and they can stop any time with Escape. After this, prefer computer_screen_read + computer_screen_click by target (no cursor movement) over moving the mouse.",
    parameters: { type: "object", properties: { reason: str("One short sentence, in plain English, saying what you will do on their screen — shown to the person on the approval and the status strip.") }, required: ["reason"], additionalProperties: false },
    spec: spec("computer_screen_begin", "COMPUTER_USE", "MEDIUM", ["desktop.active"], { alwaysRequireApproval: true, timeoutMs: 6 * 60_000 }),
  },
  {
    name: "computer_screen_read",
    description: "Read the controls on the person's active window as a list you can act on: the window title, and each button/menu/field/list item with its name, kind, whether it is enabled, and a ref. This is the 'buttons-first' way to see the screen — no cursor moves. Click a control by passing its ref or exact name to computer_screen_click. Read again after every click, because the window changes. Only works after computer_screen_begin.",
    parameters: { type: "object", properties: { maxControls: num("Cap on controls returned (default 120, max 400).") }, additionalProperties: false },
    spec: spec("computer_screen_read", "COMPUTER_USE", "READ_ONLY", ["desktop.active"], { timeoutMs: 30_000 }),
  },
  {
    name: "computer_screen_click",
    description: "Click on the person's screen. PREFER target: pass the ref or exact visible name of a control from computer_screen_read and it is invoked directly, with NO cursor movement, so the person's mouse never jumps. Only fall back to x/y (0..1 fractions of the whole screen) when a control cannot be reached by name (a game, a canvas). Only works after computer_screen_begin.",
    parameters: { type: "object", properties: { target: str("Ref (from computer_screen_read) or exact visible name of the control to click. Preferred."), x: num("Horizontal position as a 0..1 fraction of the screen — cursor fallback only."), y: num("Vertical position as a 0..1 fraction — cursor fallback only."), button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." }, double: bool("Double-click. Default false.") }, additionalProperties: false },
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
    description: "LOOK at the person's screen — returns a picture you can actually see, downscaled to fit. Use it as the FALLBACK when computer_screen_read (the control list) isn't enough to know what to do: a drawing, a game, an image, a chart, an unlabelled area. Prefer computer_screen_read first (it's cheaper and lets you click by name). Only works after computer_screen_begin.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    spec: spec("computer_screen_look", "COMPUTER_USE", "READ_ONLY", ["desktop.active"], { timeoutMs: 20_000 }),
  },
  {
    name: "computer_screen_end",
    description: "Stop controlling the person's screen and drop the blue frame. Always allowed; call it when the on-screen task is finished. The person can also stop at any time with Escape.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    spec: spec("computer_screen_end", "COMPUTER_USE", "READ_ONLY", [], { timeoutMs: 10_000 }),
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

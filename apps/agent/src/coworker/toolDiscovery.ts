/**
 * Tool discovery — which of the desktop's tool FAMILIES a turn gets (Phase 34 of
 * the Computer Control brief): "only expose relevant tool subsets to the model".
 *
 * The desktop announces ~75 built-in tools plus MCP tools. Handing all of them
 * to every turn costs tokens, invites the wrong pick, and slows the model. So the
 * families are chosen from the message, with two safety valves so a wrong guess
 * can never strand a task:
 *   1. CORE is always present (files, search, system, PowerShell, diagnostics,
 *      bookkeeping) — most computer requests live there.
 *   2. STICKY: whatever families the previous turns of this conversation used
 *      stay on ("now save it", "click OK", "yes") — remembered per conversation
 *      from the tools the model actually called.
 * When the message gives no signal at all (or is very short), EVERY family is
 * offered — a miss costs a few thousand tokens; a missing tool costs the task.
 *
 * ⛔ Pure. No I/O. Decides nothing about safety — the desktop's policy core does.
 */

export type ToolFamily = "core" | "windows" | "screen" | "browser" | "git" | "sheets" | "services" | "mcp";

export const ALL_FAMILIES: readonly ToolFamily[] = ["core", "windows", "screen", "browser", "git", "sheets", "services", "mcp"];

/** The family of a desktop tool by name. */
export function familyOf(name: string): ToolFamily {
  if (name.startsWith("mcp_")) return "mcp";
  if (name.startsWith("computer_windows_") || name === "computer_app_launch" || name === "computer_process_kill") return "windows";
  if (name.startsWith("computer_screen_")) return "screen";
  if (name.startsWith("computer_chrome_") || name.startsWith("computer_browser_")) return "browser";
  if (name.startsWith("computer_git_")) return "git";
  if (name.startsWith("computer_xlsx_")) return "sheets";
  if (name === "computer_services" || name === "computer_service_control") return "services";
  return "core";
}

const SIGNALS: Record<Exclude<ToolFamily, "core" | "mcp">, RegExp> = {
  // a program, a window, a control, an on-screen action
  windows: /\b(open|launch|start|run|close|quit|switch to|bring up|minimi[sz]e|maximi[sz]e)\b[^.\n]{0,40}\b(app|application|program|window|notepad|calculator|calc|explorer|file explorer|paint|wordpad|settings|control panel|task manager|outlook|word|excel|powerpoint|quickbooks|chrome|edge|teams|slack|zoom|terminal|cmd|powershell window|acceptance)|\b(notepad|calculator|calc\b|wordpad|mspaint|paint\b|task manager|quickbooks|file explorer|explorer window|control panel|windows settings|settings app|the settings)\b|\b(click|press|tap|tick|untick|check the box|uncheck|toggle|select the|choose the|type into|type in|enter .{1,30} (into|in) (the )?(field|box|form|name)|fill (in|out)|dropdown|drop-down|combo ?box|checkbox|radio|tab\b|menu|dialog|button|text ?box|text field|the window|on screen|on the screen|on my screen|this program|the program|the app\b|that app|save as|save it|save the (document|file|note)|calculate .{0,20}using)\b/i,
  // pixels, mouse, keyboard, pictures of the screen
  screen: /\b(screen ?shot|screenshot|picture of (my|the) screen|what('s| is) on (my|the) screen|look at (my|the) screen|see (my|the) screen|mouse|cursor|drag|scroll|right[- ]click|double[- ]click|keyboard shortcut|hotkey|press (ctrl|alt|shift|enter|escape|tab|f\d)|visual|custom control|purple|canvas|game)\b/i,
  // the web
  browser: /\b(https?:\/\/|www\.|\.com\b|\.net\b|\.org\b|\.io\b|website|web ?site|web page|webpage|browser|chrome tab|in chrome|open chrome|google it|search the web|search online|download (the|a|this) (report|file|pdf|invoice|statement)|log ?in to|sign ?in to|portal|url|link\b|online)\b/i,
  // code projects
  git: /\b(git|commit|branch|checkout|pull request|repo|repository|clone|push|merge|diff|code project|the project's (history|changes))\b/i,
  // spreadsheets
  sheets: /\b(spreadsheet|excel|xlsx|\.xls\b|workbook|worksheet|csv|sheet\b|table of|columns?|rows?|pivot)\b/i,
  // services
  services: /\b(service|services|spooler|daemon|windows update|print spooler|isn't running|not running|restart the)\b/i,
};

/** Messages that carry no signal of their own — keep what the conversation already used, or everything. */
const NO_SIGNAL = /^\s*(?:(?:yes|no|ok(?:ay)?|sure|go(?: ahead)?|do it|continue|proceed|next|again|retry|try again|done|thanks|thank you|please|now|and then|then what|what happened|status|stop|cancel|why|how)\b[\s.!?]*)+$/i;

export type DiscoveryInput = {
  text: string;
  /** Families the conversation used in earlier turns (from the tools it called). */
  sticky?: readonly ToolFamily[];
  /** The message attached a code project → git on. */
  hasRepo?: boolean;
  /** MCP servers connected → mcp on. */
  hasMcp?: boolean;
};

export function selectFamilies(input: DiscoveryInput): { families: Set<ToolFamily>; reason: string } {
  const text = String(input.text ?? "").trim();
  const families = new Set<ToolFamily>(["core"]);
  for (const f of input.sticky ?? []) families.add(f);
  if (input.hasRepo) families.add("git");
  if (input.hasMcp) families.add("mcp");
  if (!text || text.length < 3 || NO_SIGNAL.test(text)) {
    if (input.sticky && input.sticky.length) return { families, reason: "no signal — kept the conversation's families" };
    for (const f of ALL_FAMILIES) families.add(f);
    return { families, reason: "no signal — everything" };
  }
  const hits: string[] = [];
  for (const [fam, re] of Object.entries(SIGNALS) as [Exclude<ToolFamily, "core" | "mcp">, RegExp][]) {
    if (re.test(text)) { families.add(fam); hits.push(fam); }
  }
  // a program task almost always needs the screen family too (look / click fallback), and vice versa
  if (families.has("windows")) families.add("screen");
  if (families.has("screen")) families.add("windows");
  // a generic "my computer" request with no family signal: offer everything except the
  // rarely-relevant families (browser/git/sheets stay off, programs+screen on — the brief's
  // three layers are the point of this feature)
  if (!hits.length) { families.add("windows"); families.add("screen"); return { families, reason: "no family signal — core + programs + screen" }; }
  return { families, reason: `signals: ${hits.join(",")}` };
}

/** Filter a manifest's tool names to the chosen families. `computer_screen_end` always rides along (stopping must always be possible). */
export function filterToolNames(names: readonly string[], families: ReadonlySet<ToolFamily>): string[] {
  return names.filter((n) => families.has(familyOf(n)) || n === "computer_screen_end");
}

/** Remember which families a conversation has used, from the tools it called. Bounded. */
export class FamilyMemory {
  private byConversation = new Map<string, { families: Set<ToolFamily>; at: number }>();
  constructor(private maxAgeMs = 6 * 60 * 60 * 1000, private maxEntries = 5000) {}
  note(conversationId: string, toolName: string): void {
    const f = familyOf(toolName);
    if (f === "core") return;
    const cur = this.byConversation.get(conversationId) ?? { families: new Set<ToolFamily>(), at: Date.now() };
    cur.families.add(f); cur.at = Date.now();
    this.byConversation.set(conversationId, cur);
    if (this.byConversation.size > this.maxEntries) this.sweep(true);
  }
  get(conversationId: string): ToolFamily[] {
    const cur = this.byConversation.get(conversationId);
    if (!cur) return [];
    if (Date.now() - cur.at > this.maxAgeMs) { this.byConversation.delete(conversationId); return []; }
    return [...cur.families];
  }
  sweep(force = false): void {
    const now = Date.now();
    for (const [k, v] of this.byConversation) if (force || now - v.at > this.maxAgeMs) this.byConversation.delete(k);
    if (force && this.byConversation.size > this.maxEntries / 2) { for (const k of [...this.byConversation.keys()].slice(0, this.byConversation.size - this.maxEntries / 2)) this.byConversation.delete(k); }
  }
}

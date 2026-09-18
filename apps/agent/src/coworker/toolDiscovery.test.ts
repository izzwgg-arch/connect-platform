/**
 * Tool discovery (Phase 34): the model is offered the families a message needs —
 * never nothing it needs, never everything by default.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { selectFamilies, filterToolNames, familyOf, FamilyMemory, ALL_FAMILIES } from "./toolDiscovery";
import { describeStep } from "./stepDescriber";

const MANIFEST = [
  "computer_workspace", "computer_fs_list", "computer_fs_mkdir", "computer_fs_search", "computer_system_info", "computer_processes", "computer_powershell", "computer_diagnostics", "computer_task_history",
  "computer_app_launch", "computer_windows_controls", "computer_windows_invoke", "computer_windows_set_value", "computer_process_kill",
  "computer_screen_begin", "computer_screen_look", "computer_screen_click", "computer_screen_end",
  "computer_chrome_open", "computer_chrome_read", "computer_git_status", "computer_git_commit", "computer_xlsx_write", "computer_services", "computer_service_control", "mcp_qb_get_customer",
];

test("families: every name maps to exactly one family; screen_end always rides along", () => {
  for (const n of MANIFEST) assert.ok(ALL_FAMILIES.includes(familyOf(n)), n);
  assert.equal(familyOf("computer_app_launch"), "windows"); assert.equal(familyOf("computer_screen_look"), "screen"); assert.equal(familyOf("mcp_qb_x"), "mcp"); assert.equal(familyOf("computer_fs_mkdir"), "core");
  const core = filterToolNames(MANIFEST, new Set(["core"]));
  assert.ok(core.includes("computer_screen_end")); assert.ok(!core.includes("computer_screen_look")); assert.ok(core.includes("computer_fs_mkdir"));
});

test("a file request gets core + programs + screen (the three layers), not browser/git/sheets", () => {
  const r = selectFamilies({ text: "Create a folder called Loopcom Computer Test in the acceptance workspace." });
  assert.ok(r.families.has("core")); assert.ok(r.families.has("windows")); assert.ok(r.families.has("screen"));
  assert.ok(!r.families.has("browser")); assert.ok(!r.families.has("git")); assert.ok(!r.families.has("sheets"));
});

test("program, screen, browser, git, sheets and service requests light their families", () => {
  assert.ok(selectFamilies({ text: "Open Notepad and type 'Loopcom Windows automation is working'." }).families.has("windows"));
  assert.ok(selectFamilies({ text: "Open Calculator and calculate 583 × 29 using the Calculator application." }).families.has("windows"));
  assert.ok(selectFamilies({ text: "Click the purple test control." }).families.has("screen"));
  const web = selectFamilies({ text: "Open Chrome in a Coworker tab, download the acceptance report from http://127.0.0.1:8765/reports and analyze it." });
  assert.ok(web.families.has("browser"));
  assert.ok(selectFamilies({ text: "Commit my changes in the project with the message fix" }).families.has("git"));
  assert.ok(selectFamilies({ text: "Make a spreadsheet of the invoices in Downloads" }).families.has("sheets"));
  assert.ok(selectFamilies({ text: "Run PowerShell and check why the Print Spooler service isn't running" }).families.has("services"));
  assert.ok(selectFamilies({ text: "Check what's using all my RAM" }).families.has("core"));
});

test("no signal: a bare 'yes' keeps the conversation's families; with no history it offers everything", () => {
  const withHistory = selectFamilies({ text: "yes", sticky: ["browser"] });
  assert.deepEqual([...withHistory.families].sort(), ["browser", "core"]);
  const fresh = selectFamilies({ text: "ok go" });
  for (const f of ALL_FAMILIES) assert.ok(fresh.families.has(f), f);
});

test("sticky memory: families the conversation used come back; core is never remembered; entries age out", () => {
  const m = new FamilyMemory(50, 10);
  m.note("c1", "computer_fs_list"); assert.deepEqual(m.get("c1"), []);
  m.note("c1", "computer_chrome_open"); m.note("c1", "computer_windows_invoke");
  assert.deepEqual(m.get("c1").sort(), ["browser", "windows"]);
  assert.deepEqual(m.get("c2"), []);
  const r = selectFamilies({ text: "now click OK", sticky: m.get("c1") });
  assert.ok(r.families.has("browser") && r.families.has("windows") && r.families.has("screen"));
  return new Promise<void>((resolve) => setTimeout(() => { assert.deepEqual(m.get("c1"), []); resolve(); }, 80));
});

test("a repo attached or an MCP connected adds its family; discovery never drops the core", () => {
  assert.ok(selectFamilies({ text: "find the invoice", hasRepo: true }).families.has("git"));
  assert.ok(selectFamilies({ text: "find the invoice", hasMcp: true }).families.has("mcp"));
  for (const t of ["", "x", "Open Notepad", "download it", "commit", "what's on my screen"]) assert.ok(selectFamilies({ text: t }).families.has("core"), t);
});

test("stress: 20,000 varied messages classify in bounded time and always include core", () => {
  const words = ["open", "notepad", "click", "download", "commit", "spreadsheet", "service", "folder", "ram", "screen", "the", "report", "http://x.com", "and", "please", "yes"];
  const t0 = Date.now();
  for (let i = 0; i < 20_000; i++) {
    const n = 1 + (i % 9);
    const text = Array.from({ length: n }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ");
    const r = selectFamilies({ text, sticky: i % 5 === 0 ? ["git"] : [] });
    assert.ok(r.families.has("core"));
  }
  assert.ok(Date.now() - t0 < 5000, "classification is cheap");
});

test("every new computer-control tool has a plain-English step label with no tool name or code in it", () => {
  const names = ["computer_services", "computer_service_control", "computer_network_info", "computer_network_test", "computer_screen_begin", "computer_screen_end", "computer_windows_controls", "computer_windows_list", "computer_windows_find_control", "computer_app_launch", "computer_windows_activate", "computer_windows_close", "computer_windows_invoke", "computer_windows_set_value", "computer_windows_get_value", "computer_windows_select", "computer_windows_toggle", "computer_windows_expand", "computer_windows_collapse", "computer_windows_scroll", "computer_windows_focus", "computer_windows_menu", "computer_process_kill", "computer_screen_look", "computer_screen_capture", "computer_screen_click", "computer_screen_type", "computer_screen_key", "computer_screen_scroll", "computer_screen_move"];
  for (const n of names) {
    const d = describeStep(n, { app: "notepad", window: "Notepad", name: "Save", item: "Option B", path: ["File", "Save as"], key: "s", modifiers: ["ctrl"], host: "app.loopcom.net", action: "restart" });
    assert.ok(!/computer_|\{|\}|\(\)/.test(d.label), `${n}: ${d.label}`);
    assert.ok(!/^Using /.test(d.label), `${n} fell through to the generic label`);
  }
});

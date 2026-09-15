import { test } from "node:test";
import assert from "node:assert/strict";
import { describeStep, summarizeResult, baseName, folderPhrase, plain } from "./stepDescriber";

const CODE_SHAPED = /computer_|mcp_|[{}`]|\bargs\b|\bjson\b/i;

test("labels are plain English and never show a tool name, JSON or code", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["computer_fs_list", { path: "C:\\Users\\izzy\\Downloads" }],
    ["computer_fs_read", { path: "C:\\Users\\izzy\\Documents\\notes.txt" }],
    ["computer_fs_move", { from: "C:\\a\\b.pdf", to: "C:\\a\\PDFs" }],
    ["computer_powershell", { script: "Remove-Item -Recurse C:\\secret; Get-Content $env:APPDATA\\token.txt" }],
    ["computer_chrome_open", { url: "https://mail.google.com/mail/u/0" }],
    ["computer_chrome_act", { tabId: 3, action: "fill", ref: "e12", value: "hunter2" }],
    ["computer_xlsx_write", { path: "C:\\Users\\izzy\\Documents\\August.xlsx", sheets: [] }],
    ["computer_git_commit", { repo: "C:\\dev\\shop", message: "wip" }],
    ["mcp_notion_search_pages", { query: "q3" }],
    ["call_history", { extension: "101" }],
    ["some_future_tool", {}],
  ];
  for (const [name, args] of cases) {
    const d = describeStep(name, args);
    assert.ok(d.label.length > 3, name);
    assert.doesNotMatch(d.label, CODE_SHAPED, `${name} → "${d.label}"`);
  }
});

test("a PowerShell script and a typed value are never echoed in the label", () => {
  const ps = describeStep("computer_powershell", { script: "Get-Secret -Name bank" });
  assert.doesNotMatch(ps.label, /Get-Secret|bank/);
  const fill = describeStep("computer_chrome_act", { action: "fill", value: "my-password-123" });
  assert.doesNotMatch(fill.label, /my-password-123/);
});

test("folders read like people talk about them", () => {
  assert.equal(folderPhrase("C:\\Users\\izzy\\Downloads"), "your Downloads folder");
  assert.equal(folderPhrase("C:/Users/izzy/Desktop/"), "your Desktop folder");
  assert.equal(folderPhrase("C:\\Work\\Invoices"), "the Invoices folder");
  assert.equal(folderPhrase(""), "your workspace");
  assert.equal(baseName("C:\\a\\b\\report.pdf"), "report.pdf");
  assert.equal(describeStep("computer_fs_list", { path: "C:\\Users\\izzy\\Downloads" }).label, "Looking in your Downloads folder");
  assert.equal(describeStep("computer_chrome_open", { url: "https://www.example.com/x" }).label, "Opening example.com");
});

test("the person's No, a denial, a cancel and a disconnect read as exactly that", () => {
  assert.equal(summarizeResult("computer_fs_write", false, { error: "needs_approval", approved: false, denied: true, message: "The person said No" }).state, "denied");
  assert.match(summarizeResult("computer_fs_write", false, { error: "needs_approval", denied: true, message: "did not answer the approval prompt in time" }).detail[0], /in time/);
  assert.equal(summarizeResult("computer_fs_delete", false, { error: "domain_denied", denied: true, message: "Your Coworker permissions do not allow this" }).state, "denied");
  assert.equal(summarizeResult("computer_fs_list", false, { error: "task_cancelled" }).state, "cancelled");
  assert.match(summarizeResult("computer_fs_list", false, { error: "desktop_not_connected" }).detail[0], /isn't connected/);
  assert.equal(summarizeResult("computer_chrome_open", false, { error: "switched_off", message: "The web browser is switched off in Coworker settings." }).state, "denied");
});

test("results summarize what happened and what changed", () => {
  const list = summarizeResult("computer_fs_list", true, { ok: true, entries: [{ kind: "file" }, { kind: "file" }, { kind: "folder" }] });
  assert.deepEqual(list.detail, ["Found 2 files and 1 folder"]);
  assert.equal(list.changed, undefined);
  const write = summarizeResult("computer_fs_write", true, { ok: true, path: "C:\\x\\notes.txt", bytesWritten: 2048, mode: "created" });
  assert.equal(write.changed, "notes.txt created");
  const sheet = summarizeResult("computer_xlsx_write", true, { ok: true, path: "C:\\x\\a.xlsx", sheets: [{ name: "A", rows: 18 }] });
  assert.deepEqual(sheet.detail, ["1 sheet, 18 rows"]);
  assert.equal(summarizeResult("computer_fs_mkdir", true, { ok: true, created: false }).changed, undefined, "an existing folder changed nothing");
  assert.deepEqual(summarizeResult("voicemails", true, { voicemails: [1, 2, 3] }).detail, ["Found 3 voicemails"]);
  assert.deepEqual(summarizeResult("call_history", true, { calls: [1] }).detail, ["Found 1 call"]);
  assert.equal(summarizeResult("computer_fs_list", true, { ok: false, message: "outside_allowed_roots" }).state, "failed");
});

test("plain() strips code-shaped words from a message a customer reads", () => {
  assert.equal(plain("Call `computer_fs_list` again"), "Call that step again");
  assert.ok(plain("x".repeat(500)).length <= 240);
});

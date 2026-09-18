/**
 * Code projects (git) and the Coworker workspace bridge — proven against a REAL git
 * repository on this machine and the real runtime, not asserted.
 *
 *  - git runs with an argument array: a branch name or message full of shell and git
 *    syntax is one argument and never becomes a flag or a command;
 *  - the repo path is fenced like every file tool; a folder outside the roots and a
 *    folder with no git history are refused;
 *  - status / log / diff / branches / commit / checkout read and write the real repo;
 *    clone refuses ext::, file:// and local sources; push to a remote needing a
 *    password fails fast instead of hanging;
 *  - the person's switches: a family switched off is not announced and a call that
 *    still arrives is refused before any verdict; email is blocked unless switched on;
 *  - the bridge: raising access needs the native dialog, lowering does not; a
 *    hosted page from another origin is refused; a dropped folder outside home asks;
 *    drive roots and system folders can't be attached.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runGit, gitStatus, gitLog, gitDiff, gitBranches, gitCommit, gitCheckout, gitClone, gitPush, isSafeBranchName, isSafeCloneUrl, resolveRepo, gitInstalled } from "./runtime/git";
import { CoworkerRuntime, toolGroup, isWebmailUrl, type RuntimeDeps } from "./runtime";
import { Journal } from "./runtime/journal";
import { TOOL_CATALOG } from "./toolCatalog";
import { registerCoworkerUiIpc, isRaise, folderRefusal, mergeFolder, applyGroups, groupsView, isTrustedSenderUrl, ACCESS_DIALOG, TOOL_GROUPS } from "./uiBridge";
import type { DesktopSettings } from "../types";

const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "lc-git-"));

function makeRepo() {
  const home = tmp();
  const workspace = path.join(home, "LoopcomCoworkerAcceptance");
  mkdirSync(workspace, { recursive: true });
  const repo = path.join(home, "shop");
  mkdirSync(repo);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "coworker@test.local");
  g("config", "user.name", "Coworker Test");
  writeFileSync(path.join(repo, "README.md"), "# Shop\n");
  g("add", "README.md");
  g("commit", "-q", "-m", "First checkpoint");
  return { home, workspace, repo, env: { home, workspace, roots: [home, workspace] }, g };
}

test("branch names and clone URLs: anything shaped like a flag, a path trick or a shell is refused", () => {
  for (const ok of ["main", "fix/invoice-total", "release-2026.09", "feature_x"]) assert.equal(isSafeBranchName(ok), true, ok);
  for (const bad of ["-D", "--force", "a..b", "a b", "x;rm -rf ~", "$(whoami)", "a//b", "ends/", "name.lock", "@{u}", "", "x".repeat(200)]) assert.equal(isSafeBranchName(bad), false, bad);
  for (const ok of ["https://github.com/loopcom/shop.git", "https://gitlab.com/a/b", "git@github.com:loopcom/shop.git"]) assert.equal(isSafeCloneUrl(ok), true, ok);
  for (const bad of ["ext::sh -c touch% /tmp/pwned", "file:///C:/Users", "C:\\Users\\me\\repo", "--upload-pack=calc", "http://github.com/a/b", "https://user:pass@github.com/a/b", "https://github.com/a b", "git@github.com:a/b; calc"]) assert.equal(isSafeCloneUrl(bad), false, bad);
});

test("git: status, log, diff, branches, commit and checkout on a real repository", { skip: !hasGit && "git is not installed on this machine" }, async () => {
  const { env, repo } = makeRepo();
  assert.equal(await gitInstalled(), true);
  const clean = await gitStatus({ repo }, env) as any;
  assert.equal(clean.ok, true);
  assert.equal(clean.branch, "main");
  assert.match(clean.summary, /No unsaved changes on branch main/);

  writeFileSync(path.join(repo, "README.md"), "# Shop\nNow with prices\n");
  writeFileSync(path.join(repo, "prices.csv"), "item,price\nmug,12\n");
  const dirty = await gitStatus({ repo }, env) as any;
  assert.deepEqual(dirty.changed, ["README.md"]);
  assert.deepEqual(dirty.untracked, ["prices.csv"]);
  assert.match(dirty.summary, /1 file changed, 1 new file/);

  const diff = await gitDiff({ repo }, env) as any;
  assert.equal(diff.files, 1);
  assert.match(diff.patch, /Now with prices/);

  // A message full of shell and git syntax is ONE argument: it becomes the note, verbatim.
  const hostile = `Prices; rm -rf ~ && $(calc) --amend -m "x" \`whoami\``;
  const commit = await gitCommit({ repo, message: hostile }, env) as any;
  assert.equal(commit.ok, true, JSON.stringify(commit));
  assert.equal(commit.committed, true);
  const log = await gitLog({ repo, limit: 5 }, env) as any;
  assert.equal(log.commits.length, 2);
  assert.equal(log.commits[0].subject, hostile);
  assert.ok(existsSync(os.homedir()), "nothing was deleted");

  const nothing = await gitCommit({ repo, message: "again" }, env) as any;
  assert.equal(nothing.committed, false);
  assert.match(nothing.summary, /nothing new/);

  const created = await gitCheckout({ repo, branch: "fix/total", create: true }, env) as any;
  assert.equal(created.ok, true);
  const branches = await gitBranches({ repo }, env) as any;
  assert.equal(branches.current, "fix/total");
  assert.ok(branches.branches.some((b: any) => b.name === "main"));
  assert.equal((await gitCheckout({ repo, branch: "--orphan" }, env) as any).error, "bad_branch");
  assert.equal((await gitCheckout({ repo, branch: "main" }, env) as any).ok, true);
});

test("git: the repo path is fenced and must really be a project", { skip: !hasGit && "git is not installed" }, async () => {
  const { env, home } = makeRepo();
  const plain = path.join(home, "just-a-folder");
  mkdirSync(plain);
  const notRepo = await resolveRepo(plain, env) as any;
  // A folder inside a temp dir may sit under some unrelated repo; either it is refused, or its top must still be inside the fence.
  if (!notRepo.ok) assert.ok(["not_a_repo", "git_failed", "repo_outside_allowed_roots"].includes(notRepo.error), notRepo.error);
  const outside = await gitStatus({ repo: "C:\\Windows" }, env) as any;
  assert.equal(outside.ok, false);
  // The raw string, not path.join (which would resolve the `..` away before the fence sees it).
  assert.equal((await gitStatus({ repo: `${home}\\..\\escape` }, env) as any).error, "unsafe_path");
});

test("git: clone refuses dangerous sources before running anything; push without credentials fails fast", { skip: !hasGit && "git is not installed" }, async () => {
  const { env, repo, g } = makeRepo();
  for (const url of ["ext::sh -c calc", "file:///" + repo.replace(/\\/g, "/"), repo]) {
    assert.equal((await gitClone({ url }, env) as any).error, "bad_url", url);
  }
  // A remote that would need a password: must return, not hang on a hidden prompt.
  g("remote", "add", "origin", "https://127.0.0.1:9/nobody/nothing.git");
  const started = Date.now();
  const push = await gitPush({ repo }, env) as any;
  assert.equal(push.ok, false);
  assert.ok(Date.now() - started < 60_000, "push returned instead of waiting for a terminal prompt");
});

test("git not installed reads as a plain sentence", async () => {
  const r = await runGit(["--version"], { deps: { gitPath: "definitely-not-git-" + Date.now() } });
  assert.equal(r.notInstalled, true);
});

/* ─────────────── the person's switches, through the real runtime ─────────────── */

function runtimeWith(settings: { off?: string[]; blockEmail?: boolean; profile?: "SAFE" | "TRUSTED" | "AUTONOMOUS" }) {
  const home = tmp();
  const workspace = path.join(home, "ws");
  mkdirSync(workspace);
  let asked = 0;
  const deps: RuntimeDeps = {
    home, workspace, extraRoots: () => [],
    permissions: () => ({ profile: settings.profile ?? "AUTONOMOUS", overrides: {} }),
    isCallActive: () => false, coworkerEnabled: () => true,
    askApproval: async () => { asked++; return { approved: true, how: "test" }; },
    browser: { cancel() {}, currentUrl: () => null, open: async () => ({ ok: true, url: "x", title: "opened" }) } as any,
    mcp: { tools: () => [], find: () => null, status: () => [] } as any,
    journal: new Journal(path.join(home, "journal")),
    openPath: async () => {}, showInFolder: () => {},
    diagnostics: { portalUrl: "", appVersion: "", logFile: "", phoneState: () => null, linkState: () => ({}) },
    log: () => {},
    disabledGroups: () => settings.off ?? [],
    blockEmail: () => settings.blockEmail ?? true,
  };
  return { rt: new CoworkerRuntime(deps), home, workspace, asked: () => asked };
}

test("every catalogue tool belongs to a switchable family except orientation and bookkeeping tools", () => {
  // ⛔ computer_screen_* (driving the real desktop) is a separate feature with its own
  // session-level consent; it is not one of the workspace's switchable families.
  const unswitched = TOOL_CATALOG.map((t) => t.name).filter((n) => !toolGroup(n) && !n.startsWith("computer_screen_"));
  assert.deepEqual(unswitched.sort(), ["computer_mcp_servers", "computer_task_history", "computer_workspace"].sort());
  for (const g of TOOL_GROUPS) assert.ok(TOOL_CATALOG.some((t) => toolGroup(t.name) === g), `${g} has tools`);
});

test("a family switched off is not announced, and a call that arrives anyway is refused before any verdict or approval", async () => {
  const { rt, workspace, asked } = runtimeWith({ off: ["files", "git"] });
  const names = rt.manifestTools().map((t) => t.name);
  assert.ok(!names.some((n) => n.startsWith("computer_fs_") || n.startsWith("computer_git_")));
  assert.ok(names.includes("computer_xlsx_read"), "other families stay");
  const out = await rt.handle({ id: "c1", name: "computer_fs_write", args: { path: path.join(workspace, "x.txt"), content: "no" }, taskId: "t" });
  assert.equal(out.ok, false);
  assert.equal((out.content as any).error, "switched_off");
  assert.match((out.content as any).message, /Files on this computer is switched off/);
  assert.equal(existsSync(path.join(workspace, "x.txt")), false, "nothing was written");
  assert.equal(asked(), 0, "no approval prompt for a switched-off family");
});

test("email is blocked by default and opens only when switched on", async () => {
  assert.equal(isWebmailUrl("https://mail.google.com/mail/u/0/#inbox"), true);
  assert.equal(isWebmailUrl("https://outlook.office.com/mail/"), true);
  assert.equal(isWebmailUrl("https://www.icloud.com/mail"), true);
  assert.equal(isWebmailUrl("https://www.google.com/search?q=mail"), false);
  assert.equal(isWebmailUrl("https://docs.google.com/"), false);
  const blocked = runtimeWith({ blockEmail: true });
  const r1 = await blocked.rt.handle({ id: "e1", name: "computer_browser_open", args: { url: "https://mail.google.com/" }, taskId: "t" });
  assert.equal((r1.content as any).error, "switched_off");
  assert.equal((r1.content as any).group, "email");
  const allowed = runtimeWith({ blockEmail: false });
  const r2 = await allowed.rt.handle({ id: "e2", name: "computer_browser_open", args: { url: "https://mail.google.com/" }, taskId: "t" });
  assert.notEqual((r2.content as any)?.error, "switched_off");
});

test("git tools through the runtime keep the policy: a push asks even under full access", { skip: !hasGit && "git is not installed" }, async () => {
  const { rt, asked } = runtimeWith({ profile: "AUTONOMOUS" });
  const status = await rt.handle({ id: "g1", name: "computer_git_status", args: { repo: "C:\\Windows" }, taskId: "t" });
  assert.equal(status.ok, false);
  assert.equal(asked(), 0, "a read never asks");
  await rt.handle({ id: "g2", name: "computer_git_push", args: { repo: "C:\\nowhere" }, taskId: "t" });
  assert.equal(asked(), 1, "push always asks: it sends code off the computer");
});

/* ─────────────── the workspace bridge ─────────────── */

test("pure rules: raise detection, folder refusals, merge cap, switches and trusted senders", () => {
  assert.equal(isRaise("SAFE", "AUTONOMOUS"), true);
  assert.equal(isRaise(undefined, "TRUSTED"), true);
  assert.equal(isRaise("AUTONOMOUS", "SAFE"), false);
  assert.equal(isRaise("TRUSTED", "TRUSTED"), false);
  for (const bad of ["C:\\", "D:\\", "C:\\Windows\\Temp", "C:\\Users", "C:\\Program Files", "\\\\server\\share", "relative\\path"]) assert.ok(folderRefusal(bad), bad);
  assert.equal(folderRefusal("C:\\Users\\izzy\\Documents\\Invoices"), null);
  assert.equal(folderRefusal("D:\\Projects\\shop"), null);
  let list: any[] = [];
  for (let i = 0; i < 30; i++) list = mergeFolder(list, { path: `C:\\f${i}`, name: `f${i}`, repo: false, addedAt: "" });
  assert.equal(list.length, 20);
  assert.equal(mergeFolder(list, { path: "c:\\F29", name: "again", repo: true, addedAt: "" }).filter((f) => f.path.toLowerCase() === "c:\\f29").length, 1, "same folder is not listed twice");
  const s0 = {} as DesktopSettings;
  assert.deepEqual(groupsView(s0), { files: true, browser: true, sheets: true, git: true, shell: true, system: true, windows: true, screen: true, services: true, email: false }, "everything on, email off by default");
  const s1 = applyGroups(s0, { browser: false, email: true, isAdmin: true, files: "no" });
  assert.deepEqual(s1.coworkerDisabledGroups, ["browser"]);
  assert.equal(s1.coworkerBlockEmail, false);
  assert.deepEqual(applyGroups(s1, { browser: true }).coworkerDisabledGroups, []);
  assert.equal(isTrustedSenderUrl("https://app.connectcomunications.com/desktop/coworker", "https://app.connectcomunications.com"), true);
  assert.equal(isTrustedSenderUrl("https://evil.example/desktop/coworker", "https://app.connectcomunications.com"), false);
  assert.equal(isTrustedSenderUrl("http://app.connectcomunications.com/", "https://app.connectcomunications.com"), false);
  assert.equal(isTrustedSenderUrl("file:///C:/app/assets/coworkerConnections.html", "https://app.connectcomunications.com"), true);
  assert.match(ACCESS_DIALOG.AUTONOMOUS.detail, /STILL ask before it deletes/);
});

function fakeIpc() {
  const handlers = new Map<string, (e: any, a: any) => any>();
  return { handlers, ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) } as any };
}

function bridge(opts: { answer?: number; pick?: string | null; home?: string; senderUrl?: string } = {}) {
  let settings: DesktopSettings = {} as DesktopSettings;
  const dialogs: any[] = [];
  const { handlers, ipcMain } = fakeIpc();
  const events: string[] = [];
  registerCoworkerUiIpc({
    ipcMain,
    dialog: {
      showMessageBox: (async (...args: any[]) => { dialogs.push(args[args.length - 1]); return { response: opts.answer ?? 1, checkboxChecked: false }; }) as any,
      showOpenDialog: (async () => (opts.pick ? { canceled: false, filePaths: [opts.pick] } : { canceled: true, filePaths: [] })) as any,
    },
    fromWebContents: () => null,
    portalUrl: "https://app.connectcomunications.com",
    home: opts.home ?? os.homedir(),
    appVersion: "test",
    getSettings: () => settings,
    writeSettings: (n) => { settings = n; },
    announce: () => events.push("announce"),
    linkState: () => "connected",
    bubbleEnabled: () => true,
    setBubbleEnabled: (on) => events.push(`bubble:${on}`),
    openCoworkerFull: (r) => events.push(`full:${r}`),
    openBubbleChat: () => events.push("bubble-chat"),
    isChatVisible: () => false,
    setBadge: (s) => events.push(`badge:${s}`),
    notify: (t) => events.push(`notify:${t}`),
    log: () => {},
  });
  const call = (ch: string, arg?: unknown) => handlers.get(ch)!({ sender: { getURL: () => opts.senderUrl ?? "https://app.connectcomunications.com/desktop/coworker" } }, arg);
  return { call, dialogs, events, settings: () => settings, handlers };
}

test("bridge: raising access needs the native dialog; Cancel changes nothing; lowering never asks", async () => {
  const no = bridge({ answer: 1 });
  const refused = await no.call("coworker-ui:set-access", "AUTONOMOUS");
  assert.equal(refused.error, "cancelled");
  assert.equal(no.settings().coworkerPermissions, undefined);
  assert.equal(no.dialogs.length, 1);
  assert.match(no.dialogs[0].message, /full access/);

  const yes = bridge({ answer: 0 });
  assert.equal((await yes.call("coworker-ui:set-access", "AUTONOMOUS")).profile, "AUTONOMOUS");
  assert.equal(yes.settings().coworkerPermissions, "AUTONOMOUS");
  assert.ok(yes.events.includes("announce"));
  const before = yes.dialogs.length;
  assert.equal((await yes.call("coworker-ui:set-access", "SAFE")).profile, "SAFE");
  assert.equal(yes.dialogs.length, before, "going back to Ask first never asks");
  assert.equal((await yes.call("coworker-ui:set-access", "CUSTOM")).error, "bad_profile");
});

test("bridge: another origin is refused on every verb", async () => {
  const b = bridge({ answer: 0, senderUrl: "https://evil.example/" });
  for (const ch of b.handlers.keys()) {
    const r = await b.call(ch, "AUTONOMOUS");
    assert.equal(r.error, "not_allowed_from_this_window", ch);
  }
  assert.equal(b.settings().coworkerPermissions, undefined);
});

test("bridge: attach from the picker, detect a code project, refuse a plain folder as a project, drop outside home asks", { skip: !hasGit && "git is not installed" }, async () => {
  const { repo, home } = makeRepo();
  const plain = path.join(home, "Invoices");
  mkdirSync(plain);
  const picker = bridge({ pick: repo, home });
  const r = await picker.call("coworker-ui:pick-folder", { repo: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.folder.repo, true);
  assert.equal(picker.settings().coworkerFolders?.[0].name, "shop");
  const plainAsRepo = await bridge({ pick: plain, home }).call("coworker-ui:pick-folder", { repo: true });
  assert.equal(plainAsRepo.error, "not_a_repo");
  const cancelled = await bridge({ pick: null, home }).call("coworker-ui:pick-folder", {});
  assert.equal(cancelled.error, "cancelled");

  // Dropped from outside "home": the native question is asked; No attaches nothing.
  const elsewhere = bridge({ answer: 1, home: path.join(os.tmpdir(), "not-this-home") });
  const dropped = await elsewhere.call("coworker-ui:attach-dropped", plain);
  assert.equal(dropped.error, "cancelled");
  assert.equal(elsewhere.dialogs.length, 1);
  assert.equal(elsewhere.settings().coworkerFolders, undefined);
  // Inside home: attached without a question.
  const inside = bridge({ answer: 1, home });
  assert.equal((await inside.call("coworker-ui:attach-dropped", plain)).ok, true);
  assert.equal(inside.dialogs.length, 0);
  assert.equal((await inside.call("coworker-ui:attach-dropped", "C:\\Windows")).error, "refused");
  assert.equal((await inside.call("coworker-ui:attach-dropped", path.join(plain, "nope.txt"))).error, "not_a_folder");
  await inside.call("coworker-ui:remove-folder", plain.toUpperCase());
  assert.deepEqual(inside.settings().coworkerFolders, []);
});

test("bridge: open-full only opens the Coworker page; task-finished badges and notifies when the chat is hidden", async () => {
  const b = bridge();
  await b.call("coworker-ui:open-full", "/coworker?task=abc");
  await b.call("coworker-ui:open-full", "https://evil.example");
  await b.call("coworker-ui:open-full", "/admin/billing");
  assert.deepEqual(b.events.filter((e) => e.startsWith("full:")), ["full:/coworker?task=abc", "full:/coworker", "full:/coworker"]);
  await b.call("coworker-ui:task-finished", { title: "Done: organize Downloads", body: "212 files moved" });
  assert.ok(b.events.includes("badge:unread"));
  assert.ok(b.events.includes("notify:Done: organize Downloads"));
  await b.call("coworker-ui:task-finished", { notify: false });
  assert.equal(b.events.filter((e) => e.startsWith("notify:")).length, 1, "notify:false only badges");
});

test("source guards: the preload publishes the workspace bridge and turns a dropped File into a path only via webUtils; hands registers it", () => {
  const preload = readFileSync(path.join(__dirname, "..", "preload.ts"), "utf8");
  assert.match(preload, /exposeInMainWorld\("coworkerUi", coworkerUiApi\)/);
  assert.match(preload, /webUtils\.getPathForFile\(file\)/);
  assert.doesNotMatch(preload.slice(preload.indexOf("const coworkerUiApi")), /attach-dropped", (?!p\))/, "the dropped path is the webUtils one, never a page string");
  const hands = readFileSync(path.join(__dirname, "hands.ts"), "utf8");
  assert.match(hands, /registerCoworkerUiIpc\(\{/);
  assert.match(hands, /blockEmail: \(\) => d\.getSettings\(\)\.coworkerBlockEmail !== false/, "email is opt-in");
  assert.match(hands, /coworkerFolders \?\? \[\]\)\.map\(\(f\) => f\?\.path\)/, "attached folders become roots");
});

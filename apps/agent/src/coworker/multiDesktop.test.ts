/**
 * ⛔⛔ ONE PERSON, TWO COMPUTERS (2026-09-18).
 *
 * Before this, the link kept ONE session per IDENTITY, so a person with a desktop
 * and a laptop signed into the same Loopcom account shared one queue: the model
 * was handed machine A's tool list and `deliver()` gave the call to whichever
 * machine's long-poll sat at the head of the waiter list. Found live — a desktop
 * advertising 72 tools was told to open Notepad and the file appeared on a
 * DIFFERENT computer, under a different user profile, running an older build.
 *
 * These tests fail against that shape. They pin: a session per computer; a task
 * bound to the computer it started on; a stop that reaches every computer; a
 * result accepted from whichever computer holds the call; and an older app that
 * sends no desktop id still working.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DesktopLink, sessionKey, identityKey, DESKTOP_PRESENCE_MS, type DesktopManifest, type LinkIdentity } from "./desktopLink";

const ME: LinkIdentity = { tenantId: "t1", clientUserId: "u1" };
const OTHER: LinkIdentity = { tenantId: "t1", clientUserId: "u2" };

function manifest(desktopId: string, hostname: string, tools: string[]): DesktopManifest {
  return {
    desktopId, appVersion: "0.1.17-rc.20", hostname, os: "Windows_NT 10.0", username: hostname.toLowerCase(),
    profile: "AUTONOMOUS", workspace: `C:/Users/${hostname}/ws`,
    tools: tools.map((name) => ({ name, description: `${name} does a thing on this computer`, parameters: { type: "object" as const, properties: {} }, category: "FILESYSTEM", risk: "LOW", domains: ["files.read"], source: "builtin" as const, timeoutMs: 30_000 })),
    mcpServers: [],
  };
}

/** A fake computer: says hello, then long-polls, answering whatever it is given. */
class FakeDesktop {
  received: { name: string; id: string }[] = [];
  cancels: (string | null)[] = [];
  running = false;
  constructor(readonly link: DesktopLink, readonly id: string, readonly host: string, readonly tools: string[], readonly identity: LinkIdentity = ME) {}
  hello() { this.link.hello(this.identity, manifest(this.id, this.host, this.tools)); }
  /** Poll once and answer; returns what it got. */
  async pump(answer: (name: string) => unknown = () => ({ ok: true, host: this.host })): Promise<string | null> {
    const msg = await this.link.next(this.identity, 50, this.id);
    if (!msg) return null;
    if (msg.kind === "cancel") { this.cancels.push(msg.taskId); return "cancel"; }
    this.received.push({ name: msg.name, id: msg.id });
    this.link.result(this.identity, msg.id, { ok: true, content: answer(msg.name) });
    return msg.name;
  }
  /** Keep polling until stopped (the real client's loop). */
  start(answer?: (name: string) => unknown) {
    this.running = true;
    const loop = async () => { while (this.running) { await this.pump(answer); await new Promise((r) => setTimeout(r, 5)); } };
    void loop();
  }
  stop() { this.running = false; }
}

test("sessionKey is per computer; two computers on one account are two sessions", () => {
  const link = new DesktopLink();
  assert.notEqual(sessionKey(ME, "deskA"), sessionKey(ME, "deskB"));
  assert.ok(sessionKey(ME, "deskA").startsWith(identityKey(ME)));
  link.hello(ME, manifest("deskA", "DESKTOP", ["computer_fs_list"]));
  link.hello(ME, manifest("deskB", "LAPTOP", ["computer_fs_list", "computer_app_launch"]));
  assert.equal(link.sessionsFor(ME).length, 2);
  assert.equal(link.sessionsFor(OTHER).length, 0, "another person's computers are never mixed in");
  assert.equal(link.session(ME, "deskA")!.manifest.hostname, "DESKTOP");
  assert.equal(link.session(ME, "deskB")!.manifest.hostname, "LAPTOP");
});

test("⛔ the call runs on the computer the model was told about — never the other one", async () => {
  const link = new DesktopLink();
  const desk = new FakeDesktop(link, "deskA", "DESKTOP", ["computer_fs_list"]);
  const laptop = new FakeDesktop(link, "deskB", "LAPTOP", ["computer_fs_list", "computer_app_launch"]);
  // the OLD machine says hello first and sits on a long poll (this is the shape that stole the work)
  desk.hello();
  desk.start();
  await new Promise((r) => setTimeout(r, 30));
  // the machine in front of the person says hello LAST → it is the preferred one
  laptop.hello();
  laptop.start();
  const m = link.manifest(ME)!;
  assert.equal(m.hostname, "LAPTOP", "the model is told about the most recently active computer");
  const r = await link.dispatch(ME, { name: "computer_app_launch", args: {}, taskId: "task1" });
  desk.stop(); laptop.stop();
  assert.equal(r.ok, true);
  assert.equal((r.content as { host: string }).host, "LAPTOP", "the call ran where the model was told it would");
  assert.equal(laptop.received.length, 1);
  assert.equal(desk.received.length, 0, "the other computer never saw it");
});

test("⛔ a multi-step task stays on ONE computer even when the other becomes preferred mid-task", async () => {
  const link = new DesktopLink();
  const a = new FakeDesktop(link, "deskA", "A", ["computer_fs_list"]);
  const b = new FakeDesktop(link, "deskB", "B", ["computer_fs_list"]);
  a.hello(); a.start();
  await new Promise((r) => setTimeout(r, 20));
  const first = await link.dispatch(ME, { name: "computer_fs_list", args: {}, taskId: "taskX" });
  assert.equal((first.content as { host: string }).host, "A");
  // the laptop now says hello and becomes the most recent — the RUNNING task must not move
  b.hello(); b.start();
  await new Promise((r) => setTimeout(r, 20));
  const second = await link.dispatch(ME, { name: "computer_fs_list", args: {}, taskId: "taskX" });
  assert.equal((second.content as { host: string }).host, "A", "the task stayed on the computer it started on");
  // a NEW task goes to the now-preferred computer
  const other = await link.dispatch(ME, { name: "computer_fs_list", args: {}, taskId: "taskY" });
  assert.equal((other.content as { host: string }).host, "B");
  a.stop(); b.stop();
  assert.equal(a.received.length, 2);
  assert.equal(b.received.length, 1);
});

test("a task whose computer goes away is told so — it never silently continues somewhere else", async () => {
  let now = 1_000_000;
  const link = new DesktopLink(() => now);
  const a = new FakeDesktop(link, "deskA", "A", ["computer_fs_list"]);
  const b = new FakeDesktop(link, "deskB", "B", ["computer_fs_list"]);
  a.hello();
  const p = link.dispatch(ME, { name: "computer_fs_list", args: {}, taskId: "taskZ" });
  await a.pump();
  assert.equal((await p).ok, true);
  b.hello();
  // A stops polling and ages out
  now += DESKTOP_PRESENCE_MS + 1000;
  b.hello(); // B is present and fresh
  const r = await link.dispatch(ME, { name: "computer_fs_list", args: {}, taskId: "taskZ" });
  assert.equal(r.ok, false);
  assert.equal((r.content as { error: string }).error, "desktop_changed");
  assert.match(String((r.content as { message: string }).message), /went away/);
  assert.equal(b.received.length, 0, "nothing ran on the other computer behind the person's back");
});

test("⛔ STOP reaches every computer the person has, not just the preferred one", async () => {
  // ⛔ A controlled clock: two hellos in the same millisecond are a TIE, and this
  // test is about the cancel fan-out, not about which computer wins a tie.
  let now = 3_000_000;
  const link = new DesktopLink(() => now);
  const a = new FakeDesktop(link, "deskA", "A", ["computer_fs_list"]);
  const b = new FakeDesktop(link, "deskB", "B", ["computer_fs_list"]);
  // Bind each task to a NAMED computer by connecting them in a known order.
  a.hello();
  const pa = link.dispatch(ME, { name: "computer_fs_list", args: {}, taskId: "tA" });   // only A exists → tA is A's
  assert.equal((await link.next(ME, 50, "deskA"))?.kind, "call", "A took its call");
  now += 1000;
  b.hello();                                                                            // B connects later → preferred
  const pb = link.dispatch(ME, { name: "computer_fs_list", args: {}, taskId: "tB" });   // tB binds to B
  assert.equal((await link.next(ME, 50, "deskB"))?.kind, "call", "B took its call");
  const out = link.cancel(ME, null);
  const ra = await pa; const rb = await pb;
  assert.equal(ra.ok, false); assert.equal((ra.content as { error: string }).error, "task_cancelled");
  assert.equal(rb.ok, false); assert.equal((rb.content as { error: string }).error, "task_cancelled");
  assert.equal(out.cancelled, 2, "both computers' in-flight calls were failed back");
  // and both computers were TOLD to stop, so subprocesses/browsers stop too
  await a.pump(); await b.pump();
  assert.deepEqual(a.cancels, [null]);
  assert.deepEqual(b.cancels, [null]);
});

test("a result or an approval extension is accepted from whichever computer holds the call", async () => {
  const link = new DesktopLink();
  const a = new FakeDesktop(link, "deskA", "A", ["computer_fs_list"]);
  const b = new FakeDesktop(link, "deskB", "B", ["computer_fs_list"]);
  a.hello();
  await new Promise((r) => setTimeout(r, 10));
  b.hello(); // B preferred
  const p = link.dispatch(ME, { name: "computer_fs_list", args: {}, taskId: "t" });
  const msg = await link.next(ME, 50, "deskB");
  assert.ok(msg && msg.kind === "call");
  const callId = (msg as { id: string }).id;
  assert.equal(link.extend(ME, callId, 5000), true, "the approval extension found the holder");
  assert.equal(link.result(ME, "not-a-call-id", { ok: true, content: {} }), false);
  assert.equal(link.result(ME, callId, { ok: true, content: { host: "B" } }), true);
  const r = await p;
  assert.equal((r.content as { host: string }).host, "B");
  a.stop(); b.stop();
});

test("⛔ an old app that cannot name itself is never handed a NEWER computer's work", async () => {
  const link = new DesktopLink();
  const modern = new FakeDesktop(link, "deskNew", "NEW", ["computer_fs_list", "computer_app_launch"]);
  link.hello(ME, manifest("deskOld", "OLD", ["computer_fs_list"]));   // an rc.10 app: says hello, polls with no id
  modern.hello();
  // the old app polls the ONLY way it knows how — with no id at all
  const stolen = await link.next(ME, 30);
  assert.equal(stolen, null, "an unnamed poll gets nothing while two computers are present");
  // and the work goes to the computer that can name itself
  const p = link.dispatch(ME, { name: "computer_app_launch", args: {}, taskId: "t" });
  assert.equal(await link.next(ME, 30), null, "still nothing for the unnamed poller");
  await modern.pump();
  const r = await p;
  assert.equal((r.content as { host: string }).host, "NEW");
  // an unnamed goodbye cannot disconnect the machine the person is using either
  assert.equal(link.goodbye(ME), false);
  assert.equal(link.sessionsFor(ME).length, 2);
});

test("an older app that sends no computer id still works exactly as before", async () => {
  const link = new DesktopLink();
  link.hello(ME, manifest("legacyDesk", "OLD", ["computer_fs_list"]));
  // no desktopId on the poll — the preferred computer answers
  const p = link.dispatch(ME, { name: "computer_fs_list", args: {}, taskId: "t" });
  const msg = await link.next(ME, 50);
  assert.ok(msg && msg.kind === "call");
  link.result(ME, (msg as { id: string }).id, { ok: true, content: { ok: true } });
  assert.equal((await p).ok, true);
  assert.equal(link.connected(ME), true);
  assert.equal(link.status(ME).desktopId, "legacyDesk");
});

test("⛔ quitting and reopening Loopcom on the computer you are at puts new work there", async () => {
  let now = 5_000_000;
  const link = new DesktopLink(() => now);
  const deskA = (launchId: string) => ({ ...manifest("deskA", "A", ["computer_fs_list"]), launchId });
  const deskB = (launchId: string) => ({ ...manifest("deskB", "B", ["computer_fs_list"]), launchId });
  link.hello(ME, deskA("runA1"));
  now += 1000;
  link.hello(ME, deskB("runB1"));
  assert.equal(link.manifest(ME)!.hostname, "B", "the one opened last");
  // B keeps running and re-hellos every five minutes — that must NOT reshuffle anything
  for (let i = 0; i < 5; i++) { now += 60_000; link.hello(ME, deskA("runA1")); link.hello(ME, deskB("runB1")); }
  assert.equal(link.manifest(ME)!.hostname, "B");
  // the person quits Loopcom on A and opens it again → a NEW run → A is where work goes
  now += 1000;
  const r = link.hello(ME, deskA("runA2"));
  assert.equal(r.reconnected, true);
  assert.equal(link.manifest(ME)!.hostname, "A", "reopening the app moved new work to that computer");
  // and an app with no launchId at all (older build) never jumps the queue this way
  now += 1000;
  const old = link.hello(ME, manifest("deskC", "C", ["computer_fs_list"]));
  assert.equal(old.replaced, false);
  now += 1000;
  link.hello(ME, manifest("deskC", "C", ["computer_fs_list"]));
  assert.equal(link.manifest(ME)!.hostname, "C", "a genuinely new computer is still preferred on its first connection");
  link.hello(ME, deskA("runA2"));
  assert.equal(link.manifest(ME)!.hostname, "C", "a same-run re-hello from A did not jump it back");
});

test("status names every computer and which one new work goes to", async () => {
  const link = new DesktopLink();
  link.hello(ME, manifest("deskA", "DESKTOP", ["computer_fs_list"]));
  await new Promise((r) => setTimeout(r, 10));
  link.hello(ME, manifest("deskB", "LAPTOP", ["computer_fs_list", "computer_app_launch"]));
  const st = link.status(ME) as { connected: boolean; desktops: { hostname: string; preferred: boolean; present: boolean; tools: number }[] };
  assert.equal(st.connected, true);
  assert.equal(st.desktops.length, 2);
  const pref = st.desktops.filter((d) => d.preferred);
  assert.equal(pref.length, 1);
  assert.equal(pref[0].hostname, "LAPTOP");
  assert.ok(st.desktops.every((d) => d.present));
  assert.equal(st.desktops.find((d) => d.hostname === "LAPTOP")!.tools, 2);
});

test("goodbye removes only that computer, and a swept computer takes its task bindings with it", async () => {
  let now = 2_000_000;
  const link = new DesktopLink(() => now);
  link.hello(ME, manifest("deskA", "A", ["computer_fs_list"]));
  link.hello(ME, manifest("deskB", "B", ["computer_fs_list"]));
  assert.equal(link.goodbye(ME, "deskA"), true);
  assert.equal(link.sessionsFor(ME).length, 1);
  assert.equal(link.session(ME, "deskA"), null);
  assert.equal(link.session(ME, "deskB")!.manifest.hostname, "B");
  now += 11 * 60 * 1000;
  assert.equal(link.sweep(), 1);
  assert.equal(link.sessionsFor(ME).length, 0);
  assert.equal(link.connected(ME), false);
  assert.deepEqual(link.status(ME), { connected: false });
});

test("stress: 6 computers, 200 tasks — every call lands on its own task's computer and nothing crosses", async () => {
  const link = new DesktopLink();
  const desks = Array.from({ length: 6 }, (_, i) => new FakeDesktop(link, `d${i}`, `H${i}`, ["computer_fs_list"]));
  for (const d of desks) { d.hello(); d.start(); await new Promise((r) => setTimeout(r, 3)); }
  const runs: Promise<unknown>[] = [];
  const hosts = new Map<string, string>();
  for (let i = 0; i < 200; i++) {
    const taskId = `task${i}`;
    runs.push((async () => {
      const a = await link.dispatch(ME, { name: "computer_fs_list", args: {}, taskId });
      const h1 = (a.content as { host: string }).host;
      hosts.set(taskId, h1);
      const b = await link.dispatch(ME, { name: "computer_fs_list", args: {}, taskId });
      const h2 = (b.content as { host: string }).host;
      assert.equal(h2, h1, `${taskId} jumped computers mid-task (${h1} → ${h2})`);
      link.endTask(ME, taskId);
    })());
  }
  await Promise.all(runs);
  for (const d of desks) d.stop();
  assert.equal(hosts.size, 200);
  const total = desks.reduce((n, d) => n + d.received.length, 0);
  assert.equal(total, 400, "every call was delivered exactly once");
});

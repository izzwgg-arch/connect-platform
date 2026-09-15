import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityHub, MAX_QUESTIONS_PER_TURN, FINISHED_TURN_TTL_MS, STALE_TURN_TTL_MS, MAX_EVENTS_PER_TURN, QUESTION_TIMEOUT_MS } from "./activity";

const A = { tenantId: "t1", clientUserId: "u1" };
const B = { tenantId: "t1", clientUserId: "u2" };
const OTHER_TENANT = { tenantId: "t2", clientUserId: "u1" };

test("a turn is owned by the identity that opened it; everyone else reads not_found", () => {
  const hub = new ActivityHub();
  assert.deepEqual(hub.open("turn-aaaa-1", A), { ok: true });
  hub.emit("turn-aaaa-1", { type: "thinking" });
  assert.equal(hub.read("turn-aaaa-1", A, 0).ok, true);
  assert.deepEqual(hub.read("turn-aaaa-1", B, 0), { ok: false, error: "not_found" });
  assert.deepEqual(hub.read("turn-aaaa-1", OTHER_TENANT, 0), { ok: false, error: "not_found" });
  assert.deepEqual(hub.open("turn-aaaa-1", B), { ok: false, error: "turn_owned_elsewhere" });
  assert.deepEqual(hub.stop("turn-aaaa-1", B), { ok: false, error: "not_found" });
  assert.equal(hub.isStopped("turn-aaaa-1"), false);
});

test("bad turn ids are refused and a live turn id cannot be reused", () => {
  const hub = new ActivityHub();
  assert.deepEqual(hub.open("short", A), { ok: false, error: "bad_turn_id" });
  assert.deepEqual(hub.open("has space in it", A), { ok: false, error: "bad_turn_id" });
  assert.deepEqual(hub.open("x".repeat(65), A), { ok: false, error: "bad_turn_id" });
  assert.equal(hub.open("turn-reuse-1", A).ok, true);
  assert.deepEqual(hub.open("turn-reuse-1", A), { ok: false, error: "turn_busy" });
  hub.finish("turn-reuse-1", true);
  // A finished id may be reused by its owner — the old events are gone.
  assert.equal(hub.open("turn-reuse-1", A).ok, true);
  const r = hub.read("turn-reuse-1", A, 0);
  assert.ok(r.ok && r.events.length === 0 && r.done === false);
});

test("events carry increasing seq and read(after) returns only newer ones; back-to-back thinking collapses", () => {
  const hub = new ActivityHub();
  hub.open("turn-seq-0001", A);
  hub.emit("turn-seq-0001", { type: "thinking" });
  hub.emit("turn-seq-0001", { type: "thinking" });
  hub.stepStarted("turn-seq-0001", "s1", "computer_fs_list", "files", "Looking in your Downloads folder");
  hub.stepEnded("turn-seq-0001", "s1", { state: "done", detail: ["Found 3 files"] });
  const all = hub.read("turn-seq-0001", A, 0);
  assert.ok(all.ok);
  assert.deepEqual(all.events.map((e) => e.type), ["thinking", "step", "step"]);
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2, 3]);
  const later = hub.read("turn-seq-0001", A, 2);
  assert.ok(later.ok && later.events.length === 1 && later.events[0].seq === 3);
  const ended = later.ok ? later.events[0] : null;
  assert.ok(ended && ended.type === "step" && ended.state === "done" && ended.label === "Looking in your Downloads folder" && typeof ended.tookMs === "number");
});

test("finish closes any step still running, marks done, and nothing is appended after", () => {
  const hub = new ActivityHub();
  hub.open("turn-fin-0001", A);
  hub.stepStarted("turn-fin-0001", "s1", "computer_powershell", "shell", "Running a command on this computer");
  hub.finish("turn-fin-0001", false);
  hub.emit("turn-fin-0001", { type: "thinking" });
  const r = hub.read("turn-fin-0001", A, 0);
  assert.ok(r.ok);
  assert.equal(r.done, true);
  const types = r.events.map((e) => (e.type === "step" ? `step:${e.state}` : e.type));
  assert.deepEqual(types, ["step:running", "step:failed", "done"]);
});

test("a question resolves on answer, and a second answer is 'already_answered'", async () => {
  const hub = new ActivityHub();
  hub.open("turn-ask-0001", A);
  const pending = hub.ask("turn-ask-0001", { question: "Which folder?", options: ["Downloads", "Desktop", "Downloads"] });
  const r = hub.read("turn-ask-0001", A, 0);
  const q = r.ok ? r.events.find((e) => e.type === "question") : undefined;
  assert.ok(q && q.type === "question");
  assert.deepEqual(q.options, ["Downloads", "Desktop"], "duplicate options are merged");
  assert.deepEqual(hub.answer("turn-ask-0001", B, q.questionId, "Desktop"), { ok: false, error: "not_found" }, "another person cannot answer");
  assert.deepEqual(hub.answer("turn-ask-0001", A, q.questionId, "   "), { ok: false, error: "empty_answer" });
  assert.deepEqual(hub.answer("turn-ask-0001", A, q.questionId, "Desktop"), { ok: true });
  assert.deepEqual(await pending, { answered: true, answer: "Desktop" });
  assert.deepEqual(hub.answer("turn-ask-0001", A, q.questionId, "Downloads"), { ok: false, error: "already_answered" });
});

test("a question is escapable: skip, stop and the per-turn limit all resolve the wait", async () => {
  const hub = new ActivityHub();
  hub.open("turn-esc-0001", A);
  const p1 = hub.ask("turn-esc-0001", { question: "One?" });
  const q1 = (hub.read("turn-esc-0001", A, 0) as any).events.find((e: any) => e.type === "question");
  hub.answer("turn-esc-0001", A, q1.questionId, null);
  assert.deepEqual(await p1, { answered: false, reason: "skipped" });

  const p2 = hub.ask("turn-esc-0001", { question: "Two?" });
  const p3 = hub.ask("turn-esc-0001", { question: "Three?" });
  const p4 = hub.ask("turn-esc-0001", { question: "Four?" });
  assert.deepEqual(await p4, { answered: false, reason: "limit" }, `at most ${MAX_QUESTIONS_PER_TURN} per turn`);
  hub.stop("turn-esc-0001", A);
  assert.deepEqual(await p2, { answered: false, reason: "stopped" });
  assert.deepEqual(await p3, { answered: false, reason: "stopped" });
  assert.deepEqual(await hub.ask("turn-esc-0001", { question: "After stop?" }), { answered: false, reason: "stopped" });
});

test("a question times out after QUESTION_TIMEOUT_MS", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hub = new ActivityHub();
  hub.open("turn-tmo-0001", A);
  const p = hub.ask("turn-tmo-0001", { question: "Anyone there?" });
  t.mock.timers.tick(QUESTION_TIMEOUT_MS + 1);
  assert.deepEqual(await p, { answered: false, reason: "timeout" });
});

test("stop runs every registered onStop once, and one registered after stop runs immediately", () => {
  const hub = new ActivityHub();
  hub.open("turn-stop-001", A);
  let a = 0; let b = 0;
  hub.onStop("turn-stop-001", () => { a++; });
  hub.onStop("turn-stop-001", () => { throw new Error("a broken stopper must not block the others"); });
  hub.onStop("turn-stop-001", () => { a++; });
  assert.deepEqual(hub.stop("turn-stop-001", A), { ok: true, alreadyDone: false });
  hub.stop("turn-stop-001", A);
  assert.equal(a, 2);
  assert.equal(hub.isStopped("turn-stop-001"), true);
  hub.onStop("turn-stop-001", () => { b++; });
  assert.equal(b, 1);
  hub.finish("turn-stop-001", true);
  assert.deepEqual(hub.stop("turn-stop-001", A), { ok: true, alreadyDone: true });
  const r = hub.read("turn-stop-001", A, 0);
  const done = r.ok ? r.events.find((e) => e.type === "done") : undefined;
  assert.ok(done && done.type === "done" && done.stopped === true);
});

test("markWaiting flags only this person's running step for that tool", () => {
  const hub = new ActivityHub();
  hub.open("turn-wait-001", A);
  hub.open("turn-wait-002", B);
  hub.stepStarted("turn-wait-001", "s1", "computer_fs_write", "files", "Saving notes.txt");
  hub.stepStarted("turn-wait-001", "s2", "computer_fs_list", "files", "Looking in Desktop");
  hub.stepStarted("turn-wait-002", "s3", "computer_fs_write", "files", "Saving other.txt");
  assert.equal(hub.markWaiting(A, "computer_fs_write"), 1);
  const a = hub.read("turn-wait-001", A, 0);
  const waits = a.ok ? a.events.filter((e) => e.type === "step" && e.state === "waiting") : [];
  assert.equal(waits.length, 1);
  const b = hub.read("turn-wait-002", B, 0);
  assert.ok(b.ok && !b.events.some((e) => e.type === "step" && e.state === "waiting"));
});

test("activeTurnFor finds the running turn of a conversation, for its owner only", () => {
  const hub = new ActivityHub();
  hub.open("turn-conv-001", A);
  hub.setConversation("turn-conv-001", "conv1");
  hub.setConversation("turn-conv-001", "conv1");
  assert.equal(hub.activeTurnFor(A, "conv1"), "turn-conv-001");
  assert.equal(hub.activeTurnFor(B, "conv1"), null);
  const r = hub.read("turn-conv-001", A, 0);
  assert.equal(r.ok ? r.events.filter((e) => e.type === "conversation").length : -1, 1, "the conversation event is not repeated");
  hub.finish("turn-conv-001", true);
  assert.equal(hub.activeTurnFor(A, "conv1"), null);
});

test("sweep drops finished turns after their TTL and abandoned ones after the stale TTL", () => {
  let now = 1_000_000;
  const hub = new ActivityHub(() => now);
  hub.open("turn-swp-0001", A);
  hub.open("turn-swp-0002", A);
  hub.finish("turn-swp-0001", true);
  now += FINISHED_TURN_TTL_MS + 1;
  assert.equal(hub.sweep(), 1);
  assert.equal(hub.has("turn-swp-0001"), false);
  assert.equal(hub.has("turn-swp-0002"), true);
  now += STALE_TURN_TTL_MS;
  assert.equal(hub.sweep(), 1);
  assert.equal(hub.size(), 0);
});

test("the event list is bounded, dropping old thinking pings first", () => {
  const hub = new ActivityHub();
  hub.open("turn-cap-0001", A);
  for (let i = 0; i < MAX_EVENTS_PER_TURN + 200; i++) {
    hub.emit("turn-cap-0001", { type: "thinking" });
    hub.stepStarted("turn-cap-0001", `s${i}`, "computer_fs_stat", "files", `Checking ${i}`);
  }
  const r = hub.read("turn-cap-0001", A, 0);
  assert.ok(r.ok && r.events.length <= MAX_EVENTS_PER_TURN);
});

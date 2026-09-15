/**
 * The Coworker workspace's turn model — what the screen shows is derived here, from
 * events that arrive late, twice, out of order, or from a second window.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEvents, newTurn, turnStatus, stepsDone, changedItems, currentResource, formatDuration, newTurnId, taskGroup, parseReply, splitAttachmentNote,
  type ActivityEvent,
} from "./coworkerModel";

const ev = (seq: number, e: Record<string, unknown>): ActivityEvent => ({ seq, at: 1000 + seq * 100, ...e }) as ActivityEvent;

test("steps appear, update in place, and a late duplicate cannot un-finish a step", () => {
  let v = newTurn("t1", 1000);
  v = applyEvents(v, [
    ev(1, { type: "thinking" }),
    ev(2, { type: "step", stepId: "s1", state: "running", kind: "files", label: "Looking in your Downloads folder" }),
  ]);
  assert.equal(v.steps.length, 1);
  assert.equal(turnStatus(v), "working");
  v = applyEvents(v, [ev(3, { type: "step", stepId: "s1", state: "done", kind: "files", label: "Looking in your Downloads folder", detail: ["Found 214 files"], tookMs: 1800 })]);
  assert.equal(v.steps[0].state, "done");
  assert.deepEqual(v.steps[0].detail, ["Found 214 files"]);
  // A replay of everything (a second window, a retried poll) changes nothing.
  const again = applyEvents(v, [ev(2, { type: "step", stepId: "s1", state: "running", kind: "files", label: "x" })]);
  assert.equal(again, v, "old sequence numbers are ignored entirely");
  // A NEW event saying "running" for a finished step is refused too.
  const late = applyEvents(v, [ev(4, { type: "step", stepId: "s1", state: "running", kind: "files", label: "x" })]);
  assert.equal(late.steps[0].state, "done");
  assert.equal(stepsDone(late), 1);
});

test("events in one batch are applied in sequence order, whatever order they arrived in", () => {
  const v = applyEvents(newTurn("t2", 0), [
    ev(3, { type: "step", stepId: "s1", state: "done", kind: "web", label: "Opening example.com" }),
    ev(2, { type: "step", stepId: "s1", state: "running", kind: "web", label: "Opening example.com" }),
  ]);
  assert.equal(v.steps[0].state, "done");
  assert.equal(v.lastSeq, 3);
});

test("a question opens, counts, and closes when answered; approval waiting is its own status", () => {
  let v = applyEvents(newTurn("t3"), [ev(1, { type: "question", questionId: "q1", question: "Documents or Desktop?", options: ["Documents", "Desktop"], allowText: true })]);
  assert.equal(turnStatus(v), "question");
  assert.equal(v.questionsAsked, 1);
  v = applyEvents(v, [ev(2, { type: "answered", questionId: "q1", answer: "Desktop", skipped: false })]);
  assert.equal(v.question, null);
  assert.deepEqual(v.answers[0], { questionId: "q1", question: "Documents or Desktop?", answer: "Desktop", skipped: false });
  v = applyEvents(v, [
    ev(3, { type: "step", stepId: "s9", state: "running", kind: "files", label: "Saving notes.txt" }),
    ev(4, { type: "step", stepId: "s9", state: "waiting", kind: "files", label: "Saving notes.txt" }),
  ]);
  assert.equal(turnStatus(v), "approval");
});

test("done closes every open step and the question; a stopped turn reads as stopped", () => {
  const v = applyEvents(newTurn("t4"), [
    ev(1, { type: "step", stepId: "s1", state: "running", kind: "shell", label: "Running a command on this computer" }),
    ev(2, { type: "question", questionId: "q1", question: "Continue?", options: [], allowText: true }),
    ev(3, { type: "done", ok: false, stopped: true }),
  ]);
  assert.equal(v.done, true);
  assert.equal(v.question, null);
  assert.equal(v.steps[0].state, "cancelled");
  assert.equal(turnStatus(v), "stopped");
  assert.equal(v.endedAt, 1300);
});

test("what changed, the plan, the conversation id and the thing open right now", () => {
  const v = applyEvents(newTurn("t5"), [
    ev(1, { type: "conversation", conversationId: "c42" }),
    ev(2, { type: "plan", steps: ["Look in Downloads", "Move the files"], current: 1 }),
    ev(3, { type: "step", stepId: "a", state: "done", kind: "files", label: "Looking in your Downloads folder", resource: { kind: "folder", title: "C:\\Users\\me\\Downloads" } }),
    ev(4, { type: "step", stepId: "b", state: "done", kind: "files", label: "Saving notes.txt", changed: "notes.txt created" }),
    ev(5, { type: "step", stepId: "c", state: "done", kind: "files", label: "Saving notes.txt", changed: "notes.txt created" }),
    ev(6, { type: "step", stepId: "d", state: "denied", kind: "files", label: "Deleting old.txt", changed: "old.txt deleted" }),
  ]);
  assert.equal(v.conversationId, "c42");
  assert.deepEqual(v.plan, { steps: ["Look in Downloads", "Move the files"], current: 1 });
  assert.deepEqual(changedItems(v), ["notes.txt created"], "de-duplicated, and a denied step changed nothing");
  assert.equal(currentResource(v)?.resource.title, "C:\\Users\\me\\Downloads");
});

test("helpers: durations, turn ids the agent accepts, task groups, attachment notes", () => {
  assert.equal(formatDuration(400), "<1s");
  assert.equal(formatDuration(2400), "2s");
  assert.equal(formatDuration(125_000), "2m 05s");
  for (let i = 0; i < 50; i++) assert.match(newTurnId(), /^[A-Za-z0-9_-]{8,64}$/);
  assert.notEqual(newTurnId(), newTurnId());
  const now = new Date(2026, 8, 15, 14, 0);
  assert.equal(taskGroup(new Date(2026, 8, 15, 9, 0), now), "Today");
  assert.equal(taskGroup(new Date(2026, 8, 14, 23, 0), now), "Yesterday");
  assert.equal(taskGroup(new Date(2026, 8, 10, 9, 0), now), "Last 7 days");
  assert.equal(taskGroup(new Date(2026, 7, 1), now), "Earlier");
  assert.deepEqual(splitAttachmentNote("what do these say?\n[Attached: invoice.pdf (1.2 MB), notes, final.txt (3 KB)]"), { text: "what do these say?", attached: ["invoice.pdf", "notes, final.txt"] });
  assert.deepEqual(splitAttachmentNote("no files here"), { text: "no files here", attached: [] });
});

test("replies render as paragraphs, lists and bold — never as HTML", () => {
  const blocks = parseReply("Done. Your Downloads folder is organized:\n\n- **Pictures**: 88 files\n- PDFs: 61\n\n1. First\n2. Second\n<script>alert(1)</script>");
  assert.equal(blocks[0].type, "p");
  assert.equal(blocks[1].type, "ul");
  const ul = blocks[1] as Extract<(typeof blocks)[number], { type: "ul" }>;
  assert.deepEqual(ul.items[0], [{ text: "Pictures", bold: true }, { text: ": 88 files", bold: false }]);
  assert.equal(blocks[2].type, "ol");
  const last = blocks[3] as Extract<(typeof blocks)[number], { type: "p" }>;
  assert.equal(last.inline[0].text, "<script>alert(1)</script>", "kept as text; React escapes it");
});

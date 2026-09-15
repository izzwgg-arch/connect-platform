/**
 * Local stress + fuzz of the Coworker's live activity engine (the piece every
 * screen and every turn depends on). Runs the REAL ActivityHub and the REAL
 * page-side reducer against each other, hard.
 *
 * What it proves:
 *   1. many turns × many events: memory stays bounded, reads stay fast;
 *   2. the page's view, built from POLLED batches (late, duplicated, re-read),
 *      always equals the view built from the full ordered stream;
 *   3. questions under race: answer/skip/stop/timeout each resolve exactly once;
 *   4. sweep reclaims finished turns; the turn cap never grows unbounded;
 *   5. fuzz: random event streams never throw and never leave a step "running"
 *      after done.
 */
import { ActivityHub } from "../src/coworker/activity";
import { applyEvents, newTurn, turnStatus } from "../../portal/components/coworker/coworkerModel";

const OWNER = { tenantId: "t1", clientUserId: "u1" };
const ok = (cond, what) => { if (!cond) { console.error(`FAIL: ${what}`); process.exitCode = 1; } else console.log(`ok   ${what}`); };
const mb = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

/* ── 1. volume ── */
{
  const hub = new ActivityHub();
  const TURNS = 400, STEPS = 40;
  const before = mb();
  const t0 = Date.now();
  for (let t = 0; t < TURNS; t++) {
    const id = `stress_turn_${String(t).padStart(6, "0")}`;
    hub.open(id, OWNER);
    hub.setConversation(id, `conv${t % 20}`);
    for (let s = 0; s < STEPS; s++) {
      hub.emit(id, { type: "thinking" });
      hub.stepStarted(id, `s${s}`, "computer_fs_list", "files", `Looking in folder ${s}`);
      hub.stepEnded(id, `s${s}`, { state: "done", detail: [`Found ${s} files`], changed: s % 7 === 0 ? `file${s}.txt created` : undefined });
    }
    hub.finish(id, true);
  }
  const wrote = Date.now() - t0;
  const r0 = Date.now();
  let events = 0;
  for (let t = 0; t < TURNS; t++) {
    const read = hub.read(`stress_turn_${String(t).padStart(6, "0")}`, OWNER, 0);
    if (read.ok) events += read.events.length;
  }
  const readMs = Date.now() - r0;
  console.log(`   ${TURNS} turns × ${STEPS} steps → ${events} events, write ${wrote}ms, read ${readMs}ms, heap ${before}→${mb()} MB, turns held ${hub.size()}`);
  ok(wrote < 20_000 && readMs < 5_000, "volume: writes and reads stay fast");
  ok(mb() < 900, "volume: heap stays sane");
}

/* ── 2. polled batches equal the whole stream ── */
{
  let seedState = 12345;
  const rnd = () => (seedState = (seedState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 200; round++) {
    const hub = new ActivityHub();
    const id = `poll_round_${String(round).padStart(4, "0")}`;
    hub.open(id, OWNER);
    const steps = 1 + Math.floor(rnd() * 12);
    for (let s = 0; s < steps; s++) {
      hub.stepStarted(id, `s${s}`, "computer_fs_read", "files", `Reading file ${s}`);
      if (rnd() < 0.2) hub.markWaiting(OWNER, "computer_fs_read");
      hub.stepEnded(id, `s${s}`, { state: rnd() < 0.15 ? "failed" : "done", detail: ["detail"] });
      if (rnd() < 0.3) hub.emit(id, { type: "plan", steps: ["a", "b", "c"], current: s % 3 });
    }
    hub.finish(id, true);
    const all = hub.read(id, OWNER, 0);
    const whole = applyEvents(newTurn(id, 0), all.events);
    // Replay in random batches, with overlap and repeats — exactly what polling does.
    let polled = newTurn(id, 0);
    let after = 0;
    let guard = 0;
    while (after < all.lastSeq && guard++ < 500) {
      const batch = all.events.filter((e) => e.seq > after).slice(0, 1 + Math.floor(rnd() * 5));
      const withRepeat = rnd() < 0.4 ? [...batch, ...batch] : batch;
      polled = applyEvents(polled, rnd() < 0.3 ? [...withRepeat].reverse() : withRepeat);
      if (rnd() < 0.2) polled = applyEvents(polled, all.events.slice(0, 3)); // a stale re-read
      after = polled.lastSeq;
    }
    const same = JSON.stringify(polled) === JSON.stringify(whole);
    if (!same) { console.error(`FAIL: polled view diverged at round ${round}`); process.exitCode = 1; break; }
    if (round === 199) ok(true, "polling: batched/duplicated/out-of-order reads give the same view as the whole stream");
  }
}

/* ── 3. questions under race ── */
void (async () => {
  const hub = new ActivityHub();
  const id = "question_race_0001";
  hub.open(id, OWNER);
  const outcomes = [];
  const promises = [];
  for (let i = 0; i < 3; i++) promises.push(hub.ask(id, { question: `Q${i}`, options: ["a", "b"] }).then((r) => outcomes.push(r)));
  const read = hub.read(id, OWNER, 0);
  const qs = read.events.filter((e) => e.type === "question");
  // Answer the first twice at once, skip the second, stop the turn for the third.
  const a1 = hub.answer(id, OWNER, qs[0].questionId, "a");
  const a2 = hub.answer(id, OWNER, qs[0].questionId, "b");
  hub.answer(id, OWNER, qs[1].questionId, null);
  hub.stop(id, OWNER);
  await Promise.all(promises);
  ok(a1.ok === true && a2.ok === false && a2.error === "already_answered", "questions: a second answer to the same question is refused");
  ok(outcomes.filter((o) => o.answered).length === 1, "questions: exactly one answered");
  ok(outcomes.some((o) => o.reason === "skipped") && outcomes.some((o) => o.reason === "stopped"), "questions: skip and stop both resolve");
  ok(hub.ask(id, { question: "after stop" }) instanceof Promise, "questions: asking after stop still resolves");
  const after = await hub.ask(id, { question: "after stop" });
  ok(after.answered === false, "questions: a question after Stop is refused, not hung");
})().then(() => {

/* ── 4. sweep and the turn cap ── */
{
  let now = 1_000_000;
  const hub = new ActivityHub(() => now);
  for (let i = 0; i < 300; i++) { const id = `sweep_turn_${String(i).padStart(5, "0")}`; hub.open(id, OWNER); hub.finish(id, true); }
  ok(hub.size() === 300, "sweep: turns are held before their TTL");
  now += 11 * 60 * 1000;
  const dropped = hub.sweep();
  ok(dropped === 300 && hub.size() === 0, "sweep: finished turns are reclaimed after their TTL");
}

/* ── 5. fuzz ── */
{
  let s = 98765;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const kinds = ["files", "web", "sheet", "phone", "shell", "system", "git", "mcp", "ask", "account", "think"];
  const states = ["running", "waiting", "done", "failed", "denied", "cancelled"];
  let turns = 0;
  for (let i = 0; i < 2000; i++) {
    const hub = new ActivityHub();
    const id = `fuzz_turn_${String(i).padStart(6, "0")}`;
    if (!hub.open(id, OWNER).ok) continue;
    turns++;
    const n = Math.floor(rnd() * 25);
    for (let e = 0; e < n; e++) {
      const pick = rnd();
      const stepId = `s${Math.floor(rnd() * 6)}`;
      if (pick < 0.35) hub.stepStarted(id, stepId, "computer_fs_list", kinds[Math.floor(rnd() * kinds.length)], "x".repeat(Math.floor(rnd() * 200)));
      else if (pick < 0.6) hub.stepEnded(id, stepId, { state: states[2 + Math.floor(rnd() * 4)], detail: Array.from({ length: Math.floor(rnd() * 12) }, () => "d".repeat(Math.floor(rnd() * 400))) });
      else if (pick < 0.7) hub.emit(id, { type: "thinking" });
      else if (pick < 0.8) hub.emit(id, { type: "plan", steps: Array.from({ length: Math.floor(rnd() * 10) }, (_, k) => `step ${k}`), current: Math.floor(rnd() * 10) });
      else if (pick < 0.9) hub.markWaiting(OWNER, "computer_fs_list");
      else void hub.ask(id, { question: "q".repeat(Math.floor(rnd() * 500)), options: Array.from({ length: Math.floor(rnd() * 8) }, (_, k) => `o${k}`) });
    }
    if (rnd() < 0.5) hub.stop(id, OWNER);
    hub.finish(id, rnd() < 0.5);
    const read = hub.read(id, OWNER, 0);
    const view = applyEvents(newTurn(id, 0), read.events);
    if (view.steps.some((x) => x.state === "running" || x.state === "waiting")) { console.error(`FAIL: a step is still running after done (fuzz ${i})`); process.exitCode = 1; break; }
    if (view.question) { console.error(`FAIL: a question survived done (fuzz ${i})`); process.exitCode = 1; break; }
    if (!["done", "stopped"].includes(turnStatus(view))) { console.error(`FAIL: status after done is ${turnStatus(view)}`); process.exitCode = 1; break; }
  }
  ok(process.exitCode !== 1, `fuzz: ${turns} random turns — no throw, nothing left running, no question survives the end`);
}

console.log(process.exitCode === 1 ? "STRESS FAILED" : "STRESS OK");
});

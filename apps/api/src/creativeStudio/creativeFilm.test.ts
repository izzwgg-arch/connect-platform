/**
 * Creative Studio — the film pipeline, and the check that looks at a result
 * before the customer does.
 *
 * Separate from `creativeStudio.test.ts` (which covers generation, the job
 * engine and the route/permission guards) so each file stays readable. Three
 * layers again, for the same reason: pure logic, the engine against an
 * in-memory database, and source guards for the things a refactor silently
 * breaks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MAX_SHOT_SECONDS, assembleFilm, mergeTimeline, planShots, storyboardDoc, timelineFromStoryboard } from "./film";
import { EXPORT_PRESETS, normaliseTimeline } from "./localJobs";
import { planVideoSegments } from "./engines";
import { describeRetry, retryHint } from "./evaluate";

const SRC = path.join(__dirname);

/* ------------------------------------------------------------------ */
/* 1. splitting a film into shots                                      */
/* ------------------------------------------------------------------ */

test("a film is split into shots that no engine has to refuse", () => {
  for (const total of [1, 4, 5, 8, 15, 16, 30, 45, 60, 90, 120, 240]) {
    const shots = planShots(total);
    assert.ok(shots.length >= 1, `${total}s produced no shots`);
    assert.equal(shots.reduce((a, b) => a + b, 0), total, `${total}s did not add back up`);
    for (const s of shots) {
      assert.ok(s <= MAX_SHOT_SECONDS, `${total}s produced a ${s}s shot, over the engine ceiling`);
      assert.ok(s >= 1, `${total}s produced a ${s}s shot`);
    }
  }
});

test("a 15-second commercial is shots the engine bills honestly", () => {
  // ⛔ Four-second beats, not five. The engine renders 4, 8 or 12 seconds only,
  // so a five-second shot is BILLED as eight: three 5s beats cost 24 seconds of
  // engine time for a 15-second film. These four cost 16.
  assert.deepEqual(planShots(15), [4, 4, 4, 3]);
});

test("one render is used wherever one render will do", () => {
  // The waste this pins: a 5-second shot used to be planned as 4+4 — two
  // provider jobs, a continuation and a join — for something a single
  // 8-second render covers and is trimmed from.
  assert.deepEqual(planVideoSegments(5), [8]);
  assert.deepEqual(planVideoSegments(4), [4]);
  assert.deepEqual(planVideoSegments(9), [12]);
  assert.deepEqual(planVideoSegments(12), [12]);
  // Past the engine's longest clip it really does take two.
  assert.deepEqual(planVideoSegments(15), [12, 4]);
  assert.deepEqual(planVideoSegments(13), [12, 4]);
});

test("a short film stays one shot", () => {
  assert.deepEqual(planShots(4), [4]);
  assert.deepEqual(planShots(5), [5]);
});

test("a minute is planned in beats a person would actually cut", () => {
  const shots = planShots(60);
  assert.equal(shots.length, 15);
  assert.ok(shots.every((s) => s === 4));
});

test("a shot is never billed for seconds nobody sees, beyond the engine's own step", () => {
  // What the engine charges for a plan: every shot rounds UP to 4, 8 or 12.
  const billed = (shots: number[]) => shots.reduce((n, s) => n + (s <= 4 ? 4 : s <= 8 ? 8 : 12), 0);
  for (const total of [15, 30, 60]) {
    const waste = billed(planShots(total)) - total;
    assert.ok(waste <= 3, `a ${total}s film wastes ${waste}s of engine time`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. the storyboard document                                          */
/* ------------------------------------------------------------------ */

test("the storyboard the agent writes is the shape both editors read", () => {
  const doc = storyboardDoc(
    [{ prompt: "a van pulls up at dusk" }, { prompt: "the phone is answered" }, { prompt: "the logo" }],
    15,
  );
  assert.equal(doc.kind, "storyboard");
  assert.equal(doc.objects.length, 3);
  for (const o of doc.objects) {
    assert.equal(o.type, "shot");
    assert.ok(o.id, "every object needs an id or the ops door cannot address it");
    assert.ok(o.seconds >= 1 && o.seconds <= MAX_SHOT_SECONDS);
  }
  assert.equal(doc.objects.reduce((n: number, o: any) => n + o.seconds, 0), 15);
});

test("a shot the agent asks to be over the ceiling is brought back under it", () => {
  const doc = storyboardDoc([{ prompt: "one long take", seconds: 40 as any }], 40);
  assert.ok(doc.objects[0].seconds <= MAX_SHOT_SECONDS);
});

test("shots with no length share out the film, instead of one second each", () => {
  // The bug this pins: `Math.max(1, ...)` made every unspecified shot exactly
  // one second, so "a 15-second commercial in 3 shots" came back as 3 seconds.
  const doc = storyboardDoc([{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }], 15);
  assert.deepEqual(doc.objects.map((o: any) => o.seconds), [5, 5, 5]);
});

test("a length the agent insisted on is kept, and the rest share what is left", () => {
  const doc = storyboardDoc([{ prompt: "a", seconds: 8 }, { prompt: "b" }, { prompt: "c" }], 20);
  assert.equal(doc.objects[0].seconds, 8);
  assert.equal(doc.objects.reduce((n: number, o: any) => n + o.seconds, 0), 20);
});

test("asking for a minute in three shots gives shots the engine will accept", () => {
  const doc = storyboardDoc([{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }], 60);
  assert.equal(doc.objects.reduce((n: number, o: any) => n + o.seconds, 0), 60);
  assert.ok(doc.objects.every((o: any) => o.seconds <= MAX_SHOT_SECONDS));
  assert.ok(doc.objects.length > 3, "20-second beats become more shots rather than a refused render");
});

test("a storyboard with no total asked for still gives every shot a usable length", () => {
  const doc = storyboardDoc([{ prompt: "a" }, { prompt: "b" }], 0);
  assert.ok(doc.objects.every((o: any) => o.seconds >= 3 && o.seconds <= MAX_SHOT_SECONDS));
});

test("ids are unique, so re-ordering one shot cannot move another", () => {
  const doc = storyboardDoc(Array.from({ length: 8 }, (_, i) => ({ prompt: `shot ${i}` })), 40);
  assert.equal(new Set(doc.objects.map((o: any) => o.id)).size, 8);
});

/* ------------------------------------------------------------------ */
/* 3. storyboard → timeline                                            */
/* ------------------------------------------------------------------ */

const rendered = (n: number) => ({
  kind: "storyboard",
  ratio: "16:9",
  objects: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, type: "shot", title: `Shot ${i + 1}`, prompt: "x", seconds: 5, assetId: `a${i}` })),
});
const assets = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, { id: `a${i}`, durationMs: 5000 }]));

test("the cut is the shots end to end, with no gap between them", () => {
  const timeline = timelineFromStoryboard(rendered(3), assets(3));
  assert.equal(timeline.objects.length, 3);
  assert.deepEqual(timeline.objects.map((o: any) => o.startMs), [0, 5000, 10000]);
  assert.ok(timeline.objects.every((o: any) => o.track === 0 && o.type === "clip"));
});

test("a shot that has not been rendered is skipped, never left as a gap", () => {
  const board = rendered(3);
  delete (board.objects[1] as any).assetId;
  const timeline = timelineFromStoryboard(board, assets(3));
  assert.equal(timeline.objects.length, 2);
  assert.deepEqual(timeline.objects.map((o: any) => o.startMs), [0, 5000]);
});

test("a shot whose clip was deleted is skipped rather than rendering a missing file", () => {
  const timeline = timelineFromStoryboard(rendered(3), { a0: { id: "a0", durationMs: 5000 }, a2: { id: "a2", durationMs: 5000 } });
  assert.equal(timeline.objects.length, 2);
});

test("the shape of the film decides the frame size", () => {
  assert.equal(timelineFromStoryboard({ objects: [], ratio: "9:16" }, {}).width, 1080);
  assert.equal(timelineFromStoryboard({ objects: [], ratio: "9:16" }, {}).height, 1920);
  assert.equal(timelineFromStoryboard({ objects: [], ratio: "16:9" }, {}).width, 1280);
});

test("re-assembling the picture keeps the voiceover somebody recorded", () => {
  const existing = {
    burnCaptions: false,
    objects: [
      { id: "old", type: "clip", track: 0, assetId: "gone" },
      { id: "v1", type: "voice", track: 3, assetId: "vo", startMs: 0, durationMs: 6000 },
      { id: "c1", type: "caption", track: 2, text: "Your phones never sleep.", startMs: 0, endMs: 2000 },
    ],
  };
  const merged = mergeTimeline(existing, timelineFromStoryboard(rendered(2), assets(2)));
  assert.equal(merged.objects.filter((o: any) => o.type === "clip").length, 2, "the picture is rebuilt");
  assert.ok(merged.objects.some((o: any) => o.id === "v1"), "the voiceover survived");
  assert.ok(merged.objects.some((o: any) => o.id === "c1"), "the caption survived");
  assert.ok(!merged.objects.some((o: any) => o.id === "old"), "the stale clip is gone");
  assert.equal(merged.burnCaptions, false, "their caption choice survived");
});

/* ------------------------------------------------------------------ */
/* 4. the editor's document is what FFmpeg renders                     */
/* ------------------------------------------------------------------ */

test("what the editor draws is exactly what the renderer is given", () => {
  const doc = {
    width: 1280,
    height: 720,
    objects: [
      { id: "c1", type: "clip", track: 0, assetId: "v1", startMs: 0, durationMs: 5000 },
      { id: "c2", type: "clip", track: 0, assetId: "v2", startMs: 5000, durationMs: 4000, inMs: 1000 },
      { id: "m1", type: "music", track: 4, assetId: "mus", startMs: 0, gain: 0.2, duck: true },
      { id: "vo1", type: "voice", track: 3, assetId: "spk", startMs: 500 },
      { id: "sx", type: "sfx", track: 5, assetId: "ring", startMs: 200 },
      { id: "cap", type: "caption", track: 2, startMs: 1000, endMs: 3000, text: "Your phones never sleep." },
    ],
  };
  const t = normaliseTimeline(doc)!;
  assert.equal(t.clips!.length, 2);
  assert.equal(t.clips![1].inMs, 1000, "a split's in-point must reach the renderer");
  assert.equal(t.voice!.length, 1);
  assert.equal(t.music!.length, 1);
  assert.equal(t.music![0].duck, true);
  assert.equal(t.effects!.length, 1);
  assert.deepEqual(t.captions, [{ startMs: 1000, endMs: 3000, text: "Your phones never sleep." }]);
});

test("pieces are laid in time order however they were added", () => {
  const t = normaliseTimeline({
    objects: [
      { id: "b", type: "clip", assetId: "v2", startMs: 5000, durationMs: 5000 },
      { id: "a", type: "clip", assetId: "v1", startMs: 0, durationMs: 5000 },
    ],
  })!;
  assert.deepEqual(t.clips!.map((c) => c.assetId), ["v1", "v2"]);
});

test("a caption with no words is left out rather than burned in blank", () => {
  const t = normaliseTimeline({ objects: [{ id: "x", type: "caption", startMs: 0, endMs: 1000, text: "   " }, { id: "c", type: "clip", assetId: "v", startMs: 0, durationMs: 1000 }] })!;
  assert.equal(t.captions!.length, 0);
});

test("a timeline that already carries clips is passed straight through", () => {
  const legacy = { clips: [{ assetId: "v1", durationMs: 4000 }], width: 640 };
  assert.equal(normaliseTimeline(legacy), legacy);
});

test("an empty document is nothing to render, not an empty film", () => {
  assert.equal(normaliseTimeline({ objects: [] }), null);
  assert.equal(normaliseTimeline(null), null);
});

/* ------------------------------------------------------------------ */
/* 5. assembling, against a database                                   */
/* ------------------------------------------------------------------ */

function fakeDb(seed: { documents?: any[]; assets?: any[] } = {}) {
  const documents: any[] = [...(seed.documents || [])];
  const assetRows: any[] = [...(seed.assets || [])];
  const operations: any[] = [];
  let n = 0;
  const match = (row: any, where: any) =>
    Object.entries(where || {}).every(([k, v]) => (v && typeof v === "object" && "in" in (v as any) ? (v as any).in.includes(row[k]) : row[k] === v));
  return {
    operations,
    documents,
    creativeDocument: {
      async findFirst({ where }: any) {
        return documents.find((d) => match(d, where)) || null;
      },
      async create({ data }: any) {
        const row = { id: `doc${++n}`, ...data };
        documents.push(row);
        return row;
      },
      async update({ where, data }: any) {
        const row = documents.find((d) => d.id === where.id);
        Object.assign(row, data, data.revision?.increment ? { revision: row.revision + data.revision.increment } : {});
        return row;
      },
    },
    creativeAsset: {
      async findMany({ where }: any) {
        return assetRows.filter((a) => match(a, where));
      },
    },
    creativeOperation: {
      async create({ data }: any) {
        operations.push(data);
        return data;
      },
    },
  } as any;
}

test("assembling with no storyboard says so instead of making an empty film", async () => {
  const res = await assembleFilm(fakeDb(), { tenantId: "t1", projectId: "p1" });
  assert.equal(res.ok, false);
  assert.equal((res as any).code, "no_storyboard");
});

test("assembling before anything is rendered refuses in plain words", async () => {
  const db = fakeDb({ documents: [{ id: "d1", tenantId: "t1", projectId: "p1", type: "storyboard", revision: 1, doc: { objects: [{ id: "s0", type: "shot", prompt: "x", seconds: 5 }] } }] });
  const res = await assembleFilm(db, { tenantId: "t1", projectId: "p1" });
  assert.equal(res.ok, false);
  assert.equal((res as any).code, "no_shots");
  assert.match((res as any).reason, /rendered/i);
});

test("assembling writes one timeline, records who did it, and counts what it skipped", async () => {
  const db = fakeDb({
    documents: [{
      id: "d1", tenantId: "t1", projectId: "p1", type: "storyboard", revision: 3,
      doc: { ratio: "16:9", objects: [
        { id: "s0", type: "shot", title: "One", assetId: "a0", seconds: 5 },
        { id: "s1", type: "shot", title: "Two", seconds: 5 },
        { id: "s2", type: "shot", title: "Three", assetId: "a2", seconds: 5 },
      ] },
    }],
    assets: [{ id: "a0", tenantId: "t1", deletedAt: null, durationMs: 5000 }, { id: "a2", tenantId: "t1", deletedAt: null, durationMs: 4000 }],
  });
  const res = await assembleFilm(db, { tenantId: "t1", projectId: "p1", userId: "u1", actorType: "coworker" });
  assert.equal(res.ok, true);
  assert.equal((res as any).clips, 2);
  assert.equal((res as any).skipped, 1);

  const timeline = db.documents.find((d: any) => d.type === "timeline");
  assert.ok(timeline, "a timeline document was written");
  assert.equal(timeline.updatedByType, "coworker", "the history says the Coworker did it");
  assert.deepEqual(timeline.doc.objects.map((o: any) => o.startMs), [0, 5000]);
  assert.equal(db.operations.length, 1, "assembling is one entry in the history");
});

test("assembling twice keeps the sound and replaces only the picture", async () => {
  const db = fakeDb({
    documents: [
      { id: "d1", tenantId: "t1", projectId: "p1", type: "storyboard", revision: 1, doc: { objects: [{ id: "s0", type: "shot", assetId: "a0", seconds: 5 }] } },
      { id: "d2", tenantId: "t1", projectId: "p1", type: "timeline", revision: 4, doc: { objects: [{ id: "vo", type: "voice", track: 3, assetId: "spk", startMs: 0, durationMs: 3000 }] } },
    ],
    assets: [{ id: "a0", tenantId: "t1", deletedAt: null, durationMs: 5000 }],
  });
  const res = await assembleFilm(db, { tenantId: "t1", projectId: "p1", userId: "u1" });
  assert.equal(res.ok, true);
  assert.equal((res as any).revision, 5, "it is a new revision of the SAME document");
  const timeline = db.documents.find((d: any) => d.type === "timeline");
  assert.ok(timeline.doc.objects.some((o: any) => o.id === "vo"), "the voiceover survived being re-assembled");
});

test("one company's storyboard cannot be assembled by another", async () => {
  const db = fakeDb({ documents: [{ id: "d1", tenantId: "t1", projectId: "p1", type: "storyboard", revision: 1, doc: { objects: [] } }] });
  const res = await assembleFilm(db, { tenantId: "t2", projectId: "p1" });
  assert.equal(res.ok, false);
  assert.equal((res as any).code, "no_storyboard", "it reads as absent, never as forbidden");
});

/* ------------------------------------------------------------------ */
/* 6. looking at the result before the customer does                   */
/* ------------------------------------------------------------------ */

test("a re-render is explained in the words a person would use", () => {
  assert.match(describeRetry({ ok: false, checked: true, problems: [{ kind: "hands", detail: "six fingers", severity: "serious" }] }), /hands came out wrong/);
  assert.match(describeRetry({ ok: false, checked: true, problems: [{ kind: "text", detail: "garbled", severity: "serious" }] }), /lettering/);
  // Never the machine's own vocabulary.
  const said = describeRetry({ ok: false, checked: true, problems: [{ kind: "face", detail: "x", severity: "serious" }] });
  assert.ok(!/evaluation|inference|model/i.test(said), `"${said}" reads like a machine`);
});

test("a serious fault is preferred over a cosmetic one when explaining", () => {
  const said = describeRetry({
    ok: false,
    checked: true,
    problems: [{ kind: "framing", detail: "slightly tight", severity: "minor" }, { kind: "hands", detail: "six fingers", severity: "serious" }],
  });
  assert.match(said, /hands/);
});

test("the second attempt is told what to avoid", () => {
  const hint = retryHint({ ok: false, checked: true, problems: [{ kind: "hands", detail: "", severity: "serious" }, { kind: "text", detail: "", severity: "serious" }] });
  assert.match(hint, /five fingers/);
  assert.match(hint, /no text/);
});

test("nothing found means nothing to add to the prompt", () => {
  assert.equal(retryHint({ ok: true, checked: true, problems: [] }), "");
});

/* ------------------------------------------------------------------ */
/* 6b. what a provider's refusal turns into                            */
/* ------------------------------------------------------------------ */

test("a provider's real reason survives, wherever that provider puts it", () => {
  const src = read("engines.ts");
  // ⛔ OpenAI puts it in error.message, ElevenLabs in detail.message. Reading
  // only one threw the reason away: a lapsed subscription came out as "The
  // voice engine refused (401)" on production.
  assert.match(src, /detail\?\.message/);
  assert.match(src, /body\?\.error\?\.message/);
});

test("a problem with Loopcom's own account is not blamed on the customer, and is not retried", () => {
  const engines = read("engines.ts");
  const block = engines.slice(engines.indexOf("function errorFrom"), engines.indexOf("function errorFrom") + 1600);
  assert.match(block, /payment\|billing\|quota_exceeded\|insufficient\|subscription/);
  assert.match(block, /not something you did/);
  assert.match(block, /errorCode: "provider_account"/);

  const jobs = read("jobs.ts");
  assert.match(jobs, /errorCode === "provider_account"/, "it must be permanent — retrying hits the same wall three times");
});

/* ------------------------------------------------------------------ */
/* 6c. a queue that does not lie                                       */
/* ------------------------------------------------------------------ */

test("every shot of an approved storyboard is accepted, not two of them", async () => {
  // ⛔ The failure this pins, seen in a real Coworker turn: the concurrency cap
  // counted QUEUED work, so "render all four shots" took two and refused the
  // rest — and the Coworker then told the person "the other two will start
  // automatically" when nothing would ever start them.
  const { checkQuota } = await import("./jobs");
  const counts: Record<string, number> = { running: 2, queued: 2 };
  const db: any = {
    creativeQuota: { async findUnique() { return null; } },
    creativeUsage: { async groupBy() { return []; } },
    creativeJob: {
      async count({ where }: any) {
        return where.status === "queued" ? counts.queued : counts.running;
      },
    },
  };
  // Two already running and two waiting: the third and fourth shot still go in.
  const verdict = await checkQuota(db, "t1", "video.generate", { seconds: 3 });
  assert.equal(verdict.ok, true, "a shot must be allowed to WAIT even when two are running");

  // But a runaway loop is still stopped.
  counts.queued = 40;
  const full = await checkQuota(db, "t1", "video.generate", { seconds: 3 });
  assert.equal(full.ok, false);
  assert.equal((full as any).code, "quota_queue");
  assert.match((full as any).reason, /finish on their own/);
});

test("the monthly allowance is still checked before anything is queued", async () => {
  const { checkQuota } = await import("./jobs");
  const db: any = {
    creativeQuota: { async findUnique() { return { videoSeconds: 10, images: 100, storageGb: 5, maxConcurrent: 2, premiumEngines: false }; } },
    creativeUsage: { async groupBy() { return [{ measure: "video_seconds", _sum: { quantity: 9 } }]; } },
    creativeJob: { async count() { return 0; } },
  };
  const verdict = await checkQuota(db, "t1", "video.generate", { seconds: 4 });
  assert.equal(verdict.ok, false, "queueing must not become a way around the allowance");
  assert.match((verdict as any).reason, /seconds of video/);
});

/* ------------------------------------------------------------------ */
/* 7. source guards                                                    */
/* ------------------------------------------------------------------ */

const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");

test("a checker that cannot answer passes the work rather than blocking it", () => {
  const src = read("evaluate.ts");
  assert.match(src, /if \(!key\) return PASS_UNCHECKED;/, "no key must not fail a good picture");
  assert.match(src, /could not answer/, "an unparseable verdict must not fail a good picture");
});

test("the checker is given room to think, or it never answers at all", () => {
  // Proven on production: with max_completion_tokens 400 the model spent the
  // whole budget on reasoning and returned EMPTY content, so every single
  // check came back "the checker could not answer" — the feature looked like
  // it was running and was looking at nothing.
  const src = read("evaluate.ts");
  const budget = Number((src.match(/max_completion_tokens: (\d+)/) || [])[1] || 0);
  assert.ok(budget >= 1500, `max_completion_tokens is ${budget} — reasoning tokens eat that before an answer is written`);
  assert.match(src, /REASONING TOKENS COUNT AGAINST THIS/);
});

test("the re-render is bounded, and video is bounded harder than pictures", () => {
  const src = read("jobs.ts");
  const block = src.slice(src.indexOf("QUALITY_RETRY_LIMIT"), src.indexOf("QUALITY_RETRY_LIMIT") + 400);
  assert.match(block, /"video\.generate": 1/, "a 15-second shot is two provider calls — one second chance only");
  assert.match(block, /"image\.generate": 2/);
  assert.match(src, /used < limit && job\.attempts < job\.maxAttempts/, "the job's own attempt cap still applies");
});

test("the job stays sweepable while it is being checked", () => {
  const src = read("jobs.ts");
  // A status the lease sweeper does not know about would strand the job for
  // ever if the process died mid-check.
  assert.ok(!/status: "evaluating"/.test(src), "do not park a job in a status sweepLostLeases ignores");
  assert.match(src, /leaseExpiresAt: new Date\(Date\.now\(\) \+ LEASE_MS \* 2\)/, "the lease is extended before a check that can take a minute");
});

test("a rejected attempt is recorded, not silently thrown away", () => {
  const src = read("jobs.ts");
  assert.match(src, /outcome: "rejected"/);
  assert.match(src, /deletedAt: new Date\(\)/, "the broken file is soft-deleted, so it leaves the library but not the record");
});

test("the renderer and the editor share one document shape", () => {
  const routes = read("routes.ts");
  assert.match(routes, /normaliseTimeline\(document\?\.doc\)/, "the render door must read the timeline the same way the renderer does");
  const local = read("localJobs.ts");
  assert.match(local, /normaliseTimeline\(req\.timeline\)/);
});

test("a finished clip attaches itself to its shot, with no second step to forget", () => {
  const jobs = read("jobs.ts");
  assert.match(jobs, /if \(request\.shotId && job\.projectId && assets\.length\)/, "the render must attach its own clip");
  assert.match(jobs, /async function attachToShot/);
  // It is a read-modify-write that bumps the revision like any other edit, so
  // a browser holding the old revision is told to re-read rather than losing it.
  const block = jobs.slice(jobs.indexOf("async function attachToShot"), jobs.indexOf("export async function cancelJob"));
  assert.match(block, /revision: \{ increment: 1 \}/);
  assert.match(block, /creativeOperation/, "the attach belongs in the project history");

  // Both callers pass the shot, and neither writes the attach itself.
  const tools = readFileSync(path.join(SRC, "..", "..", "..", "agent", "src", "tools", "creativeTools.ts"), "utf8");
  assert.match(tools, /shotId: args\.shot_id/);
  const page = readFileSync(path.join(SRC, "..", "..", "..", "portal", "app", "(platform)", "creative", "storyboard", "page.tsx"), "utf8");
  assert.match(page, /shotId: shot\.id/);
  assert.ok(!/payload: \{ assetId/.test(page), "the page must not attach the clip a second time");
});

test("a shot does not land in the library twice", () => {
  // Proven on production 2026-09-16: every 4-second shot produced BOTH a
  // clip.mp4 (the raw segment) and a shot.mp4 (a re-encoded copy 20 KB
  // bigger), because the single-segment shortcut compared exactly — a 4.1s
  // clip for a 4s ask fell through to the join path. Double the storage, a
  // pointless re-encode, and two near-identical files in the customer's
  // library for one shot.
  const jobs = read("jobs.ts");
  assert.match(jobs, /source: "segment"/, "intermediates must be marked as intermediates");
  assert.match(jobs, /<= wantedMs \+ 500/, "half a second of tolerance, or the copy comes back");
  assert.match(jobs, /source: "generated", expiresAt: null, name: "shot\.mp4"/, "the kept piece is promoted in place");

  // And neither library shows them.
  const routes = read("routes.ts");
  assert.match(routes, /else where\.source = \{ not: "segment" \}/);
  assert.match(routes, /deletedAt: null, source: \{ not: "segment" \} \}, orderBy/);
  const internal = read("internalRoutes.ts");
  assert.match(internal, /source: \{ not: "segment" \}/);
});

test("the film pipeline has one implementation, used by both doors", () => {
  const internal = read("internalRoutes.ts");
  assert.match(internal, /assembleFilm\(db, \{[^}]*actorType: "coworker"/s, "the agent assembles through the shared function");
  const routes = read("routes.ts");
  assert.match(routes, /assembleFilm\(db, \{[^}]*actorType: "user"/s, "and so does the browser");

  // The portal must not build a second one.
  const page = readFileSync(path.join(SRC, "..", "..", "..", "portal", "app", "(platform)", "creative", "storyboard", "page.tsx"), "utf8");
  assert.match(page, /\/assemble/, "the storyboard page asks the server to assemble");
  assert.ok(!/type: "clip", track: 0/.test(page), "the page must not assemble the cut itself");
});

test("every export destination the agent may name really exists", () => {
  const tools = readFileSync(path.join(SRC, "..", "..", "..", "agent", "src", "tools", "creativeTools.ts"), "utf8");
  const block = tools.slice(tools.indexOf("creative_export_file"), tools.indexOf("creative_export_file") + 1400);
  const named = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((n) => n in EXPORT_PRESETS);
  assert.ok(named.length >= 6, "the tool should offer the real destinations");
  for (const n of named) assert.ok(EXPORT_PRESETS[n], `${n} is offered to the model but is not a real preset`);
});

test("no tool posts anything anywhere, and export says so", () => {
  const tools = readFileSync(path.join(SRC, "..", "..", "..", "agent", "src", "tools", "creativeTools.ts"), "utf8");
  assert.ok(!/name: "creative_(post|publish|send|email|share)/.test(tools), "exporting makes a file; a person sends it");
  assert.match(tools, /does NOT post anything anywhere/i);
});

test("the new pages each have their own key, and none is in a default bucket", () => {
  const shared = readFileSync(path.join(SRC, "..", "..", "..", "..", "packages", "shared", "src", "portalPermissions.ts"), "utf8");
  const nav = readFileSync(path.join(SRC, "..", "..", "..", "portal", "navigation", "navConfig.ts"), "utf8");
  for (const key of ["can_view_creative_storyboard", "can_view_creative_timeline", "can_view_creative_audio", "can_view_creative_export"]) {
    assert.ok(shared.includes(key), `${key} is missing from the shared catalog, so neither permission editor can offer it`);
    assert.ok(nav.includes(key), `${key} has no sidebar entry, so it has no toggle anywhere`);
  }
  const buckets = shared.slice(shared.indexOf("const END_USER_ACTIONS"), shared.indexOf("export const DEFAULT_ROLE_PERMISSIONS"));
  for (const key of ["can_view_creative_storyboard", "can_view_creative_timeline", "can_view_creative_audio", "can_view_creative_export"]) {
    assert.ok(!buckets.includes(key), `${key} is in a default bucket — granting a key IS the launch`);
  }
});

test("a page you were granted never 403s on the calls it has to make", () => {
  // The trap this pins: /creative/jobs, /creative/voices and
  // /creative/export-presets are shared by every Creative page and fall under
  // the `/creative` catch-all. Keyed on one PAGE's key, somebody granted only
  // the storyboard would see the page and get 403s inside it — a toggle that
  // lies. Keyed on the SECTION, which every Creative page requires anyway, a
  // granted page really works.
  const server = readFileSync(path.join(SRC, "..", "server.ts"), "utf8");
  const block = server.slice(server.indexOf('{ prefix: "/creative"'), server.indexOf('{ prefix: "/admin/creative"') + 120);
  assert.match(block, /\{ prefix: "\/creative", permission: "can_view_section_creative" \}/);
  assert.match(block, /\{ prefix: "\/creative\/download", permission: null \}/, "the signed download must stay public");
  // And the pages that spend money still gate on their own ACTION key in the
  // handler, which the catch-all does not provide.
  const routes = read("routes.ts");
  assert.match(routes, /needs\(req, reply, "can_creative_export", "export finished work"\)/);
  assert.match(routes, /needs\(req, reply, "can_creative_generate_video", "render a film"\)/);
});

test("this test file's glob is registered, or it never runs on anybody else's machine", () => {
  const pkg = readFileSync(path.join(SRC, "..", "..", "package.json"), "utf8");
  assert.match(pkg, /src\/creativeStudio\/\*\.test\.ts/);
});

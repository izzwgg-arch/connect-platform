/**
 * Creative Studio tests.
 *
 * Three layers, the same shape LoopCom Mobile uses:
 *   1. pure logic — prompts, safety, segment planning, storage keys, captions;
 *   2. the job engine against an in-memory database, so idempotency, leases,
 *      quota and the licence gate are actually exercised rather than asserted
 *      about;
 *   3. source guards — the wiring in server.ts and the permission catalogue,
 *      because a unit test of a helper passes straight through a feature that
 *      was never registered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { planVideoSegments, SORA_SECONDS, imageSizeFor, videoSizeFor, chooseEngine } from "./engines";
import { buildPrompt, checkRequestSafety, memoryClauses, describeRequest } from "./promptBuilder";
import { buildKey, keyBelongsToTenant, safeSegment, sniffMime, kindForMime, ALLOWED_UPLOAD_MIME } from "./storage";
import { toSrt } from "./media";
import { lessonsFor, EVIDENCE_TO_ACTIVE, upsertLesson, recordFeedback, activeMemoryFor } from "./memory";
import { idempotencyKeyFor, createJob, checkQuota, claimJobs, sweepLostLeases, cancelJob, estimateCostMicros, periodOf } from "./jobs";
import { applyOps } from "./helpers";
import { EXPORT_PRESETS } from "./localJobs";

const repoFile = (rel: string) => readFileSync(path.join(__dirname, "..", "..", "..", "..", rel), "utf8").replace(/\r\n/g, "\n");
const apiFile = (rel: string) => readFileSync(path.join(__dirname, "..", "..", rel), "utf8").replace(/\r\n/g, "\n");

/* ------------------------------------------------------------------ */
/* 1. pure logic                                                       */
/* ------------------------------------------------------------------ */

test("a 15-second shot is planned as segments the engine can actually render", () => {
  // Sora's longest native clip is 12s, so 15 is composed. Every piece must be
  // a length the engine accepts, and together they must cover what was asked.
  const segs = planVideoSegments(15);
  assert.ok(segs.length >= 2, "15s must be more than one segment");
  for (const s of segs) assert.ok(SORA_SECONDS.includes(s), `${s}s is not a length the engine accepts`);
  assert.ok(segs.reduce((a, b) => a + b, 0) >= 15, "the segments must cover the whole shot");
});

test("short shots stay one segment, and nothing exceeds the ceiling", () => {
  assert.deepEqual(planVideoSegments(4), [4]);
  assert.deepEqual(planVideoSegments(8), [8]);
  assert.deepEqual(planVideoSegments(12), [12]);
  // Asking for more than 15 is clamped, not honoured.
  assert.ok(planVideoSegments(60).reduce((a, b) => a + b, 0) <= 16);
});

test("a request for another company's logo is refused with something to say", () => {
  const verdict = checkRequestSafety("put the Coca-Cola logo on the van");
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.equal(verdict.kind, "trademark");
  assert.match(verdict.reason, /your own branding|unbranded/i);
});

test("a request for a real named person is refused, an invented one is fine", () => {
  const no = checkRequestSafety("a photo of Elon Musk holding our phone");
  assert.equal(no.ok, false);
  const yes = checkRequestSafety("a shop owner in her fifties holding our phone");
  assert.equal(yes.ok, true);
});

test("ordinary business requests are not caught by the safety net", () => {
  for (const ask of [
    "our desk phone on a wooden desk, morning light",
    "a flyer for our spring sale with room for a headline",
    "a delivery van outside a small shop at dusk",
  ]) {
    assert.equal(checkRequestSafety(ask).ok, true, `${ask} should be allowed`);
  }
});

test("the prompt carries the brand kit and never invites someone else's logo", () => {
  const built = buildPrompt({
    request: "our phone on a desk",
    kind: "image",
    brandKit: { name: "Loopcom", colors: [{ label: "Signal blue", value: "#22A8FF" }], voice: "plain and calm", prohibitions: ["neon gradients"] },
    memory: [],
  });
  assert.match(built.prompt, /our phone on a desk/);
  assert.match(built.prompt, /#22A8FF/);
  assert.match(built.prompt, /Do not include any logo, brand name, or readable trademark/i);
  assert.match(built.negative, /other companies' logos|trademarks/i);
  assert.match(built.negative, /neon gradients/);
});

test("only settled preferences reach the prompt — a suggestion does not", () => {
  const memory = [
    { dimension: "style", statement: "Prefers cinematic imagery", value: "cinematic, filmic light", confidence: 0.8, status: "active" },
    { dimension: "pacing", statement: "Prefers a slower pace", value: "slower", confidence: 0.4, status: "suggested" },
    { dimension: "logo", statement: "Logo small", value: "small and restrained", confidence: 0.9, status: "pinned" },
  ];
  const { clauses, applied } = memoryClauses(memory as any);
  assert.equal(clauses.length, 2, "the suggested one must not be applied yet");
  assert.ok(applied.includes("Prefers cinematic imagery"));
  assert.ok(!applied.includes("Prefers a slower pace"));
});

test("storage keys start with the company and cannot be escaped", () => {
  const key = buildKey({ tenantId: "t_abc", kind: "image", assetId: "a1", name: "../../etc/passwd" });
  assert.ok(key.startsWith("t/t_abc/image/"), key);
  assert.ok(!key.includes(".."), "traversal must not survive into a key");
  assert.equal(keyBelongsToTenant(key, "t_abc"), true);
  assert.equal(keyBelongsToTenant(key, "t_other"), false, "another company must not own this key");
  assert.equal(keyBelongsToTenant("t/t_abc/../t_other/x", "t_abc"), false);
  assert.equal(safeSegment(""), "file");
});

test("an upload is judged by its bytes, not by what it claims to be", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  assert.equal(sniffMime(png), "image/png");
  assert.equal(kindForMime("image/png"), "image");
  // An executable renamed to .png is not a png, and is not on the list.
  const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(20)]);
  const sniffed = sniffMime(exe);
  assert.ok(!sniffed || !ALLOWED_UPLOAD_MIME.has(sniffed), "an exe must never pass as an allowed type");
});

test("captions come out as valid SRT", () => {
  const srt = toSrt([{ startMs: 1000, endMs: 2500, text: "Your phones never sleep." }]);
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:02,500\nYour phones never sleep\./);
});

test("image and video sizes map to what each engine accepts", () => {
  assert.equal(imageSizeFor("16:9"), "1536x1024");
  assert.equal(imageSizeFor("9:16"), "1024x1536");
  assert.equal(videoSizeFor("16:9"), "1280x720");
  assert.equal(videoSizeFor("9:16"), "720x1280");
});

test("edit operations apply, and a nonsense one is skipped rather than fatal", () => {
  const doc = { objects: [{ id: "head", text: "Big", size: 10 }] };
  const next = applyOps(doc, [
    { op: "set", target: "head", payload: { size: 6 } },
    { op: "set", target: "does-not-exist", payload: { size: 99 } },
    { op: "add", payload: { id: "logo", type: "logo" } },
  ]);
  assert.equal(next.objects[0].size, 6);
  assert.equal(next.objects.length, 2);
  assert.equal(next.objects[1].id, "logo");
  // The original is untouched: ops never mutate what was read.
  assert.equal(doc.objects[0].size, 10);
});

test("what the person is told is plain English, not the built prompt", () => {
  assert.match(describeRequest("video.generate", "a night shop floor with one ringing phone"), /^Rendering/);
  assert.match(describeRequest("audio.speech", "anything"), /voiceover/i);
});

test("every export preset has a real pixel size", () => {
  for (const [id, p] of Object.entries(EXPORT_PRESETS)) {
    assert.ok(p.width > 0 && p.height > 0, `${id} needs real dimensions`);
  }
  assert.equal(EXPORT_PRESETS.whatsapp_status.width, 1080);
  assert.equal(EXPORT_PRESETS.whatsapp_status.height, 1920);
});

/* ------------------------------------------------------------------ */
/* 2. the job engine, against an in-memory database                     */
/* ------------------------------------------------------------------ */

function makeDb() {
  const rows: Record<string, any[]> = { creativeJob: [], creativeEngine: [], creativeQuota: [], creativeUsage: [], creativeMemoryItem: [], creativeMemoryEvidence: [], creativeFeedback: [], creativeEngineStat: [], creativeAsset: [] };
  let seq = 0;
  const id = () => `id_${++seq}`;
  const matches = (row: any, where: any): boolean => {
    for (const [k, v] of Object.entries(where || {})) {
      if (k === "OR") { if (!(v as any[]).some((w) => matches(row, w))) return false; continue; }
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const cond: any = v;
        if ("in" in cond && !cond.in.includes(row[k])) return false;
        if ("not" in cond && row[k] === cond.not) return false;
        if ("lt" in cond && !(row[k] && new Date(row[k]) < cond.lt)) return false;
        if ("gte" in cond && !(row[k] && new Date(row[k]) >= cond.gte)) return false;
        if ("hasSome" in cond && !(row[k] || []).some((x: any) => cond.hasSome.includes(x))) return false;
        continue;
      }
      if (row[k] !== v) return false;
    }
    return true;
  };
  const table = (name: string) => ({
    async create({ data }: any) { const row = { id: data.id || id(), createdAt: new Date(), ...data }; rows[name].push(row); return row; },
    async findFirst({ where, orderBy }: any = {}) { const hits = rows[name].filter((r) => matches(r, where)); return hits[0] || null; },
    async findUnique({ where }: any) {
      if (where.tenantId_idempotencyKey) {
        const { tenantId, idempotencyKey } = where.tenantId_idempotencyKey;
        return rows[name].find((r) => r.tenantId === tenantId && r.idempotencyKey === idempotencyKey) || null;
      }
      return rows[name].find((r) => r.id === where.id || (where.tenantId && r.tenantId === where.tenantId)) || null;
    },
    async findMany({ where, take }: any = {}) { const hits = rows[name].filter((r) => matches(r, where || {})); return take ? hits.slice(0, take) : hits; },
    async update({ where, data }: any) {
      const row = rows[name].find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && "increment" in (v as any)) row[k] = (row[k] || 0) + (v as any).increment;
        else row[k] = v;
      }
      return row;
    },
    async updateMany({ where, data }: any) {
      const hits = rows[name].filter((r) => matches(r, where));
      for (const row of hits) {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as any)) row[k] = (row[k] || 0) + (v as any).increment;
          else row[k] = v;
        }
      }
      return { count: hits.length };
    },
    async count({ where }: any = {}) { return rows[name].filter((r) => matches(r, where || {})).length; },
    async groupBy({ by, where, _sum }: any) {
      const hits = rows[name].filter((r) => matches(r, where || {}));
      const out = new Map<string, any>();
      for (const r of hits) {
        const key = by.map((b: string) => r[b]).join("|");
        const cur = out.get(key) || { ...Object.fromEntries(by.map((b: string) => [b, r[b]])), _sum: { quantity: 0, costMicros: 0 } };
        cur._sum.quantity += Number(r.quantity || 0);
        cur._sum.costMicros += Number(r.costMicros || 0);
        out.set(key, cur);
      }
      return [...out.values()];
    },
    async upsert({ where, create, update }: any) {
      const existing = rows[name].find((r) => matches(r, where.id ? { id: where.id } : where));
      if (existing) { Object.assign(existing, update); return existing; }
      const row = { id: create.id || id(), createdAt: new Date(), ...create };
      rows[name].push(row);
      return row;
    },
    async delete({ where }: any) { const i = rows[name].findIndex((r) => r.id === where.id); return i >= 0 ? rows[name].splice(i, 1)[0] : null; },
    async deleteMany({ where }: any) { const before = rows[name].length; rows[name] = rows[name].filter((r) => !matches(r, where || {})); return { count: before - rows[name].length }; },
  });
  const db: any = { __rows: rows };
  for (const name of Object.keys(rows)) db[name] = table(name);
  return db;
}

async function seedTestEngine(db: any, over: Partial<any> = {}) {
  return db.creativeEngine.create({
    data: {
      id: over.id || "loopcom.image",
      label: "Loopcom image",
      provider: "openai",
      capabilities: ["image.generate"],
      model: "gpt-image-2.5-flare",
      license: "Commercial API",
      commercialOk: true,
      enabled: true,
      isDefault: true,
      costModel: { unit: "image", micros: 12_000 },
      sortOrder: 10,
      ...over,
    },
  });
}

test("the same request twice is one job and one charge", async () => {
  const db = makeDb();
  await seedTestEngine(db);
  const request = { request: "a phone on a desk", prompt: "a phone on a desk", count: 1 };
  const first = await createJob(db, { tenantId: "t1", capability: "image.generate", request });
  const second = await createJob(db, { tenantId: "t1", capability: "image.generate", request });
  assert.equal(second.deduped, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(db.__rows.creativeJob.length, 1, "a repeat must not create a second job");
});

test("the same request from ANOTHER company is a different job", async () => {
  const db = makeDb();
  await seedTestEngine(db);
  const request = { request: "identical", prompt: "identical" };
  const a = await createJob(db, { tenantId: "t1", capability: "image.generate", request });
  const b = await createJob(db, { tenantId: "t2", capability: "image.generate", request });
  assert.notEqual(a.job.id, b.job.id);
  assert.equal(db.__rows.creativeJob.length, 2);
  assert.equal(idempotencyKeyFor("image.generate", request), idempotencyKeyFor("image.generate", request));
});

test("an engine we may not sell with is never chosen, even as the only one", async () => {
  const db = makeDb();
  await seedTestEngine(db, { id: "research.model", commercialOk: false, enabled: true, isDefault: true });
  const chosen = await chooseEngine(db, "image.generate");
  assert.equal(chosen, null, "a non-commercial licence must disqualify an engine");
  const res = await createJob(db, { tenantId: "t1", capability: "image.generate", request: { request: "x" } });
  assert.equal(res.job, null);
  assert.match(String(res.refused), /No engine/);
});

test("video seconds are checked against the allowance BEFORE anything is queued", async () => {
  const db = makeDb();
  await db.creativeQuota.create({ data: { tenantId: "t1", videoSeconds: 10, images: 100, storageGb: 5, maxConcurrent: 5, premiumEngines: false } });
  await db.creativeUsage.create({ data: { tenantId: "t1", capability: "video.generate", measure: "video_seconds", quantity: 8, costMicros: 0, period: periodOf() } });
  const verdict = await checkQuota(db, "t1", "video.generate", { seconds: 8 });
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.equal(verdict.code, "quota_video");
  assert.match(verdict.reason, /2 are left|seconds/i);
  // And what fits is still allowed.
  assert.equal((await checkQuota(db, "t1", "video.generate", { seconds: 2 })).ok, true);
});

test("two runners cannot claim the same job", async () => {
  const db = makeDb();
  await seedTestEngine(db);
  await createJob(db, { tenantId: "t1", capability: "image.generate", request: { request: "one" } });
  const [a, b] = await Promise.all([claimJobs(db, "worker-a", 2), claimJobs(db, "worker-b", 2)]);
  assert.equal(a.length + b.length, 1, "exactly one runner may win the job");
});

test("a runner that dies loses its lease and the work is picked up again", async () => {
  const db = makeDb();
  await seedTestEngine(db);
  await createJob(db, { tenantId: "t1", capability: "image.generate", request: { request: "one" } });
  const claimed = await claimJobs(db, "worker-a", 1);
  assert.equal(claimed.length, 1);
  // The worker stops sending heartbeats; its lease runs out.
  await db.creativeJob.update({ where: { id: claimed[0].id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
  const requeued = await sweepLostLeases(db);
  assert.equal(requeued, 1);
  const again = await claimJobs(db, "worker-b", 1);
  assert.equal(again.length, 1, "another worker must be able to pick it up");
  assert.equal(again[0].id, claimed[0].id);
});

test("a job already sent to a provider is polled again, not paid for twice", async () => {
  const db = makeDb();
  await seedTestEngine(db, { id: "loopcom.video", capabilities: ["video.generate"] });
  const { job } = await createJob(db, { tenantId: "t1", capability: "video.generate", request: { request: "a shot", seconds: 4 } });
  await db.creativeJob.update({ where: { id: job.id }, data: { status: "running", providerJobId: "video_123", workerId: "worker-a", leaseExpiresAt: new Date(Date.now() - 1000) } });
  await sweepLostLeases(db);
  const row = db.__rows.creativeJob[0];
  assert.equal(row.status, "running", "a provider-side job must stay running, not be re-queued");
  assert.equal(row.providerJobId, "video_123");
});

test("cancelling records the work the engine already did as spent", async () => {
  const db = makeDb();
  await seedTestEngine(db);
  const { job } = await createJob(db, { tenantId: "t1", capability: "image.generate", request: { request: "x" } });
  await db.creativeJob.update({ where: { id: job.id }, data: { status: "running", costMicros: 80_000 } });
  const res = await cancelJob(db, "t1", job.id);
  assert.equal(res.ok, true);
  assert.equal(db.__rows.creativeJob[0].status, "cancelled");
  const wasted = db.__rows.creativeUsage.find((u: any) => u.wasted);
  assert.ok(wasted, "the part-done work must be recorded, not hidden");
});

test("one company cannot cancel another company's job", async () => {
  const db = makeDb();
  await seedTestEngine(db);
  const { job } = await createJob(db, { tenantId: "t1", capability: "image.generate", request: { request: "x" } });
  const res = await cancelJob(db, "t2", job.id);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_found", "it must read as absent, never as forbidden");
});

test("video is estimated by the second and images by the picture", () => {
  const engine = { costModel: { unit: "second", micros: 100_000 } };
  assert.equal(estimateCostMicros("video.generate", { seconds: 8 }, engine), 800_000);
  const img = { costModel: { unit: "image", micros: 12_000 } };
  assert.equal(estimateCostMicros("image.generate", { count: 4, quality: "low" }, img), 48_000);
  assert.ok(estimateCostMicros("image.generate", { count: 1, quality: "high" }, img) > estimateCostMicros("image.generate", { count: 1, quality: "low" }, img));
});

/* ------------------------------------------------------------------ */
/* 3. memory: observe → learn → adapt                                   */
/* ------------------------------------------------------------------ */

test("a correction becomes a lesson, and three of them make it apply", async () => {
  const db = makeDb();
  const base = { tenantId: "t1", userId: "u1", subjectType: "asset", subjectId: "a1", signal: "reject", reasonCodes: ["camera_slower"] };

  const first = await recordFeedback(db, base as any);
  assert.equal(first.learned[0].status, "suggested", "one signal is not a preference yet");

  await recordFeedback(db, base as any);
  const third = await recordFeedback(db, base as any);
  assert.equal(third.learned[0].status, "active", `it should apply after ${EVIDENCE_TO_ACTIVE} consistent signals`);

  // And once active it reaches the prompt builder.
  const memory = await activeMemoryFor(db, "t1", "u1");
  const dims = memory.map((m) => m.dimension);
  assert.ok(dims.includes("camera_movement"));
  const built = buildPrompt({ request: "a shot of the shop", kind: "video", memory: memory as any });
  assert.match(built.prompt, /Camera: slow/i);
});

test("what one company learns never reaches another", async () => {
  const db = makeDb();
  await recordFeedback(db, { tenantId: "t1", userId: "u1", subjectType: "asset", signal: "reject", reasonCodes: ["more_cinematic"] } as any);
  await recordFeedback(db, { tenantId: "t1", userId: "u1", subjectType: "asset", signal: "reject", reasonCodes: ["more_cinematic"] } as any);
  await recordFeedback(db, { tenantId: "t1", userId: "u1", subjectType: "asset", signal: "reject", reasonCodes: ["more_cinematic"] } as any);
  const mine = await activeMemoryFor(db, "t1", "u1");
  const theirs = await activeMemoryFor(db, "t2", "u2");
  assert.ok(mine.length >= 1);
  assert.equal(theirs.length, 0, "another company must learn nothing from ours");
});

test("a company-wide rule waits for a person, however much evidence there is", async () => {
  const db = makeDb();
  for (let i = 0; i < 5; i++) {
    await recordFeedback(db, { tenantId: "t1", userId: "u1", subjectType: "design", signal: "edit", reasonCodes: ["logo_too_big"] } as any);
  }
  const row = db.__rows.creativeMemoryItem.find((m: any) => m.dimension === "logo");
  assert.ok(row);
  assert.equal(row.scope, "company");
  assert.equal(row.status, "suggested", "a rule for everyone must be agreed to, not assumed");
});

test("a disabled lesson stays disabled no matter how often it recurs", async () => {
  const db = makeDb();
  const item = await upsertLesson(db, { tenantId: "t1", userId: "u1", scope: "user", dimension: "pacing", value: "slower", statement: "Prefers a slower pace" });
  await db.creativeMemoryItem.update({ where: { id: item.id }, data: { status: "disabled" } });
  await upsertLesson(db, { tenantId: "t1", userId: "u1", scope: "user", dimension: "pacing", value: "slower", statement: "Prefers a slower pace" });
  assert.equal(db.__rows.creativeMemoryItem[0].status, "disabled");
});

test("accepting something teaches, and an unknown reason code teaches nothing", () => {
  assert.ok(lessonsFor("accept", [], { style: "cinematic" }).length >= 1);
  assert.equal(lessonsFor("reject", ["not_a_real_code"]).length, 0);
});

/* ------------------------------------------------------------------ */
/* 4. source guards — the wiring, not the helpers                       */
/* ------------------------------------------------------------------ */

test("the routes are actually registered on the server", () => {
  const server = apiFile("src/server.ts");
  assert.match(server, /registerCreativeStudioRoutes\(\{/, "the customer routes must be registered");
  assert.match(server, /registerCreativeAdminRoutes\(\{/, "the admin routes must be registered");
  assert.match(server, /registerCreativeInternalRoutes\(\{ app, db \}\)/, "the Coworker's door must be registered");
  assert.match(server, /runCreativeCycle/, "something has to move the jobs along");
});

test("every Creative route sits behind a permission rule", () => {
  const server = apiFile("src/server.ts");
  for (const rule of [
    '{ prefix: "/creative", permission: "can_view_creative_home" }',
    '{ prefix: "/creative/projects", permission: "can_view_creative_projects" }',
    '{ prefix: "/creative/brand-kit", permission: "can_view_creative_brand_kit" }',
    '{ prefix: "/admin/creative", permission: "can_manage_global_settings" }',
  ]) {
    assert.ok(server.includes(rule), `missing permission rule: ${rule}`);
  }
});

test("the signed media route is the only public one, and it is public on purpose", () => {
  const bypass = apiFile("src/jwtPublicRouteBypass.ts");
  assert.match(bypass, /\/creative\/download\//, "signed downloads must skip JWT like hold-music audio");
  const server = apiFile("src/server.ts");
  assert.ok(server.includes('{ prefix: "/creative/download", permission: null }'), "and it must be declared, not implied");
});

test("the sidebar, both permission editors and the API agree on the keys", () => {
  const perms = repoFile("packages/shared/src/portalPermissions.ts");
  const nav = repoFile("apps/portal/navigation/navConfig.ts");
  for (const key of [
    "can_view_section_creative",
    "can_view_creative_home",
    "can_view_creative_projects",
    "can_view_creative_images",
    "can_view_creative_video",
    "can_view_creative_design",
    "can_view_creative_assets",
    "can_view_creative_brand_kit",
    "can_view_creative_memory",
    "can_view_admin_creative_console",
  ]) {
    assert.ok(perms.includes(key), `${key} missing from the shared catalogue`);
    assert.ok(nav.includes(key), `${key} missing from navConfig`);
  }
  for (const action of [
    "can_creative_generate_image",
    "can_creative_generate_video",
    "can_manage_creative_brand_kit",
    "can_creative_export",
    "can_view_company_creative_projects",
    "can_delete_creative_projects",
  ]) {
    assert.ok(perms.includes(action), `${action} missing from ACTION_PERMISSION_KEYS`);
  }
});

test("no Creative key is in a default bucket — granting one IS the launch", () => {
  const perms = repoFile("packages/shared/src/portalPermissions.ts");
  const endUser = perms.slice(perms.indexOf("const END_USER_ACTIONS"), perms.indexOf("const TENANT_ADMIN_EXTRA_ACTIONS"));
  const tenantAdmin = perms.slice(perms.indexOf("const TENANT_ADMIN_EXTRA_ACTIONS"), perms.indexOf("export const DEFAULT_ROLE_PERMISSIONS"));
  for (const block of [endUser, tenantAdmin]) {
    assert.ok(!/can_view_creative|can_creative_|can_manage_creative/.test(block), "a Creative key must not be in a default bucket");
  }
});

test("the Coworker's tools follow the name rule the providers enforce", () => {
  const tools = repoFile("apps/agent/src/tools/creativeTools.ts");
  const names = [...tools.matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 8, "the studio should give the Coworker a real toolset");
  for (const n of names) assert.match(n, /^[a-z][a-z0-9_]{0,63}$/, `${n} would be rejected by the model providers`);
  assert.ok(names.includes("creative_make_image"));
  assert.ok(names.includes("creative_check_job"), "long work must be polled, never awaited");
  // ⛔ No tool may send anything anywhere: exporting makes a file, a person sends it.
  assert.ok(!/name: "creative_(post|publish|send|email|share)_/.test(tools), "the agent must not be able to publish");
});

test("the agent's tools go through the same door as the browser", () => {
  const tools = repoFile("apps/agent/src/tools/creativeTools.ts");
  assert.match(tools, /internal\/agent\/creative\/generate/);
  const internal = apiFile("src/creativeStudio/internalRoutes.ts");
  assert.match(internal, /startGeneration/, "the agent door must use the shared service, not its own path");
  assert.match(internal, /x-agent-internal-secret/, "and it must be behind the shared secret");
});

test("FFmpeg is never handed a shell string or an open protocol list", () => {
  const media = apiFile("src/creativeStudio/media.ts");
  assert.ok(!/exec\(/.test(media.replace(/execFile/g, "")), "no shell exec in the media pipeline");
  assert.match(media, /protocol_whitelist/, "a playlist must not be able to make FFmpeg fetch a URL");
  const count = (media.match(/SAFE_PROTOCOLS/g) || []).length;
  assert.ok(count >= 6, "every FFmpeg call needs the protocol whitelist");
});

test("this test file's glob is registered in apps/api/package.json", () => {
  const pkg = apiFile("package.json");
  assert.match(pkg, /src\/creativeStudio\/\*\.test\.ts/, "an unregistered test file is silently never run");
});

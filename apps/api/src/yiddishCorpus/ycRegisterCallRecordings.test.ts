/**
 * yc-register-call-recordings — tests.
 *
 * ⛔ NO NETWORK, NO PRISMA, NO REAL AUDIO. A small in-memory fake stands in for
 * the handful of tables the script and `enqueueNext` touch. What must hold:
 *
 *   - only tenants with a Yiddish (yi / yi-en) voicemail are candidates;
 *   - --tenant narrows by a case-insensitive substring of Tenant.name;
 *   - --min-talk-sec excludes short calls;
 *   - re-running the script never duplicates an item (unique sourceId+externalId);
 *   - `enqueueNext` is driven for NEW items only, never for ones already registered;
 *   - --dry-run writes nothing at all (no YcSourceItem, no YcProcessingJob row).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { registerCallRecordings, CALL_RECORDINGS_SOURCE_KEY, DEFAULT_MIN_TALK_SEC } from "../../scripts/yc-register-call-recordings";

// ── a very small fake Prisma (mirrors the shape jobs.test.ts uses) ─────────

function matches(row: any, where: any): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!(v as any[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === "NOT") {
      if (matches(row, v)) return false;
      continue;
    }
    const rv = row[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      let handled = false;
      for (const [op, ov] of Object.entries(v as any)) {
        if (op === "lt") { if (!(rv < (ov as any))) return false; handled = true; }
        else if (op === "lte") { if (!(rv <= (ov as any))) return false; handled = true; }
        else if (op === "gt") { if (!(rv > (ov as any))) return false; handled = true; }
        else if (op === "gte") { if (!(rv >= (ov as any))) return false; handled = true; }
        else if (op === "in") { if (!(ov as any[]).includes(rv)) return false; handled = true; }
        else if (op === "notIn") { if ((ov as any[]).includes(rv)) return false; handled = true; }
        else if (op === "not") { if (rv === ov) return false; handled = true; }
        else if (op === "contains") {
          const hay = String(rv ?? "");
          const needle = String(ov ?? "");
          const insensitive = (v as any).mode === "insensitive";
          const ok = insensitive ? hay.toLowerCase().includes(needle.toLowerCase()) : hay.includes(needle);
          if (!ok) return false;
          handled = true;
        } else if (op === "mode") {
          handled = true; // consumed by `contains` above
        }
      }
      if (handled) continue;
      // A composite unique key object, e.g. { sourceId, externalId }.
      if (!matches(row, v)) return false;
      continue;
    }
    if ((rv ?? null) !== (v ?? null)) return false;
  }
  return true;
}

let idSeq = 0;
function table(name: string, defaults: Record<string, any> = {}) {
  const rows: any[] = [];
  const clone = (r: any) => (r ? { ...r } : r);
  return {
    rows,
    async findMany({ where, orderBy, take, select }: any = {}) {
      let out = rows.filter((r) => matches(r, where)).map(clone);
      if (orderBy) {
        const [field, dir] = Object.entries(orderBy)[0] as [string, string];
        out = out.slice().sort((a, b) => {
          const av = a[field];
          const bv = b[field];
          const c = av === bv ? 0 : av < bv ? -1 : 1;
          return dir === "desc" ? -c : c;
        });
      }
      if (take != null) out = out.slice(0, take);
      if (select) out = out.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])));
      return out;
    },
    async findFirst({ where }: any = {}) {
      return clone(rows.find((r) => matches(r, where))) ?? null;
    },
    async findUnique({ where, include }: any = {}) {
      const row = clone(rows.find((r) => matches(r, where)));
      if (!row) return null;
      if (include?.budget) row.budget = null;
      if (include?.rights) row.rights = [];
      return row;
    },
    async create({ data }: any) {
      idSeq += 1;
      const row = { id: `${name}-${idSeq}`, ...defaults, ...data, updatedAt: new Date() };
      rows.push(row);
      return clone(row);
    },
    async update({ where, data }: any) {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`${name}: no row for update`);
      Object.assign(row, data, { updatedAt: new Date() });
      return clone(row);
    },
    async updateMany({ where, data }: any) {
      const hits = rows.filter((r) => matches(r, where));
      for (const r of hits) Object.assign(r, data);
      return { count: hits.length };
    },
  };
}

function makeDb() {
  const ycSourceRows = table("src");
  const ycBudget = table("budget");
  const ycSourceItem = table("item", { state: "DISCOVERED", priority: 50, metadata: {} });
  const ycProcessingJob = table("job", {
    state: "PENDING",
    priority: 50,
    attempts: 0,
    maxAttempts: 5,
    costCents: 0,
    leaseUntil: null,
    leaseOwner: null,
    error: null,
    payload: null,
    itemId: null,
  });
  const tenant = table("tenant");
  const voicemail = table("vm");
  const connectCdr = table("cdr");

  ycSourceRows.rows.push({
    id: "src-cr",
    key: CALL_RECORDINGS_SOURCE_KEY,
    name: "Call recordings",
    kind: "INTERNAL_TABLE",
    governanceClass: "CUSTOMER_PRIVATE",
    trainingExportEligibility: "EXCLUDED",
    contentAllowed: false,
    audioFetchMode: "DISABLED",
    enabled: false,
    discoveryCursor: null,
  });
  // The global budget row `loadBudget` falls back to when a source has none.
  ycBudget.rows.push({ id: "budget-global", scope: "global", paused: false, mode: "METADATA_ONLY", apiCentsPerDay: 0, transcriptionMinutesPerDay: 0, spentCentsToday: 0, transcribedMinutesToday: 0, spendDate: null });

  return { ycSource: ycSourceRows, ycBudget, ycSourceItem, ycProcessingJob, tenant, voicemail, connectCdr } as any;
}

function seedTenant(db: any, id: string, name: string, language: "yi" | "yi-en" | "en" | null) {
  db.tenant.rows.push({ id, name });
  if (language) db.voicemail.rows.push({ id: `vm-${id}`, tenantId: id, transcriptLanguage: language });
}

function seedCdr(db: any, tenantId: string, linkedId: string, talkSec: number, opts: Partial<any> = {}) {
  db.connectCdr.rows.push({
    id: `cdr-${linkedId}`,
    linkedId,
    tenantId,
    recordingPath: `/var/spool/asterisk/monitor/${tenantId}/2026/09/17/${linkedId}.wav`,
    recordingMissingAt: null,
    talkSec,
    direction: "incoming",
    startedAt: new Date("2026-09-17T10:00:00Z"),
    ...opts,
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

test("only Yiddish-speaking tenants are candidates", async () => {
  const db = makeDb();
  seedTenant(db, "t-yi", "Gesheft", "yi");
  seedTenant(db, "t-en", "English Only Co", "en");
  seedCdr(db, "t-yi", "call-1", 60);
  seedCdr(db, "t-en", "call-2", 60);

  const res = await registerCallRecordings(db, { dryRun: true });
  assert.equal(res.tenants.length, 1);
  assert.equal(res.tenants[0].tenantName, "Gesheft");
  assert.equal(res.tenants[0].candidates, 1);
});

test("--tenant narrows by case-insensitive substring", async () => {
  const db = makeDb();
  seedTenant(db, "t1", "Gesheft LLC", "yi");
  seedTenant(db, "t2", "Relax Tires", "yi-en");
  seedCdr(db, "t1", "call-1", 60);
  seedCdr(db, "t2", "call-2", 60);

  const res = await registerCallRecordings(db, { tenantName: "relax", dryRun: true });
  assert.equal(res.tenants.length, 1);
  assert.equal(res.tenants[0].tenantName, "Relax Tires");
});

test("--min-talk-sec excludes calls shorter than the floor", async () => {
  const db = makeDb();
  seedTenant(db, "t1", "Gesheft", "yi");
  seedCdr(db, "t1", "short", 5);
  seedCdr(db, "t1", "long", DEFAULT_MIN_TALK_SEC + 30);

  const res = await registerCallRecordings(db, { dryRun: true });
  assert.equal(res.tenants[0].candidates, 1);

  const res2 = await registerCallRecordings(db, { minTalkSec: 1, dryRun: true });
  assert.equal(res2.tenants[0].candidates, 2);
});

test("re-running is idempotent on (sourceId, externalId=linkedId)", async () => {
  const db = makeDb();
  seedTenant(db, "t1", "Gesheft", "yi");
  seedCdr(db, "t1", "call-1", 60);

  const first = await registerCallRecordings(db, {});
  assert.equal(first.totalRegistered, 1);
  assert.equal(db.ycSourceItem.rows.length, 1);

  const second = await registerCallRecordings(db, {});
  assert.equal(second.totalRegistered, 0);
  assert.equal(second.totalAlreadyRegistered, 1);
  assert.equal(db.ycSourceItem.rows.length, 1, "no duplicate item was created");
});

test("item metadata carries the fields the audio leg needs, never audio bytes", async () => {
  const db = makeDb();
  seedTenant(db, "t1", "Gesheft", "yi");
  seedCdr(db, "t1", "call-1", 60, { direction: "outgoing" });

  await registerCallRecordings(db, {});
  const item = db.ycSourceItem.rows[0];
  assert.equal(item.state, "QUEUED");
  assert.equal(item.durationSec, 60);
  assert.equal(item.metadata.tenantId, "t1");
  assert.equal(item.metadata.tenantName, "Gesheft");
  assert.equal(item.metadata.direction, "outgoing");
  assert.equal(item.metadata.localAudioPath, "call-1.wav");
  assert.ok(item.metadata.pbxPath.includes("call-1.wav"));
  assert.equal(Object.prototype.hasOwnProperty.call(item, "audio"), false);
});

test("enqueueNext runs for new items only, not for already-registered ones", async () => {
  const db = makeDb();
  seedTenant(db, "t1", "Gesheft", "yi");
  seedCdr(db, "t1", "call-1", 60);
  seedCdr(db, "t1", "call-2", 60);

  await registerCallRecordings(db, {});
  assert.equal(db.ycProcessingJob.rows.length, 2, "one job queued per new item");

  seedCdr(db, "t1", "call-3", 60);
  await registerCallRecordings(db, {});
  // call-1/call-2 already registered → no new jobs for them; call-3 is new.
  assert.equal(db.ycProcessingJob.rows.length, 3);
});

test("--dry-run writes nothing", async () => {
  const db = makeDb();
  seedTenant(db, "t1", "Gesheft", "yi");
  seedCdr(db, "t1", "call-1", 60);

  const res = await registerCallRecordings(db, { dryRun: true });
  assert.equal(res.totalRegistered, 1, "dry run still reports what it WOULD do");
  assert.equal(db.ycSourceItem.rows.length, 0);
  assert.equal(db.ycProcessingJob.rows.length, 0);
});

test("refuses when the call_recordings source row is missing", async () => {
  const db = makeDb();
  db.ycSource.rows.length = 0;
  await assert.rejects(() => registerCallRecordings(db, {}), /is missing/);
});

test("never reads audio or transcript fields — the source file has no such call", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "scripts", "yc-register-call-recordings.ts"),
    "utf8",
  );
  assert.doesNotMatch(src, /cdr\.transcript\b/);
  assert.doesNotMatch(src, /yiddishLabs/i);
  assert.doesNotMatch(src, /readFileSync\(.*recordingPath/);
});

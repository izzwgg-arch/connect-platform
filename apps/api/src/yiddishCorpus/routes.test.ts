/**
 * Yiddish Corpus — route tests.
 *
 * These drive the REAL handlers through a fake fastify and a fake Prisma
 * client, so no database and no network is needed. The four things that would
 * actually hurt if they broke:
 *
 *  1. the platform-staff gate holds on EVERY route (table-driven), and no
 *     handler touches the database before the gate — the db here THROWS on any
 *     access, so a single pre-gate query fails the test;
 *  2. rights and audio-mode refuse without a typed acknowledgement, and stamp
 *     the decider from the JWT;
 *  3. the export preview reports 0 exportable WITH the exclusion breakdown
 *     instead of pretending the corpus is merely empty;
 *  4. the dashboard answers an empty database with real zeros and says so.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerYiddishCorpusRoutes, YC_REGISTERED_ROUTES, badgeForSource, buildExportPreview, audioBlockedReason } from "./routes";
import { YC_API_PREFIX, YC_CUSTOMER_WALL_MESSAGE } from "./contracts";

// ── fakes ───────────────────────────────────────────────────────────────────

type Handler = (req: any, reply: any) => Promise<any>;

function fakeApp() {
  const routes = new Map<string, Handler>();
  const record = (method: string) => (path: string, handler: Handler) => routes.set(`${method} ${path}`, handler);
  return {
    app: { get: record("GET"), post: record("POST"), patch: record("PATCH"), log: { info() {}, warn() {}, error() {} } },
    routes,
  };
}

function fakeReply() {
  const r: any = {
    statusCode: 200,
    payload: undefined as any,
    code(n: number) {
      r.statusCode = n;
      return r;
    },
    send(p: any) {
      r.payload = p;
      return undefined;
    },
  };
  return r;
}

/** Any property access explodes — used to prove the gate runs FIRST. */
const explodingDb: any = new Proxy(
  {},
  {
    get(_t, model: string) {
      return new Proxy(
        {},
        {
          get() {
            return () => {
              throw new Error(`the handler touched db.${String(model)} before the permission gate`);
            };
          },
        },
      );
    },
  },
);

const EMPTY_DEFAULTS: Record<string, any> = {
  count: 0,
  findMany: [],
  findFirst: null,
  findUnique: null,
  aggregate: { _sum: {} },
  groupBy: [],
  updateMany: { count: 0 },
};

/** An empty Prisma-shaped client. `overrides` is keyed "model.method". */
function fakeDb(overrides: Record<string, any> = {}): any {
  return new Proxy(
    {},
    {
      get(_t, model: string) {
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async (args: any) => {
                const key = `${String(model)}.${String(method)}`;
                if (key in overrides) {
                  const v = overrides[key];
                  return typeof v === "function" ? v(args) : v;
                }
                if (String(method) in EMPTY_DEFAULTS) return EMPTY_DEFAULTS[String(method)];
                // create / update / upsert echo something row-shaped back
                return { id: "row_1", ...(args?.data ?? args?.create ?? {}) };
              };
            },
          },
        );
      },
    },
  );
}

const SUPER_ADMIN = { sub: "u_owner", email: "izzy@loopcom.net", role: "SUPER_ADMIN" };

/** Mimics requireSuperAdmin for a user who is NOT platform staff. */
const denyingGate = async (_req: any, reply: any) => {
  reply.code(403).send({ error: "forbidden" });
  return null;
};
const allowingGate = async () => SUPER_ADMIN;

function register(db: any, gate: any) {
  const { app, routes } = fakeApp();
  registerYiddishCorpusRoutes({ app, db, requireOwner: gate });
  return routes;
}

// ── 1. the gate, on every route ─────────────────────────────────────────────

test("every registered route sits under the platform prefix and is in the route table", () => {
  const routes = register(explodingDb, allowingGate);
  assert.ok(routes.size >= YC_REGISTERED_ROUTES.length, `registered ${routes.size} routes, table lists ${YC_REGISTERED_ROUTES.length}`);
  for (const r of YC_REGISTERED_ROUTES) {
    assert.ok(routes.has(`${r.method} ${r.path}`), `route table lists ${r.method} ${r.path} but nothing registered it`);
    assert.ok(r.path.startsWith(`${YC_API_PREFIX}/`), `${r.path} is outside ${YC_API_PREFIX}`);
  }
});

test("a non-SUPER_ADMIN gets 403 on EVERY route, and no handler queries the database first", async () => {
  const routes = register(explodingDb, denyingGate);
  for (const [key, handler] of routes) {
    const reply = fakeReply();
    await handler({ params: { key: "yiddish24", id: "x" }, query: {}, body: {}, user: { role: "TENANT_ADMIN" } }, reply);
    assert.equal(reply.statusCode, 403, `${key} did not refuse a non-platform user`);
    assert.deepEqual(reply.payload, { error: "forbidden" }, `${key} sent something other than the standard refusal`);
  }
});

test("the route list is tenant-free: no handler path carries a tenant segment", () => {
  for (const r of YC_REGISTERED_ROUTES) {
    assert.ok(!/tenant/i.test(r.path), `${r.path} looks tenant-scoped; this is platform data`);
  }
});

// ── 2. rights + audio-mode are human-only ───────────────────────────────────

const SOURCE_Y24 = {
  id: "src_y24",
  key: "yiddish24",
  name: "Yiddish24",
  kind: "EXTERNAL_ADAPTER",
  governanceClass: "EXTERNAL",
  trainingExportEligibility: "UNKNOWN",
  contentAllowed: true,
  audioFetchMode: "DISABLED",
  enabled: true,
  termsUrl: null,
  termsCheckedAt: null,
  rightsNote: "no terms page exists",
};
const SOURCE_VOICEMAIL = {
  id: "src_vm",
  key: "voicemail",
  name: "Voicemail transcripts",
  kind: "INTERNAL_TABLE",
  governanceClass: "CUSTOMER_PRIVATE",
  trainingExportEligibility: "EXCLUDED",
  contentAllowed: false,
  audioFetchMode: "DISABLED",
  enabled: true,
};

test("POST /sources/:key/rights refuses without an acknowledgement, and writes nothing", async () => {
  let wrote = 0;
  const db = fakeDb({
    "ycSource.findUnique": SOURCE_Y24,
    "ycRightsRecord.upsert": () => {
      wrote += 1;
      return {};
    },
  });
  const routes = register(db, allowingGate);
  const handler = routes.get(`POST ${YC_API_PREFIX}/sources/:key/rights`)!;
  const reply = fakeReply();
  await handler({ params: { key: "yiddish24" }, body: { allowedUse: "training_export", state: "GRANTED" }, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 400);
  assert.equal(reply.payload.error, "acknowledgement_required");
  assert.equal(wrote, 0, "a rights record was written despite the refusal");
});

test("POST /sources/:key/rights records decidedBy from the JWT and audits it", async () => {
  const upserts: any[] = [];
  const audits: any[] = [];
  const db = fakeDb({
    "ycSource.findUnique": SOURCE_Y24,
    "ycRightsRecord.upsert": (a: any) => {
      upserts.push(a);
      return { ...a.create, decidedAt: new Date() };
    },
    "ycRightsRecord.findMany": [],
    "agentAuditLog.create": (a: any) => {
      audits.push(a);
      return {};
    },
    "ycSource.update": (a: any) => ({ ...SOURCE_Y24, ...a.data }),
  });
  const routes = register(db, allowingGate);
  const handler = routes.get(`POST ${YC_API_PREFIX}/sources/:key/rights`)!;
  const reply = fakeReply();
  await handler(
    {
      params: { key: "yiddish24" },
      body: { allowedUse: "analysis", state: "GRANTED", acknowledgement: "Owner replied in writing on 2026-09-20." },
      user: SUPER_ADMIN,
    },
    reply,
  );
  assert.equal(reply.statusCode, 200);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].create.decidedBy, SUPER_ADMIN.email, "the decider must come from the JWT, not the body");
  assert.equal(audits.length, 1, "a rights decision must leave an audit row");
  assert.equal(audits[0].data.event, "yiddish.rights.recorded");
  assert.ok(String(audits[0].data.hash).length === 64, "the audit row must be hashed like the rest of the ledger");
});

test("POST /sources/:key/audio-mode refuses without an acknowledgement and never flips the switch", async () => {
  let updates = 0;
  const db = fakeDb({
    "ycSource.findUnique": SOURCE_Y24,
    "ycSource.update": () => {
      updates += 1;
      return SOURCE_Y24;
    },
  });
  const routes = register(db, allowingGate);
  const handler = routes.get(`POST ${YC_API_PREFIX}/sources/:key/audio-mode`)!;
  const reply = fakeReply();
  await handler({ params: { key: "yiddish24" }, body: { mode: "OWNER_AUTHORIZED" }, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 400);
  assert.equal(reply.payload.error, "acknowledgement_required");
  assert.equal(updates, 0, "audio mode changed without an acknowledgement");
});

test("audio-mode can never lift the customer wall, acknowledgement or not", async () => {
  let updates = 0;
  const db = fakeDb({
    "ycSource.findUnique": SOURCE_VOICEMAIL,
    "ycSource.update": () => {
      updates += 1;
      return SOURCE_VOICEMAIL;
    },
  });
  const routes = register(db, allowingGate);
  const handler = routes.get(`POST ${YC_API_PREFIX}/sources/:key/audio-mode`)!;
  const reply = fakeReply();
  await handler(
    { params: { key: "voicemail" }, body: { mode: "OWNER_AUTHORIZED", acknowledgement: "I say so" }, user: SUPER_ADMIN },
    reply,
  );
  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.message, YC_CUSTOMER_WALL_MESSAGE);
  assert.equal(updates, 0);
});

test("audio stays blocked while the source says DISABLED, and the reason is plain English", () => {
  assert.ok(audioBlockedReason(SOURCE_Y24, [])!.includes("does not come from its own pages") || audioBlockedReason(SOURCE_Y24, [])!.length > 40);
  assert.equal(audioBlockedReason({ ...SOURCE_Y24, audioFetchMode: "OWNER_AUTHORIZED" }, [{ allowedUse: "analysis", state: "GRANTED" }]), null);
  assert.ok(audioBlockedReason({ ...SOURCE_Y24, audioFetchMode: "OWNER_AUTHORIZED" }, [{ allowedUse: "analysis", state: "DENIED" }]));
});

// ── 3. the governance badge is on the responses ─────────────────────────────

test("the badge is derived from the row's own columns, walls and all", () => {
  const vm = badgeForSource(SOURCE_VOICEMAIL);
  assert.equal(vm.governanceClass, "CUSTOMER_PRIVATE");
  assert.equal(vm.contentAllowed, false);
  assert.equal(vm.note, YC_CUSTOMER_WALL_MESSAGE);

  const yl = badgeForSource({ key: "yiddishlabs_cache", governanceClass: "PLATFORM", trainingExportEligibility: "EXCLUDED", contentAllowed: true });
  assert.equal(yl.ylDerived, true);
  assert.ok(String(yl.note).includes("serving-only"));

  // An EXTERNAL source with no recorded training_export grant is EXCLUDED —
  // the column may say UNKNOWN, but the governance ladder is the authority and
  // "we have not asked" is never "we may".
  const y24 = badgeForSource(SOURCE_Y24, []);
  assert.equal(y24.trainingExportEligibility, "EXCLUDED");
  assert.equal(y24.ylDerived, false);
  assert.equal(y24.contentAllowed, true, "public listing metadata is readable; it is the AUDIO that is blocked");

  // With the grant recorded, and only then, it becomes exportable.
  const granted = badgeForSource(SOURCE_Y24, [{ allowedUse: "training_export", state: "GRANTED" }]);
  assert.equal(granted.trainingExportEligibility, "ALLOWED");
});

test("a walled source's items come back counted but withheld", async () => {
  const db = fakeDb({
    "ycSource.findUnique": SOURCE_VOICEMAIL,
    "ycSourceItem.findMany": [{ id: "i1", externalId: "vm1", title: "a customer's message", seriesName: null, host: null, state: "DISCOVERED", priority: 50, discoveredAt: new Date() }],
  });
  const routes = register(db, allowingGate);
  const handler = routes.get(`GET ${YC_API_PREFIX}/sources/:key/items`)!;
  const reply = fakeReply();
  await handler({ params: { key: "voicemail" }, query: {}, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.items.length, 1);
  assert.equal(reply.payload.items[0].title, null, "a customer-private title was returned");
  assert.equal(reply.payload.items[0].withheld, true);
  assert.equal(reply.payload.note, YC_CUSTOMER_WALL_MESSAGE);
  assert.equal(reply.payload.badge.contentAllowed, false);
});

// ── 4. export preview is honest ─────────────────────────────────────────────

test("export preview reports 0 exportable with the exclusion breakdown, not an empty success", async () => {
  const db = fakeDb({
    "ycSource.findMany": [
      SOURCE_VOICEMAIL,
      { id: "src_yl", key: "yiddishlabs_cache", name: "Yiddish Labs cache", governanceClass: "PLATFORM", trainingExportEligibility: "EXCLUDED", contentAllowed: true },
      SOURCE_Y24,
    ],
    "ycTranscript.count": 7,
  });
  const preview = await buildExportPreview(db);
  assert.equal(preview.exportable, 0);
  assert.equal(preview.totalRows, 21);
  assert.ok(preview.breakdown.length >= 3, "every exclusion reason must be named");
  const reasons = preview.breakdown.map((b) => String(b.reason));
  assert.ok(reasons.includes("CUSTOMER_PRIVATE"), "the customer wall must be named as a reason");
  assert.ok(reasons.includes("YL_DERIVED"), "the Yiddish Labs wall must be named as a reason");
  assert.ok(reasons.includes("NO_EXTERNAL_RIGHTS"), "an unrecorded external rights state must be named as a reason");
  // Each reason carries the plain-English sentence the screen prints.
  const notes = preview.breakdown.map((b) => b.note).join(" | ");
  assert.ok(notes.includes("counted, never read"));
  assert.ok(notes.toLowerCase().includes("serving-only"));
  // The breakdown adds up: a row excluded for several reasons is counted once.
  assert.equal(preview.breakdown.reduce((s, b) => s + b.count, 0), preview.totalRows);
  assert.ok(preview.note.includes("Nothing is exportable"), `note was: ${preview.note}`);
  for (const s of preview.sources) assert.ok(s.badge, `${s.key} came back without a governance badge`);
});

test("POST /export/build refuses to write an export of nothing", async () => {
  const db = fakeDb({ "ycSource.findMany": [SOURCE_VOICEMAIL], "ycTranscript.count": 3 });
  const routes = register(db, allowingGate);
  const handler = routes.get(`POST ${YC_API_PREFIX}/export/build`)!;
  const reply = fakeReply();
  await handler({ body: {}, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.error, "nothing_exportable");
  assert.ok(reply.payload.breakdown.length > 0);
});

// ── 5. the dashboard is honest about an empty engine ────────────────────────

test("GET /dashboard answers an empty database with real zeros and says so", async () => {
  const db = fakeDb();
  const routes = register(db, allowingGate);
  const handler = routes.get(`GET ${YC_API_PREFIX}/dashboard`)!;
  const reply = fakeReply();
  await handler({ query: {}, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  const v = reply.payload;
  for (const [k, val] of Object.entries(v.corpus)) assert.equal(val, 0, `corpus.${k} was ${val}, not an honest zero`);
  assert.deepEqual(v.sources, []);
  assert.deepEqual(v.queue, []);
  assert.equal(v.worker.alive, false);
  assert.equal(v.worker.lastTickAt, null);
  assert.ok(v.worker.note.includes("Nothing has run yet"));
  assert.ok(v.note.includes("real count of zero"), `note was: ${v.note}`);
  assert.equal(v.profile, null);
});

test("GET /queue and GET /progress say nothing has run rather than drawing a curve", async () => {
  const db = fakeDb();
  const routes = register(db, allowingGate);
  for (const path of [`GET ${YC_API_PREFIX}/queue`, `GET ${YC_API_PREFIX}/progress`]) {
    const reply = fakeReply();
    await routes.get(path)!({ query: {}, user: SUPER_ADMIN }, reply);
    assert.equal(reply.statusCode, 200);
    assert.ok(reply.payload.note && String(reply.payload.note).length > 10, `${path} returned no honest note`);
  }
});

test("POST /internal/reindex counts and says plainly that it read no customer content", async () => {
  const db = fakeDb();
  const routes = register(db, allowingGate);
  const reply = fakeReply();
  await routes.get(`POST ${YC_API_PREFIX}/internal/reindex`)!({ body: {}, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  assert.ok(String(reply.payload.note).includes("Counts only"));
  assert.ok(String(reply.payload.note).includes("content was read"));
  assert.ok(Array.isArray(reply.payload.sources), "the reindex must return per-source counts");
});

test("GET /corpus/search never matches a customer-private source's text", async () => {
  const db = fakeDb({ "ycSource.findMany": [SOURCE_VOICEMAIL, SOURCE_Y24] });
  const routes = register(db, allowingGate);
  const reply = fakeReply();
  await routes.get(`GET ${YC_API_PREFIX}/corpus/search`)!({ query: { q: "anything" }, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  assert.ok(Array.isArray(reply.payload.rows));
  // The walled source comes back as a COUNT plus the wall's sentence, never a row.
  const walledKeys = (reply.payload.walled ?? []).map((w: any) => w.sourceKey);
  assert.ok(walledKeys.includes("voicemail"), "the customer-private source must be reported as walled, not searched");
  assert.ok(!reply.payload.rows.some((r: any) => r.sourceKey === "voicemail"), "a customer-private row was returned");
  assert.equal(reply.payload.wallNote, YC_CUSTOMER_WALL_MESSAGE);
});

test("GET /health reports the worker honestly when it has never ticked", async () => {
  const db = fakeDb();
  const routes = register(db, allowingGate);
  const reply = fakeReply();
  await routes.get(`GET ${YC_API_PREFIX}/health`)!({ query: {}, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.worker.alive, false);
  assert.equal(reply.payload.worker.lastTickAt, null);
  assert.ok(reply.payload.worker.note.includes("never processed a job"));
});

test("GET /governance names every wall and every gap", async () => {
  const db = fakeDb({ "ycSource.findMany": [SOURCE_VOICEMAIL, SOURCE_Y24], "ycRightsRecord.findMany": [] });
  const routes = register(db, allowingGate);
  const reply = fakeReply();
  await routes.get(`GET ${YC_API_PREFIX}/governance`)!({ query: {}, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.walls.length, 3);
  assert.ok(reply.payload.gaps.some((g: any) => g.key === "voicemail"));
  assert.ok(reply.payload.gaps.some((g: any) => g.key === "yiddish24" && /terms/i.test(g.gap)));
  for (const s of reply.payload.sources) assert.ok(s.badge, `${s.key} came back without a badge`);
});

// ── the Governance screen's own payload ─────────────────────────────────────
// Both of these were REAL defects found by opening the deployed page: the
// refusal quoted Yiddish24's hotlink block on customer voicemail rows, and the
// screen said "no budget configured" and "no worker heartbeat" while both
// existed, because the route never sent them.

test("the audio refusal describes the source it is actually about", () => {
  const customer = audioBlockedReason({ governanceClass: "CUSTOMER_PRIVATE", audioFetchMode: "DISABLED" }, []);
  assert.ok(customer && /customer audio/i.test(customer), `customer reason was: ${customer}`);
  assert.ok(
    customer && !/its own pages/i.test(customer),
    "a voicemail row must never quote a third-party site's hotlink block",
  );

  const external = audioBlockedReason({ governanceClass: "EXTERNAL", audioFetchMode: "DISABLED" }, []);
  assert.ok(external && /its own pages/i.test(external), `external reason was: ${external}`);

  const platform = audioBlockedReason({ governanceClass: "PLATFORM", audioFetchMode: "DISABLED" }, []);
  assert.ok(platform && /our own material/i.test(platform), `platform reason was: ${platform}`);
});

test("GET /governance carries the wall counts, the budget and the worker heartbeat", async () => {
  const now = Date.now();
  const db = fakeDb({
    "ycSource.findMany": [
      {
        id: "s1",
        key: "voicemail",
        name: "Voicemail transcripts",
        governanceClass: "CUSTOMER_PRIVATE",
        audioFetchMode: "DISABLED",
        contentAllowed: false,
        config: { inventory: { items: 3510, audioHours: 35.8 } },
      },
    ],
    "ycBudget.findFirst": {
      scope: "global",
      mode: "METADATA_ONLY",
      paused: true,
      apiCentsPerDay: 0,
      transcriptionMinutesPerDay: 0,
      concurrency: 2,
      requestsPerMinute: 30,
      spentCentsToday: 0,
      transcribedMinutesToday: 0,
    },
    "ycMetricSnapshot.findFirst": { metric: "worker_heartbeat_ms", value: now, createdAt: new Date(now) },
  });
  const routes = register(db, allowingGate);
  const reply = fakeReply();
  await routes.get(`GET ${YC_API_PREFIX}/governance`)!({ query: {}, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  const v = reply.payload;

  assert.equal(v.walled.length, 1, "the customer wall must list its sources");
  assert.equal(v.walled[0].rows, 3510, "the wall must show the real counted rows");
  assert.equal(v.walled[0].audioHours, 35.8);

  assert.ok(v.budget, "the budget must be sent, or the screen reports none exists");
  assert.equal(v.budget.paused, true);
  assert.equal(v.budget.mode, "METADATA_ONLY");

  assert.equal(v.worker.alive, true, "a heartbeat from just now means alive");
  assert.ok(v.worker.lastTickAt, "the screen shows when the worker last ticked");
  assert.ok(v.promotionStates, "promotion states are part of this screen");
});

test("the dashboard counts pairs as audio+transcript, and the wall as counted inventory", async () => {
  const db = fakeDb({
    "ycSource.findMany": [
      {
        id: "s1",
        key: "voicemail",
        name: "Voicemail transcripts",
        governanceClass: "CUSTOMER_PRIVATE",
        contentAllowed: false,
        audioFetchMode: "DISABLED",
        config: { inventory: { items: 3510, audioHours: 35.8 } },
      },
    ],
    "ycTranslation.count": 434,
    "ycSourceItem.count": 7,
  });
  const routes = register(db, allowingGate);
  const reply = fakeReply();
  await routes.get(`GET ${YC_API_PREFIX}/dashboard`)!({ query: {}, user: SUPER_ADMIN }, reply);
  const v = reply.payload;

  // 434 translations are not 434 aligned pairs. Reporting them as pairs made an
  // empty corpus look half-built.
  assert.notEqual(v.corpus.pairs, 434, "pairs must never be the translation count");

  // The wall must show what the indexer counted in place, not the (zero)
  // ingested rows — internal sources are counted, never ingested.
  const row = v.walled.find((w: any) => w.label === "Voicemail transcripts");
  assert.ok(row, "the customer wall must list voicemail");
  assert.equal(row.count, 3510, `the wall showed ${row.count} instead of the counted 3,510`);
  assert.equal(row.hours, 35.8);
});

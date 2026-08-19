import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_AUTO_REMOVALS,
  findOrphanTenants,
  isPbxAnswerHealthy,
  mysqlConfirmGoneVerifier,
  planOrphanSweep,
  runOrphanSweepAfterSync,
} from "./pbxOrphanTenantSweep";

/* The safety rails are the whole point of this module: the sweep is driven by a
   list fetched from the PBX, and a short list makes live customers look
   deleted. These tests exist to make that impossible to regress. */

test("an empty PBX answer is never trusted", () => {
  const r = isPbxAnswerHealthy({ seenCount: 0, knownCount: 28 });
  assert.equal(r.healthy, false);
  assert.match(String(r.reason), /no tenants/);
});

test("losing more than half the estate in one sync is a broken answer", () => {
  // 28 known, 13 returned: a paginated or permission-filtered response, not
  // fifteen simultaneous deletions.
  assert.equal(isPbxAnswerHealthy({ seenCount: 13, knownCount: 28 }).healthy, false);
});

test("a normal answer, and a genuine deletion or two, are healthy", () => {
  assert.equal(isPbxAnswerHealthy({ seenCount: 28, knownCount: 28 }).healthy, true);
  assert.equal(isPbxAnswerHealthy({ seenCount: 26, knownCount: 28 }).healthy, true);
});

test("the first sync on an empty Connect is healthy", () => {
  assert.equal(isPbxAnswerHealthy({ seenCount: 28, knownCount: 0 }).healthy, true);
});

/** Minimal stand-in for the bits of Prisma the sweep touches. */
function fakeDb(opts: {
  links: Array<{ tenantId: string; pbxTenantId: string | null }>;
  directory: string[];
  tenants: Array<{ id: string; name: string; users?: number; invoices?: number; cards?: number }>;
  paidInvoiceTenantIds?: string[];
  approvedTxTenantIds?: string[];
}) {
  return {
    tenantPbxLink: {
      findMany: async () => opts.links.filter((l) => l.pbxTenantId !== null),
    },
    pbxTenantDirectory: {
      findMany: async () => opts.directory.map((vitalTenantId) => ({ vitalTenantId })),
    },
    tenant: {
      findMany: async ({ where }: any) => {
        const ids: string[] = where.id.in;
        return opts.tenants
          .filter((t) => ids.includes(t.id))
          .map((t) => ({
            id: t.id,
            name: t.name,
            _count: {
              users: t.users ?? 0,
              billingInvoices: t.invoices ?? 0,
              paymentMethods: t.cards ?? 0,
            },
          }));
      },
    },
    billingInvoice: {
      groupBy: async () => (opts.paidInvoiceTenantIds || []).map((tenantId) => ({ tenantId })),
    },
    paymentTransaction: {
      groupBy: async () => (opts.approvedTxTenantIds || []).map((tenantId) => ({ tenantId })),
    },
  } as any;
}

test("a tenant whose PBX tenant vanished is an orphan", async () => {
  const db = fakeDb({
    links: [
      { tenantId: "t-live", pbxTenantId: "5" },
      { tenantId: "t-dead", pbxTenantId: "44" },
    ],
    directory: ["5"],
    tenants: [
      { id: "t-live", name: "Luxure Management" },
      { id: "t-dead", name: "Agent", users: 1 },
    ],
  });
  const orphans = await findOrphanTenants(db, "pbx-1");
  assert.deepEqual(
    orphans.map((o) => o.name),
    ["Agent"],
  );
  assert.equal(orphans[0].pbxTenantId, "44");
  assert.equal(orphans[0].users, 1);
});

test("⛔ a tenant that was NEVER linked to the PBX is not an orphan", async () => {
  // It was never on the PBX, so "deleted on the PBX" never happened to it.
  // This is what keeps the never-linked duplicate Connect Communications — two
  // users, an unpaid invoice and a saved card — out of an automatic sweep.
  const db = fakeDb({
    links: [{ tenantId: "t-never", pbxTenantId: null }],
    directory: ["5"],
    tenants: [{ id: "t-never", name: "Connect Communications", users: 2, invoices: 1, cards: 1 }],
  });
  assert.deepEqual(await findOrphanTenants(db, "pbx-1"), []);
});

test("a paid invoice marks the orphan as having completed payments", async () => {
  const db = fakeDb({
    links: [{ tenantId: "t-paid", pbxTenantId: "77" }],
    directory: ["5"],
    tenants: [{ id: "t-paid", name: "Former Customer", invoices: 4 }],
    paidInvoiceTenantIds: ["t-paid"],
  });
  const [o] = await findOrphanTenants(db, "pbx-1");
  assert.equal(o.hasCompletedPayment, true);
});

test("an approved card charge counts as money even with no paid invoice", async () => {
  const db = fakeDb({
    links: [{ tenantId: "t-charged", pbxTenantId: "78" }],
    directory: ["5"],
    tenants: [{ id: "t-charged", name: "Paid By Card" }],
    approvedTxTenantIds: ["t-charged"],
  });
  const [o] = await findOrphanTenants(db, "pbx-1");
  assert.equal(o.hasCompletedPayment, true);
});

test("an orphan with no invoice and no charge is a clean removal", async () => {
  const db = fakeDb({
    links: [{ tenantId: "t-junk", pbxTenantId: "40" }],
    directory: ["5"],
    tenants: [{ id: "t-junk", name: "robot test" }],
  });
  const [o] = await findOrphanTenants(db, "pbx-1");
  assert.equal(o.hasCompletedPayment, false);
});

test("a broken PBX answer produces no orphans at all, whatever the database says", async () => {
  const db = fakeDb({
    links: [{ tenantId: "t-dead", pbxTenantId: "44" }],
    directory: [],
    tenants: [{ id: "t-dead", name: "Agent" }],
  });
  const plan = await planOrphanSweep(db, "pbx-1", { seenCount: 0, knownCount: 28 });
  assert.equal(plan.healthy, false);
  assert.deepEqual(plan.orphans, []);
});

test("more orphans than the unattended cap asks for confirmation", async () => {
  const many = Array.from({ length: MAX_AUTO_REMOVALS + 1 }, (_, i) => ({
    id: `t${i}`,
    name: `Test ${i}`,
  }));
  const db = fakeDb({
    links: many.map((t, i) => ({ tenantId: t.id, pbxTenantId: String(900 + i) })),
    directory: ["5"],
    tenants: many,
  });
  const plan = await planOrphanSweep(db, "pbx-1", { seenCount: 28, knownCount: 28 });
  assert.equal(plan.healthy, true);
  assert.equal(plan.orphans.length, MAX_AUTO_REMOVALS + 1);
  assert.equal(plan.needsConfirmation, true);
});

test("a single genuine deletion goes through unattended", async () => {
  const db = fakeDb({
    links: [
      { tenantId: "t-live", pbxTenantId: "5" },
      { tenantId: "t-dead", pbxTenantId: "44" },
    ],
    directory: ["5"],
    tenants: [
      { id: "t-live", name: "Luxure Management" },
      { id: "t-dead", name: "agent test" },
    ],
  });
  const plan = await planOrphanSweep(db, "pbx-1", { seenCount: 27, knownCount: 28 });
  assert.equal(plan.healthy, true);
  assert.equal(plan.orphans.length, 1);
  assert.equal(plan.needsConfirmation, false);
});


/* ── REST is not ground truth (2026-08-19) ─────────────────────────────────
   VitalPBX's REST tenant list serves a cached snapshot — observed 40+ minutes
   stale during the 20x10 mirror stress test, when a directory built from it
   made exactly three tenants look orphaned (inside the auto cap) and the sweep
   marked all three: one test leftover and TWO LIVE CUSTOMERS. These tests pin
   the rule that earned: discovery may ride REST, but nothing is MARKED unless
   ombutel MySQL confirms the PBX tenant is really gone. */

function markableDb(opts: Parameters<typeof fakeDb>[0]) {
  const db = fakeDb(opts);
  db.tenant.update = async ({ where }: any) => ({ id: where.id });
  db.tenantPbxLink.updateMany = async () => ({ count: 1 });
  db.tenantBillingSettings = { updateMany: async () => ({ count: 1 }) };
  return db;
}

const oneDead = () =>
  markableDb({
    links: [
      { tenantId: "t-live", pbxTenantId: "5" },
      { tenantId: "t-dead", pbxTenantId: "44" },
    ],
    directory: ["5"],
    tenants: [
      { id: "t-live", name: "Luxure Management" },
      { id: "t-dead", name: "agent test" },
    ],
  });

test("⛔ with no MySQL verifier, the sweep MARKS NOTHING — REST alone may not sentence a tenant", async () => {
  const r = await runOrphanSweepAfterSync(oneDead(), "pbx-1", { seenCount: 27, knownCount: 28 });
  assert.equal(r.healthy, true);
  assert.equal(r.marked.length, 0);
  assert.deepEqual(r.awaitingConfirmation.map((o) => o.name), ["agent test"]);
});

test("⛔ MySQL unreachable (verifier answers null) — nothing is marked", async () => {
  const r = await runOrphanSweepAfterSync(oneDead(), "pbx-1", { seenCount: 27, knownCount: 28 }, undefined, async () => null);
  assert.equal(r.marked.length, 0);
  assert.deepEqual(r.awaitingConfirmation.map((o) => o.name), ["agent test"]);
});

test("⛔ THE 2026-08-19 SHAPE: REST says gone, MySQL says alive — the tenant is NOT marked", async () => {
  // MySQL confirms NOTHING is gone: the "orphan" is a stale-cache artifact.
  const r = await runOrphanSweepAfterSync(oneDead(), "pbx-1", { seenCount: 27, knownCount: 28 }, undefined, async () => new Set());
  assert.equal(r.marked.length, 0);
  assert.equal(r.awaitingConfirmation.length, 0, "a REST lie is dropped, not queued for a person to wrongly confirm");
});

test("a MySQL-confirmed deletion still goes through unattended", async () => {
  const r = await runOrphanSweepAfterSync(oneDead(), "pbx-1", { seenCount: 27, knownCount: 28 }, undefined, async (ids) => new Set(ids));
  assert.equal(r.marked.length, 1);
  assert.equal(r.marked[0].name, "agent test");
});

test("the unattended cap applies to the CONFIRMED list", async () => {
  const many = Array.from({ length: MAX_AUTO_REMOVALS + 1 }, (_, i) => ({ id: `t${i}`, name: `Test ${i}` }));
  const db = markableDb({
    links: many.map((t, i) => ({ tenantId: t.id, pbxTenantId: String(900 + i) })),
    directory: ["5"],
    tenants: many,
  });
  const r = await runOrphanSweepAfterSync(db, "pbx-1", { seenCount: 28, knownCount: 28 }, undefined, async (ids) => new Set(ids));
  assert.equal(r.marked.length, 0);
  assert.equal(r.awaitingConfirmation.length, MAX_AUTO_REMOVALS + 1);
});

test("the MySQL verifier refuses to guess about a non-numeric pbx tenant id", async () => {
  // openReadConn is never reached: the id fails the shape check first, and the
  // verifier answers null — which the sweep reads as "do not mark anything".
  const verdict = await mysqlConfirmGoneVerifier(null)(["44", "not-a-number"]);
  assert.equal(verdict, null);
});

test("server.ts wires the verifier into BOTH the sync sweep and the confirm route", () => {
  // The defect was in the CALLER: the sweep function could be perfect and a
  // route that skips the verifier still deletes live customers off stale REST.
  const src = readFileSync(join(__dirname, "server.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(/runOrphanSweepAfterSync\([^)]*mysqlConfirmGoneVerifier\(instance\.ombuMysqlUrlEncrypted\)/s.test(src),
    "the sync route must pass the MySQL verifier to the sweep");
  const confirmAt = src.indexOf("/admin/pbx/removed-tenants/confirm");
  const confirmBody = src.slice(confirmAt, confirmAt + 4000);
  assert.ok(confirmBody.includes("mysqlConfirmGoneVerifier(instance.ombuMysqlUrlEncrypted)"),
    "the confirm route must verify against MySQL before marking");
  assert.ok(confirmBody.includes("pbx_database_unavailable"),
    "an unreachable PBX database must refuse the confirm, not proceed on REST alone");
});

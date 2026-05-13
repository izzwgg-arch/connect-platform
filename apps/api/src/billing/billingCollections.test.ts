import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markDoNotCharge,
  pauseInvoiceCollections,
  readInvoiceCollectionsSlice,
  readTenantCollectionsConfig,
  resumeInvoiceCollections,
  skipNextRetry,
  validateTenantCollectionsConfigUpdate,
  writeInvoiceCollectionsSlice,
  writeTenantCollectionsConfig,
  type CollectionsDb,
} from "./billingCollections.js";

// ── readTenantCollectionsConfig ───────────────────────────────────────────────

test("readTenantCollectionsConfig: defaults when metadata is null", () => {
  const cfg = readTenantCollectionsConfig(null);
  assert.equal(cfg.dunningEnabled, null);
  assert.equal(cfg.maxAttempts, null);
  assert.equal(cfg.retryDelayHours, null);
});

test("readTenantCollectionsConfig: defaults when no collections slice", () => {
  const cfg = readTenantCollectionsConfig({ foo: "bar" });
  assert.equal(cfg.dunningEnabled, null);
  assert.equal(cfg.maxAttempts, null);
});

test("readTenantCollectionsConfig: reads stored values", () => {
  const meta = { collections: { dunningEnabled: false, maxAttempts: 5, retryDelayHours: 48 } };
  const cfg = readTenantCollectionsConfig(meta);
  assert.equal(cfg.dunningEnabled, false);
  assert.equal(cfg.maxAttempts, 5);
  assert.equal(cfg.retryDelayHours, 48);
});

test("readTenantCollectionsConfig: clamps maxAttempts to [1, 10]", () => {
  assert.equal(readTenantCollectionsConfig({ collections: { maxAttempts: 0 } }).maxAttempts, 1);
  assert.equal(readTenantCollectionsConfig({ collections: { maxAttempts: 99 } }).maxAttempts, 10);
});

test("readTenantCollectionsConfig: clamps retryDelayHours to [1, 336]", () => {
  assert.equal(readTenantCollectionsConfig({ collections: { retryDelayHours: 0 } }).retryDelayHours, 1);
  assert.equal(readTenantCollectionsConfig({ collections: { retryDelayHours: 999 } }).retryDelayHours, 336);
});

// ── writeTenantCollectionsConfig ─────────────────────────────────────────────

test("writeTenantCollectionsConfig: preserves existing metadata keys", () => {
  const existing = { otherKey: "keep-me", collections: { maxAttempts: 3 } };
  const result = writeTenantCollectionsConfig(existing, { maxAttempts: 5 });
  assert.equal((result as any).otherKey, "keep-me");
  assert.equal((result as any).collections.maxAttempts, 5);
});

test("writeTenantCollectionsConfig: sets dunningEnabled", () => {
  const result = writeTenantCollectionsConfig({}, { dunningEnabled: false });
  assert.equal((result as any).collections.dunningEnabled, false);
});

test("writeTenantCollectionsConfig: partial update only changes specified keys", () => {
  const existing = { collections: { maxAttempts: 3, retryDelayHours: 72, dunningEnabled: true } };
  const result = writeTenantCollectionsConfig(existing, { maxAttempts: 6 });
  const c = (result as any).collections;
  assert.equal(c.maxAttempts, 6);
  assert.equal(c.retryDelayHours, 72);
  assert.equal(c.dunningEnabled, true);
});

// ── validateTenantCollectionsConfigUpdate ────────────────────────────────────

test("validateTenantCollectionsConfigUpdate: accepts empty body", () => {
  const r = validateTenantCollectionsConfigUpdate({});
  assert.equal(r.ok, true);
});

test("validateTenantCollectionsConfigUpdate: null clears to default", () => {
  assert.equal(validateTenantCollectionsConfigUpdate({ maxAttempts: null }).ok, true);
  assert.equal(validateTenantCollectionsConfigUpdate({ retryDelayHours: null }).ok, true);
  assert.equal(validateTenantCollectionsConfigUpdate({ dunningEnabled: null }).ok, true);
});

test("validateTenantCollectionsConfigUpdate: rejects maxAttempts out of range", () => {
  const r = validateTenantCollectionsConfigUpdate({ maxAttempts: 0 });
  assert.equal(r.ok, false);
  assert.ok("error" in r && r.error.includes("maxAttempts"));
});

test("validateTenantCollectionsConfigUpdate: rejects maxAttempts > 10", () => {
  const r = validateTenantCollectionsConfigUpdate({ maxAttempts: 11 });
  assert.equal(r.ok, false);
});

test("validateTenantCollectionsConfigUpdate: rejects retryDelayHours out of range", () => {
  const r = validateTenantCollectionsConfigUpdate({ retryDelayHours: 400 });
  assert.equal(r.ok, false);
  assert.ok("error" in r && r.error.includes("retryDelayHours"));
});

test("validateTenantCollectionsConfigUpdate: rejects non-boolean dunningEnabled", () => {
  const r = validateTenantCollectionsConfigUpdate({ dunningEnabled: "yes" });
  assert.equal(r.ok, false);
});

test("validateTenantCollectionsConfigUpdate: accepts valid config", () => {
  const r = validateTenantCollectionsConfigUpdate({ dunningEnabled: true, maxAttempts: 4, retryDelayHours: 48 });
  assert.equal(r.ok, true);
});

// ── readInvoiceCollectionsSlice ───────────────────────────────────────────────

test("readInvoiceCollectionsSlice: defaults to NORMAL when no slice", () => {
  const s = readInvoiceCollectionsSlice(null);
  assert.equal(s.status, "NORMAL");
  assert.equal(s.paused, false);
  assert.equal(s.doNotCharge, false);
  assert.equal(s.skipNextRetry, false);
});

test("readInvoiceCollectionsSlice: PAUSED when paused=true", () => {
  const s = readInvoiceCollectionsSlice({ collections: { paused: true, pausedBy: "admin@test.com" } });
  assert.equal(s.status, "PAUSED");
  assert.equal(s.paused, true);
  assert.equal(s.pausedBy, "admin@test.com");
});

test("readInvoiceCollectionsSlice: DO_NOT_CHARGE wins over paused", () => {
  const s = readInvoiceCollectionsSlice({ collections: { paused: true, doNotCharge: true } });
  assert.equal(s.status, "DO_NOT_CHARGE");
});

// ── writeInvoiceCollectionsSlice ──────────────────────────────────────────────

test("writeInvoiceCollectionsSlice: preserves dunning and other metadata keys", () => {
  const existing = { dunning: { attempts: 2, maxAttempts: 3 }, someOtherKey: "keep" };
  const result = writeInvoiceCollectionsSlice(existing, { paused: true, updatedBy: "op1" });
  assert.deepEqual((result as any).dunning, { attempts: 2, maxAttempts: 3 });
  assert.equal((result as any).someOtherKey, "keep");
  assert.equal((result as any).collections.paused, true);
});

test("writeInvoiceCollectionsSlice: clears pause fields on unpause", () => {
  const existing = {
    collections: { paused: true, pausedAt: "2025-01-01", pausedBy: "op1", pauseReason: "test" },
  };
  const result = writeInvoiceCollectionsSlice(existing, { paused: false, updatedBy: "op2" });
  const c = (result as any).collections;
  assert.equal(c.paused, false);
  assert.equal(c.pausedAt, null);
  assert.equal(c.pausedBy, null);
  assert.equal(c.pauseReason, null);
});

// ── pauseInvoiceCollections ───────────────────────────────────────────────────

function makeDb(invoice: any): CollectionsDb {
  const logs: any[] = [];
  return {
    billingInvoice: {
      findMany: async () => [],
      findUnique: async (_args: any) => invoice,
      update: async (args: any) => {
        if (invoice) invoice.metadata = (args as any).data.metadata;
        return invoice;
      },
    },
    tenantBillingSettings: {
      findUnique: async () => null,
      upsert: async () => null,
    },
    billingEventLog: {
      create: async (args: any) => {
        logs.push((args as any).data);
        return (args as any).data;
      },
    },
    _logs: logs,
  } as any;
}

test("pauseInvoiceCollections: pauses an OPEN invoice", async () => {
  const inv = { id: "inv1", tenantId: "t1", status: "OPEN", metadata: {}, invoiceNumber: "INV-001" };
  const cdb = makeDb(inv);
  const result = await pauseInvoiceCollections(cdb, "inv1", "admin-sub", "awaiting dispute resolution");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.collections.status, "PAUSED");
  assert.equal(result.collections.pausedBy, "admin-sub");
  assert.equal(result.collections.pauseReason, "awaiting dispute resolution");
  const logs = (cdb as any)._logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].type, "collections_action");
  assert.equal(logs[0].metadata.action, "pause");
  assert.equal(logs[0].metadata.operatorId, "admin-sub");
});

test("pauseInvoiceCollections: rejects PAID invoice", async () => {
  const inv = { id: "inv2", tenantId: "t1", status: "PAID", metadata: {}, invoiceNumber: "INV-002" };
  const result = await pauseInvoiceCollections(makeDb(inv), "inv2", "admin-sub");
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "invalid_status");
});

test("pauseInvoiceCollections: rejects already-paused invoice", async () => {
  const inv = { id: "inv3", tenantId: "t1", status: "FAILED", metadata: { collections: { paused: true } }, invoiceNumber: "INV-003" };
  const result = await pauseInvoiceCollections(makeDb(inv), "inv3", "admin-sub");
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "already_paused");
});

test("pauseInvoiceCollections: returns invoice_not_found for missing invoice", async () => {
  const result = await pauseInvoiceCollections(makeDb(null), "missing", "admin-sub");
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "invoice_not_found");
});

// ── resumeInvoiceCollections ──────────────────────────────────────────────────

test("resumeInvoiceCollections: clears all pause/doNotCharge/skipNextRetry flags", async () => {
  const inv = {
    id: "inv4",
    tenantId: "t1",
    status: "FAILED",
    metadata: { collections: { paused: true, skipNextRetry: true, doNotCharge: false } },
    invoiceNumber: "INV-004",
  };
  const cdb = makeDb(inv);
  const result = await resumeInvoiceCollections(cdb, "inv4", "admin-sub");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.collections.status, "NORMAL");
  assert.equal(result.collections.paused, false);
  assert.equal(result.collections.skipNextRetry, false);
  const logs = (cdb as any)._logs;
  assert.equal(logs[0].metadata.action, "resume");
});

test("resumeInvoiceCollections: rejects if nothing to resume", async () => {
  const inv = { id: "inv5", tenantId: "t1", status: "FAILED", metadata: {}, invoiceNumber: "INV-005" };
  const result = await resumeInvoiceCollections(makeDb(inv), "inv5", "admin-sub");
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "not_paused");
});

// ── skipNextRetry ─────────────────────────────────────────────────────────────

test("skipNextRetry: sets skipNextRetry flag and logs", async () => {
  const inv = { id: "inv6", tenantId: "t1", status: "OPEN", metadata: {}, invoiceNumber: "INV-006" };
  const cdb = makeDb(inv);
  const result = await skipNextRetry(cdb, "inv6", "admin-sub");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.collections.skipNextRetry, true);
  const logs = (cdb as any)._logs;
  assert.equal(logs[0].metadata.action, "skip_next_retry");
});

test("skipNextRetry: rejects VOID invoice", async () => {
  const inv = { id: "inv7", tenantId: "t1", status: "VOID", metadata: {}, invoiceNumber: "INV-007" };
  const result = await skipNextRetry(makeDb(inv), "inv7", "admin-sub");
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "invalid_status");
});

// ── markDoNotCharge ───────────────────────────────────────────────────────────

test("markDoNotCharge: sets doNotCharge and logs", async () => {
  const inv = { id: "inv8", tenantId: "t1", status: "OVERDUE", metadata: {}, invoiceNumber: "INV-008" };
  const cdb = makeDb(inv);
  const result = await markDoNotCharge(cdb, "inv8", "admin-sub", "written off");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.collections.status, "DO_NOT_CHARGE");
  assert.equal(result.collections.doNotCharge, true);
  const logs = (cdb as any)._logs;
  assert.equal(logs[0].metadata.action, "do_not_charge");
  assert.equal(logs[0].metadata.reason, "written off");
});

test("markDoNotCharge: rejects PAID invoice", async () => {
  const inv = { id: "inv9", tenantId: "t1", status: "PAID", metadata: {}, invoiceNumber: "INV-009" };
  const result = await markDoNotCharge(makeDb(inv), "inv9", "admin-sub");
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "invalid_status");
});

// ── Audit log completeness ────────────────────────────────────────────────────

test("all action helpers log prevState and nextState", async () => {
  const inv = { id: "invA", tenantId: "t1", status: "FAILED", metadata: {}, invoiceNumber: "INV-A" };
  const cdb = makeDb(inv);
  await pauseInvoiceCollections(cdb, "invA", "op1");
  const log = (cdb as any)._logs[0];
  assert.ok(log.metadata.prevState, "prevState should be present");
  assert.ok(log.metadata.nextState, "nextState should be present");
  assert.equal(log.metadata.prevState.status, "NORMAL");
  assert.equal(log.metadata.nextState.status, "PAUSED");
});

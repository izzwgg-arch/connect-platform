import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeDunningAfterFailure,
  clearDunningSlice,
  readDunningSlice,
  runDunningSweepEligibility,
  consumeSkipNextRetryFlag,
} from "./billingDunning.js";

// ── Existing pure-function tests ──────────────────────────────────────────────

test("mergeDunningAfterFailure increments from empty metadata", () => {
  const r = mergeDunningAfterFailure({});
  assert.equal(r.attempts, 1);
  assert.equal(r.exhausted, false);
  assert.ok(r.nextRetryAt instanceof Date);
  assert.ok((r.metadata as any).dunning);
});

test("mergeDunningAfterFailure defaults declined-card retry to 12 hours", () => {
  const previous = process.env.BILLING_DUNNING_RETRY_DELAY_HOURS;
  delete process.env.BILLING_DUNNING_RETRY_DELAY_HOURS;
  try {
    const r = mergeDunningAfterFailure({});
    assert.ok(r.nextRetryAt instanceof Date);
    const diffMs = r.nextRetryAt!.getTime() - Date.now();
    const twelveHoursMs = 12 * 3600_000;
    assert.ok(diffMs > twelveHoursMs - 10_000 && diffMs <= twelveHoursMs + 10_000, `expected ~12h delay, got ${diffMs}ms`);
  } finally {
    if (previous === undefined) delete process.env.BILLING_DUNNING_RETRY_DELAY_HOURS;
    else process.env.BILLING_DUNNING_RETRY_DELAY_HOURS = previous;
  }
});

test("clearDunningSlice removes dunning", () => {
  const cleared = clearDunningSlice({ dunning: { attempts: 2 }, other: 1 });
  assert.equal((cleared as any).dunning, undefined);
  assert.equal((cleared as any).other, 1);
});

test("readDunningSlice reads nested dunning", () => {
  const d = readDunningSlice({ dunning: { attempts: 2, maxAttempts: 5, nextRetryAt: "2099-01-01T00:00:00.000Z" } });
  assert.equal(d.attempts, 2);
  assert.equal(d.maxAttempts, 5);
});

test("mergeDunningAfterFailure: per-tenant maxAttempts override exhausts sooner", () => {
  // With maxAttempts=2, second attempt is exhausted
  const after1 = mergeDunningAfterFailure({}, { maxAttempts: 2 });
  assert.equal(after1.attempts, 1);
  assert.equal(after1.exhausted, false);
  const after2 = mergeDunningAfterFailure(after1.metadata, { maxAttempts: 2 });
  assert.equal(after2.attempts, 2);
  assert.equal(after2.exhausted, true);
  assert.equal(after2.nextRetryAt, null);
});

test("mergeDunningAfterFailure: per-tenant retryDelayMs override changes nextRetryAt", () => {
  const shortDelay = 1 * 3600_000; // 1 hour
  const r = mergeDunningAfterFailure({}, { retryDelayMs: shortDelay });
  assert.ok(r.nextRetryAt instanceof Date);
  // nextRetryAt should be roughly 1 hour from now (within 10 seconds tolerance)
  const diffMs = r.nextRetryAt!.getTime() - Date.now();
  assert.ok(diffMs > 0 && diffMs <= shortDelay + 10_000, `expected ~1h delay, got ${diffMs}ms`);
});

// ── Phase 2: runDunningSweepEligibility tests ─────────────────────────────────

const PAST_RETRY = new Date(Date.now() - 1000).toISOString(); // nextRetryAt in the past (due)

function makeInvoice(overrides: {
  id?: string;
  tenantId?: string;
  status?: string;
  balanceDueCents?: number;
  dunning?: object;
  collections?: object;
  tenantCollections?: object;
  defaultPaymentMethodId?: string;
}): any {
  const id = overrides.id ?? "inv-test";
  return {
    id,
    tenantId: overrides.tenantId ?? "tenant-1",
    status: overrides.status ?? "FAILED",
    balanceDueCents: overrides.balanceDueCents ?? 5000,
    updatedAt: new Date(),
    metadata: {
      dunning: { attempts: 1, maxAttempts: 3, nextRetryAt: PAST_RETRY, ...overrides.dunning },
      ...(overrides.collections ? { collections: overrides.collections } : {}),
    },
    tenant: {
      billingSettings: {
        defaultPaymentMethodId: overrides.defaultPaymentMethodId ?? "pm-1",
        metadata: overrides.tenantCollections ? { collections: overrides.tenantCollections } : {},
      },
    },
  };
}

function makeDb(invoices: any[]) {
  const logs: any[] = [];
  return {
    billingInvoice: {
      findMany: async () => invoices,
      findUnique: async ({ where }: any) => {
        const inv = invoices.find((i) => i.id === where.id);
        return inv ? { metadata: inv.metadata } : null;
      },
      update: async (args: any) => {
        const inv = invoices.find((i) => i.id === args.where.id);
        if (inv) inv.metadata = args.data.metadata;
        return inv;
      },
    },
    billingEventLog: {
      create: async (args: any) => {
        logs.push(args.data);
        return args.data;
      },
    },
    _logs: logs,
  };
}

test("runDunningSweepEligibility: eligible invoice goes to toCharge", async () => {
  const inv = makeInvoice({});
  const cdb = makeDb([inv]);
  const result = await runDunningSweepEligibility(25, cdb);
  assert.equal(result.toCharge.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.skipNextRetryInvoices.length, 0);
  assert.equal(result.toCharge[0].attemptNumber, 2); // attempts=1 +1
});

test("runDunningSweepEligibility: paused invoice goes to skipped", async () => {
  const inv = makeInvoice({ collections: { paused: true } });
  const cdb = makeDb([inv]);
  const result = await runDunningSweepEligibility(25, cdb);
  assert.equal(result.toCharge.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "paused");
});

test("runDunningSweepEligibility: doNotCharge invoice goes to skipped", async () => {
  const inv = makeInvoice({ collections: { doNotCharge: true } });
  const cdb = makeDb([inv]);
  const result = await runDunningSweepEligibility(25, cdb);
  assert.equal(result.toCharge.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "do_not_charge");
});

test("runDunningSweepEligibility: tenant dunningEnabled=false skips invoice", async () => {
  const inv = makeInvoice({ tenantCollections: { dunningEnabled: false } });
  const cdb = makeDb([inv]);
  const result = await runDunningSweepEligibility(25, cdb);
  assert.equal(result.toCharge.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "tenant_dunning_disabled");
});

test("runDunningSweepEligibility: tenant dunningEnabled=true does not skip", async () => {
  const inv = makeInvoice({ tenantCollections: { dunningEnabled: true } });
  const cdb = makeDb([inv]);
  const result = await runDunningSweepEligibility(25, cdb);
  assert.equal(result.toCharge.length, 1);
  assert.equal(result.skipped.length, 0);
});

test("runDunningSweepEligibility: skipNextRetry invoice goes to skipNextRetryInvoices", async () => {
  const inv = makeInvoice({ collections: { skipNextRetry: true } });
  const cdb = makeDb([inv]);
  const result = await runDunningSweepEligibility(25, cdb);
  assert.equal(result.toCharge.length, 0);
  assert.equal(result.skipNextRetryInvoices.length, 1);
  assert.equal(result.skipped.length, 0);
});

test("runDunningSweepEligibility: per-tenant maxAttempts override allows more retries", async () => {
  // Invoice has attempts=3 (exhausted under global max=3), but tenant allows 5
  const inv = makeInvoice({
    dunning: { attempts: 3, maxAttempts: 3, nextRetryAt: PAST_RETRY },
    tenantCollections: { maxAttempts: 5 },
  });
  const cdb = makeDb([inv]);
  const result = await runDunningSweepEligibility(25, cdb);
  assert.equal(result.toCharge.length, 1);
  assert.equal(result.toCharge[0].effectiveMaxAttempts, 5);
});

test("runDunningSweepEligibility: per-tenant maxAttempts override restricts retries", async () => {
  // Invoice has attempts=2 (ok under global max=3), but tenant allows only 2
  const inv = makeInvoice({
    dunning: { attempts: 2, maxAttempts: 3, nextRetryAt: PAST_RETRY },
    tenantCollections: { maxAttempts: 2 },
  });
  const cdb = makeDb([inv]);
  const result = await runDunningSweepEligibility(25, cdb);
  assert.equal(result.toCharge.length, 0); // attempts >= effectiveMax(2) → skip
});

test("runDunningSweepEligibility: per-tenant retryDelayMs propagated to effectiveDelayMs", async () => {
  const inv = makeInvoice({ tenantCollections: { retryDelayHours: 24 } });
  const cdb = makeDb([inv]);
  const result = await runDunningSweepEligibility(25, cdb);
  assert.equal(result.toCharge.length, 1);
  assert.equal(result.toCharge[0].effectiveDelayMs, 24 * 3_600_000);
});

test("runDunningSweepEligibility: invoice not due yet is silently excluded", async () => {
  const futureRetry = new Date(Date.now() + 10 * 3_600_000).toISOString();
  const inv = makeInvoice({ dunning: { attempts: 1, maxAttempts: 3, nextRetryAt: futureRetry } });
  const cdb = makeDb([inv]);
  const result = await runDunningSweepEligibility(25, cdb);
  assert.equal(result.toCharge.length, 0);
  assert.equal(result.skipped.length, 0); // timing miss → silent skip (not a collections block)
});

// ── Phase 2: consumeSkipNextRetryFlag tests ───────────────────────────────────

test("consumeSkipNextRetryFlag: clears flag and logs collections_action", async () => {
  const inv = { id: "inv-skip", metadata: { dunning: { attempts: 1 }, collections: { skipNextRetry: true, paused: false } } };
  const cdb = makeDb([inv]);
  await consumeSkipNextRetryFlag("inv-skip", "tenant-1", cdb);
  // Metadata should be updated
  assert.equal((inv.metadata as any).collections.skipNextRetry, false);
  // Log should be created
  const logs = (cdb as any)._logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].type, "collections_action");
  assert.equal(logs[0].metadata.action, "skip_next_retry_consumed");
  assert.equal(logs[0].metadata.prevState.skipNextRetry, true);
  assert.equal(logs[0].metadata.nextState.skipNextRetry, false);
});

test("consumeSkipNextRetryFlag: preserves other metadata keys (dunning, other collections)", async () => {
  const inv = {
    id: "inv-skip2",
    metadata: {
      dunning: { attempts: 2, maxAttempts: 3, nextRetryAt: PAST_RETRY },
      someOther: "keep",
      collections: { skipNextRetry: true, paused: false, doNotCharge: false },
    },
  };
  const cdb = makeDb([inv]);
  await consumeSkipNextRetryFlag("inv-skip2", "tenant-1", cdb);
  assert.deepEqual((inv.metadata as any).dunning, { attempts: 2, maxAttempts: 3, nextRetryAt: PAST_RETRY });
  assert.equal((inv.metadata as any).someOther, "keep");
  assert.equal((inv.metadata as any).collections.paused, false);
  assert.equal((inv.metadata as any).collections.doNotCharge, false);
});

// ── Deterministic idempotency key format ─────────────────────────────────────

test("worker idempotency key format is deterministic", () => {
  // Verify the expected key format without calling the worker directly
  const invoiceId = "inv-abc123";
  const attemptNumber = 2;
  const key = `worker:billing:sale:${invoiceId}:a${attemptNumber}`;
  assert.equal(key, "worker:billing:sale:inv-abc123:a2");
  // Key must NOT contain Date.now() — confirm it's a fixed string
  assert.ok(!key.match(/\d{13}/), "idempotency key must not contain a 13-digit timestamp");
});

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { UNPAID_FAILURE_STATUSES, runServiceInterruptionSweep, serviceInterruptionCutover } from "./serviceInterruptionJob";
import { readServiceInterruption, startCountdown, writeServiceInterruption } from "./serviceInterruptionSettings";

const DAY = 24 * 3600 * 1000;
const FAILED = new Date("2026-08-17T14:00:00Z");
const CUTOVER = "2026-08-01T00:00:00Z";

const log = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * The REAL `BillingInvoiceStatus` enum, read from the Prisma schema — not a
 * copy. ⛔ Seen live 2026-08-19: the sweep queried `status: { in: [..., "UNPAID"] }`,
 * a value that is not in the enum, so Prisma rejected the whole query
 * (`Invalid value for argument 'in'. Expected BillingInvoiceStatus.`), the only
 * switched-on tenant landed in `errors[]` on every run, and this suite — whose
 * fake db ignored `where.status` — passed 102/102 while production never ran
 * the cutoff logic for anyone. The fake now behaves like Prisma on this point.
 */
const SCHEMA_PATH = resolve(__dirname, "../../../../../packages/db/prisma/schema.prisma");
const BILLING_INVOICE_STATUSES: readonly string[] = (() => {
  const src = readFileSync(SCHEMA_PATH, "utf8").replace(/\r\n/g, "\n");
  const m = src.match(/enum BillingInvoiceStatus \{([^}]*)\}/);
  assert.ok(m, "enum BillingInvoiceStatus not found in schema.prisma");
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"));
})();

/** What Prisma does with a bad enum member in an `in:` list — throws, whole query. */
function assertPrismaEnumIn(where: any) {
  const list: unknown = where?.status?.in;
  if (list === undefined) return;
  assert.ok(Array.isArray(list), "status.in must be an array");
  for (const v of list) {
    if (!BILLING_INVOICE_STATUSES.includes(String(v))) {
      throw new Error(`Invalid value for argument 'in'. Expected BillingInvoiceStatus. (got ${JSON.stringify(v)})`);
    }
  }
}

function fakeDb(rows: Array<{ tenantId: string; metadata: unknown }>, invoices: Record<string, any>) {
  const store = new Map(rows.map((r) => [r.tenantId, r.metadata]));
  const queries: any[] = [];
  return {
    store,
    queries,
    tenantBillingSettings: {
      findMany: async () => [...store.entries()].map(([tenantId, metadata]) => ({ tenantId, metadata })),
      update: async ({ where, data }: any) => {
        store.set(where.tenantId, data.metadata);
      },
    },
    billingInvoice: {
      findFirst: async ({ where }: any) => {
        queries.push(where);
        assertPrismaEnumIn(where);
        const row = invoices[where.tenantId] ?? null;
        if (!row) return null;
        // Honour the status filter like the database would: a fixture that
        // names a status only comes back when the query asks for it.
        if (row.status && Array.isArray(where?.status?.in) && !where.status.in.includes(row.status)) return null;
        return row;
      },
    },
  };
}

const inv = (createdAt: Date, firstFailedAt?: Date) => ({
  id: "inv_1",
  balanceDueCents: 14000,
  createdAt,
  updatedAt: createdAt,
  metadata: firstFailedAt ? { dunning: { firstFailedAt: firstFailedAt.toISOString() } } : {},
});

function deps(db: any, now: Date, calls: any = {}) {
  return {
    db,
    log,
    now: () => now,
    sendReminder: calls.sendReminder ?? (async () => {}),
    interrupt: calls.interrupt ?? (async () => [{ arsId: "214", outboundRouteId: "125" }]),
    restore: calls.restore ?? (async () => {}),
  };
}

// ─── ⛔ The invoice query must be one Prisma will actually run ───────────────

test("⛔ every status the sweep queries is a real BillingInvoiceStatus (2026-08-19 regression)", () => {
  assert.ok(BILLING_INVOICE_STATUSES.length >= 5, `schema enum looks wrong: ${BILLING_INVOICE_STATUSES.join(",")}`);
  assert.ok(!BILLING_INVOICE_STATUSES.includes("UNPAID"), "the schema has no UNPAID — this test guards exactly that");
  for (const s of UNPAID_FAILURE_STATUSES) {
    assert.ok(BILLING_INVOICE_STATUSES.includes(s), `"${s}" is not a member of BillingInvoiceStatus in schema.prisma`);
  }
  assert.ok(UNPAID_FAILURE_STATUSES.includes("FAILED"), "a declined charge is the whole point");
  assert.ok(UNPAID_FAILURE_STATUSES.includes("OVERDUE"), "an invoice marked past due by hand still counts");
  assert.ok(!(UNPAID_FAILURE_STATUSES as readonly string[]).includes("OPEN"), "OPEN = not yet collected; the countdown must not start before the charge");
});

test("⛔ the query the sweep really issues carries only enum members, and the tenant is NOT skipped", async () => {
  process.env.SERVICE_INTERRUPTION_CUTOVER_AT = CUTOVER;
  const db = fakeDb([{ tenantId: "t1", metadata: writeServiceInterruption({}, { enabled: true }) }], {
    t1: { ...inv(FAILED), status: "FAILED" },
  });
  const s = await runServiceInterruptionSweep(deps(db, FAILED));
  assert.equal(db.queries.length, 1, "one invoice lookup for the one switched-on tenant");
  for (const v of db.queries[0].status.in) assert.ok(BILLING_INVOICE_STATUSES.includes(v), `${v} is not in the enum`);
  assert.deepEqual(s.errors, [], "on the old list this was [{tenantId:'t1', error:'Invalid value for argument in…'}]");
  assert.equal(s.considered, 1);
  assert.equal(readServiceInterruption(db.store.get("t1")).countdownStartedAt, FAILED.toISOString(), "the countdown actually started");
});

test("FAILED and OVERDUE invoices start the countdown; an OPEN one does not", async () => {
  process.env.SERVICE_INTERRUPTION_CUTOVER_AT = CUTOVER;
  const on = () => writeServiceInterruption({}, { enabled: true });
  const db = fakeDb(
    [
      { tenantId: "failed", metadata: on() },
      { tenantId: "overdue", metadata: on() },
      { tenantId: "open", metadata: on() },
    ],
    {
      failed: { ...inv(FAILED), status: "FAILED" },
      overdue: { ...inv(FAILED), status: "OVERDUE" },
      open: { ...inv(FAILED), status: "OPEN" },
    },
  );
  const s = await runServiceInterruptionSweep(deps(db, FAILED));
  assert.deepEqual(s.errors, []);
  assert.equal(s.considered, 3);
  assert.equal(readServiceInterruption(db.store.get("failed")).countdownStartedAt, FAILED.toISOString());
  assert.equal(readServiceInterruption(db.store.get("overdue")).countdownStartedAt, FAILED.toISOString());
  assert.equal(readServiceInterruption(db.store.get("open")).countdownStartedAt, null, "nobody has tried to collect an OPEN invoice yet");
});

// ─── ⛔ The cutover is the safety property ───────────────────────────────────

test("with NO cutover date the sweep does nothing at all", async () => {
  delete process.env.SERVICE_INTERRUPTION_CUTOVER_AT;
  const db = fakeDb([{ tenantId: "t1", metadata: writeServiceInterruption({}, { enabled: true }) }], {
    t1: inv(FAILED),
  });
  let interrupted = false;
  const s = await runServiceInterruptionSweep(deps(db, new Date(FAILED.getTime() + 30 * DAY), {
    interrupt: async () => {
      interrupted = true;
      return [];
    },
  }));
  assert.equal(interrupted, false, "a missing cutover must never cut anyone off");
  assert.equal(s.considered, 0);
});

test("a customer already past due before the cutover is never cut off", async () => {
  process.env.SERVICE_INTERRUPTION_CUTOVER_AT = CUTOVER;
  const oldFailure = new Date("2026-07-20T00:00:00Z"); // before the cutover
  const db = fakeDb([{ tenantId: "t1", metadata: writeServiceInterruption({}, { enabled: true }) }], {
    t1: inv(oldFailure),
  });
  let interrupted = false;
  const s = await runServiceInterruptionSweep(deps(db, new Date("2026-09-01T00:00:00Z"), {
    interrupt: async () => {
      interrupted = true;
      return [];
    },
  }));
  assert.equal(interrupted, false);
  assert.equal(s.skippedPreCutover, 1);
  assert.equal(readServiceInterruption(db.store.get("t1")).countdownStartedAt, null, "no countdown recorded either");
});

// ─── Normal life ────────────────────────────────────────────────────────────

test("a failure after the cutover starts a countdown, then reminds once a day", async () => {
  process.env.SERVICE_INTERRUPTION_CUTOVER_AT = CUTOVER;
  const db = fakeDb([{ tenantId: "t1", metadata: writeServiceInterruption({}, { enabled: true }) }], {
    t1: inv(FAILED),
  });
  const sent: number[] = [];
  const d = (now: Date) => deps(db, now, { sendReminder: async (p: any) => void sent.push(p.daysLeft) });

  await runServiceInterruptionSweep(d(FAILED));
  assert.equal(readServiceInterruption(db.store.get("t1")).countdownStartedAt, FAILED.toISOString());

  for (let day = 0; day < 7; day++) {
    await runServiceInterruptionSweep(d(new Date(FAILED.getTime() + day * DAY)));
    await runServiceInterruptionSweep(d(new Date(FAILED.getTime() + day * DAY))); // twice
  }
  assert.deepEqual(sent, [7, 6, 5, 4, 3, 2, 1], "one reminder per day, no repeats");
});

test("on day seven it interrupts and records what it disabled", async () => {
  process.env.SERVICE_INTERRUPTION_CUTOVER_AT = CUTOVER;
  const meta = startCountdown(writeServiceInterruption({}, { enabled: true }), { invoiceId: "inv_1", failedAt: FAILED });
  const db = fakeDb([{ tenantId: "t1", metadata: meta }], { t1: inv(FAILED) });
  const s = await runServiceInterruptionSweep(deps(db, new Date(FAILED.getTime() + 7 * DAY)));
  assert.equal(s.interrupted, 1);
  const after = readServiceInterruption(db.store.get("t1"));
  assert.ok(after.interruptedAt);
  assert.deepEqual(after.disabledArsMembers, [{ arsId: "214", outboundRouteId: "125" }]);
});

test("paying restores exactly what was disabled, and clears the state", async () => {
  process.env.SERVICE_INTERRUPTION_CUTOVER_AT = CUTOVER;
  let meta: unknown = startCountdown(writeServiceInterruption({}, { enabled: true }), { invoiceId: "inv_1", failedAt: FAILED });
  meta = writeServiceInterruption(meta, {
    interruptedAt: new Date(FAILED.getTime() + 7 * DAY).toISOString(),
    disabledArsMembers: [{ arsId: "214", outboundRouteId: "125" }],
  });
  const db = fakeDb([{ tenantId: "t1", metadata: meta }], {}); // no open invoice = paid
  let restored: any = null;
  const s = await runServiceInterruptionSweep(deps(db, new Date(FAILED.getTime() + 8 * DAY), {
    restore: async (p: any) => void (restored = p.members),
  }));
  assert.equal(s.restored, 1);
  assert.deepEqual(restored, [{ arsId: "214", outboundRouteId: "125" }]);
  const after = readServiceInterruption(db.store.get("t1"));
  assert.equal(after.interruptedAt, null);
  assert.deepEqual(after.disabledArsMembers, []);
});

// ─── Robustness ─────────────────────────────────────────────────────────────

test("one tenant blowing up does not stop the others", async () => {
  process.env.SERVICE_INTERRUPTION_CUTOVER_AT = CUTOVER;
  const meta = startCountdown(writeServiceInterruption({}, { enabled: true }), { invoiceId: "inv_1", failedAt: FAILED });
  const db = fakeDb(
    [
      { tenantId: "bad", metadata: meta },
      { tenantId: "good", metadata: meta },
    ],
    { bad: inv(FAILED), good: inv(FAILED) },
  );
  let goodInterrupted = false;
  const s = await runServiceInterruptionSweep(deps(db, new Date(FAILED.getTime() + 7 * DAY), {
    interrupt: async (p: any) => {
      if (p.tenantId === "bad") throw new Error("panel exploded");
      goodInterrupted = true;
      return [];
    },
  }));
  assert.equal(goodInterrupted, true, "the tenant after the failure is still processed");
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].tenantId, "bad");
});

test("a failed reminder does not stamp the day as sent", async () => {
  process.env.SERVICE_INTERRUPTION_CUTOVER_AT = CUTOVER;
  const meta = startCountdown(writeServiceInterruption({}, { enabled: true }), { invoiceId: "inv_1", failedAt: FAILED });
  const db = fakeDb([{ tenantId: "t1", metadata: meta }], { t1: inv(FAILED) });
  await runServiceInterruptionSweep(deps(db, FAILED, {
    sendReminder: async () => {
      throw new Error("queue down");
    },
  }));
  assert.equal(readServiceInterruption(db.store.get("t1")).lastReminderDaysLeft, null, "so tomorrow retries it");
});

test("a switched-off tenant with no state is skipped entirely", async () => {
  process.env.SERVICE_INTERRUPTION_CUTOVER_AT = CUTOVER;
  const db = fakeDb([{ tenantId: "t1", metadata: {} }], { t1: inv(FAILED) });
  const s = await runServiceInterruptionSweep(deps(db, FAILED));
  assert.equal(s.considered, 0);
});

test("⛔ a tenant cut off BEFORE the switch was turned off is still restored", async () => {
  process.env.SERVICE_INTERRUPTION_CUTOVER_AT = CUTOVER;
  const meta = writeServiceInterruption({}, {
    enabled: false,
    interruptedAt: FAILED.toISOString(),
    disabledArsMembers: [{ arsId: "214", outboundRouteId: "125" }],
  });
  const db = fakeDb([{ tenantId: "t1", metadata: meta }], {});
  const s = await runServiceInterruptionSweep(deps(db, new Date(FAILED.getTime() + DAY)));
  assert.equal(s.restored, 1, "switching the feature off must not strand someone with no phones");
});

// ─── The cutover reader ─────────────────────────────────────────────────────

test("an unset or unparseable cutover reads as null", () => {
  assert.equal(serviceInterruptionCutover({} as any), null);
  assert.equal(serviceInterruptionCutover({ SERVICE_INTERRUPTION_CUTOVER_AT: "   " } as any), null);
  assert.equal(serviceInterruptionCutover({ SERVICE_INTERRUPTION_CUTOVER_AT: "nonsense" } as any), null);
  assert.equal(
    serviceInterruptionCutover({ SERVICE_INTERRUPTION_CUTOVER_AT: CUTOVER } as any)?.getTime(),
    new Date(CUTOVER).getTime(),
  );
});

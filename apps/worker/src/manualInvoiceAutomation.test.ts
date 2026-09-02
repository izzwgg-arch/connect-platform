import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBillingSchedule, buildUpcomingBillingSchedule } from "./billingSchedule";
import { manualInvoiceAutomationEnabled, paymentDayResendEnabled, runManualInvoiceAutomationCore, type ManualInvoiceAutomationDeps } from "./manualInvoiceAutomation";

// Yossis Wood Works shapes (the tenant this feature was built for): billing day
// 4, America/New_York, and — the regression case — a TRANSITION-month invoice
// whose period starts AFTER the payment instant (Sep 5 → Oct 4 with payment
// day the 4th, from the 5→4 billing-day move on 2026-09-02).
const TENANT = "tenant-yossis";
const T3_NOW = new Date("2026-09-02T15:00:00Z"); // inside [Sep 1, Sep 4) NY reminder window for day 4
const DUE_NOW = new Date("2026-09-04T15:00:00Z"); // the payment day itself
const CHARGE_AT = new Date("2026-09-04T04:00:00.000Z"); // Sep 4 midnight NY

function baseSetting(overrides?: Record<string, unknown>) {
  return {
    tenantId: TENANT,
    billingDayOfMonth: 4,
    autoBillingEnabled: false,
    metadata: { billingManualInvoiceAutomation: true },
    tenant: { id: TENANT, name: "Yossis Wood Works", pbxRemovedAt: null },
    ...(overrides || {}),
  };
}

function transitionInvoice(overrides?: Record<string, unknown>) {
  return {
    id: "inv-sep",
    tenantId: TENANT,
    invoiceNumber: "CC-202609-00002",
    status: "OPEN",
    totalCents: 20696,
    balanceDueCents: 20696,
    dueDate: new Date("2026-09-17T15:11:44Z"),
    periodStart: new Date("2026-09-05T04:00:00.000Z"),
    periodEnd: new Date("2026-10-04T03:59:59.999Z"),
    source: null,
    ...(overrides || {}),
  };
}

type Calls = {
  created: any[];
  finalizeEmails: any[];
  resends: Array<{ invoice: any; scheduledChargeAt: Date }>;
  eventLogs: any[];
  invoiceFindFirstWheres: any[];
};

function makeDeps(opts: {
  settings: any[];
  now: Date;
  paidCoverage?: any | null;
  solaBlock?: any | null;
  periodInvoice?: any | null;
  openBill?: any | null;
  resendResult?: { queued: boolean; reason?: string };
}): { deps: ManualInvoiceAutomationDeps; calls: Calls } {
  const calls: Calls = { created: [], finalizeEmails: [], resends: [], eventLogs: [], invoiceFindFirstWheres: [] };
  const deps: ManualInvoiceAutomationDeps = {
    now: opts.now,
    db: {
      tenantBillingSettings: { findMany: async () => opts.settings },
      billingEventLog: { create: async (a: any) => { calls.eventLogs.push(a.data); return a.data; } },
      billingInvoice: {
        findFirst: async (a: any) => { calls.invoiceFindFirstWheres.push(a.where); return opts.openBill ?? null; },
      },
    },
    buildBillingSchedule,
    buildUpcomingBillingSchedule,
    findPaidBillingPeriodCoverage: async () => opts.paidCoverage ?? null,
    checkActiveSolaScheduleBlock: async () => opts.solaBlock ?? null,
    findPeriodInvoice: async () => opts.periodInvoice ?? null,
    createInvoice: async (_setting, schedule) => {
      const inv = { id: "inv-new", tenantId: TENANT, invoiceNumber: "CC-NEW", status: "OPEN", totalCents: 20696, balanceDueCents: 20696, dueDate: new Date(), periodStart: schedule.periodStart, periodEnd: schedule.periodEnd };
      calls.created.push(inv);
      return inv;
    },
    queueInvoiceSentOnFinalize: async (invoice) => { calls.finalizeEmails.push(invoice); return { queued: true }; },
    queueInvoicePaymentDayResendOnce: async (invoice, scheduledChargeAt) => {
      calls.resends.push({ invoice, scheduledChargeAt });
      return opts.resendResult ?? { queued: true };
    },
  };
  return { deps, calls };
}

test("a tenant WITHOUT the opt-in flag is never touched — the sweep is opt-in, not every-autopay-off-tenant", async () => {
  const { deps, calls } = makeDeps({ settings: [baseSetting({ metadata: {} })], now: T3_NOW });
  const results = await runManualInvoiceAutomationCore(deps);
  assert.equal(results.length, 0);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.resends.length, 0);
});

test("a removed tenant is skipped even with the flag on", async () => {
  const { deps, calls } = makeDeps({
    settings: [baseSetting({ tenant: { id: TENANT, name: "gone", pbxRemovedAt: new Date() } })],
    now: T3_NOW,
  });
  const results = await runManualInvoiceAutomationCore(deps);
  assert.equal(results.length, 0);
  assert.equal(calls.created.length, 0);
});

test("T-3: no invoice for the upcoming period -> one is created and logged (email rides the finalize hook)", async () => {
  const { deps, calls } = makeDeps({ settings: [baseSetting()], now: T3_NOW });
  const results = await runManualInvoiceAutomationCore(deps);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].periodStart.toISOString(), CHARGE_AT.toISOString());
  assert.ok(calls.eventLogs.some((e) => e.type === "manual_invoice_created"));
  assert.ok(results.some((r) => r.phase === "manual_t3" && r.created === true));
});

test("T-3: an existing OPEN invoice is NOT re-created; its email is re-attempted through the self-deduping finalize hook", async () => {
  const { deps, calls } = makeDeps({ settings: [baseSetting()], now: T3_NOW, periodInvoice: transitionInvoice() });
  await runManualInvoiceAutomationCore(deps);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.finalizeEmails.length, 1);
  assert.equal(calls.finalizeEmails[0].id, "inv-sep");
});

test("T-3: a paid-covered period creates nothing (the skip-a-cycle guard is honored)", async () => {
  const { deps, calls } = makeDeps({ settings: [baseSetting()], now: T3_NOW, paidCoverage: { invoiceId: "inv-paid" } });
  const results = await runManualInvoiceAutomationCore(deps);
  assert.equal(calls.created.length, 0);
  assert.ok(results.some((r) => r.skipped === "period_already_paid"));
});

const RESEND_META = { billingManualInvoiceAutomation: true, billingManualInvoicePaymentDayResend: true };

test("payment day: WITHOUT the resend flag nothing is re-sent — Izzy withdrew the day-of resend for Yossis", async () => {
  const { deps, calls } = makeDeps({ settings: [baseSetting()], now: DUE_NOW, openBill: transitionInvoice() });
  const results = await runManualInvoiceAutomationCore(deps);
  assert.equal(calls.resends.length, 0);
  assert.equal(results.filter((r) => r.phase === "manual_payment_day").length, 0);
});

test("payment day: the TRANSITION invoice (period starts AFTER the payment instant) is still found and re-sent", async () => {
  const { deps, calls } = makeDeps({ settings: [baseSetting({ metadata: RESEND_META })], now: DUE_NOW, openBill: transitionInvoice() });
  const results = await runManualInvoiceAutomationCore(deps);
  assert.equal(calls.resends.length, 1);
  assert.equal(calls.resends[0].invoice.id, "inv-sep");
  assert.equal(calls.resends[0].scheduledChargeAt.toISOString(), CHARGE_AT.toISOString());
  assert.ok(calls.eventLogs.some((e) => e.type === "manual_invoice_payment_day_resent"));
  assert.ok(results.some((r) => r.phase === "manual_payment_day" && r.resendQueued === true));

  // The lookup must be periodEnd >= scheduledChargeAt — NEVER the containment
  // shape (periodStart <= chargeAt), which misses a transition month and finds
  // the previous PAID invoice instead.
  const where = calls.invoiceFindFirstWheres[0];
  const periodClause = (where.AND as any[]).find((c) => c.periodEnd);
  assert.equal(periodClause.periodEnd.gte.toISOString(), CHARGE_AT.toISOString());
  assert.equal(JSON.stringify(where).includes("periodStart"), false);
});

test("payment day: a deduped resend (already sent today) does not write the resent event log", async () => {
  const { deps, calls } = makeDeps({
    settings: [baseSetting({ metadata: RESEND_META })],
    now: DUE_NOW,
    openBill: transitionInvoice(),
    resendResult: { queued: false, reason: "already_resent_today" },
  });
  const results = await runManualInvoiceAutomationCore(deps);
  assert.equal(calls.resends.length, 1);
  assert.equal(calls.eventLogs.filter((e) => e.type === "manual_invoice_payment_day_resent").length, 0);
  assert.ok(results.some((r) => r.resendReason === "already_resent_today"));
});

test("not in any window (mid-month): nothing happens at all", async () => {
  const { deps, calls } = makeDeps({ settings: [baseSetting({ metadata: RESEND_META })], now: new Date("2026-09-20T15:00:00Z"), openBill: transitionInvoice() });
  const results = await runManualInvoiceAutomationCore(deps);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.resends.length, 0);
  assert.equal(results.length, 0);
});

test("resend flag reader accepts only the literal true", () => {
  assert.equal(paymentDayResendEnabled({ billingManualInvoicePaymentDayResend: true }), true);
  assert.equal(paymentDayResendEnabled({ billingManualInvoiceAutomation: true }), false);
  assert.equal(paymentDayResendEnabled({}), false);
});

test("flag reader accepts only the literal true", () => {
  assert.equal(manualInvoiceAutomationEnabled({ billingManualInvoiceAutomation: true }), true);
  assert.equal(manualInvoiceAutomationEnabled({ billingManualInvoiceAutomation: "true" }), false);
  assert.equal(manualInvoiceAutomationEnabled({}), false);
  assert.equal(manualInvoiceAutomationEnabled(null), false);
  assert.equal(manualInvoiceAutomationEnabled([]), false);
});

// ── Source guards ────────────────────────────────────────────────────────────

function readSource(rel: string): string {
  return readFileSync(join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
}

test("source guard: the manual automation can NEVER charge — no charge call, no payment method, no transaction", () => {
  const src = readSource("manualInvoiceAutomation.ts");
  // Strip comments so the doc block explaining the rule cannot trip the guard.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const banned of ["chargeBillingInvoice", "chargeWorkerInvoice", "paymentMethod", "PaymentTransaction", "chargeToken"]) {
    assert.equal(code.includes(banned), false, `manualInvoiceAutomation.ts must not reference ${banned}`);
  }
});

test("source guard: worker-created invoices carry dueDate = the payment date (Izzy: the due date IS the day of payment)", () => {
  const src = readSource("main.ts");
  const nl = String.fromCharCode(10);
  const fn = src.slice(src.indexOf("async function createWorkerBillingInvoice"));
  const body = fn.slice(0, fn.indexOf(nl + "}"));
  const code = body.split(nl).filter((l) => !l.trim().startsWith("//")).join(nl);
  assert.ok(code.includes("dueDate: schedule.scheduledChargeAt"), "createWorkerBillingInvoice must pin dueDate to the payment date");
});

test("source guard: main.ts wires the manual sweep with its own interval AND a boot run (a bare interval is starved by deploy churn)", () => {
  const src = readSource("main.ts");
  assert.ok(src.includes("runManualInvoiceAutomationCore"), "main.ts must call the core");
  const bootRuns = src.match(/runManualInvoiceAutomation\(\)\.catch/g) || [];
  assert.ok(bootRuns.length >= 2, "expected both a setInterval call and a boot call");
  assert.ok(src.includes("queueInvoicePaymentDayResendOnce,"), "main.ts must import the payment-day resend");
});

test("source guard: the api resend dedupes on EmailJob createdAt >= the payment instant, and the finalize path keeps its own dedupe", () => {
  const src = readFileSync(join(__dirname, "../../api/src/billing/billingEmailLifecycle.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(src.includes("export async function queueInvoicePaymentDayResendOnce"), "resend function must exist");
  assert.ok(src.includes("createdAt: { gte: scheduledChargeAt }"), "resend dedupe must be time-bounded to the payment day");
  assert.ok(/queueInvoiceSentOnFinalize[\s\S]{0,600}hasBillingEmailJob/.test(src), "finalize path must keep its once-per-invoice dedupe");
});

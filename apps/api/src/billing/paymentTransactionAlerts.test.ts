import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_PAYMENT_ALERT_LOOKBACK_MS,
  PAYMENT_ALERT_EMAIL_TYPE,
  UNSETTLED_TRANSACTION_STATUS,
  buildPaymentAlertEmail,
  decidePaymentAlert,
  formatEastern,
  formatUsd,
  isPayLinkAllocationRow,
  paymentAlertHeadline,
  paymentAlertMethodLine,
  runPaymentTransactionAlertSweep,
} from "./paymentTransactionAlerts";

const REPO = resolve(__dirname, "..", "..", "..", "..");
/** ⛔ Windows checks .ts out as CRLF (core.autocrlf=true) — a multi-line literal match finds nothing otherwise. */
const readSource = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
/** Negative source guards must not match the comment that explains the rule. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-08-24T12:00:00Z");
const CUTOVER = new Date("2026-08-23T21:00:00Z");
const OPTS = { now: NOW, cutoverAt: CUTOVER, lookbackMs: DEFAULT_PAYMENT_ALERT_LOOKBACK_MS };

function tx(over: Record<string, any> = {}) {
  return {
    id: "tx_1",
    tenantId: "tenant_1",
    status: "APPROVED",
    amountCents: 15500,
    currency: "USD",
    createdAt: new Date("2026-08-24T11:00:00Z"),
    alertEmailedStatus: null,
    rawResponseSafeJson: null,
    ...over,
  };
}

// ── The decision ─────────────────────────────────────────────────────────────

test("a settled approved transaction is alerted", () => {
  assert.deepEqual(decidePaymentAlert(tx(), OPTS), { send: true, reason: "send" });
});

test("a declined transaction is alerted — the half Izzy asked for by name", () => {
  assert.equal(decidePaymentAlert(tx({ status: "DECLINED" }), OPTS).send, true);
});

test("a gateway ERROR is alerted too: it is a failed charge nobody would otherwise hear about", () => {
  assert.equal(decidePaymentAlert(tx({ status: "ERROR" }), OPTS).send, true);
});

test("a PENDING transaction is never alerted — it has not settled", () => {
  assert.deepEqual(decidePaymentAlert(tx({ status: "PENDING" }), OPTS), { send: false, reason: "not_settled" });
});

test("nothing before the cutover is ever emailed (no back-catalogue burst on deploy)", () => {
  const old = tx({ createdAt: new Date("2026-08-23T04:35:00Z") });
  assert.deepEqual(decidePaymentAlert(old, OPTS), { send: false, reason: "before_cutover" });
});

test("nothing older than the lookback window is emailed", () => {
  const stale = tx({ createdAt: new Date("2026-08-01T00:00:00Z") });
  const opts = { ...OPTS, cutoverAt: new Date("2026-07-01T00:00:00Z") };
  assert.deepEqual(decidePaymentAlert(stale, opts), { send: false, reason: "too_old" });
});

test("a transaction already alerted at this status is not alerted again", () => {
  assert.deepEqual(decidePaymentAlert(tx({ alertEmailedStatus: "APPROVED" }), OPTS), {
    send: false,
    reason: "already_emailed",
  });
});

test("an APPROVED payment later REFUNDED raises a second alert, not a swallowed duplicate", () => {
  const refunded = tx({ status: "REFUNDED", alertEmailedStatus: "APPROVED" });
  assert.equal(decidePaymentAlert(refunded, OPTS).send, true);
});

// ── The pay-link double-count trap ───────────────────────────────────────────

test("pay-link allocation rows are skipped — one card charge must not read as four payments", () => {
  const alloc = tx({ rawResponseSafeJson: { allocation: true, parentTransactionId: "tx_parent" } });
  assert.deepEqual(decidePaymentAlert(alloc, OPTS), { send: false, reason: "allocation_split" });
});

test("the parent row of a combined pay link IS alerted", () => {
  const parent = tx({ rawResponseSafeJson: { payLink: { code: "X7K2QF", allocations: [{}, {}, {}] } } });
  assert.equal(decidePaymentAlert(parent, OPTS).send, true);
});

test("isPayLinkAllocationRow tolerates junk", () => {
  for (const junk of [null, undefined, "", 0, [], { allocation: false }, { allocation: "true" }]) {
    assert.equal(isPayLinkAllocationRow(junk as any), false);
  }
  assert.equal(isPayLinkAllocationRow({ allocation: true }), true);
});

// ── Exhaustive over the real enum ────────────────────────────────────────────

const SCHEMA = readSource(resolve(REPO, "packages", "db", "prisma", "schema.prisma"));

function enumMembers(name: string): string[] {
  const m = SCHEMA.match(new RegExp(`enum ${name} \\{([^}]*)\\}`));
  assert.ok(m, `enum ${name} not found in schema.prisma`);
  return m![1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("///"));
}

test("EVERY settled status in the live enum is alerted — a new member can never vanish silently", () => {
  const members = enumMembers("BillingPaymentTransactionStatus");
  assert.ok(members.length >= 5, `expected the real enum, got ${JSON.stringify(members)}`);
  assert.ok(members.includes(UNSETTLED_TRANSACTION_STATUS), "PENDING must exist in the enum");
  for (const status of members) {
    const decision = decidePaymentAlert(tx({ status }), OPTS);
    if (status === UNSETTLED_TRANSACTION_STATUS) {
      assert.equal(decision.send, false, `${status} must not alert`);
    } else {
      assert.equal(decision.send, true, `${status} must alert — it is money settling`);
    }
  }
});

test("every settled status has real words, never a raw enum token", () => {
  for (const status of enumMembers("BillingPaymentTransactionStatus")) {
    if (status === UNSETTLED_TRANSACTION_STATUS) continue;
    const headline = paymentAlertHeadline(status);
    assert.ok(headline.startsWith("Payment "), `${status} -> ${headline}`);
    assert.ok(!/[A-Z]{3,}/.test(headline.replace("DECLINED", "")), `${status} leaks an enum token: ${headline}`);
  }
});

test("every external payment method in the live enum has a label", () => {
  for (const method of enumMembers("ExternalPaymentMethod")) {
    const line = paymentAlertMethodLine({ source: "MANUAL", externalMethod: method });
    assert.ok(!line.includes("External payment"), `${method} falls through to the generic label`);
    assert.ok(line.includes("posted by an operator"), line);
  }
});

// ── Wording ──────────────────────────────────────────────────────────────────

test("amounts render as dollars", () => {
  assert.equal(formatUsd(15500), "$155.00");
  assert.equal(formatUsd(4665), "$46.65");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(123456789), "$1,234,567.89");
});

test("the time is New York, named — the server is in France", () => {
  const rendered = formatEastern(new Date("2026-08-24T01:30:00Z"));
  assert.match(rendered, /EDT|EST/, rendered);
  // 01:30 UTC is the previous evening in New York; a bare UTC stamp would be a day out.
  assert.match(rendered, /Aug 23/, rendered);
});

test("method line names the card and how it was taken", () => {
  assert.equal(
    paymentAlertMethodLine({ paymentMethodId: "pm_1", paymentMethod: { brand: "Visa", last4: "4242" }, billingChargeOperation: { chargeType: "saved_card" } }),
    "Visa ending 4242 — saved card on file",
  );
  assert.match(
    paymentAlertMethodLine({ paymentMethodId: null, billingChargeOperation: { chargeType: "new_card" }, rawResponseSafeJson: { cardBrand: "Mastercard", cardLast4: "1111" } }),
    /Mastercard ending 1111 — entered at checkout/,
  );
  assert.match(
    paymentAlertMethodLine({ rawResponseSafeJson: { payLink: { code: "X7K2QF" }, cardLast4: "9999" } }),
    /combined pay link X7K2QF/,
  );
  assert.match(
    paymentAlertMethodLine({ source: "MANUAL", externalMethod: "CHECK", externalReference: "1042", payerName: "Trust Bookkeepings" }),
    /Check — posted by an operator · ref 1042 · from Trust Bookkeepings/,
  );
});

// ── The email ────────────────────────────────────────────────────────────────

function mail(over: Record<string, any> = {}) {
  return buildPaymentAlertEmail({
    status: "APPROVED",
    amountCents: 15500,
    tenantName: "Trust Bookkeepings",
    tenantId: "tenant_1",
    invoiceNumber: "CC-202608-00021",
    methodLine: "Visa ending 4242 — saved card on file",
    reason: null,
    processorRef: "998877",
    transactionId: "tx_1",
    occurredAt: new Date("2026-08-24T15:04:00Z"),
    customerBillingUrl: "https://app.loopcom.net/admin/billing/customer/tenant_1",
    ...over,
  });
}

test("the subject says what happened, how much, and who — readable on a phone", () => {
  assert.equal(mail().subject, "Payment approved — $155.00 — Trust Bookkeepings");
  assert.equal(
    mail({ status: "DECLINED", amountCents: 13000, tenantName: "Create A Box" }).subject,
    "Payment DECLINED — $130.00 — Create A Box",
  );
});

test("the decline reason is carried through", () => {
  const m = mail({ status: "DECLINED", reason: "Insufficient funds" });
  assert.ok(m.html.includes("Insufficient funds"));
  assert.ok(m.text.includes("Reason: Insufficient funds"));
});

test("every fact is in the plain-text half too", () => {
  const m = mail();
  for (const fact of ["$155.00", "Trust Bookkeepings", "CC-202608-00021", "Visa ending 4242", "998877", "tx_1"]) {
    assert.ok(m.text.includes(fact), `text is missing ${fact}`);
  }
});

test("a transaction with no invoice still produces a sane email", () => {
  const m = mail({ invoiceNumber: null });
  assert.ok(m.text.includes("No invoice on this transaction"));
});

test("a combined pay link says so instead of naming one invoice", () => {
  const m = mail({ invoiceCount: 3, invoiceNumber: null });
  assert.ok(m.text.includes("3 invoices (combined payment)"));
});

test("a missing company name never renders as blank or undefined", () => {
  for (const name of [null, "", "   "]) {
    const m = mail({ tenantName: name });
    assert.ok(m.subject.endsWith("Unknown company"), m.subject);
    assert.ok(!m.html.includes("undefined"));
  }
});

test("company names are escaped, not injected into the HTML", () => {
  const m = mail({ tenantName: '<script>alert("x")</script>' });
  assert.ok(!m.html.includes("<script>"), "raw script tag reached the HTML");
  assert.ok(m.html.includes("&lt;script&gt;"));
});

test("⛔ it carries NEITHER PDF-attachment marker — this alert must never pull an invoice or receipt PDF", () => {
  const m = mail();
  for (const marker of ["connect-billing-transaction:", "connect-billing-invoice:"]) {
    assert.ok(!m.html.includes(marker), `html carries ${marker}`);
    assert.ok(!m.text.includes(marker), `text carries ${marker}`);
  }
});

test("it rides the hardened billing shell (Outlook VML frame), not hand-rolled HTML", () => {
  const m = mail();
  assert.ok(m.html.includes("<!doctype html>"));
  assert.ok(m.html.includes("[if mso]"), "missing the Outlook fixed-width wrapper");
});

// ── The sweep ────────────────────────────────────────────────────────────────

function fakeDb(rows: any[], opts: { failEmail?: boolean } = {}) {
  const emails: any[] = [];
  const claims: any[] = [];
  return {
    emails,
    claims,
    rows,
    paymentTransaction: {
      findMany: async ({ where }: any) => {
        const gte = where?.createdAt?.gte?.getTime?.() ?? 0;
        return rows.filter((r) => r.createdAt.getTime() >= gte);
      },
      updateMany: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) return { count: 0 };
        const expected = where.alertEmailedStatus ?? null;
        if ((row.alertEmailedStatus ?? null) !== expected) return { count: 0 };
        row.alertEmailedStatus = data.alertEmailedStatus;
        row.alertEmailedAt = data.alertEmailedAt;
        claims.push({ id: where.id, to: data.alertEmailedStatus });
        return { count: 1 };
      },
    },
    emailJob: {
      create: async ({ data }: any) => {
        if (opts.failEmail) throw new Error("smtp table is gone");
        emails.push(data);
        return { id: `job_${emails.length}` };
      },
    },
  };
}

function sweepRow(over: Record<string, any> = {}) {
  return {
    ...tx(over),
    tenant: { id: "tenant_1", name: "Trust Bookkeepings" },
    invoice: { invoiceNumber: "CC-202608-00021" },
    paymentMethod: { brand: "Visa", last4: "4242" },
    billingChargeOperation: { chargeType: "saved_card" },
    responseMessage: null,
    processorTransactionId: "998877",
    paymentDate: null,
    ...over,
  };
}

test("the sweep queues exactly one alert per settled transaction", async () => {
  const d = fakeDb([sweepRow(), sweepRow({ id: "tx_2", status: "DECLINED" })]);
  const res = await runPaymentTransactionAlertSweep(d as any, undefined, NOW);
  assert.equal(res.emailed, 2);
  assert.equal(d.emails.length, 2);
  assert.equal(d.emails[0].type, PAYMENT_ALERT_EMAIL_TYPE);
  assert.equal(d.emails[0].toEmail, "izzy@loopcom.net");
});

test("running the sweep twice does not send the same alert twice", async () => {
  const d = fakeDb([sweepRow()]);
  await runPaymentTransactionAlertSweep(d as any, undefined, NOW);
  const second = await runPaymentTransactionAlertSweep(d as any, undefined, NOW);
  assert.equal(second.emailed, 0);
  assert.equal(d.emails.length, 1);
  assert.equal(second.skipped.already_emailed, 1);
});

test("the claim is taken BEFORE the email, so a racing second api process cannot double-send", async () => {
  const rows = [sweepRow()];
  const d = fakeDb(rows);
  // A second process claims the row between the read and the write.
  const original = d.paymentTransaction.updateMany;
  let first = true;
  (d.paymentTransaction as any).updateMany = async (args: any) => {
    if (first) {
      first = false;
      (rows[0] as any).alertEmailedStatus = "APPROVED"; // the other process got there first
    }
    return original(args);
  };
  const res = await runPaymentTransactionAlertSweep(d as any, undefined, NOW);
  assert.equal(res.emailed, 0, "we sent an alert the other process had already claimed");
  assert.equal(d.emails.length, 0);
});

test("a failed email RELEASES the claim so the next sweep retries — silence is the failure here", async () => {
  const rows = [sweepRow()];
  const d = fakeDb(rows, { failEmail: true });
  const res = await runPaymentTransactionAlertSweep(d as any, undefined, NOW);
  assert.equal(res.emailed, 0);
  assert.equal(res.errors.length, 1);
  assert.equal(rows[0].alertEmailedStatus, null, "the claim was left spent — the alert is lost forever");

  const healthy = fakeDb(rows);
  const retry = await runPaymentTransactionAlertSweep(healthy as any, undefined, NOW);
  assert.equal(retry.emailed, 1);
});

test("the sweep never emails the back catalogue", async () => {
  const d = fakeDb([
    sweepRow({ id: "old_1", createdAt: new Date("2026-08-23T04:35:00Z") }),
    sweepRow({ id: "old_2", createdAt: new Date("2026-05-27T10:00:00Z") }),
  ]);
  const res = await runPaymentTransactionAlertSweep(d as any, undefined, NOW);
  assert.equal(res.emailed, 0);
  assert.equal(d.emails.length, 0);
});

test("a database failure degrades quietly instead of throwing into the boot timer", async () => {
  const broken = {
    paymentTransaction: {
      findMany: async () => {
        throw new Error("connection refused");
      },
    },
  };
  const res = await runPaymentTransactionAlertSweep(broken as any, undefined, NOW);
  assert.equal(res.emailed, 0);
  assert.match(res.errors[0], /connection refused/);
});

test("a pay-link parent and its allocations produce ONE email, not four", async () => {
  const d = fakeDb([
    sweepRow({ id: "parent", invoice: null, rawResponseSafeJson: { payLink: { code: "X7K2QF", allocations: [{}, {}, {}] } } }),
    sweepRow({ id: "alloc_1", rawResponseSafeJson: { allocation: true } }),
    sweepRow({ id: "alloc_2", rawResponseSafeJson: { allocation: true } }),
    sweepRow({ id: "alloc_3", rawResponseSafeJson: { allocation: true } }),
  ]);
  const res = await runPaymentTransactionAlertSweep(d as any, undefined, NOW);
  assert.equal(res.emailed, 1);
  assert.equal(res.skipped.allocation_split, 3);
  assert.ok(d.emails[0].subject.includes("$155.00"));
});

// ── Source guards (the defect class here is a CALLER, not a function) ────────

test("server.ts actually arms the sweep — a module nobody starts is decoration", () => {
  const server = readSource(resolve(REPO, "apps", "api", "src", "server.ts"));
  assert.ok(server.includes('from "./billing/paymentTransactionAlerts"'), "server.ts does not import the module");
  assert.match(server, /startPaymentTransactionAlerts\(app\.log\)/, "server.ts never starts the sweep");
  assert.match(server, /if \(paymentAlertTimer\) registerShutdownTimer\(paymentAlertTimer\)/, "timer is not registered for shutdown");
});

test("⛔ the alert type is NOT ADMIN_ALERT — that category is muted at the send door", () => {
  assert.notEqual(PAYMENT_ALERT_EMAIL_TYPE, "ADMIN_ALERT");
  const src = stripComments(readSource(resolve(__dirname, "paymentTransactionAlerts.ts")));
  assert.ok(!src.includes("ADMIN_ALERT"), "the module references ADMIN_ALERT in executable code");
});

test("⛔ the sweep is not wired into any charge path — it must never be able to fail a payment", () => {
  for (const file of ["solaBillingPayments.ts", "payLinkRoutes.ts", "externalPayment.ts", "publicPayRoutes.ts"]) {
    const src = readSource(resolve(__dirname, file));
    assert.ok(
      !src.includes("paymentTransactionAlerts"),
      `${file} calls the alert module inside a charge path — a fault there would break a real payment`,
    );
  }
});

test("the boot kick exists beside the interval — a bare setInterval is starved by deploy churn", () => {
  const src = readSource(resolve(__dirname, "paymentTransactionAlerts.ts"));
  assert.match(src, /setTimeout\(/, "no boot kick");
  assert.match(src, /setInterval\(/, "no recurring sweep");
  assert.ok(src.indexOf("setTimeout(") < src.indexOf("setInterval("), "boot kick must be the first run");
});

test("EmailJob.invoiceId is always null — that FK points at the LEGACY Invoice table", () => {
  const src = readSource(resolve(__dirname, "paymentTransactionAlerts.ts"));
  assert.match(src, /invoiceId: null/, "the alert job must not carry a BillingInvoice id");
});

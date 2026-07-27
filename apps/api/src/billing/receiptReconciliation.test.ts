/**
 * Tests for receiptReconciliation.ts — the sweep that guarantees every
 * approved payment eventually gets a receipt email.
 *
 * ESM module-mock rule: mock.module() once per module per test file.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, any>;

const state: {
  tenants: Map<string, Row>;
  invoices: Map<string, Row>;
  transactions: Row[];
  emailJobs: Row[];
  events: Row[];
  users: Row[];
} = {
  tenants: new Map(),
  invoices: new Map(),
  transactions: [],
  emailJobs: [],
  events: [],
  users: [],
};

function resetState() {
  state.tenants = new Map();
  state.invoices = new Map();
  state.transactions = [];
  state.emailJobs = [];
  state.events = [];
  state.users = [];
}

const HOUR = 3600_000;

const db = {
  tenant: {
    findUnique: async ({ where }: { where: Row }) => state.tenants.get(where.id) || null,
  },
  billingInvoice: {
    findUnique: async ({ where }: { where: Row }) => state.invoices.get(where.id) || null,
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const invoice = state.invoices.get(where.id);
      if (invoice) Object.assign(invoice, data);
      return invoice;
    },
  },
  user: {
    findMany: async ({ where }: { where: Row }) => state.users.filter((u) =>
      u.tenantId === where.tenantId
      && (!where.status || u.status === where.status)
      && (!where.role?.in || where.role.in.includes(u.role)),
    ),
  },
  paymentTransaction: {
    findMany: async ({ where, take }: { where: Row; take?: number }) => state.transactions
      .filter((tx) =>
        tx.status === where.status
        && (where.invoiceId?.not === undefined || tx.invoiceId !== where.invoiceId.not)
        && (where.amountCents?.gt === undefined || tx.amountCents > where.amountCents.gt)
        && (!where.createdAt?.gte || tx.createdAt >= where.createdAt.gte)
        && (!where.createdAt?.lte || tx.createdAt <= where.createdAt.lte),
      )
      .map((tx) => ({
        ...tx,
        invoice: tx.invoiceId ? state.invoices.get(tx.invoiceId) || null : null,
        paymentMethod: tx.paymentMethod || null,
      }))
      .slice(0, take ?? 500),
  },
  emailJob: {
    findFirst: async ({ where }: { where: Row }) => state.emailJobs.find((job) =>
      job.tenantId === where.tenantId
      && job.type === where.type
      && (!where.status?.in || where.status.in.includes(job.status))
      && (!where.htmlBody?.contains || String(job.htmlBody || "").includes(where.htmlBody.contains)),
    ) || null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: `email_${state.emailJobs.length + 1}`, status: "QUEUED", createdAt: new Date(), ...data };
      state.emailJobs.push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const job = state.emailJobs.find((j) => j.id === where.id);
      if (job) Object.assign(job, data);
      return job;
    },
  },
  billingEventLog: {
    findFirst: async ({ where }: { where: Row }) => state.events.find((event) =>
      event.type === where.type
      && (!where.message || event.message === where.message)
      && (!where.tenantId || event.tenantId === where.tenantId)
      && (!where.createdAt?.gte || (event.createdAt && event.createdAt >= where.createdAt.gte))
      && (!where.metadata?.path || event.metadata?.[where.metadata.path[0]] === where.metadata.equals),
    ) || null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: `event_${state.events.length + 1}`, createdAt: new Date(), ...data };
      state.events.push(row);
      return row;
    },
  },
};

mock.module("@connect/db", { namedExports: { db } });

let reconciliation: any;
async function loadReconciliation() {
  reconciliation ||= await import("./receiptReconciliation");
  return reconciliation;
}

function seedTenant(tenantId: string, billingEmail: string | null) {
  state.tenants.set(tenantId, { name: "Tenant", billingSettings: { billingEmail } });
}

function seedInvoice(invoiceId: string, extra: Row = {}) {
  state.invoices.set(invoiceId, { id: invoiceId, invoiceNumber: `INV-${invoiceId}`, totalCents: 5000, metadata: {}, ...extra });
}

function seedTx(id: string, extra: Row = {}) {
  state.transactions.push({
    id,
    tenantId: "tenant_1",
    invoiceId: "invoice_1",
    amountCents: 5000,
    status: "APPROVED",
    source: null,
    createdAt: new Date(Date.now() - HOUR),
    ...extra,
  });
}

test("sweep queues a receipt for an approved payment that never got one", async () => {
  const { sweepMissingReceiptEmails } = await loadReconciliation();
  resetState();
  seedTenant("tenant_1", "billing@example.com");
  seedInvoice("invoice_1");
  seedTx("tx_missed");

  const summary = await sweepMissingReceiptEmails({ runner: "api" });

  assert.equal(summary.scanned, 1);
  assert.equal(summary.queued, 1);
  assert.equal(summary.escalated, 0);
  const receipt = state.emailJobs.find((j) => j.type === "BILLING_RECEIPT");
  assert.ok(receipt, "receipt email job queued");
  assert.match(String(receipt!.htmlBody), /connect-billing-transaction:tx_missed/);
  assert.equal(receipt!.toEmail, "billing@example.com");
  assert.ok(state.events.some((e) => e.type === "receipt_email_reconciled" && e.message === "tx_missed"));
  // Operator is told the primary path missed one.
  assert.equal(state.emailJobs.filter((j) => j.type === "ADMIN_ALERT").length, 1);
});

test("sweep leaves transactions with a SENT receipt alone", async () => {
  const { sweepMissingReceiptEmails } = await loadReconciliation();
  resetState();
  seedTenant("tenant_1", "billing@example.com");
  seedInvoice("invoice_1");
  seedTx("tx_ok");
  state.emailJobs.push({
    id: "email_sent",
    tenantId: "tenant_1",
    type: "BILLING_RECEIPT",
    status: "SENT",
    htmlBody: "<!-- connect-billing-transaction:tx_ok -->",
    createdAt: new Date(Date.now() - HOUR),
  });

  const summary = await sweepMissingReceiptEmails({ runner: "api" });

  assert.equal(summary.scanned, 1);
  assert.equal(summary.queued, 0);
  assert.equal(summary.revived, 0);
  assert.equal(summary.escalated, 0);
  assert.equal(state.emailJobs.length, 1);
});

test("sweep revives a receipt job that exhausted all retries", async () => {
  const { sweepMissingReceiptEmails } = await loadReconciliation();
  resetState();
  seedTenant("tenant_1", "billing@example.com");
  seedInvoice("invoice_1");
  seedTx("tx_failed");
  state.emailJobs.push({
    id: "email_failed",
    tenantId: "tenant_1",
    type: "BILLING_RECEIPT",
    status: "FAILED",
    attempts: 5,
    maxAttempts: 5,
    lastErrorCode: "SMTP_SEND_FAILED",
    htmlBody: "<!-- connect-billing-transaction:tx_failed -->",
    createdAt: new Date(Date.now() - HOUR),
  });

  const summary = await sweepMissingReceiptEmails({ runner: "worker" });

  assert.equal(summary.revived, 1);
  const job = state.emailJobs.find((j) => j.id === "email_failed")!;
  assert.equal(job.status, "QUEUED");
  assert.equal(job.attempts, 0);
  assert.ok(state.events.some((e) => e.type === "receipt_email_revived" && e.message === "tx_failed"));

  // Second sweep right away: job is QUEUED again — no double action.
  const again = await sweepMissingReceiptEmails({ runner: "worker" });
  assert.equal(again.revived, 0);
});

test("sweep does not revive a FAILED job that still has retries pending", async () => {
  const { sweepMissingReceiptEmails } = await loadReconciliation();
  resetState();
  seedTenant("tenant_1", "billing@example.com");
  seedInvoice("invoice_1");
  seedTx("tx_retrying");
  state.emailJobs.push({
    id: "email_retrying",
    tenantId: "tenant_1",
    type: "BILLING_RECEIPT",
    status: "FAILED",
    attempts: 2,
    maxAttempts: 5,
    htmlBody: "<!-- connect-billing-transaction:tx_retrying -->",
    createdAt: new Date(Date.now() - HOUR),
  });

  const summary = await sweepMissingReceiptEmails({ runner: "api" });

  assert.equal(summary.revived, 0);
  assert.equal(summary.queued, 0);
  assert.equal(state.emailJobs.find((j) => j.id === "email_retrying")!.status, "FAILED");
});

test("sweep skips MANUAL payments unless a receipt was intended", async () => {
  const { sweepMissingReceiptEmails } = await loadReconciliation();
  resetState();
  seedTenant("tenant_1", "billing@example.com");
  seedInvoice("invoice_1");
  seedInvoice("invoice_2");
  // Operator opted out — no receipt events exist for this tx.
  seedTx("tx_manual_optout", { source: "MANUAL", invoiceId: "invoice_1" });
  // Receipt was intended but skipped at posting time (no billing email back then).
  seedTx("tx_manual_intended", { source: "MANUAL", invoiceId: "invoice_2" });
  state.events.push({
    id: "event_skip",
    type: "receipt_email_skipped",
    tenantId: "tenant_1",
    message: "No billingEmail",
    metadata: { transactionId: "tx_manual_intended" },
    createdAt: new Date(Date.now() - HOUR),
  });

  const summary = await sweepMissingReceiptEmails({ runner: "api" });

  assert.equal(summary.queued, 1);
  const receipts = state.emailJobs.filter((j) => j.type === "BILLING_RECEIPT");
  assert.equal(receipts.length, 1);
  assert.match(String(receipts[0].htmlBody), /connect-billing-transaction:tx_manual_intended/);
});

test("sweep escalates once when no recipient is resolvable, then throttles retries", async () => {
  const { sweepMissingReceiptEmails } = await loadReconciliation();
  resetState();
  seedTenant("tenant_1", null);
  seedInvoice("invoice_1");
  seedTx("tx_unroutable");

  const first = await sweepMissingReceiptEmails({ runner: "api" });
  assert.equal(first.queued, 0);
  assert.equal(first.escalated, 1);
  assert.ok(state.events.some((e) => e.type === "receipt_email_escalated" && e.message === "tx_unroutable"));
  // Escalation alert + sweep summary alert.
  assert.equal(state.emailJobs.filter((j) => j.type === "ADMIN_ALERT").length, 2);

  // Immediate re-run: attempt throttled, nothing new.
  const second = await sweepMissingReceiptEmails({ runner: "worker" });
  assert.equal(second.queued, 0);
  assert.equal(second.escalated, 0);
  assert.equal(state.emailJobs.filter((j) => j.type === "ADMIN_ALERT").length, 2);
});

test("sweep self-heals a previously unroutable payment once a billing email exists", async () => {
  const { sweepMissingReceiptEmails } = await loadReconciliation();
  resetState();
  seedTenant("tenant_1", null);
  seedInvoice("invoice_1");
  seedTx("tx_healed");

  await sweepMissingReceiptEmails({ runner: "api" });
  assert.equal(state.emailJobs.filter((j) => j.type === "BILLING_RECEIPT").length, 0);

  // Operator sets a billing email; expire the attempt throttle.
  seedTenant("tenant_1", "fixed@example.com");
  for (const e of state.events) {
    if (e.type === "receipt_email_reconcile_attempted") e.createdAt = new Date(Date.now() - 10 * HOUR);
  }

  const summary = await sweepMissingReceiptEmails({ runner: "api" });
  assert.equal(summary.queued, 1);
  const receipt = state.emailJobs.find((j) => j.type === "BILLING_RECEIPT")!;
  assert.equal(receipt.toEmail, "fixed@example.com");
});

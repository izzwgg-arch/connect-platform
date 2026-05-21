import test, { mock } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, any>;

const state: {
  tenants: Map<string, Row>;
  invoices: Map<string, Row>;
  emailJobs: Row[];
  events: Row[];
} = {
  tenants: new Map(),
  invoices: new Map(),
  emailJobs: [],
  events: [],
};

function resetState() {
  state.tenants = new Map();
  state.invoices = new Map();
  state.emailJobs = [];
  state.events = [];
}

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
  emailJob: {
    findFirst: async ({ where }: { where: Row }) => state.emailJobs.find((job) =>
      job.tenantId === where.tenantId
      && job.type === where.type
      && where.status?.in?.includes(job.status)
      && (!where.htmlBody?.contains || String(job.htmlBody || "").includes(where.htmlBody.contains)),
    ) || null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: `email_${state.emailJobs.length + 1}`, status: "QUEUED", ...data };
      state.emailJobs.push(row);
      return row;
    },
  },
  billingEventLog: {
    findFirst: async ({ where }: { where: Row }) => state.events.find((event) =>
      event.type === where.type && (!where.message || event.message === where.message),
    ) || null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: `event_${state.events.length + 1}`, ...data };
      state.events.push(row);
      return row;
    },
  },
};

mock.module("@connect/db", { namedExports: { db } });

let lifecycle: any;
async function loadLifecycle() {
  lifecycle ||= await import("./billingEmailLifecycle");
  return lifecycle;
}

function seedTenant(tenantId: string, billingEmail: string | null) {
  state.tenants.set(tenantId, {
    name: "Tenant",
    billingSettings: { billingEmail },
  });
}

function seedInvoice(invoiceId: string, metadata: Row = {}) {
  state.invoices.set(invoiceId, {
    id: invoiceId,
    metadata,
  });
}

test("approved autopay receipt queues once per approved transaction", async () => {
  const { queueReceiptEmailOnce } = await loadLifecycle();
  resetState();
  seedTenant("tenant_1", "billing@example.com");
  seedInvoice("invoice_1");

  const first = await queueReceiptEmailOnce({
    tenantId: "tenant_1",
    invoiceId: "invoice_1",
    invoiceNumber: "CC-1",
    totalCents: 1000,
    transactionId: "tx_approved",
    paidViaAutopay: true,
  });
  const replay = await queueReceiptEmailOnce({
    tenantId: "tenant_1",
    invoiceId: "invoice_1",
    invoiceNumber: "CC-1",
    totalCents: 1000,
    transactionId: "tx_approved",
    paidViaAutopay: true,
  });

  assert.equal(first, true);
  assert.equal(replay, false);
  assert.equal(state.emailJobs.filter((job) => job.type === "BILLING_RECEIPT").length, 1);
  assert.equal(state.emailJobs[0].toEmail, "billing@example.com");
  assert.equal(state.events.filter((event) => event.type === "receipt_emailed").length, 1);
});

test("receipt email falls back to invoice/customer metadata when tenant billing email is missing", async () => {
  const { queueReceiptEmailOnce } = await loadLifecycle();
  resetState();
  seedTenant("tenant_1", null);
  seedInvoice("invoice_1", { customerBillingEmail: "customer-billing@example.com" });

  const queued = await queueReceiptEmailOnce({
    tenantId: "tenant_1",
    invoiceId: "invoice_1",
    invoiceNumber: "CC-2",
    totalCents: 2500,
    transactionId: "tx_customer_fallback",
  });

  assert.equal(queued, true);
  assert.equal(state.emailJobs[0].type, "BILLING_RECEIPT");
  assert.equal(state.emailJobs[0].toEmail, "customer-billing@example.com");
  assert.equal(state.events[0].metadata.recipientSource, "invoice_metadata");
});

test("declined payment email path does not create a paid receipt", async () => {
  const { queuePaymentFailedEmailOnce } = await loadLifecycle();
  resetState();
  seedTenant("tenant_1", "billing@example.com");
  seedInvoice("invoice_1");

  const queued = await queuePaymentFailedEmailOnce({
    tenantId: "tenant_1",
    invoiceId: "invoice_1",
    invoiceNumber: "CC-3",
    totalCents: 1000,
    transactionId: "tx_declined",
    reason: "Declined",
  });

  assert.equal(queued, true);
  assert.equal(state.emailJobs.length, 1);
  assert.equal(state.emailJobs[0].type, "BILLING_PAYMENT_FAILED");
  assert.equal(state.events.some((event) => event.type === "receipt_emailed"), false);
});

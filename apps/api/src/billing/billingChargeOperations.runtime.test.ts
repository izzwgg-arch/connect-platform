import test, { mock } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, any>;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const state: {
  operations: Row[];
  transactions: Row[];
  invoices: Row[];
  now: number;
} = {
  operations: [],
  transactions: [],
  invoices: [],
  now: 1,
};

function uniqueError(field: string) {
  const err: any = new Error("unique constraint failed");
  err.code = "P2002";
  err.meta = { target: [field] };
  return err;
}

function nextId(prefix: string) {
  return `${prefix}_${state.now++}`;
}

function resetState() {
  state.operations = [];
  state.transactions = [];
  state.invoices = [];
  state.now = 1;
  process.env.BILLING_LIVE_CHARGES_DISABLED = "0";
}

const db = {
  billingChargeOperation: {
    create: async ({ data }: { data: Row }) => {
      if (state.operations.some((op) => op.businessKey === data.businessKey)) throw uniqueError("businessKey");
      const row = { id: nextId("op"), createdAt: new Date(state.now), updatedAt: new Date(state.now), ...data };
      state.operations.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: Row }) =>
      state.operations.find((op) => (where.businessKey ? op.businessKey === where.businessKey : op.id === where.id)) || null,
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = state.operations.find((op) => op.id === where.id);
      if (!row) throw new Error("operation_not_found");
      Object.assign(row, data, { updatedAt: new Date(state.now++) });
      return row;
    },
  },
  paymentTransaction: {
    create: async ({ data }: { data: Row }) => {
      if (state.transactions.some((tx) => tx.idempotencyKey === data.idempotencyKey)) throw uniqueError("idempotencyKey");
      const row = { id: nextId("tx"), createdAt: new Date(state.now), updatedAt: new Date(state.now), ...data };
      state.transactions.push(row);
      return row;
    },
    findMany: async ({ where }: { where: Row }) =>
      state.transactions
        .filter((tx) =>
          tx.tenantId === where.tenantId
          && tx.invoiceId === where.invoiceId
          && (!where.idempotencyKey?.startsWith || String(tx.idempotencyKey || "").startsWith(where.idempotencyKey.startsWith)),
        )
        .sort((a, b) => Number(a.createdAt) - Number(b.createdAt)),
    findUnique: async ({ where }: { where: Row }) =>
      state.transactions.find((tx) => (where.id ? tx.id === where.id : tx.idempotencyKey === where.idempotencyKey)) || null,
    findFirst: async ({ where }: { where: Row }) =>
      state.transactions
        .filter((tx) => !where.billingChargeOperationId || tx.billingChargeOperationId === where.billingChargeOperationId)
        .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0] || null,
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = state.transactions.find((tx) => tx.id === where.id);
      if (!row) throw new Error("transaction_not_found");
      Object.assign(row, data, { updatedAt: new Date(state.now++) });
      return row;
    },
  },
  paymentMethod: {
    update: async () => ({}),
  },
  tenantBillingSettings: {
    findUnique: async () => null,
  },
  alert: {
    create: async () => ({}),
  },
  billingInvoice: {
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = state.invoices.find((invoice) => invoice.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    },
    findUnique: async ({ where }: { where: Row }) => state.invoices.find((invoice) => invoice.id === where.id) || null,
  },
};

mock.module("@connect/db", { namedExports: { db } });
mock.module("./solaGateway", {
  namedExports: {
    decryptPaymentToken: () => "saved-token",
    getBillingSolaAdapter: async () => {
      throw new Error("adapter_should_be_injected");
    },
    storeSolaPaymentMethod: async () => ({ id: "saved-method", brand: "Visa", last4: "4242" }),
  },
});
mock.module("./invoiceEngine", {
  namedExports: {
    logBillingEvent: async () => undefined,
    markBillingInvoicePaid: async (invoiceId: string, amountCents: number) => {
      const invoice = state.invoices.find((row) => row.id === invoiceId);
      if (invoice) {
        invoice.status = "PAID";
        invoice.amountPaidCents = amountCents;
        invoice.balanceDueCents = 0;
      }
    },
  },
});
mock.module("./billingEmailLifecycle", {
  namedExports: {
    queuePaymentFailedEmailOnce: async () => undefined,
    queueReceiptEmailOnce: async () => undefined,
  },
});

let payments: any;
let operations: any;

async function loadBillingModules() {
  payments ||= await import("./solaBillingPayments");
  operations ||= await import("./billingChargeOperations");
  return { payments, operations };
}

function invoice(id = "inv_1") {
  const row = {
    id,
    tenantId: "tenant_1",
    invoiceNumber: `INV-${id}`,
    status: "OPEN",
    totalCents: 1000,
    balanceDueCents: 1000,
  };
  state.invoices.push(row);
  return row;
}

function savedMethod() {
  return {
    id: "pm_1",
    tenantId: "tenant_1",
    processorCustomerId: "cust_1",
    tokenEncrypted: "encrypted",
  };
}

function approvedAdapter(delay?: Promise<unknown>) {
  let chargeCalls = 0;
  let saveCalls = 0;
  return {
    get chargeCalls() {
      return chargeCalls;
    },
    get saveCalls() {
      return saveCalls;
    },
    chargeToken: async (input: Row) => {
      chargeCalls++;
      await delay;
      return {
        approved: true,
        status: "APPROVED",
        xResult: "A",
        xStatus: "Approved",
        xRefNum: `ref_${chargeCalls}`,
        safePayload: { xRefNum: `ref_${chargeCalls}`, xInvoice: input.gatewayXInvoice, xCustom01: input.idempotencyKey },
      };
    },
    saveCardWithSut: async () => {
      saveCalls++;
      await delay;
      return { approved: true, xToken: "saved-token", xCardType: "Visa", xMaskedCardNumber: "xxxx4242", safePayload: {} };
    },
  };
}

test("parallel same invoice saved-card charge reserves one operation and calls gateway once", async () => {
  const { payments } = await loadBillingModules();
  resetState();
  const hold = createDeferred<void>();
  const adapter = approvedAdapter(hold.promise);
  const inv = invoice();
  const method = savedMethod();

  const first = payments.chargeBillingInvoice(inv, method, { adapter: adapter as any });
  const second = payments.chargeBillingInvoice(inv, method, { adapter: adapter as any }).catch((err: any) => err);
  await new Promise((resolve) => setImmediate(resolve));
  hold.resolve();
  const results = await Promise.all([first, second]);

  assert.equal(adapter.chargeCalls, 1);
  assert.equal(state.operations.length, 1);
  assert.equal(state.transactions.filter((tx) => tx.status === "APPROVED").length, 1);
  assert.equal(results[1].code, "CHARGE_IN_PROGRESS");
});

test("parallel same invoice SUT charges with different tokens use one customer operation", async () => {
  const { payments } = await loadBillingModules();
  resetState();
  const hold = createDeferred<void>();
  const adapter = approvedAdapter(hold.promise);
  const inv = invoice();

  const first = payments.chargeBillingInvoiceWithSut(inv, { xSut: "sut_one_123" }, { adapter: adapter as any });
  const second = payments.chargeBillingInvoiceWithSut(inv, { xSut: "sut_two_456" }, { adapter: adapter as any }).catch((err: any) => err);
  await new Promise((resolve) => setImmediate(resolve));
  hold.resolve();
  const results = await Promise.all([first, second]);

  assert.equal(adapter.saveCalls, 1);
  assert.equal(adapter.chargeCalls, 1);
  assert.equal(state.operations.length, 1);
  assert.equal(state.transactions.filter((tx) => tx.status === "APPROVED").length, 1);
  assert.equal(results[1].code, "CHARGE_IN_PROGRESS");
});

test("parallel one-time charge reservation creates one invoice and one gateway call", async () => {
  const { payments, operations } = await loadBillingModules();
  resetState();
  const hold = createDeferred<void>();
  const adapter = approvedAdapter(hold.promise);
  let invoiceCreates = 0;

  async function oneTimeSubmit() {
    const businessKey = operations.buildOneTimeChargeBusinessKey({
      tenantId: "tenant_1",
      customerKey: "tenant:tenant_1",
      amountCents: 1000,
      description: "Install fee",
      chargeMode: "card_on_file",
      paymentMethodId: "pm_1",
    });
    const reserved = await operations.reserveBillingChargeOperation({
      tenantId: "tenant_1",
      businessKey,
      operationType: "ONE_TIME_CHARGE",
      chargeType: "card_on_file",
      amountCents: 1000,
      paymentMethodId: "pm_1",
      customerKey: "tenant:tenant_1",
    });
    if (reserved.kind === "replay") return reserved.transaction;
    invoiceCreates++;
    const inv = invoice(`one_time_${invoiceCreates}`);
    await operations.attachBillingChargeOperationInvoice(reserved.operation.id, inv.id);
    return payments.chargeBillingInvoice(inv, savedMethod(), {
      adapter: adapter as any,
      serverOperationKey: businessKey,
      serverOperationId: reserved.operation.id,
    });
  }

  const first = oneTimeSubmit();
  const second = oneTimeSubmit().catch((err) => err);
  await new Promise((resolve) => setImmediate(resolve));
  hold.resolve();
  const results = await Promise.all([first, second]);

  assert.equal(invoiceCreates, 1);
  assert.equal(adapter.chargeCalls, 1);
  assert.equal(state.transactions.filter((tx) => tx.status === "APPROVED").length, 1);
  assert.equal(results[1].code, "CHARGE_IN_PROGRESS");
});

test("approved replay and declined retry behavior are explicit", async () => {
  const { payments } = await loadBillingModules();
  resetState();
  const adapter = approvedAdapter();
  const inv = invoice();
  const method = savedMethod();

  const approved = await payments.chargeBillingInvoice(inv, method, { adapter: adapter as any });
  const replay = await payments.chargeBillingInvoice({ ...inv, status: "OPEN", balanceDueCents: 1000 }, method, { adapter: adapter as any });
  assert.equal(replay.id, approved.id);
  assert.equal(adapter.chargeCalls, 1);

  resetState();
  const declineAdapter = {
    chargeCalls: 0,
    chargeToken: async (input: Row) => {
      declineAdapter.chargeCalls++;
      return {
        approved: false,
        status: "DECLINED",
        xResult: "D",
        xStatus: "Declined",
        xRefNum: `decline_${declineAdapter.chargeCalls}`,
        safePayload: { xInvoice: input.gatewayXInvoice, xCustom01: input.idempotencyKey },
      };
    },
  };
  const declinedInvoice = invoice("declined");
  const declined = await payments.chargeBillingInvoice(declinedInvoice, method, { adapter: declineAdapter as any });
  const accidentalReplay = await payments.chargeBillingInvoice({ ...declinedInvoice, status: "OPEN" }, method, { adapter: declineAdapter as any });
  assert.equal(accidentalReplay.id, declined.id);
  assert.equal(declineAdapter.chargeCalls, 1);

  await payments.chargeBillingInvoice({ ...declinedInvoice, status: "OPEN" }, method, { adapter: declineAdapter as any, allowRetry: true });
  assert.equal(declineAdapter.chargeCalls, 2);
});

test("worker/API saved-card overlap shares one server operation", async () => {
  const { payments } = await loadBillingModules();
  resetState();
  const hold = createDeferred<void>();
  const adapter = approvedAdapter(hold.promise);
  const inv = invoice();
  const method = savedMethod();

  const api = payments.chargeBillingInvoice(inv, method, { adapter: adapter as any });
  const worker = payments.chargeBillingInvoice(inv, method, { adapter: adapter as any, runId: "run_1" }).catch((err: any) => err);
  await new Promise((resolve) => setImmediate(resolve));
  hold.resolve();
  const results = await Promise.all([api, worker]);

  assert.equal(adapter.chargeCalls, 1);
  assert.equal(state.operations.length, 1);
  assert.equal(results[1].code, "CHARGE_IN_PROGRESS");
});

test("kill switch blocks before gateway charge or tokenization", async () => {
  const { payments } = await loadBillingModules();
  resetState();
  process.env.BILLING_LIVE_CHARGES_DISABLED = "1";
  const adapter = approvedAdapter();

  await assert.rejects(
    () => payments.chargeBillingInvoice(invoice(), savedMethod(), { adapter: adapter as any }),
    (err: any) => err.code === "BILLING_LIVE_CHARGES_DISABLED",
  );
  await assert.rejects(
    () => payments.chargeBillingInvoiceWithSut(invoice("sut_blocked"), { xSut: "sut" }, { adapter: adapter as any }),
    (err: any) => err.code === "BILLING_LIVE_CHARGES_DISABLED",
  );
  assert.equal(adapter.chargeCalls, 0);
  assert.equal(adapter.saveCalls, 0);
});

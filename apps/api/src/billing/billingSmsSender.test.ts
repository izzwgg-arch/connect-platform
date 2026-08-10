import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The bug this guards: the old resolver read the CUSTOMER's provider
 * credentials and the CUSTOMER's phone numbers, so every send failed with
 * `sms_provider_unavailable` — and on the tenants where it would have
 * succeeded, it would have texted a Connect bill from the customer's own
 * number. Both are wrong. Billing texts always come from Connect.
 */

const fakeConfig: { row: any } = { row: null };

mock.module("@connect/db", {
  namedExports: {
    db: {
      globalVoipMsConfig: {
        findUnique: async () => fakeConfig.row,
      },
    },
  },
});

const sentPayloads: Array<{ did: string; to: string; body: string }> = [];

mock.module("@connect/security", {
  namedExports: {
    decryptJson: (encoded: string) => JSON.parse(encoded),
  },
});

mock.module("@connect/integrations", {
  namedExports: {
    VoipMsSmsProvider: class {
      credentials: any;
      testMode: boolean;
      constructor(credentials: any, testMode: boolean) {
        this.credentials = credentials;
        this.testMode = testMode;
      }
      async sendMessage(input: { to: string; from: string; body: string }) {
        // Mirrors the real provider: the credential's fromNumber wins over the
        // per-message `from`.
        sentPayloads.push({ did: this.credentials.fromNumber || input.from, to: input.to, body: input.body });
        return { status: "SENT", providerMessageId: "fake-1" };
      }
    },
  },
});

let mod: any;
async function load() {
  mod ||= await import("./billingSmsSender");
  return mod as typeof import("./billingSmsSender");
}

function withGoodConfig() {
  fakeConfig.row = {
    id: "default",
    smsEnabled: true,
    apiBaseUrl: null,
    credentialsEncrypted: JSON.stringify({ username: "u", password: "p" }),
  };
}

test("normalizeUsPhone accepts the shapes an operator actually types", async () => {
  const { normalizeUsPhone } = await load();
  assert.equal(normalizeUsPhone("8455550123"), "+18455550123");
  assert.equal(normalizeUsPhone("(845) 555-0123"), "+18455550123");
  assert.equal(normalizeUsPhone("845-555-0123"), "+18455550123");
  assert.equal(normalizeUsPhone("18455550123"), "+18455550123");
  assert.equal(normalizeUsPhone("+18455550123"), "+18455550123");
  assert.equal(normalizeUsPhone(" 845 555 0123 "), "+18455550123");
});

test("normalizeUsPhone refuses what is not a phone number", async () => {
  const { normalizeUsPhone } = await load();
  assert.equal(normalizeUsPhone(""), null);
  assert.equal(normalizeUsPhone(null), null);
  assert.equal(normalizeUsPhone("555-0123"), null, "7 digits is not enough");
  assert.equal(normalizeUsPhone("abc"), null);
});

test("formatUsPhoneForHumans is what a person reads back", async () => {
  const { formatUsPhoneForHumans } = await load();
  assert.equal(formatUsPhoneForHumans("+18457231213"), "(845) 723-1213");
  assert.equal(formatUsPhoneForHumans("+443300000000"), "+443300000000");
});

test("the from-number is read at call time, not module load", async () => {
  const { CONNECT_BILLING_SMS_FROM_FALLBACK, resolveBillingSmsFromNumber } = await load();
  const prev = process.env.BILLING_SMS_FROM_NUMBER;
  try {
    process.env.BILLING_SMS_FROM_NUMBER = "8455550199";
    assert.equal(resolveBillingSmsFromNumber(), "+18455550199");
    process.env.BILLING_SMS_FROM_NUMBER = "";
    assert.equal(resolveBillingSmsFromNumber(), CONNECT_BILLING_SMS_FROM_FALLBACK);
  } finally {
    if (prev === undefined) delete process.env.BILLING_SMS_FROM_NUMBER;
    else process.env.BILLING_SMS_FROM_NUMBER = prev;
  }
});

test("with no setting at all it still sends from Connect's own number", async () => {
  const { resolveBillingSmsFromNumber } = await load();
  const prev = process.env.BILLING_SMS_FROM_NUMBER;
  try {
    delete process.env.BILLING_SMS_FROM_NUMBER;
    assert.equal(resolveBillingSmsFromNumber(), "+18457231213");
  } finally {
    if (prev !== undefined) process.env.BILLING_SMS_FROM_NUMBER = prev;
  }
});

test("every send goes out from Connect's number, whatever tenant it is for", async () => {
  const { resolveBillingSmsSender } = await load();
  withGoodConfig();
  sentPayloads.length = 0;
  const prevFrom = process.env.BILLING_SMS_FROM_NUMBER;
  const prevTest = process.env.SMS_PROVIDER_TEST_MODE;
  try {
    process.env.BILLING_SMS_FROM_NUMBER = "8457231213";
    process.env.SMS_PROVIDER_TEST_MODE = "false";

    const sender = await resolveBillingSmsSender();
    assert.equal(sender.ok, true);
    if (!sender.ok) return;
    assert.equal(sender.fromNumber, "+18457231213");

    await sender.send({ tenantId: "customer-a", to: "+18455550123", body: "Pay invoice A: https://x" });
    await sender.send({ tenantId: "customer-b", to: "+18455550124", body: "Pay invoice B: https://x" });

    assert.equal(sentPayloads.length, 2);
    for (const p of sentPayloads) {
      assert.equal(p.did, "+18457231213", "the sending number must not vary by customer");
    }
  } finally {
    if (prevFrom === undefined) delete process.env.BILLING_SMS_FROM_NUMBER;
    else process.env.BILLING_SMS_FROM_NUMBER = prevFrom;
    if (prevTest === undefined) delete process.env.SMS_PROVIDER_TEST_MODE;
    else process.env.SMS_PROVIDER_TEST_MODE = prevTest;
  }
});

test("a missing sending setting is not a reason to send test traffic for real", async () => {
  const { resolveBillingSmsSender } = await load();
  withGoodConfig();
  const prev = process.env.SMS_PROVIDER_TEST_MODE;
  try {
    delete process.env.SMS_PROVIDER_TEST_MODE;
    const sender = await resolveBillingSmsSender();
    assert.equal(sender.ok, true);
    if (!sender.ok) return;
    assert.equal(sender.testMode, true, "only an explicit 'false' may send real texts");
  } finally {
    if (prev !== undefined) process.env.SMS_PROVIDER_TEST_MODE = prev;
  }
});

test("no platform credentials is refused in plain English, never thrown", async () => {
  const { resolveBillingSmsSender } = await load();
  fakeConfig.row = null;
  const sender = await resolveBillingSmsSender();
  assert.equal(sender.ok, false);
  if (sender.ok) return;
  assert.equal(sender.error, "billing_sms_not_configured");
  assert.match(sender.message, /texting account is not set up/i);
});

test("texting switched off on Connect's own account is refused", async () => {
  const { resolveBillingSmsSender } = await load();
  fakeConfig.row = {
    id: "default",
    smsEnabled: false,
    credentialsEncrypted: JSON.stringify({ username: "u", password: "p" }),
  };
  const sender = await resolveBillingSmsSender();
  assert.equal(sender.ok, false);
  if (sender.ok) return;
  assert.equal(sender.error, "billing_sms_disabled");
});

test("unreadable credentials are refused, not treated as absent", async () => {
  const { resolveBillingSmsSender } = await load();
  fakeConfig.row = { id: "default", smsEnabled: true, credentialsEncrypted: "not-json" };
  const sender = await resolveBillingSmsSender();
  assert.equal(sender.ok, false);
  if (sender.ok) return;
  assert.equal(sender.error, "billing_sms_credentials_unreadable");
});

test("a long message is split rather than rejected by the carrier", async () => {
  const { resolveBillingSmsSender } = await load();
  withGoodConfig();
  sentPayloads.length = 0;
  const sender = await resolveBillingSmsSender();
  assert.equal(sender.ok, true);
  if (!sender.ok) return;
  await sender.send({ tenantId: "t", to: "+18455550123", body: "x".repeat(400) });
  assert.ok(sentPayloads.length >= 1);
  assert.equal(sentPayloads.map((p) => p.body).join("").length, 400);
});

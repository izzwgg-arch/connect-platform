import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyMetaSignature, verifyTwilioSignature } from "../src/whatsapp/signature";
import { normalizeMeta, normalizeTwilioStatus } from "../src/whatsapp/normalize";

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

function hmacSha256Hex(secret: string, body: string | Buffer): string {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return crypto.createHmac("sha256", secret).update(buf).digest("hex");
}

function hmacSha1Base64(secret: string, data: string): string {
  return crypto.createHmac("sha1", secret).update(data).digest("base64");
}

async function run() {
  let passed = 0;
  let failed = 0;
  const pass = (m: string) => { passed++; console.log(`OK  - ${m}`); };
  const fail = (m: string, e?: any) => { failed++; console.error(`FAIL - ${m}${e?.message ? ": " + e.message : ""}`); };

  // 1-2 Meta signature accept/reject
  try {
    const secret = "test_secret";
    const rawBody = JSON.stringify({ hello: "world" });
    const good = `sha256=${hmacSha256Hex(secret, rawBody)}`;
    assert(verifyMetaSignature(rawBody, secret, good) === true, "Meta signature should accept valid");
    pass("verifyMetaSignature accepts valid");
  } catch (e) { fail("verifyMetaSignature accepts valid", e); }

  try {
    const secret = "test_secret";
    const rawBody = JSON.stringify({ hello: "world" });
    const bad = `sha256=${hmacSha256Hex("wrong", rawBody)}`;
    assert(verifyMetaSignature(rawBody, secret, bad) === false, "Meta signature should reject invalid");
    pass("verifyMetaSignature rejects invalid");
  } catch (e) { fail("verifyMetaSignature rejects invalid", e); }

  // 3-4 Twilio signature accept/reject
  try {
    const authToken = "twilio_token";
    const fullUrl = "https://example.com/webhooks/whatsapp/twilio/status";
    const params: Record<string, string> = {
      AccountSid: "AC123",
      MessageSid: "SM456",
      Body: "hello",
      From: "whatsapp:+15551234567",
      To: "whatsapp:+15557654321",
    };
    const sorted = Object.keys(params).sort().map(k => k + String(params[k] ?? "")).join("");
    const sig = hmacSha1Base64(authToken, fullUrl + sorted);
    assert(verifyTwilioSignature(fullUrl, params, authToken, sig) === true, "Twilio signature should accept valid");
    pass("verifyTwilioSignature accepts valid");
  } catch (e) { fail("verifyTwilioSignature accepts valid", e); }

  try {
    const authToken = "twilio_token";
    const fullUrl = "https://example.com/webhooks/whatsapp/twilio/status";
    const params: Record<string, string> = { AccountSid: "AC123", MessageSid: "SM456" };
    const sig = hmacSha1Base64("wrong", fullUrl + Object.keys(params).sort().map(k => k + params[k]).join(""));
    assert(verifyTwilioSignature(fullUrl, params, authToken, sig) === false, "Twilio signature should reject invalid");
    pass("verifyTwilioSignature rejects invalid");
  } catch (e) { fail("verifyTwilioSignature rejects invalid", e); }

  // 5 Normalizers redact sensitive fields
  try {
    const tenantId = "t1";
    const phoneNumberId = "pnid";
    const metaBody = {
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: phoneNumberId, display_phone_number: "+123" },
        messages: [{ id: "m1", from: "+1", text: { body: "hi" }, access_token: "SECRET", token: "SECRET" }],
        statuses: [{ id: "m1", status: "delivered", errors: [], secret: "NOPE" }]
      }}]}]
    };
    const events = normalizeMeta(metaBody as any, tenantId, phoneNumberId);
    assert(events.length >= 2, "normalizeMeta should produce messages/statuses");
    for (const ev of events) {
      const red = (ev as any).providerPayloadRedacted || {};
      const keys = Object.keys(red).map(k => k.toLowerCase());
      assert(!keys.some(k => k.includes("token") || k.includes("secret")), "normalizeMeta redacts tokens/secrets");
    }
    pass("normalizeMeta redacts sensitive fields");
  } catch (e) { fail("normalizeMeta redacts sensitive fields", e); }

  try {
    const tenantId = "t1";
    const form: any = { AccountSid: "AC123", MessageSid: "SM1", Body: "ok", token: "SECRET" };
    const events = normalizeTwilioStatus(form, tenantId);
    for (const ev of events) {
      const red = (ev as any).providerPayloadRedacted || {};
      const keys = Object.keys(red).map(k => k.toLowerCase());
      assert(!keys.some(k => k.includes("token") || k.includes("secret")), "normalizeTwilioStatus redacts tokens/secrets");
    }
    pass("normalizeTwilioStatus redacts sensitive fields");
  } catch (e) { fail("normalizeTwilioStatus redacts sensitive fields", e); }

  // 6 Worker skeleton logging prints sanitized summary only (static scan of source)
  try {
    const root = path.resolve(__dirname, "../../..");
    const inboundSrc = fs.readFileSync(path.join(root, "apps/worker/src/whatsappInboundJob.ts"), "utf8");
    const statusSrc = fs.readFileSync(path.join(root, "apps/worker/src/whatsappStatusJob.ts"), "utf8");
    assert(/summary:\s*safe/.test(inboundSrc) && inboundSrc.includes('event: "WA_INBOUND_JOB"'), "inbound worker logs summary only");
    assert(/summary:\s*safe/.test(statusSrc) && statusSrc.includes('event: "WA_STATUS_JOB"'), "status worker logs summary only");
    // Ensure we do not stringify the full payload in logs
    assert(!/providerPayloadRedacted/.test(inboundSrc), "inbound worker does not log redacted payload object");
    assert(!/providerPayloadRedacted/.test(statusSrc), "status worker does not log redacted payload object");
    pass("workers log sanitized summary only");
  } catch (e) { fail("workers log sanitized summary only", e); }

  if (failed > 0) {
    console.error(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  } else {
    console.log(`\n${passed} passed, 0 failed`);
  }
}

run().catch((e) => {
  console.error("UNEXPECTED_ERROR", e);
  process.exit(1);
});

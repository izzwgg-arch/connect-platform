/**
 * Customer delivery-error copy — the no-carrier-names rule, proven.
 *
 * The corpus below includes REAL production strings (the Telnyx messaging-
 * profile refusal from the 2026-09-16 acceptance run, SignalWire code errors,
 * the VoIP.ms not-configured stamp). Whatever goes in, what comes out must
 * never contain a carrier name — and the projection in connectChatRoutes must
 * actually route non-super viewers through this door.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CUSTOMER_DELIVERY_PHRASES, sanitizeCustomerDeliveryError } from "./customerDeliveryCopy";

const CARRIER_WORDS = /telnyx|signalwire|voip\.?ms|twilio/i;

const REAL_CORPUS = [
  "Telnyx refused the message: The 'from' address should be string containing a valid number associated with the sending messaging profile.",
  "SIGNALWIRE_21610",
  "SignalWire refused the message: unsubscribed recipient",
  "VOIPMS_NOT_CONFIGURED",
  "TELNYX_NOT_CONFIGURED",
  "SIGNALWIRE_NOT_CONFIGURED",
  "MMS_NOT_AVAILABLE",
  "SMS_THREAD_INCOMPLETE",
  "TELNYX_40008",
  "Telnyx did not answer within 30 seconds — the message may or may not have gone out",
  "VoIP.ms rejected: destination is a landline",
  "some totally unknown future failure mentioning Telnyx mid-sentence",
];

test("no carrier name can ever survive into customer copy", () => {
  for (const raw of REAL_CORPUS) {
    const out = sanitizeCustomerDeliveryError(raw);
    assert.ok(out, `non-empty input maps to a phrase (${raw.slice(0, 40)})`);
    assert.ok(!CARRIER_WORDS.test(out!), `no carrier word in: "${out}" (from "${raw.slice(0, 40)}…")`);
  }
  for (const phrase of CUSTOMER_DELIVERY_PHRASES) {
    assert.ok(!CARRIER_WORDS.test(phrase), `fixed phrase is clean: "${phrase}"`);
  }
});

test("empty stays empty — no phantom errors", () => {
  assert.equal(sanitizeCustomerDeliveryError(null), null);
  assert.equal(sanitizeCustomerDeliveryError(""), null);
  assert.equal(sanitizeCustomerDeliveryError("   "), null);
});

test("the known codes keep their helpful phrasing", () => {
  assert.match(sanitizeCustomerDeliveryError("MMS_NOT_AVAILABLE")!, /Media/);
  assert.match(sanitizeCustomerDeliveryError("SMS_THREAD_INCOMPLETE")!, /missing a phone number/);
});

test("the messages projection routes non-super viewers through this door", () => {
  const src = readFileSync(join(__dirname, "..", "connectChatRoutes.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(src.includes("sanitizeCustomerDeliveryError"), "the sanitizer is imported/used");
  assert.ok(
    src.includes("isSuper(user) ? m.deliveryError : sanitizeCustomerDeliveryError(m.deliveryError)"),
    "raw deliveryError is platform-staff only",
  );
  assert.ok(src.includes("sentViaBackupRoute: Boolean("), "the backup-route BOOLEAN ships (never the carrier)");
  assert.ok(!src.includes("backupCarrier"), "the projection never mentions the backup carrier name");
});

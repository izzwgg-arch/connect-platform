/**
 * The regression these guard against, in one line: a key that ElevenLabs had
 * retired was reported to its owner as "couldn't reach ElevenLabs", so the
 * blame landed on Connect and the one action that would have fixed it — make
 * a new key — was never suggested.
 *
 * The bodies below are the real ones ElevenLabs returned on 2026-08-06,
 * verbatim (request ids trimmed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ELEVENLABS_KEY_PREFIX,
  ELEVENLABS_LEGACY_KEY_MESSAGE,
  classifyElevenLabsFailure,
  describeElevenLabsKey,
  isElevenLabsKeyFailure,
} from "./elevenLabsKeyFormat";

const LEGACY_PREFIX_BODY = JSON.stringify({
  detail: {
    type: "authentication_error",
    code: "invalid_api_key",
    message: "API key must start with 'sk_'.",
    status: "invalid_api_key_prefix",
  },
});

// ── the retired key format ───────────────────────────────────────────────────

test("a retired-format key is named as such, not lumped in with a bad key", () => {
  const msg = classifyElevenLabsFailure(LEGACY_PREFIX_BODY);
  assert.equal(msg, ELEVENLABS_LEGACY_KEY_MESSAGE);
});

test("the message says re-pasting will not help — otherwise that is exactly what happens", () => {
  assert.match(ELEVENLABS_LEGACY_KEY_MESSAGE, /will not help/i);
  assert.match(ELEVENLABS_LEGACY_KEY_MESSAGE, /sk_/);
  assert.match(ELEVENLABS_LEGACY_KEY_MESSAGE, /elevenlabs\.io/);
});

test("the message clears Connect, because the owner's first read is that we broke it", () => {
  assert.match(ELEVENLABS_LEGACY_KEY_MESSAGE, /nothing is wrong on Connect/i);
});

test("the specific prefix case wins over the generic invalid-key case", () => {
  // "invalid_api_key_prefix" contains "invalid_api_key" — order in the
  // classifier is what keeps the useful message from being swallowed.
  assert.notEqual(classifyElevenLabsFailure(LEGACY_PREFIX_BODY), classifyElevenLabsFailure(JSON.stringify({ detail: { status: "invalid_api_key" } })));
});

test("the prefix rule reads a plain-text body too", () => {
  assert.equal(classifyElevenLabsFailure("API key must start with 'sk_'."), ELEVENLABS_LEGACY_KEY_MESSAGE);
});

// ── the rest of the rules still hold ─────────────────────────────────────────

test("an unpaid invoice is still blamed on the invoice, not the key", () => {
  const msg = classifyElevenLabsFailure(JSON.stringify({ detail: { status: "payment_issue" } }));
  assert.match(msg!, /unpaid invoice/i);
  assert.match(msg!, /key is fine/i);
});

test("a genuinely invalid key is still called invalid", () => {
  assert.match(classifyElevenLabsFailure(JSON.stringify({ detail: { status: "invalid_api_key" } }))!, /rejected/i);
});

test("nothing recognised means nothing said, so the status code still decides", () => {
  assert.equal(classifyElevenLabsFailure(""), null);
  assert.equal(classifyElevenLabsFailure("<html>502 Bad Gateway</html>"), null);
});

test("a malformed body never throws", () => {
  assert.doesNotThrow(() => classifyElevenLabsFailure("{not json"));
  assert.equal(classifyElevenLabsFailure("{not json"), null);
});

// ── blaming the key vs blaming the connection ────────────────────────────────

test("a 400 from ElevenLabs is about the key — this is the bug that misled everyone", () => {
  assert.equal(isElevenLabsKeyFailure(400, LEGACY_PREFIX_BODY), true);
});

test("401 and 403 are about the key too", () => {
  assert.equal(isElevenLabsKeyFailure(401), true);
  assert.equal(isElevenLabsKeyFailure(403), true);
});

test("a provider 5xx is NOT the key — that one really is their end", () => {
  assert.equal(isElevenLabsKeyFailure(500), false);
  assert.equal(isElevenLabsKeyFailure(503), false);
});

// ── describing a key without revealing it ────────────────────────────────────

test("a current key is recognised by its prefix", () => {
  const s = describeElevenLabsKey(`${ELEVENLABS_KEY_PREFIX}abcdef0123456789`);
  assert.equal(s!.looksCurrent, true);
  assert.equal(s!.looksLegacy, false);
});

test("the retired 64-hex format is recognised on sight, before any network call", () => {
  const s = describeElevenLabsKey("bc4" + "a".repeat(57) + "ab4c");
  assert.equal(s!.looksCurrent, false);
  assert.equal(s!.looksLegacy, true);
});

test("describing a key exposes only its last four characters", () => {
  const key = `${ELEVENLABS_KEY_PREFIX}supersecretvalue9999`;
  const s = describeElevenLabsKey(key)!;
  assert.equal(s.last4, "9999");
  assert.equal(JSON.stringify(s).includes("supersecret"), false);
});

test("surrounding whitespace never changes the verdict — pasted keys carry it", () => {
  const s = describeElevenLabsKey(`  ${ELEVENLABS_KEY_PREFIX}abcdef0123456789\n`)!;
  assert.equal(s.looksCurrent, true);
});

test("no key described as nothing, rather than an empty-looking bad key", () => {
  assert.equal(describeElevenLabsKey(""), null);
  assert.equal(describeElevenLabsKey("   "), null);
  assert.equal(describeElevenLabsKey(null), null);
  assert.equal(describeElevenLabsKey(undefined), null);
});

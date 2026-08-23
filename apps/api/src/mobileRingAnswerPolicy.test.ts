/**
 * Guards for the answered_elsewhere self-cancel fix (Hanna's dropped answers,
 * 2026-08-21): an invite answered by ITS OWN APP must be marked ACCEPTED with
 * no cancel push, and the cancel write must be conditional so a claim that
 * lands mid-sweep is never clobbered. See
 * docs/ai-context/AGENT_HANDOFF_HANNA_FIRST_CALLS_2026-08-21.md §3.
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { endpointFromChannel, inviteFulfilledByOwnApp } from "./mobileRingAnswerPolicy";

test("endpointFromChannel: the real channel shapes", () => {
  assert.strictEqual(endpointFromChannel("PJSIP/T141_101_1-0000125e"), "T141_101_1");
  assert.strictEqual(endpointFromChannel("PJSIP/T8_114-00001265"), "T8_114");
  assert.strictEqual(endpointFromChannel("PJSIP/344022_Comfortcont-00001250"), null); // trunk
  assert.strictEqual(endpointFromChannel("Local/T141_101_1@connect-mobile-wake-dial-000007d3;2"), null);
  assert.strictEqual(endpointFromChannel(null), null);
  assert.strictEqual(endpointFromChannel(""), null);
});

test("THE HANNA CASE: her own app endpoint fulfils her invite", () => {
  assert.strictEqual(inviteFulfilledByOwnApp("T141_101_1", "101"), true);
});

test("a DESK phone answering must NOT fulfil — the original stop-the-apps feature stays", () => {
  // No device suffix = desk/base endpoint; the apps must still be cancel-pushed.
  assert.strictEqual(inviteFulfilledByOwnApp("T141_101", "101"), false);
});

test("a ring-group sibling's invite (other extension) is NOT fulfilled by this answer", () => {
  assert.strictEqual(inviteFulfilledByOwnApp("T141_101_1", "102"), false);
});

test("missing/unknown answering endpoint falls back to today's behaviour", () => {
  assert.strictEqual(inviteFulfilledByOwnApp(null, "101"), false);
  assert.strictEqual(inviteFulfilledByOwnApp(undefined, "101"), false);
  assert.strictEqual(inviteFulfilledByOwnApp("", "101"), false);
  assert.strictEqual(inviteFulfilledByOwnApp("garbage", "101"), false);
  assert.strictEqual(inviteFulfilledByOwnApp("T141_101_1", null), false);
});

test("a second app device suffix still fulfils (any _n suffix is the app AOR)", () => {
  assert.strictEqual(inviteFulfilledByOwnApp("T141_101_2", "101"), true);
});

// ── Source guards on the CALLER — the defect lived in server.ts's loop, and a
// unit test of the policy passes straight through a caller that ignores it. ──

const serverSrc = () => readFileSync(join(__dirname, "server.ts"), "utf8").replace(/\r\n/g, "\n");

test("SOURCE GUARD: the mobile-ring-notify loop consults inviteFulfilledByOwnApp", () => {
  const src = serverSrc();
  assert.ok(
    src.includes("inviteFulfilledByOwnApp(input.answeredEndpoint, inv.toExtension)"),
    "the cancel loop must check whether the invite's own app answered",
  );
  assert.ok(
    src.includes('answeredEndpoint: z.string().max(80).nullable().optional()'),
    "the schema must accept answeredEndpoint (optional, for old telephony builds)",
  );
});

test("SOURCE GUARD: the cancel write is CONDITIONAL on status PENDING — never a bare update by id", () => {
  const src = serverSrc();
  // The race that clobbered an ACCEPTED invite: findMany(PENDING) then an
  // unconditional update. The write must re-check status.
  assert.ok(
    /updateMany\(\{\s*\n\s*where: \{ id: inv\.id, status: "PENDING" \},\s*\n\s*data: \{ status: "CANCELED", canceledAt: new Date\(\) \},/.test(src),
    "the CANCELED write must be updateMany conditioned on status PENDING",
  );
  const noComments = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/callInvite\.update\(\{\s*\n\s*where: \{ id: inv\.id \},\s*\n\s*data: \{ status: "CANCELED"/.test(noComments),
    "the unconditional cancel update must not return",
  );
});

test("SOURCE GUARD: a claim that lands mid-sweep skips the push (count === 0 continue)", () => {
  const src = serverSrc();
  assert.ok(
    src.includes("if (cancelRes.count === 0) {"),
    "a 0-row cancel means the claim won — the push must be skipped",
  );
});

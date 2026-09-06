/**
 * Inbound SMS poll — one account-wide carrier fetch per cycle.
 *
 * Fixup Group, 2026-09-06 ("incoming messages take too long"): VoIP.ms answers
 * ~7–11 s per API call, and the cycle used to make getSMS + getMMS for EACH
 * of 16 numbers (32 calls, ~3–3.5 min per cycle, measured from the worker log:
 * cycle gaps p50 180 s). A text therefore sat unseen for up to a whole cycle.
 * Now: ONE getSMS + ONE getMMS per cycle, split per DID by the same merge the
 * per-number path always used; a failed or FULL page falls back to per-number.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACCOUNT_WIDE_SMS_LIMIT, mergeInboundRowsForDid } from "./voipMsInboundSyncJob";

const FIXUP = "+18458067040";
const OTHER = "+18452449666";

const sms = (over: Record<string, unknown>) => ({
  id: "1",
  date: "2026-09-06 12:00:00",
  type: "1",
  did: "8458067040",
  contact: "9737565563",
  message: "hi",
  ...over,
});

test("an account-wide batch is split per DID: a number only gets its own rows", () => {
  const smsRaw = [
    sms({ id: "101", contact: "9737565563", message: "for fixup" }),
    sms({ id: "202", did: "8452449666", contact: "8455551234", message: "for gesheft" }),
    sms({ id: "103", contact: "29283", message: "Your WhatsApp code: 123-456" }), // short code sender must survive
    sms({ id: "104", type: "0", contact: "9737565563", message: "outbound, never inbound" }),
  ];
  const fixupRows = mergeInboundRowsForDid(FIXUP, smsRaw, []);
  assert.deepEqual(fixupRows.map((r) => r.providerMessageId).sort(), ["voipms:101", "voipms:103"]);
  assert.ok(fixupRows.every((r) => r.to === FIXUP));
  const otherRows = mergeInboundRowsForDid(OTHER, smsRaw, []);
  assert.deepEqual(otherRows.map((r) => r.providerMessageId), ["voipms:202"]);
});

test("an MMS row for the same id merges its media into the SMS row, per DID", () => {
  const smsRaw = [sms({ id: "301", message: "photo" })];
  const mmsRaw = [
    { id: "301", date: "2026-09-06 12:00:00", type: "1", did: "8458067040", contact: "9737565563", message: "photo", col_media1: "https://voip.ms/media/x/media.jpeg" },
    { id: "302", date: "2026-09-06 12:00:00", type: "1", did: "8452449666", contact: "8455551234", message: "", col_media1: "https://voip.ms/media/y/media.jpeg" },
  ];
  const rows = mergeInboundRowsForDid(FIXUP, smsRaw, mmsRaw);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].mediaUrls, ["https://voip.ms/media/x/media.jpeg"]);
  const other = mergeInboundRowsForDid(OTHER, smsRaw, mmsRaw);
  assert.equal(other.length, 1);
  assert.equal(other[0].providerMessageId, "voipms:302");
});

test("the account-wide page size is large enough to never be full on a normal day", () => {
  // Measured 2026-09-06: 61 SMS rows account-wide over the 2-day window.
  assert.ok(ACCOUNT_WIDE_SMS_LIMIT >= 500);
});

// ── Source guard: the cycle fetches ONCE, and falls back ────────────────────
test("guard: the sync cycle fetches account-wide once and falls back to per-number", () => {
  const src = readFileSync(path.join(__dirname, "voipMsInboundSyncJob.ts"), "utf8").replace(/\r\n/g, "\n");
  const cycle = src.slice(src.indexOf("export async function runVoipMsInboundSyncCycle("));
  const loop = cycle.indexOf("for (const n of numbers) {");
  const fetchOnce = cycle.indexOf("await fetchAccountWideRecent(creds)");
  assert.ok(fetchOnce > 0 && fetchOnce < loop, "the account-wide fetch must happen BEFORE the per-number loop");
  assert.ok(/if \(b\.complete\) batch = b;/.test(cycle), "a full page must NOT be used as the batch");
  assert.ok(/batch\s*\?\s*mergeInboundRowsForDid\(n\.phoneE164, batch\.smsRaw, batch\.mmsRaw\)\s*:\s*await fetchRecentSmsForDid\(creds, n\.phoneE164\)/.test(cycle), "per-number fetch must remain the fallback");
  assert.ok(cycle.includes("mode=${mode} ms=${Date.now() - cycleStartedAt}"), "the cycle must log its mode and duration");
  // The account-wide getSMS must carry no did and the big limit.
  assert.ok(/opts\?\.accountWide[\s\S]*?url\.searchParams\.set\("limit", String\(ACCOUNT_WIDE_SMS_LIMIT\)\)/.test(src));
});

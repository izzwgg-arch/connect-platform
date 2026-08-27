/**
 * The audio-copy race: a just-arrived voicemail whose recording has not landed
 * yet must be ASKED AGAIN, never stamped `no_recording` forever.
 *
 * Found 2026-08-27 auditing a week of voicemail email. Three real voicemails —
 * one of them a customer speaking Yiddish to Trust Bookkeepings — were skipped
 * because the 60-second email sweep ticked inside the ~2-second window that the
 * fire-and-forget arrival audio copy takes. They were decided 0.2/0.3/0.7 s
 * after their row was created, where every other outcome averages ~30 s.
 *
 * These tests pin the three properties that make the fix safe, and the two
 * bounds that stop it becoming a worse bug than the one it fixes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  decideVoicemailEmail,
  AUDIO_ARRIVAL_GRACE_MS,
  MIN_VOICEMAIL_SECONDS_FOR_EMAIL,
} from "./voicemailEmail";
import { NEVER_PROCESSED_GRACE_MS } from "./voicemailEmailWatchdog";
import { processVoicemailForEmail } from "./voicemailEmailSender";
import { buildNoRecordingReopenWhere, REOPEN_BATCH } from "./voicemailEmailRuntime";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const base = {
  pbxUserEmail: "someone@example.com",
  durationSec: 14,
  vmEmailEnabled: true,
  emailedAt: null as Date | null,
};

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

// ── The decision ────────────────────────────────────────────────────────────

test("a voicemail that arrived seconds ago with no audio yet is RETRIED, not stamped", () => {
  const d = decideVoicemailEmail({ ...base, hasAudio: false, receivedAt: ago(700), now: NOW });
  assert.equal(d.send, false);
  assert.equal(d.send === false && d.reason, "awaiting_recording");
  assert.equal(d.send === false && d.retry, true, "the caller must be told to ask again");
});

test("the three real casualties would all have been retried, not lost", () => {
  // Their measured decision ages, in milliseconds after the row was created.
  for (const ms of [200, 300, 700]) {
    const d = decideVoicemailEmail({ ...base, hasAudio: false, receivedAt: ago(ms), now: NOW });
    assert.equal(d.send === false && d.retry, true, `a decision ${ms}ms after arrival must retry`);
  }
});

test("once the grace has passed, missing audio is still a FINAL no_recording", () => {
  const d = decideVoicemailEmail({
    ...base,
    hasAudio: false,
    receivedAt: ago(AUDIO_ARRIVAL_GRACE_MS + 1000),
    now: NOW,
  });
  assert.equal(d.send === false && d.reason, "no_recording");
  assert.ok(!(d.send === false && d.retry), "an aged-out row MUST stamp, or it blocks the sweep forever");
});

test("a voicemail with no receivedAt is stamped immediately — an unknown age buys no retry", () => {
  const d = decideVoicemailEmail({ ...base, hasAudio: false, receivedAt: null, now: NOW });
  assert.equal(d.send === false && d.reason, "no_recording");
  assert.ok(!(d.send === false && d.retry));
});

test("a clock skew that puts arrival in the FUTURE does not buy an unbounded retry", () => {
  const d = decideVoicemailEmail({ ...base, hasAudio: false, receivedAt: new Date(NOW.getTime() + 60_000), now: NOW });
  assert.equal(d.send === false && d.reason, "no_recording");
});

test("audio present still emails, and the grace changes nothing else", () => {
  const d = decideVoicemailEmail({ ...base, hasAudio: true, receivedAt: ago(500), now: NOW });
  assert.equal(d.send, true);
});

test("a hang-up with no audio yet is still retried, then falls to too_short once audio lands", () => {
  const waiting = decideVoicemailEmail({ ...base, durationSec: 1, hasAudio: false, receivedAt: ago(500), now: NOW });
  assert.equal(waiting.send === false && waiting.reason, "awaiting_recording");
  const settled = decideVoicemailEmail({ ...base, durationSec: 1, hasAudio: true, receivedAt: ago(500), now: NOW });
  assert.equal(settled.send === false && settled.reason, "too_short");
  assert.ok(Number(MIN_VOICEMAIL_SECONDS_FOR_EMAIL) > 1);
});

// ── The bounds that stop this becoming a worse bug ──────────────────────────

test("⛔ the audio grace MUST stay under the watchdog's never-processed grace", () => {
  assert.ok(
    AUDIO_ARRIVAL_GRACE_MS < NEVER_PROCESSED_GRACE_MS,
    "a voicemail legitimately waiting for audio would otherwise be reported as stranded",
  );
});

test("⛔ the audio grace MUST be finite and generous vs the ~2s arrival copy", () => {
  assert.ok(Number.isFinite(AUDIO_ARRIVAL_GRACE_MS));
  assert.ok(AUDIO_ARRIVAL_GRACE_MS >= 60_000, "must survive a briefly wedged PBX helper");
});

// ── The sender must honour retry by NOT stamping ────────────────────────────

function senderHarness(vm: Partial<Record<string, unknown>>) {
  const marked: Array<[string, string | null]> = [];
  const queued: unknown[] = [];
  const row = {
    id: "vm1", tenantId: "t1", extension: "101", callerName: null, callerNumber: "8455551212",
    durationSec: 14, receivedAt: ago(500), transcript: null, transcriptLanguage: null,
    localAudioPath: null, audioGoneAt: null, emailedAt: null, ...vm,
  };
  const deps = {
    loadExtension: async () => ({
      id: "e1", displayName: "Front Desk", pbxUserEmail: "someone@example.com",
      extraRecipients: [], vmEmailEnabled: true, tenantName: "Acme",
    }),
    queueEmail: async (p: unknown) => { queued.push(p); },
    markProcessed: async (id: string, reason: string | null) => { marked.push([id, reason]); },
  };
  return { row, deps, marked, queued };
}

test("the sender does NOT stamp a voicemail that is still waiting for its audio", async () => {
  const h = senderHarness({ localAudioPath: null, receivedAt: new Date(Date.now() - 1000) });
  const out = await processVoicemailForEmail(h.row as any, h.deps as any);
  assert.equal(out.queued, false);
  assert.equal(out.queued === false && out.reason, "awaiting_recording");
  assert.deepEqual(h.marked, [], "⛔ stamping here is what made the loss permanent");
  assert.deepEqual(h.queued, []);
});

test("the sender DOES stamp once the grace has passed, so the row cannot block the sweep", async () => {
  const h = senderHarness({
    localAudioPath: null,
    receivedAt: new Date(Date.now() - (AUDIO_ARRIVAL_GRACE_MS + 5_000)),
  });
  const out = await processVoicemailForEmail(h.row as any, h.deps as any);
  assert.equal(out.queued === false && out.reason, "no_recording");
  assert.deepEqual(h.marked, [["vm1", "no_recording"]]);
});

test("the sender still emails normally when the audio is there", async () => {
  const h = senderHarness({ localAudioPath: "vm1.wav", receivedAt: new Date(Date.now() - 1000) });
  const out = await processVoicemailForEmail(h.row as any, h.deps as any);
  assert.equal(out.queued, true);
  assert.equal(h.queued.length, 1);
  assert.deepEqual(h.marked, [["vm1", null]]);
});

// ── The re-open recovery ────────────────────────────────────────────────────

test("the re-open query only matches no_recording rows whose audio is actually present", () => {
  const w = buildNoRecordingReopenWhere({ since: ago(7 * 24 * 3600_000), excludedTenantIds: [] });
  assert.equal(w.emailSkipReason, "no_recording");
  assert.deepEqual(w.localAudioPath, { not: null });
  assert.equal(w.audioGoneAt, null, "⛔ audio proven gone must never be re-opened — it would email nothing");
  assert.equal(w.deletedAt, null);
});

test("⛔ the re-open query excludes excluded tenants, in the QUERY", () => {
  const w = buildNoRecordingReopenWhere({ since: NOW, excludedTenantIds: ["gesheft", " ", ""] });
  assert.deepEqual(w.tenantId, { not: null, notIn: ["gesheft"] });
  const none = buildNoRecordingReopenWhere({ since: NOW, excludedTenantIds: [] });
  assert.deepEqual(none.tenantId, { not: null }, "notIn must be absent when there is nothing to exclude");
});

test("the re-open pass is bounded", () => {
  assert.ok(Number.isFinite(REOPEN_BATCH) && REOPEN_BATCH > 0 && REOPEN_BATCH <= 200);
});

test("⛔ TERMINATION: nothing the re-decision can produce re-matches the re-open query", () => {
  // A re-opened row is judged again WITH audio. Enumerate every outcome that
  // re-decision can reach and prove none of them is `no_recording`, which is the
  // only reason the re-open query matches. If one ever is, the row re-opens on
  // every watchdog tick and emails the customer forever.
  const withAudio = { ...base, hasAudio: true, receivedAt: ago(500), now: NOW };
  const outcomes = [
    decideVoicemailEmail(withAudio),
    decideVoicemailEmail({ ...withAudio, vmEmailEnabled: false }),
    decideVoicemailEmail({ ...withAudio, durationSec: 1 }),
    decideVoicemailEmail({ ...withAudio, pbxUserEmail: null, extraRecipients: [] }),
    decideVoicemailEmail({ ...withAudio, emailedAt: NOW }),
  ];
  for (const o of outcomes) {
    if (o.send) continue;
    assert.notEqual(o.reason, "no_recording", `re-decision produced ${o.reason} — check the loop argument`);
  }
});

// ── Source guards: the defect was a CALLER, so read the call sites ──────────

function src(file: string): string {
  return readFileSync(join(__dirname, file), "utf8").replace(/\r\n/g, "\n");
}
/** Comments quote the old broken shapes on purpose; a negative match must not see them. */
function code(file: string): string {
  return src(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

test("⛔ the sender passes receivedAt into the decision", () => {
  assert.match(code("voicemailEmailSender.ts"), /receivedAt:\s*vm\.receivedAt/);
});

test("⛔ the sender has a no-stamp branch for a retry decision", () => {
  const s = code("voicemailEmailSender.ts");
  const retryAt = s.indexOf("decision.retry");
  const markAt = s.indexOf("markProcessed(vm.id, decision.reason)");
  assert.ok(retryAt > 0, "the retry branch is missing");
  assert.ok(retryAt < markAt, "the retry check MUST come before the stamp, or it never runs");
});

test("⛔ the watchdog calls the re-open pass", () => {
  assert.match(code("voicemailEmailRuntime.ts"), /reopenRecoveredNoRecordings\(/);
});

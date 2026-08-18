import { strict as assert } from "node:assert";
import test from "node:test";

import {
  processVoicemailForEmail,
  formatReceivedAt,
  voicemailEmailExcludedTenantIds,
  type ExtensionEmailConfig,
  type PendingVoicemail,
  type VoicemailSenderDeps,
} from "./voicemailEmailSender";
import {
  NEVER_PROCESSED_GRACE_MS,
  describeVoicemailEmailGaps,
  findVoicemailEmailGaps,
  gapsWorthAlerting,
} from "./voicemailEmailWatchdog";

const VM: PendingVoicemail = {
  id: "vm1", tenantId: "t1", extension: "102",
  callerName: "Moshe", callerNumber: "8455377994",
  durationSec: 39, receivedAt: new Date("2026-08-16T18:15:00Z"),
  transcript: null, transcriptLanguage: null,
  localAudioPath: "vm1.wav", audioGoneAt: null, emailedAt: null,
};
const EXT: ExtensionEmailConfig = {
  id: "e1", displayName: "Ari Schonbrun",
  pbxUserEmail: "orders@gesheftkosher.com", vmEmailEnabled: true, extraRecipients: [],
};

function deps(over: Partial<VoicemailSenderDeps> = {}) {
  const queued: any[] = [];
  const marked: Array<[string, string | null]> = [];
  const d: VoicemailSenderDeps = {
    loadExtension: async () => EXT,
    queueEmail: async (p) => { queued.push(p); return {}; },
    markProcessed: async (id, reason) => { marked.push([id, reason]); return {}; },
    ...over,
  };
  return { d, queued, marked };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; }
  }
}

// ─── the happy path ──────────────────────────────────────────────────────────

test("a good voicemail is queued to the outbox and stamped", async () => {
  const { d, queued, marked } = deps();
  const out = await processVoicemailForEmail(VM, d);
  assert.equal(out.queued, true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].type, "VOICEMAIL_NOTIFICATION");
  assert.equal(queued[0].toEmail, "orders@gesheftkosher.com");
  assert.match(queued[0].htmlBody, /connect-voicemail:vm1/);
  assert.deepEqual(marked, [["vm1", null]]);
});

test("several recipients ride ONE job, so a retry cannot double-send", async () => {
  const { d, queued } = deps({
    loadExtension: async () => ({ ...EXT, extraRecipients: ["boss@x.com", "office@x.com"] }),
  });
  await processVoicemailForEmail(VM, d);
  assert.equal(queued.length, 1, "one job, not one per recipient");
  assert.equal(queued[0].toEmail, "orders@gesheftkosher.com,boss@x.com,office@x.com");
});

// ─── the rule that protects against silence ──────────────────────────────────

test("if queueing throws, the voicemail is NOT stamped, so the next sweep retries", async () => {
  const { d, marked } = deps({ queueEmail: async () => { throw new Error("db down"); } });
  await assert.rejects(() => processVoicemailForEmail(VM, d));
  assert.deepEqual(marked, [], "must not stamp a voicemail we failed to queue");
});

test("an excluded tenant is never stamped, so it becomes eligible the moment it is let in", async () => {
  await withEnv({ VOICEMAIL_EMAIL_EXCLUDED_TENANT_IDS: "t1" }, async () => {
    const { d, queued, marked } = deps();
    const out = await processVoicemailForEmail(VM, d);
    assert.equal(out.queued, false);
    assert.equal(out.queued === false && out.reason, "excluded_tenant");
    assert.equal(queued.length, 0);
    assert.deepEqual(marked, [], "stamping here would permanently skip the hold-back period");
  });
});

test("an unknown mailbox is a data gap, not a decision — also never stamped", async () => {
  const { d, marked } = deps({ loadExtension: async () => null });
  const out = await processVoicemailForEmail(VM, d);
  assert.equal(out.queued === false && out.reason, "unknown_extension");
  assert.deepEqual(marked, []);
});

// ─── the send rules ──────────────────────────────────────────────────────────

test("no audio, no email — and the reason is recorded", async () => {
  const { d, queued, marked } = deps();
  const out = await processVoicemailForEmail({ ...VM, localAudioPath: null }, d);
  assert.equal(out.queued, false);
  assert.equal(queued.length, 0);
  assert.deepEqual(marked, [["vm1", "no_recording"]]);
});

test("audio proven gone counts as no audio", async () => {
  const { d, queued } = deps();
  const out = await processVoicemailForEmail({ ...VM, audioGoneAt: new Date() }, d);
  assert.equal(out.queued === false && out.reason, "no_recording");
  assert.equal(queued.length, 0);
});

test("a hang-up is recorded as too_short, not sent", async () => {
  const { d, marked } = deps();
  await processVoicemailForEmail({ ...VM, durationSec: 1 }, d);
  assert.deepEqual(marked, [["vm1", "too_short"]]);
});

test("a mailbox with nobody to email is recorded as no_recipient", async () => {
  const { d, marked, queued } = deps({ loadExtension: async () => ({ ...EXT, pbxUserEmail: null }) });
  await processVoicemailForEmail(VM, d);
  assert.equal(queued.length, 0);
  assert.deepEqual(marked, [["vm1", "no_recipient"]]);
});

test("the master switch defaults OFF so deploying changes nothing", () => {
  withEnv({ VOICEMAIL_EMAIL_ENABLED: undefined }, async () => {
    const { voicemailEmailEnabled } = await import("./voicemailEmailSender");
    assert.equal(voicemailEmailEnabled(), false);
  });
});

test("excluded tenants parse from env, tolerating spaces and blanks", () => {
  withEnv({ VOICEMAIL_EMAIL_EXCLUDED_TENANT_IDS: " t1 , ,t2," }, () => {
    const s = voicemailEmailExcludedTenantIds();
    assert.equal(s.has("t1"), true);
    assert.equal(s.has("t2"), true);
    assert.equal(s.size, 2);
  });
});

test("the received-at label reads like speech", () => {
  const label = formatReceivedAt(new Date("2026-08-16T18:15:00Z"));
  assert.match(label, /Aug 16/);
  assert.match(label, / at /);
});

// ─── the watchdog ────────────────────────────────────────────────────────────

const gapBase = { tenantId: "t1", tenantName: "Gesheft", extension: "102", receivedAt: new Date() };

test("deliberate skips never raise an alarm", () => {
  const gaps = findVoicemailEmailGaps({
    eligible: ["disabled", "no_recording", "too_short", "predates_feature"].map((r, i) => ({
      id: `v${i}`, ...gapBase, emailedAt: new Date(), emailSkipReason: r,
    })),
    jobStatusByVoicemailId: new Map(),
  });
  assert.deepEqual(gaps, []);
});

test("a voicemail the sender never touched is caught — once it is older than the grace", () => {
  const old = new Date(Date.now() - NEVER_PROCESSED_GRACE_MS - 1000);
  const gaps = findVoicemailEmailGaps({
    eligible: [{ id: "v1", ...gapBase, receivedAt: old, emailedAt: null, emailSkipReason: null }],
    jobStatusByVoicemailId: new Map(),
  });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].problem, "never_processed");
});

test("a voicemail that just arrived is NOT a gap yet — the sweep runs every minute and has not had its turn", () => {
  const gaps = findVoicemailEmailGaps({
    eligible: [{ id: "v1", ...gapBase, receivedAt: new Date(Date.now() - 30_000), emailedAt: null, emailSkipReason: null }],
    jobStatusByVoicemailId: new Map(),
  });
  assert.deepEqual(gaps, []);
  // A voicemail with no receivedAt at all cannot be aged, so it IS reported.
  const noDate = findVoicemailEmailGaps({
    eligible: [{ id: "v2", ...gapBase, receivedAt: null, emailedAt: null, emailSkipReason: null }],
    jobStatusByVoicemailId: new Map(),
  });
  assert.equal(noDate[0]?.problem, "never_processed");
});

test("a stamped voicemail with no job at all is caught — this is the silent loss", () => {
  const gaps = findVoicemailEmailGaps({
    eligible: [{ id: "v1", ...gapBase, emailedAt: new Date(), emailSkipReason: null }],
    jobStatusByVoicemailId: new Map(),
  });
  assert.equal(gaps[0].problem, "job_missing");
});

test("an outbox that gave up is caught", () => {
  const gaps = findVoicemailEmailGaps({
    eligible: [{ id: "v1", ...gapBase, emailedAt: new Date(), emailSkipReason: null }],
    jobStatusByVoicemailId: new Map([["v1", { status: "FAILED", lastErrorMessage: "550 quota" }]]),
  });
  assert.equal(gaps[0].problem, "delivery_failed");
  assert.match(gaps[0].detail || "", /550 quota/);
});

test("a job still retrying is NOT a miss yet", () => {
  const gaps = findVoicemailEmailGaps({
    eligible: [{ id: "v1", ...gapBase, emailedAt: new Date(), emailSkipReason: null }],
    jobStatusByVoicemailId: new Map([["v1", { status: "QUEUED" }]]),
  });
  assert.deepEqual(gaps, []);
});

test("a SKIPPED job is a miss — that is how the muted-alert trap would look", () => {
  const gaps = findVoicemailEmailGaps({
    eligible: [{ id: "v1", ...gapBase, emailedAt: new Date(), emailSkipReason: null }],
    jobStatusByVoicemailId: new Map([["v1", { status: "SKIPPED" }]]),
  });
  assert.equal(gaps[0].problem, "delivery_failed");
});

test("no_recipient is reported but does not alert, so the alarm stays meaningful", () => {
  const gaps = findVoicemailEmailGaps({
    eligible: [{ id: "v1", ...gapBase, emailedAt: new Date(), emailSkipReason: "no_recipient" }],
    jobStatusByVoicemailId: new Map(),
  });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].problem, "no_recipient");
  assert.deepEqual(gapsWorthAlerting(gaps), []);
});

test("the summary is readable, not a stack trace", () => {
  assert.equal(describeVoicemailEmailGaps([]), "All voicemail emails went out.");
  const text = describeVoicemailEmailGaps([
    { voicemailId: "v1", ...gapBase, problem: "delivery_failed", detail: "550 quota" },
  ]);
  assert.match(text, /1 voicemail did not reach anyone/);
  assert.match(text, /the email failed to send/);
  assert.match(text, /Gesheft ext 102/);
});

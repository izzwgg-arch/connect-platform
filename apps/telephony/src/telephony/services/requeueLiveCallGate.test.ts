import "./requeueTestEnv";
import test from "node:test";
import assert from "node:assert/strict";
import { TelephonyService } from "./TelephonyService";
import { CallStateStore } from "../state/CallStateStore";
import type { AmiClient } from "../ami/AmiClient";
import type { AriClient } from "../ari/AriClient";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";

// Regression guard for the RSBK ext-102 ring-group voicemail loop (2026-06-25):
// the mobile cold-start "requeue" AMI-Redirected the trunk leg back into the
// ring group WHILE the app's WebRTC leg (PJSIP/T34_102_1) was already ringing,
// tearing down the live ring and looping the group forever. The requeue must be
// a no-op when an extension leg is already live; it must still fire for genuine
// cold-start (no extension leg present).

type SentAction = { action: string; params: Record<string, unknown> };

function makeService(): { svc: TelephonyService; calls: CallStateStore; sent: SentAction[] } {
  const sent: SentAction[] = [];
  const ami = {
    on: () => undefined,
    sendAction: (action: string, params: Record<string, unknown>) => {
      sent.push({ action, params });
      return `actionId-${sent.length}`;
    },
  } as unknown as AmiClient;
  const ari = { on: () => undefined } as unknown as AriClient;
  const calls = new CallStateStore();
  const extensions = {} as unknown as ExtensionStateStore;
  const queues = {} as unknown as QueueStateStore;
  const svc = new TelephonyService(ami, ari, calls, extensions, queues);
  return { svc, calls, sent };
}

function addChannel(
  calls: CallStateStore,
  linkedId: string,
  uniqueid: string,
  channel: string,
  channelState: string,
  exten: string,
  context: string,
): void {
  calls.upsertFromNewchannel({
    linkedId,
    uniqueid,
    channel,
    channelState,
    callerIDNum: "5622096644",
    callerIDName: "Caller",
    connectedLineNum: "",
    connectedLineName: "",
    context,
    exten,
    tenantId: "tenant-1",
    tenantSlug: "rsbk",
    tenantName: "RSBK",
    direction: "inbound",
  });
}

test("requeue is SKIPPED while an extension leg is already ringing (no Redirect)", async () => {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782424010.136659";
  // Trunk leg dialing the ring group.
  addChannel(calls, linkedId, "u-trunk", "PJSIP/344022_Comfortcont-00012f0e", "Up", "801", "T34_ext-ringgroups");
  // App WebRTC leg is RINGING (not answered) — this is the live INVITE.
  addChannel(calls, linkedId, "u-ext", "PJSIP/T34_102_1-00012f14", "Ringing", "102", "T34_cos-all");

  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "801",
    fallbackContext: "T34_ext-ringgroups",
  });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "extension_leg_already_live");
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    0,
    "must not issue an AMI Redirect over a live ringing extension leg",
  );
});

test("requeue PROCEEDS for genuine cold-start (no extension leg present)", async () => {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782424010.999999";
  // Only the trunk leg exists — the app was asleep, so no PJSIP/T34_* leg was created.
  addChannel(calls, linkedId, "u-trunk", "PJSIP/344022_Comfortcont-00099999", "Up", "801", "T34_ext-ringgroups");

  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "801",
    fallbackContext: "T34_ext-ringgroups",
  });

  assert.equal(result.skipped, false);
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    1,
    "cold-start requeue must still issue exactly one AMI Redirect",
  );
});

// iOS cold-answer fix (2026-06-28): a swipe-killed app leaves a half-open
// WebSocket contact. The DIRECT-extension Dial() rings that DEAD contact
// (leg created, but it NEVER returns 180/200/486 — stays at "Ring"), which
// previously blocked the requeue and starved the rewoken fresh contact.
// Proven live: linkedId 1782671680.142801, leg PJSIP/T21_101_1-00013cde.
test("requeue PROCEEDS over a DEAD extension leg on a direct-extension dial (cold answer)", async () => {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782671680.142801";
  const trunk = "PJSIP/344022_Comfortcont-00013cdd";
  // Trunk leg dialing extension 101 DIRECTLY (sub-local-dialing, not a ring group).
  addChannel(calls, linkedId, "u-trunk", trunk, "Up", "101", "sub-local-dialing");
  // Record the trunk's Dial() position so the requeue knows the target is a
  // direct extension dial (this is what DialBegin captures live).
  calls.onDialBegin({
    linkedId,
    callerIDNum: "5622096644",
    destination: "PJSIP/T21_101_1-00013cde",
    channel: trunk,
    context: "sub-local-dialing",
    exten: "101",
  });
  // The dead/zombie contact's leg: created and "Ring" (we are dialing it) but it
  // NEVER responds — no 180/200/486 ever arrives.
  addChannel(calls, linkedId, "u-ext", "PJSIP/T21_101_1-00013cde", "Ring", "101", "T21_cos-all");

  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "101",
    fallbackContext: "sub-local-dialing",
  });

  assert.equal(result.skipped, false, "must requeue past a dead (never-responded) extension leg");
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    1,
    "cold-answer requeue over a dead leg must issue exactly one AMI Redirect",
  );
});

// ANDROID SAFETY GUARD: even on a direct-extension dial, a genuinely-ringing
// device (it returned 180 → "Ringing") must NEVER be disturbed by a requeue.
test("requeue is SKIPPED over a RINGING device even on a direct-extension dial (android-safe)", async () => {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782671680.143000";
  const trunk = "PJSIP/344022_Comfortcont-00013d00";
  addChannel(calls, linkedId, "u-trunk", trunk, "Up", "101", "sub-local-dialing");
  calls.onDialBegin({
    linkedId,
    callerIDNum: "5622096644",
    destination: "PJSIP/T21_101_1-00013d01",
    channel: trunk,
    context: "sub-local-dialing",
    exten: "101",
  });
  // A REAL device: its leg returned 180 → channel state "Ringing".
  addChannel(calls, linkedId, "u-ext", "PJSIP/T21_101_1-00013d01", "Ringing", "101", "T21_cos-all");

  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "101",
    fallbackContext: "sub-local-dialing",
  });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "extension_leg_already_live");
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    0,
    "must not Redirect over a device that actually rang (180), even on a direct dial",
  );
});

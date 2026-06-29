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

// ANDROID REGRESSION GUARD (2026-06-28): a trigger-keyed "cold-answer bypass"
// (allow the requeue to supersede a live leg when trigger=device_register_complete)
// was deployed and REVERTED. Android re-registers on its wake push, which also
// fires device_register_complete, so the bypass Redirected the trunk WHILE the
// Android extension leg was ringing → re-dial → straight to voicemail while the
// app re-rang (confirmed live: linkedId 1782677604.143074, leg
// PJSIP/T21_101_1-00013d78 state=ringing). The gate is therefore trigger-AGNOSTIC:
// a live extension leg is left alone no matter what the requeue trigger is.
test("requeue is SKIPPED over a live extension leg even with a device_register_complete trigger (android-safe)", async () => {
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
  // The Android device's leg is RINGING on its wake-push registration.
  addChannel(calls, linkedId, "u-ext", "PJSIP/T21_101_1-00013d01", "Ringing", "101", "T21_cos-all");

  // device_register_complete (Android's wake-register trigger) must NOT supersede it.
  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "101",
    fallbackContext: "sub-local-dialing",
    trigger: "device_register_complete",
  });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "extension_leg_already_live");
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    0,
    "must not Redirect over a live extension leg, regardless of the requeue trigger",
  );
});

// COOLDOWN GUARD (2026-06-29): the mobile-invite requeue can now be triggered by
// two independent signals — the app's device_register_complete HTTP report AND
// the PBX's own fresh-contact registration event (ContactStatus/PeerStatus
// REGISTERED edge). Those can land within milliseconds. A second AMI Redirect
// issued before the first re-dial has produced an extension leg would tear down
// the in-flight re-dial and restart it. The cooldown must collapse the second
// trigger into a no-op so only ONE Redirect is sent.
test("second requeue within the cooldown window is skipped (no double Redirect)", async () => {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782424010.555555";
  // Genuine cold-start: only the trunk leg, no extension leg → first requeue fires.
  addChannel(calls, linkedId, "u-trunk", "PJSIP/344022_Comfortcont-00055555", "Up", "801", "T34_ext-ringgroups");

  const first = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "801",
    fallbackContext: "T34_ext-ringgroups",
    trigger: "register_complete",
  });
  const second = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "801",
    fallbackContext: "T34_ext-ringgroups",
    trigger: "pbx_contact_registered",
  });

  assert.equal(first.skipped, false, "first requeue must fire");
  assert.equal(second.skipped, true, "second requeue within cooldown must be skipped");
  assert.equal(second.skipReason, "requeue_cooldown");
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    1,
    "exactly one AMI Redirect for two near-simultaneous triggers",
  );
});

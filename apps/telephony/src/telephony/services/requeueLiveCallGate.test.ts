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
  const trunk = "PJSIP/344022_Comfortcont-00099999";
  // Only the trunk leg exists — the app was asleep, so no PJSIP/T34_* leg was created.
  addChannel(calls, linkedId, "u-trunk", trunk, "Up", "801", "T34_ext-ringgroups");
  // The trunk leg DID invoke Dial() into the ring group (the target just had no
  // reachable contact), so its safe Dial position is captured. destination is the
  // unavailable dialstring — empty here so markExtensionLegSeen stays false.
  calls.onDialBegin({
    linkedId,
    callerIDNum: "5622096644",
    destination: "",
    channel: trunk,
    context: "T34_ext-ringgroups",
    exten: "801",
  });

  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "801",
    fallbackContext: "T34_ext-ringgroups",
  });

  assert.equal(result.skipped, false);
  assert.equal(result.context, "T34_ext-ringgroups");
  assert.equal(result.exten, "801");
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    1,
    "cold-start requeue must still issue exactly one AMI Redirect",
  );
});

// SAFE-TARGET GUARD (2026-06-29): when the trunk leg's Dial() position is unknown
// (the call is still in the IVR — no extension Dial() yet), the requeue must NOT
// fall back to lastContext/lastExten (which is the inbound entry trk-*-in,<DID>)
// and re-run the whole inbound DID route. It must skip with no AMI Redirect.
// Proven live: linkedId 1782742495.143999 (device_register_complete /
// zero_contact_coldstart) redirected to trk-37-in,8457823064 because
// trunkContext/trunkExten were null.
test("requeue is SKIPPED when no trunk Dial position is known (refuses last_newchannel fallback)", async () => {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782742495.143999";
  // Inbound DID call sitting in the IVR — only the trunk leg, entered at the
  // inbound trunk context with the DID as exten. No trunk-leg Dial() into an
  // extension happened, so trunkDialContext/trunkDialExten are unset and the
  // most-recent Newchannel context/exten are trk-37-in/<DID>.
  addChannel(calls, linkedId, "u-trunk", "PJSIP/344022_Comfortcont-00013fb5", "Up", "8457823064", "trk-37-in");

  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    trigger: "device_register_complete",
  });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "missing_safe_redirect_target");
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    0,
    "must not Redirect when the safe trunk Dial position is unknown",
  );
});

test("requeue never Redirects into a trk-*-in inbound context + DID (no IVR re-entry loop)", async () => {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782742495.144111";
  addChannel(calls, linkedId, "u-trunk", "PJSIP/344022_Comfortcont-00013fb6", "Up", "8457823064", "trk-37-in");

  // Even if the caller supplies the inbound entry as a fallback, it must never win.
  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "8457823064",
    fallbackContext: "trk-37-in",
    trigger: "device_register_complete",
  });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "missing_safe_redirect_target");
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    0,
    "no AMI Redirect at all when only the inbound trk-*-in/DID is available",
  );
  assert.equal(
    sent.some((s) => /trk-.*-in/i.test(String(s.params["Context"] ?? ""))),
    false,
    "must never AMI-Redirect into a trk-*-in inbound context",
  );
});

test("requeue PROCEEDS to the trunk Dial position when it is known (safe redirect)", async () => {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782742495.144222";
  const trunk = "PJSIP/344022_Comfortcont-00099991";
  // Inbound DID leg, currently parked at the inbound entry (trk-37-in/<DID>) …
  addChannel(calls, linkedId, "u-trunk", trunk, "Up", "8457823064", "trk-37-in");
  // … but the trunk has now Dial()ed the extension's local-dialing context, so the
  // safe Dial position is captured. Empty destination → no extension leg seen.
  calls.onDialBegin({
    linkedId,
    callerIDNum: "5622096644",
    destination: "",
    channel: trunk,
    context: "sub-local-dialing",
    exten: "110",
  });

  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    trigger: "device_register_complete",
  });

  assert.equal(result.skipped, false);
  assert.equal(result.context, "sub-local-dialing");
  assert.equal(result.exten, "110");
  const redirects = sent.filter((s) => s.action === "Redirect");
  assert.equal(redirects.length, 1, "exactly one safe Redirect to the trunk Dial position");
  assert.equal(redirects[0]?.params["Context"], "sub-local-dialing");
  assert.equal(redirects[0]?.params["Exten"], "110");
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

// COLD-ANSWER RE-DELIVERY CARVE-OUT (2026-06-29): when the app is swipe-killed,
// its WebRTC contact lingers as a DEAD WebSocket. The next call's Dial() sends an
// INVITE to that dead contact, creating a PJSIP/T<id>_<exten> leg that rings into
// the void (state "Ring"=1, never returns 180/200/486, so extensionLegResponded
// stays unset). When the rewoken app registers a fresh contact and asks to be
// re-delivered, the requeue MUST re-deliver to the EXTENSION's own *local-dialing*
// Dial position (NOT the trunk's IVR position) so the fresh contact gets a new
// INVITE. Proven live: linkedId 1782746721.144584 (ext 110 via IVR-5, 2026-06-29),
// previously skipped `extension_leg_already_live` → voicemail.
test("requeue PROCEEDS over a DEAD (never-responded) extension leg for mobile cold-answer (IVR route)", async () => {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782746721.144584";
  const trunk = "PJSIP/344022_Comfortcont-000140fa";
  // Inbound DID → IVR. The trunk's recorded Dial position is the IVR context.
  addChannel(calls, linkedId, "u-trunk", trunk, "Up", "110", "IVR-5");
  calls.onDialBegin({
    linkedId,
    callerIDNum: "5622096644",
    destination: "Local/110@T2_cos-all-00006b5e;1",
    channel: trunk,
    context: "IVR-5",
    exten: "110",
  });
  // One layer deeper the Local channel dials the extension from *local-dialing* —
  // this is the safe direct-extension Dial position the requeue must target.
  calls.onDialBegin({
    linkedId,
    callerIDNum: "5622096644",
    destination: "PJSIP/T2_110_1-000140fe",
    channel: "Local/110@T2_cos-all-00006b5e;2",
    context: "sub-local-dialing",
    exten: "110",
  });
  // The extension leg exists but is ringing a DEAD post-swipe contact: state
  // "Ring" (1, outgoing) — never returns 180, so extensionLegResponded stays unset.
  addChannel(calls, linkedId, "u-ext", "PJSIP/T2_110_1-000140fe", "Ring", "110", "T2_cos-all");

  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    trigger: "device_register_complete",
  });

  assert.equal(result.skipped, false);
  assert.equal(result.context, "sub-local-dialing");
  assert.equal(result.exten, "110");
  const redirects = sent.filter((s) => s.action === "Redirect");
  assert.equal(redirects.length, 1, "cold-answer must re-deliver via exactly one Redirect");
  assert.equal(redirects[0]?.params["Context"], "sub-local-dialing", "redirect to the extension's *local-dialing* position, NOT IVR-5");
  assert.equal(redirects[0]?.params["Exten"], "110");
  assert.equal(
    redirects.some((s) => /^ivr-/i.test(String(s.params["Context"] ?? ""))),
    false,
    "must never re-run the IVR context on cold-answer re-delivery",
  );
});

// LOOP-SAFETY for the carve-out: a ring-group member leg is dialed from a
// ring-group context (NOT *local-dialing*). Even when that member's contact is
// dead (never responded), re-delivering would re-enter the group at priority 1 →
// the RSBK loop. Condition #2 (direct-dial-only target) must keep it skipped
// independent of the responded flag.
test("requeue is SKIPPED for a dead ring-group member leg (loop-safe; target is not *local-dialing*)", async () => {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782424010.700700";
  const trunk = "PJSIP/344022_Comfortcont-00012700";
  addChannel(calls, linkedId, "u-trunk", trunk, "Up", "801", "T34_ext-ringgroups");
  // Ring group fans out to a member extension from a RING-GROUP dial context.
  calls.onDialBegin({
    linkedId,
    callerIDNum: "5622096644",
    destination: "PJSIP/T34_102_1-00012714",
    channel: "Local/102@T34_ext-ringgroups-0000aa00;2",
    context: "T34_ring-group-dial",
    exten: "801",
  });
  // Dead member contact: state "Ring" (1), never responded.
  addChannel(calls, linkedId, "u-ext", "PJSIP/T34_102_1-00012714", "Ring", "102", "T34_cos-all");

  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    trigger: "device_register_complete",
  });

  assert.equal(result.skipped, true, "ring-group dial must still be skipped even with a dead member contact");
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    0,
    "must never Redirect into/over a ring-group dial — that is the RSBK loop",
  );
});

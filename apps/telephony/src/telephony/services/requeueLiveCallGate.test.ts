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

// MODE-B cold-answer setup (proven prod APK call 1782764578.146922, ext 110 /
// AOR T2_110_1, IVR-5 route): inbound DID → IVR dials the extension from
// `sub-local-dialing`, forking to a STALE post-swipe contact. That leg rings
// (returns 180 → "responded"), the rewoken app registers a BRAND-NEW contact
// AFTER the dial, the user taps Answer (`invite_accept`). The default scenario
// reproduces exactly that; opts let each test perturb a single dimension.
function setupColdAnswer(opts?: {
  extLegContext?: string; // context the ext leg is dialed from (default sub-local-dialing)
  legState?: string; // dead/zombie leg channel state (default "Ringing" = responded)
  withLeg?: boolean; // include the live (stale) ext leg (default true)
}): {
  svc: TelephonyService;
  calls: CallStateStore;
  sent: SentAction[];
  linkedId: string;
  aor: string;
  dialedUri: string;
  extLegDialedAt: number;
  addFreshContact: (afterMs?: number) => string;
  addReRegisterOfDialedContact: (afterMs?: number) => void;
} {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782764578.146922";
  const trunk = "PJSIP/344022_Comfortcont-000146fc";
  const aor = "T2_110_1";
  const dialedUri = "sip:8hkh5htv@50.49.194.85:39240";
  const extLegContext = opts?.extLegContext ?? "sub-local-dialing";
  // Inbound DID → IVR: the trunk's recorded Dial position is the IVR context.
  addChannel(calls, linkedId, "u-trunk", trunk, "Up", "110", "IVR-5");
  calls.onDialBegin({
    linkedId,
    callerIDNum: "5622096644",
    destination: "Local/110@T2_cos-all-00006d0a;1",
    channel: trunk,
    context: "IVR-5",
    exten: "110",
  });
  // One layer deeper, the Local channel dials the extension — this carries the
  // safe direct-extension Dial position AND the dialed contact URI (DialString).
  calls.onDialBegin({
    linkedId,
    callerIDNum: "5622096644",
    destination: "PJSIP/T2_110_1-000140fe",
    channel: "Local/110@T2_cos-all-00006d0a;2",
    context: extLegContext,
    exten: "110",
    dialString: `${aor}/${dialedUri};transport=ws;x-ast-orig-host=fegp85rdeme4.invalid:0`,
  });
  if (opts?.withLeg !== false) {
    addChannel(calls, linkedId, "u-ext", "PJSIP/T2_110_1-000140fe", opts?.legState ?? "Ringing", "110", "T2_cos-all");
  }
  const extLegDialedAt = (calls.getById(linkedId)?.metadata["extLegDialedAt"] as number) ?? Date.now();
  const addFreshContact = (afterMs = 60000): string => {
    // A brand-new, not-yet-dialed contact registers AFTER the dial.
    const freshUri = "sip:165frhpi@50.49.194.85:49460";
    svc.contactRegistry.record(aor, freshUri, "Reachable", extLegDialedAt + afterMs);
    return freshUri;
  };
  const addReRegisterOfDialedContact = (afterMs = 60000): void => {
    // A live device only re-qualifies the SAME contact the leg was dialed to.
    svc.contactRegistry.record(aor, dialedUri, "Reachable", extLegDialedAt + afterMs);
  };
  return { svc, calls, sent, linkedId, aor, dialedUri, extLegDialedAt, addFreshContact, addReRegisterOfDialedContact };
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

// ── MODE-B cold-answer re-delivery (2026-06-29) ─────────────────────────────
// The 10 required guards for the production Android killed/swiped-away ANSWER fix.

// (1) Proven Mode-B SUCCEEDS: a stale leg is ringing (it even returned 180, so
// the old `extensionLegResponded` carve-out would NOT have fired), a brand-new
// contact registered AFTER the dial, and the user tapped Answer. The requeue
// must re-deliver via exactly one Redirect to the tenant's self-contained
// COS-all extension-dial context (`T<pbx>_cos-all,<ext>`) — NEVER the IVR and
// NEVER `sub-local-dialing` (which is not a valid standalone trunk re-entry —
// it needs TENANT/CALL_DESTINATION set upstream and would hang the call up).
test("MODE-B (1): stale leg + fresh not-dialed contact after dial + invite_accept ⇒ one safe Redirect to T*_cos-all", async () => {
  const { svc, calls, sent, linkedId, addFreshContact } = setupColdAnswer();
  addFreshContact();

  const result = await svc.requeueLiveCallToDialplan({ linkedId, trigger: "invite_accept" });

  assert.equal(result.skipped, false);
  // AOR is T2_110_1 ⇒ redirect target is the self-contained T2_cos-all,110 —
  // NOT sub-local-dialing (which would land with no DIAL_STRING → hangup).
  assert.equal(result.context, "T2_cos-all");
  assert.equal(result.exten, "110");
  const redirects = sent.filter((s) => s.action === "Redirect");
  assert.equal(redirects.length, 1, "Mode-B must re-deliver via exactly one Redirect");
  assert.equal(redirects[0]?.params["Context"], "T2_cos-all");
  assert.equal(redirects[0]?.params["Exten"], "110");
  assert.notEqual(
    redirects[0]?.params["Context"],
    "sub-local-dialing",
    "must NOT redirect into sub-local-dialing — it is not a self-contained trunk re-entry point",
  );
  assert.equal(
    redirects.some((s) => /^ivr-/i.test(String(s.params["Context"] ?? ""))),
    false,
    "must never re-run the IVR context",
  );
});

// (2) A live Android/desk device whose contact did NOT change (only re-qualified
// the SAME contact the leg was dialed to) yields no fresh contact ⇒ no bypass.
test("MODE-B (2): live device, no replacement contact ⇒ skipped extension_leg_already_live", async () => {
  const { svc, calls, sent, linkedId, addReRegisterOfDialedContact } = setupColdAnswer();
  addReRegisterOfDialedContact(); // same dialed URI re-qualifies — NOT a fresh contact

  const result = await svc.requeueLiveCallToDialplan({ linkedId, trigger: "invite_accept" });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "extension_leg_already_live");
  assert.equal(sent.filter((s) => s.action === "Redirect").length, 0);
});

// (3) Ring-group restart still impossible: even with a fresh contact AND
// invite_accept, a leg dialed from a ring-group context is not a direct-extension
// target, so the bypass cannot fire (the RSBK loop stays impossible).
test("MODE-B (3): ring-group leg + fresh contact + invite_accept ⇒ still skipped (no loop)", async () => {
  const { svc, calls, sent, linkedId, addFreshContact } = setupColdAnswer({
    extLegContext: "T34_ring-group-dial",
  });
  addFreshContact();

  const result = await svc.requeueLiveCallToDialplan({ linkedId, trigger: "invite_accept" });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "extension_leg_already_live");
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    0,
    "must never Redirect into/over a ring-group dial — that is the RSBK loop",
  );
});

// (4) Queue restart still impossible: a leg dialed from a queue context is not a
// direct-extension target.
test("MODE-B (4): queue leg + fresh contact + invite_accept ⇒ still skipped", async () => {
  const { svc, calls, sent, linkedId, addFreshContact } = setupColdAnswer({
    extLegContext: "T8_queue-call-to-agents",
  });
  addFreshContact();

  const result = await svc.requeueLiveCallToDialplan({ linkedId, trigger: "invite_accept" });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "extension_leg_already_live");
  assert.equal(sent.filter((s) => s.action === "Redirect").length, 0);
});

// (5) IVR restart still impossible: any non-*local-dialing* context (here an IVR
// context as the ext-leg Dial position) is not a direct-extension target.
test("MODE-B (5): IVR-context leg + fresh contact + invite_accept ⇒ still skipped (no IVR re-entry)", async () => {
  const { svc, calls, sent, linkedId, addFreshContact } = setupColdAnswer({
    extLegContext: "IVR-5",
  });
  addFreshContact();

  const result = await svc.requeueLiveCallToDialplan({ linkedId, trigger: "invite_accept" });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "extension_leg_already_live");
  assert.equal(
    sent.some((s) => /^ivr-/i.test(String(s.params["Context"] ?? ""))),
    false,
    "must never Redirect into an IVR context",
  );
});

// (6) register_complete alone cannot bypass — the exact mistake reverted on
// 2026-06-28 (Android re-registers on its wake push, which fires
// device_register_complete). Full Mode-B evidence present, but wrong trigger.
test("MODE-B (6): full Mode-B evidence but trigger=device_register_complete ⇒ cannot bypass", async () => {
  const { svc, calls, sent, linkedId, addFreshContact } = setupColdAnswer();
  addFreshContact();

  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    trigger: "device_register_complete",
  });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "extension_leg_already_live");
  assert.equal(sent.filter((s) => s.action === "Redirect").length, 0);
});

// (7) An already-answered call cannot bypass: the top `extensionAnsweredAt` gate
// wins, so a bridged extension is never torn down.
test("MODE-B (7): answered call cannot bypass (extension_already_answered)", async () => {
  const { svc, calls, sent, linkedId, addFreshContact } = setupColdAnswer();
  addFreshContact();
  const call = calls.getById(linkedId);
  assert.ok(call);
  call.extensionAnsweredAt = new Date().toISOString();

  const result = await svc.requeueLiveCallToDialplan({ linkedId, trigger: "invite_accept" });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "extension_already_answered");
  assert.equal(sent.filter((s) => s.action === "Redirect").length, 0);
});

// (8) Missing safe target skips: invite_accept, no extension Dial position and no
// trunk Dial position known ⇒ refuse (never last_newchannel/DID).
test("MODE-B (8): invite_accept with no safe Dial position ⇒ missing_safe_redirect_target", async () => {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782764578.888888";
  // Inbound DID still in the IVR — only the trunk leg, no extension dialed yet.
  addChannel(calls, linkedId, "u-trunk", "PJSIP/344022_Comfortcont-00088888", "Up", "8457823064", "trk-37-in");

  const result = await svc.requeueLiveCallToDialplan({ linkedId, trigger: "invite_accept" });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "missing_safe_redirect_target");
  assert.equal(sent.filter((s) => s.action === "Redirect").length, 0);
});

// (9) No trk-*-in,<DID> redirect possible even with invite_accept + a supplied
// inbound fallback.
test("MODE-B (9): invite_accept never Redirects into trk-*-in/DID", async () => {
  const { svc, calls, sent } = makeService();
  const linkedId = "1782764578.999000";
  addChannel(calls, linkedId, "u-trunk", "PJSIP/344022_Comfortcont-00099000", "Up", "8457823064", "trk-37-in");

  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    trigger: "invite_accept",
    fallbackExten: "8457823064",
    fallbackContext: "trk-37-in",
  });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "missing_safe_redirect_target");
  assert.equal(
    sent.some((s) => /trk-.*-in/i.test(String(s.params["Context"] ?? ""))),
    false,
    "must never AMI-Redirect into a trk-*-in inbound context",
  );
});

// (10) One-shot: a Mode-B redirect cannot execute twice for the same linkedId.
// After the first re-delivery, the stale leg is still live, so the duplicate
// requeue falls straight back to extension_leg_already_live.
test("MODE-B (10): one-shot — a second requeue cannot Redirect again", async () => {
  const { svc, calls, sent, linkedId, addFreshContact } = setupColdAnswer();
  addFreshContact();

  const first = await svc.requeueLiveCallToDialplan({ linkedId, trigger: "invite_accept" });
  assert.equal(first.skipped, false, "first Mode-B requeue redirects");

  const second = await svc.requeueLiveCallToDialplan({ linkedId, trigger: "invite_accept" });
  assert.equal(second.skipped, true, "second requeue must not redirect again");
  assert.equal(second.skipReason, "extension_leg_already_live");

  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    1,
    "exactly one Mode-B Redirect across two requeue attempts",
  );
});

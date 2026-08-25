import "./requeueTestEnv";
import test from "node:test";
import assert from "node:assert/strict";
import { TelephonyService } from "./TelephonyService";
import { CallStateStore } from "../state/CallStateStore";
import { resolveWakeDialLeg } from "./wakeDialLeg";
import type { AmiClient } from "../ami/AmiClient";
import type { AriClient } from "../ari/AriClient";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";

// WAKE-LEG MODE-B RE-DELIVERY (2026-08-25). Replays the PROVEN production
// failure: Fixup Group ext 103, linkedId 1787609370.20746, 2026-08-24 18:09 ET.
// The user tapped Answer on an iPhone that had re-registered 4.3 s after the
// PBX committed its dial list; the fresh contact was in the registry; Mode-B
// refused `not_direct_extension` because the app fork is dialed from
// `connect-mobile-wake-dial` — a context that did not exist when the gate was
// written — and `extLegAor` had captured the DESK AOR. These tests drive the
// real `requeueLiveCallToDialplan` against the real CallStateStore/registry.
//
// ⛔ Non-vacuity: the "redirects" test FAILS replayed against the pre-change
// TelephonyService (it skips `extension_leg_already_live`), which is the proof
// this suite is not decorative.

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
  const svc = new TelephonyService(
    ami,
    ari,
    calls,
    {} as unknown as ExtensionStateStore,
    {} as unknown as QueueStateStore,
  );
  // Shrink the Mode-B waits so tests run in milliseconds (test-only knobs).
  svc.modeBFreshContactWaitMs = 60;
  svc.modeBFreshContactPollMs = 5;
  svc.modeBAnswerGraceMs = 40;
  svc.modeBAnswerGracePollMs = 5;
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
    callerIDNum: "8456993907",
    callerIDName: "Caller",
    connectedLineNum: "",
    connectedLineName: "",
    context,
    exten,
    tenantId: "cmqr9cs9402qqs013m7p64lpi",
    tenantSlug: "fixup_group",
    tenantName: "Fixup Group",
    direction: "inbound",
  });
}

const TRUNK = "PJSIP/344022_Comfortcont-000029b3";
const DESK_LEG = "PJSIP/T31_103-000029b4";
const APP_LEG = "PJSIP/T31_103_1-000029b6";
const WAKE_LOCAL_1 = "Local/T31_103_1@connect-mobile-wake-dial-0000120f;1";
const WAKE_LOCAL_2 = "Local/T31_103_1@connect-mobile-wake-dial-0000120f;2";
const DESK_URI = "sip:T31_103@159.89.179.105:28208";
const DESKTOP_APP_URI = "sip:p13utp95@50.122.143.130:15880";
const ANDROID_URI = "sip:5prquhca@192.157.90.181:60328";
const FRESH_IPHONE_URI = "sip:pai9lf84@174.216.244.213:5360";

/**
 * Rebuild the real Fixup Group call shape: trunk → IVR → direct extension dial
 * (`sub-local-dialing`) forking desk contacts + the wake-dial Local pair, whose
 * ;2 side dials the app AOR's contacts. Metadata lands through the SAME
 * DialBegin capture production uses, so `extLegAor` really is the DESK AOR and
 * `extLegDialContext` really is `connect-mobile-wake-dial` — the two captured
 * values the wake-leg shape must survive.
 */
function setupFixupShape(opts?: { trunkDialContext?: string }): {
  svc: TelephonyService;
  calls: CallStateStore;
  sent: SentAction[];
  linkedId: string;
  extLegDialedAt: number;
  addFreshIphoneContact: (afterMs?: number) => void;
} {
  const { svc, calls, sent } = makeService();
  const linkedId = "1787609370.20746";
  const trunkDialContext = opts?.trunkDialContext ?? "sub-local-dialing";

  addChannel(calls, linkedId, "u-trunk", TRUNK, "Up", "8458067040", "trk-37-in");
  // The trunk leg's Dial() into the extension (or ring group, per opts): forks
  // the desk contacts and the wake-dial Local channel.
  calls.onDialBegin({
    linkedId,
    callerIDNum: "8456993907",
    destination: DESK_LEG,
    channel: TRUNK,
    context: trunkDialContext,
    exten: "103",
    dialString: `T31_103/${DESK_URI};rinstance=61C3F00B;x-ast-orig-host=10.65.30.2:28208`,
  });
  addChannel(calls, linkedId, "u-desk", DESK_LEG, "Ringing", "s", "T31_cos-all");
  addChannel(calls, linkedId, "u-wl1", WAKE_LOCAL_1, "Ringing", "T31_103_1", "connect-mobile-wake-dial");
  addChannel(calls, linkedId, "u-wl2", WAKE_LOCAL_2, "Up", "T31_103_1", "connect-mobile-wake-dial");
  // The wake-dial ;2 side dials the app AOR's contacts (frozen at t=0 — the
  // iPhone is NOT among them; that freeze is the whole incident).
  calls.onDialBegin({
    linkedId,
    callerIDNum: "8456993907",
    destination: APP_LEG,
    channel: WAKE_LOCAL_2,
    context: "connect-mobile-wake-dial",
    exten: "T31_103_1",
    dialString: `T31_103_1/${DESKTOP_APP_URI};transport=ws;x-ast-orig-host=duaguj4kf5s5.invalid:0`,
  });
  calls.onDialBegin({
    linkedId,
    callerIDNum: "8456993907",
    destination: "PJSIP/T31_103_1-000029b7",
    channel: WAKE_LOCAL_2,
    context: "connect-mobile-wake-dial",
    exten: "T31_103_1",
    dialString: `T31_103_1/${ANDROID_URI};transport=ws;x-ast-orig-host=2jnb2vn71rc8.invalid:0`,
  });
  addChannel(calls, linkedId, "u-app", APP_LEG, "Ringing", "s", "T31_cos-all");

  const extLegDialedAt =
    (calls.getById(linkedId)?.metadata["extLegDialedAt"] as number) ?? Date.now();
  const addFreshIphoneContact = (afterMs = 4300): void => {
    // The woken iPhone registers a brand-new contact on the APP AOR after the
    // dial — the behavioural signature that separates it from every stale
    // contact (which by definition existed before the dial).
    svc.contactRegistry.record("T31_103_1", FRESH_IPHONE_URI, "Created", extLegDialedAt + afterMs);
  };
  return { svc, calls, sent, linkedId, extLegDialedAt, addFreshIphoneContact };
}

// ── resolveWakeDialLeg (pure) ────────────────────────────────────────────────

test("resolveWakeDialLeg parses the wake channel and dedupes the ;1/;2 pair", () => {
  const leg = resolveWakeDialLeg([TRUNK, DESK_LEG, WAKE_LOCAL_1, WAKE_LOCAL_2], "103");
  assert.deepEqual(leg, { aor: "T31_103_1", pbxCode: "T31", ext: "103" });
});

test("resolveWakeDialLeg fails closed when the named extension has no wake leg", () => {
  assert.equal(resolveWakeDialLeg([WAKE_LOCAL_1, WAKE_LOCAL_2], "104"), null);
});

test("resolveWakeDialLeg without preferExt accepts a single AOR and refuses ambiguity", () => {
  assert.deepEqual(resolveWakeDialLeg([WAKE_LOCAL_2], null), {
    aor: "T31_103_1",
    pbxCode: "T31",
    ext: "103",
  });
  assert.equal(
    resolveWakeDialLeg(
      [WAKE_LOCAL_2, "Local/T31_104_1@connect-mobile-wake-dial-00000abc;2"],
      null,
    ),
    null,
    "two wake AORs with no extension named must fail closed",
  );
  assert.equal(resolveWakeDialLeg([TRUNK, DESK_LEG], "103"), null);
});

// ── The Fixup replay: the fix itself ─────────────────────────────────────────

test("wake-leg shape REDIRECTS the trunk to T31_cos-all,103 (the 2026-08-24 Fixup failure now rescues)", async () => {
  const { svc, sent, linkedId, addFreshIphoneContact } = setupFixupShape();
  addFreshIphoneContact();

  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "103",
    fallbackContext: "trk-37-in",
    trigger: "invite_accept",
  });

  assert.equal(result.skipped, false, `expected redirect, got skip: ${result.skipReason}`);
  assert.equal(result.context, "T31_cos-all");
  assert.equal(result.exten, "103", "exten must be the EXTENSION NUMBER, never the endpoint name");
  const redirects = sent.filter((s) => s.action === "Redirect");
  assert.equal(redirects.length, 1);
  assert.equal(redirects[0].params["Channel"], TRUNK, "the redirect channel is the trunk leg");
  assert.equal(redirects[0].params["Context"], "T31_cos-all");
  assert.equal(redirects[0].params["Exten"], "103");
});

test("a normal answer landing during the grace stands the redirect down", async () => {
  const { svc, calls, sent, linkedId, addFreshIphoneContact } = setupFixupShape();
  addFreshIphoneContact();

  const pending = svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "103",
    fallbackContext: "trk-37-in",
    trigger: "invite_accept",
  });
  // Mid-grace, a device answers the ordinary way (SIP 200 → extensionAnsweredAt).
  await new Promise((r) => setTimeout(r, 10));
  const call = calls.getById(linkedId);
  assert.ok(call);
  call.extensionAnsweredAt = new Date().toISOString();

  const result = await pending;
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "answered_during_grace");
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    0,
    "a redirect must never race a live answer",
  );
});

test("no fresh contact -> still refused (stale contacts alone can never trigger)", async () => {
  const { svc, sent, linkedId } = setupFixupShape();
  // No registration after the dial: only the frozen dialed contacts exist.
  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "103",
    fallbackContext: "trk-37-in",
    trigger: "invite_accept",
  });
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "extension_leg_already_live");
  assert.equal(sent.filter((s) => s.action === "Redirect").length, 0);
});

test("a re-register of an ALREADY-DIALED contact is not a fresh contact", async () => {
  const { svc, sent, linkedId, extLegDialedAt } = setupFixupShape();
  // The Android merely re-qualifies/re-registers the exact contact the leg was
  // dialed to — the 2026-06-28 trap. Must not trigger.
  svc.contactRegistry.record("T31_103_1", ANDROID_URI, "Reachable", extLegDialedAt + 4000);
  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "103",
    fallbackContext: "trk-37-in",
    trigger: "invite_accept",
  });
  assert.equal(result.skipped, true);
  assert.equal(sent.filter((s) => s.action === "Redirect").length, 0);
});

test("ring-group trunk position keeps the wake shape OFF (RSBK loop stays impossible)", async () => {
  const { svc, sent, linkedId, addFreshIphoneContact } = setupFixupShape({
    trunkDialContext: "T31_ext-ringgroups",
  });
  addFreshIphoneContact();
  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "103",
    fallbackContext: "trk-37-in",
    trigger: "invite_accept",
  });
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "extension_leg_already_live");
  assert.equal(sent.filter((s) => s.action === "Redirect").length, 0);
});

test("fallbackExten naming a different extension fails closed", async () => {
  const { svc, sent, linkedId, addFreshIphoneContact } = setupFixupShape();
  addFreshIphoneContact();
  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "104",
    fallbackContext: "trk-37-in",
    trigger: "invite_accept",
  });
  assert.equal(result.skipped, true);
  assert.equal(sent.filter((s) => s.action === "Redirect").length, 0);
});

test("a bare device_register_complete can never trigger the wake shape (the 2026-06-28 revert)", async () => {
  const { svc, sent, linkedId, addFreshIphoneContact } = setupFixupShape();
  addFreshIphoneContact();
  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "103",
    fallbackContext: "trk-37-in",
    trigger: "device_register_complete",
  });
  assert.equal(result.skipped, true);
  assert.equal(sent.filter((s) => s.action === "Redirect").length, 0);
});

test("one-shot: a second invite_accept after the redirect is refused", async () => {
  const { svc, sent, linkedId, addFreshIphoneContact } = setupFixupShape();
  addFreshIphoneContact();
  const first = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "103",
    fallbackContext: "trk-37-in",
    trigger: "invite_accept",
  });
  assert.equal(first.skipped, false);
  const second = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "103",
    fallbackContext: "trk-37-in",
    trigger: "invite_accept",
  });
  assert.equal(second.skipped, true);
  assert.equal(
    sent.filter((s) => s.action === "Redirect").length,
    1,
    "exactly one Redirect per call, ever",
  );
});

test("an answered call is never disturbed (extensionAnsweredAt gate still dominates)", async () => {
  const { svc, calls, sent, linkedId, addFreshIphoneContact } = setupFixupShape();
  addFreshIphoneContact();
  const call = calls.getById(linkedId);
  assert.ok(call);
  call.extensionAnsweredAt = new Date().toISOString();
  const result = await svc.requeueLiveCallToDialplan({
    linkedId,
    fallbackExten: "103",
    fallbackContext: "trk-37-in",
    trigger: "invite_accept",
  });
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "extension_already_answered");
  assert.equal(sent.filter((s) => s.action === "Redirect").length, 0);
});

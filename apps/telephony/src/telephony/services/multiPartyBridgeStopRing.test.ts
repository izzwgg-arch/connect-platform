/**
 * Guards for the SECOND half of Hanna's dropped-answer bug (2026-08-21) — the
 * half that was still live on 2026-08-23 with the answeredEndpoint fix deployed.
 *
 * ⛔⛔ THE DEFECT. `MobilePushNotifier` decided "somebody answered, stop ringing"
 * with:
 *
 *     call.extensionAnsweredAt != null || call.bridgeIds.length > 0
 *
 * `bridgeIds` is pushed on EVERY BridgeEnter — including the first channel
 * entering a bridge ALONE (music-on-hold, parking, an announcement), which
 * happens before anyone answers. So the one-shot stop-ring fired one event too
 * early, while `extensionAnsweredChannel` was still null, and the payload's
 * `answeredEndpoint` went out BLANK. The api could then not tell that the
 * answerer was the invited app, so it cancelled the invite and pushed
 * INVITE_CANCELED at the very phone that had just answered.
 *
 * Live proof (Create A Box ext 102, 2026-08-23, pbxCallId 1787515311.13805):
 *   20:02:00.973  telephony -> api "answered_elsewhere"   (answeredEndpoint null)
 *   20:02:00.982  extensionAnsweredChannel finally recorded — 9 ms too late
 *   20:02:01.344  api queues INVITE_CANCELED at the answering phone
 *
 * ⛔ The fix must NOT be "wait until we know who answered". In the follow-me /
 * virtual-extension case the customer answers on their CARRIER phone and NO
 * tenant extension leg ever answers, so a wait would never resolve and the app
 * would ring forever after pickup — the 2026-07-29 complaint. The fix is to test
 * a REAL two-party bridge (`multiPartyBridgeAt`), which is set in the same
 * handler that resolves the answering channel and BEFORE its emit.
 *
 * Run: pnpm --filter @connect/telephony test
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.JWT_SECRET = "x".repeat(32);
process.env.AMI_USERNAME = "test";
process.env.AMI_PASSWORD = "test";
process.env.ARI_BASE_URL = "http://test.invalid";
process.env.ARI_USERNAME = "test";
process.env.ARI_PASSWORD = "test";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";

// TELEPHONY_GUARD_ROOT lets these guards be replayed against a checkout of an
// older tree — the only way to prove they are not decorative. Proven against the
// pre-fix tree: the first three fail there.
const GUARD_ROOT = process.env.TELEPHONY_GUARD_ROOT;
const read = (rel: string) => {
  const base = GUARD_ROOT ? join(GUARD_ROOT, "services") : __dirname;
  return readFileSync(join(base, rel), "utf8").replace(new RegExp("\\r\\n", "g"), "\n");
};

/** Negative assertions must not match the comment that explains the old defect. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

test("the stop-ring must NOT be triggered by bridgeIds being non-empty", () => {
  const src = stripComments(read("./MobilePushNotifier.ts"));
  const decl = /const answeredByAnyParty\s*=([\s\S]{0,300}?);/.exec(src);
  assert.ok(decl, "answeredByAnyParty is gone — MobilePushNotifier was restructured");
  assert.ok(
    !/bridgeIds/.test(decl[1]),
    "answeredByAnyParty still reads bridgeIds — that is non-empty one BridgeEnter " +
      "before anyone answers, which fires the stop-ring with a blank answeredEndpoint " +
      "and cancel-pushes the phone that just answered (Hanna 2026-08-21 / 2026-08-23)",
  );
});

test("the stop-ring still fires for a follow-me answer (no extension leg ever answers)", () => {
  // Both arms must survive. The extension arm covers desk/app answers; the
  // bridge arm is the ONLY signal for the carrier-phone answer, and removing it
  // would leave the app ringing after pickup (2026-07-29).
  const src = stripComments(read("./MobilePushNotifier.ts"));
  const decl = /const answeredByAnyParty\s*=([\s\S]{0,300}?);/.exec(src);
  assert.ok(decl);
  assert.ok(
    /extensionAnsweredAt/.test(decl[1]),
    "lost the extension-answer arm",
  );
  assert.ok(
    /multiPartyBridgeAt/.test(decl[1]),
    "lost the bridged-to-an-answering-party arm — follow-me answers would never stop the ring",
  );
});

test("multiPartyBridgeAt is stamped ONLY inside the >= 2 channels branch", () => {
  const src = stripComments(read("../state/CallStateStore.ts"));
  const stamps = src.split("multiPartyBridgeAt = new Date().toISOString()").length - 1;
  assert.strictEqual(stamps, 1, "expected exactly one multiPartyBridgeAt stamp");

  const guardAt = src.indexOf('parseInt(params.bridgeNumChannels, 10) >= 2');
  const stampAt = src.indexOf("multiPartyBridgeAt = new Date().toISOString()");
  assert.ok(guardAt > 0, "the >= 2 branch is gone");
  assert.ok(
    stampAt > guardAt,
    "multiPartyBridgeAt must be stamped INSIDE the two-party branch — stamping it " +
      "on any BridgeEnter reintroduces the exact bug this file guards",
  );
});

test("the answering channel is resolved BEFORE the callUpsert that carries it", () => {
  // This ordering is the whole fix: any consumer reading multiPartyBridgeAt off
  // that emit is guaranteed to see extensionAnsweredChannel too.
  const src = stripComments(read("../state/CallStateStore.ts"));
  const from = src.indexOf('parseInt(params.bridgeNumChannels, 10) >= 2');
  const region = src.slice(from);
  const channelAt = region.indexOf("extensionAnsweredChannel =");
  const emitAt = region.indexOf('this.emit("callUpsert"');
  assert.ok(channelAt > 0, "extensionAnsweredChannel is no longer resolved in onBridgeEnter");
  assert.ok(emitAt > 0, "the callUpsert emit is gone from onBridgeEnter");
  assert.ok(
    channelAt < emitAt,
    "extensionAnsweredChannel must be set before the emit, or answeredEndpoint ships blank",
  );
});

test("REPLAY: the live 2026-08-23 failure resolves to the answering app endpoint", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { answeredEndpointFromChannel } =
    require("./MobilePushNotifier") as typeof import("./MobilePushNotifier");
  // The channel that answered Sender's call — a wake-dial app leg.
  const endpoint = answeredEndpointFromChannel("PJSIP/T7_102_1-00001b93");
  assert.strictEqual(endpoint, "T7_102_1");

  // And the api's rule must read that as "the invited app answered", so the
  // invite is marked ACCEPTED with no cancel push. Mirrors
  // apps/api/src/mobileRingAnswerPolicy.ts inviteFulfilledByOwnApp.
  const m = /^T\d+_(\d+)_\d+$/i.exec(endpoint!);
  assert.ok(m, "endpoint must carry a device suffix");
  assert.strictEqual(m![1], "102", "must match the invite's toExtension");

  // A DESK answer has no device suffix and must still cancel-push the apps.
  const desk = answeredEndpointFromChannel("PJSIP/T7_102-00001b8f");
  assert.strictEqual(desk, "T7_102");
  assert.strictEqual(/^T\d+_(\d+)_\d+$/i.test(desk!), false);
});

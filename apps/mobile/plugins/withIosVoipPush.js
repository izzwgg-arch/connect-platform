// Expo config plugin that wires react-native-voip-push-notification AND
// react-native-callkeep into the iOS AppDelegate produced by `expo prebuild -p
// ios`. Both libraries auto-link via CocoaPods (no Podfile patches needed) but:
//   • PushKit does NOT auto-deliver tokens — Apple requires the AppDelegate to
//     implement PKPushRegistryDelegate and forward events to
//     RNVoipPushNotificationManager.
//   • A VoIP push MUST report a CallKit call BEFORE the PushKit completion
//     handler returns, or iOS terminates / bans the app. JS-only reporting is
//     NOT sufficient for a fully cold-killed app (JS has not booted yet), so the
//     `didReceiveIncomingPushWithPayload` patch below reports to CallKit
//     natively via `[RNCallKeep reportNewIncomingCall:…]` using a UUID derived
//     deterministically from the push `callId` (ConnectDeterministicCallKitUUID,
//     kept in lockstep with apps/mobile/src/sip/callkitUuid.ts).
// Expo regenerates AppDelegate on every prebuild, so we inject all of this here
// with sentinel-guarded idempotent patches. Re-runs are no-ops.
//
// IMPORTANT: this plugin is iOS-only. Android builds that import it will get
// the unchanged config object back (the `withMod` wrappers below do nothing
// when platform === 'android'). Android's incoming-call story lives in
// plugins/withIncomingCallService.js — this plugin deliberately does not
// touch it.
//
// AppDelegate language: SDK 51 emits Objective-C++ (.mm), which we fully patch.
// If a Swift AppDelegate is generated, we FAIL LOUDLY (see withIosVoipPush
// below) rather than silently no-op, because that would leave cold-killed calls
// unable to ring. Verify the generated language on the first EAS build.
//
// Post-prebuild checklist (the pieces outside this plugin's reach):
//   1. `UIBackgroundModes` includes 'voip' — already declared in
//      apps/mobile/app.config.ts (ios.infoPlist).
//   2. Your Apple Developer team must issue a VoIP Services Certificate OR
//      enable VoIP topic on your APNs Auth Key. The VoIP topic is
//      `<bundleId>.voip` (i.e. com.connectcommunications.mobile.voip).
//   3. The Connect worker sends VoIP pushes directly to APNs with
//      `apns-push-type: voip` — IMPLEMENTED in apps/worker/src/apnsVoipPush.ts
//      (Phase 1). Set the APNS_* env vars for it to fire.
//
// If any of those are missing, the token still registers on iOS but no inbound
// push will wake the app when it's backgrounded or killed.
const { withAppDelegate, withEntitlementsPlist } = require('@expo/config-plugins');

/** Begin/end sentinels let us detect and re-apply the patch safely even if
 *  an engineer hand-edits AppDelegate.mm between prebuilds. */
const PATCH_BEGIN = '// CONNECT_VOIP_PUSH_BEGIN';
const PATCH_END = '// CONNECT_VOIP_PUSH_END';

const IMPORT_BLOCK = `
${PATCH_BEGIN}
#import <PushKit/PushKit.h>
#import <RNVoipPushNotificationManager.h>
#import "RNCallKeep.h"
#include <string.h>
#include <stdint.h>

// Deterministic CallKit UUID from a backend callId. MUST stay byte-for-byte
// identical to the JS algorithm in apps/mobile/src/sip/callkitUuid.ts
// (FNV-1a-32 per output byte over [i, ...utf8(callId)], fold to 8 bits, set
// RFC-4122 version 5 + variant bits, format 8-4-4-4-12). Cold-killed VoIP pushes
// are reported to CallKit from native code BEFORE JS boots, so native and JS
// must derive the same UUID with no shared state.
// LOCKED reference vector: "call-123" => bcbdbb23-3b75-50f2-a5ad-b6d46bada693
static NSString *ConnectDeterministicCallKitUUID(NSString *callId)
{
  const char *cstr = [callId UTF8String];
  if (cstr == NULL) { cstr = ""; }
  size_t baseLen = strlen(cstr);
  unsigned char out[16];
  for (int i = 0; i < 16; i++) {
    uint32_t h = 0x811c9dc5u;
    h ^= (uint32_t)((unsigned char)i);
    h = h * 0x01000193u;
    for (size_t j = 0; j < baseLen; j++) {
      h ^= (uint32_t)((unsigned char)cstr[j]);
      h = h * 0x01000193u;
    }
    out[i] = (unsigned char)((h ^ (h >> 8) ^ (h >> 16) ^ (h >> 24)) & 0xFFu);
  }
  out[6] = (unsigned char)((out[6] & 0x0F) | 0x50);
  out[8] = (unsigned char)((out[8] & 0x3F) | 0x80);
  return [NSString stringWithFormat:
    @"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
    out[0], out[1], out[2], out[3], out[4], out[5], out[6], out[7],
    out[8], out[9], out[10], out[11], out[12], out[13], out[14], out[15]];
}
${PATCH_END}
`;

/** Inserted INSIDE application:didFinishLaunchingWithOptions: — registers
 *  the app with PushKit so iOS will deliver VoIP push tokens to this
 *  AppDelegate's PKPushRegistryDelegate methods below. */
const DID_LAUNCH_INJECT = `
  ${PATCH_BEGIN}
  // PushKit VoIP push registration — see plugins/withIosVoipPush.js.
  [RNVoipPushNotificationManager voipRegistration];
  ${PATCH_END}
`;

/** The three PKPushRegistryDelegate methods that forward every event into
 *  RNVoipPushNotificationManager so JS can subscribe via
 *  `VoipPushNotification.addEventListener(...)`. */
const DELEGATE_METHODS = `
${PATCH_BEGIN}
// --- PKPushRegistryDelegate (VoIP push → RNVoipPushNotification) ---------
- (void)pushRegistry:(PKPushRegistry *)registry didUpdatePushCredentials:(PKPushCredentials *)credentials forType:(NSString *)type
{
  [RNVoipPushNotificationManager didUpdatePushCredentials:credentials forType:(NSString *)type];
}

- (void)pushRegistry:(PKPushRegistry *)registry didInvalidatePushTokenForType:(PKPushType)type
{
  [RNVoipPushNotificationManager didInvalidatePushTokenForType:(NSString *)type];
}

- (void)pushRegistry:(PKPushRegistry *)registry didReceiveIncomingPushWithPayload:(PKPushPayload *)payload forType:(PKPushType)type withCompletionHandler:(void (^)(void))completion
{
  // Apple REQUIRES that every VoIP push reports a CallKit call BEFORE the
  // completion handler returns, or iOS terminates / bans the app. We therefore
  // report to CallKit natively here — this is what makes a FULLY COLD-KILLED
  // iPhone ring, because JS has not booted yet at this point.
  NSDictionary *dict = payload.dictionaryPayload;
  NSString *callId = dict[@"callId"];
  if (callId == nil || callId.length == 0) { callId = dict[@"inviteId"]; }
  NSString *callerNumber = dict[@"callerNumber"];
  if (callerNumber == nil) { callerNumber = @""; }
  NSString *callerName = dict[@"callerName"];
  if (callerName == nil || callerName.length == 0) { callerName = callerNumber; }
  NSString *handle = (callerNumber.length > 0) ? callerNumber : @"Unknown";

  if (callId != nil && callId.length > 0) {
    NSString *uuid = ConnectDeterministicCallKitUUID(callId);
    [RNCallKeep reportNewIncomingCall:uuid
                               handle:handle
                           handleType:@"number"
                             hasVideo:NO
                  localizedCallerName:(callerName.length > 0 ? callerName : nil)
                      supportsHolding:YES
                         supportsDTMF:YES
                     supportsGrouping:NO
                   supportsUngrouping:NO
                          fromPushKit:YES
                              payload:dict
                withCompletionHandler:nil];
  }

  // Deliver the same payload to JS so NotificationsContext can hydrate invite
  // state and drive the EXISTING answer/decline pipeline. JS uses the same
  // deterministic UUID, so it reconciles with the call already reported above
  // instead of creating a second CallKit call.
  [RNVoipPushNotificationManager didReceiveIncomingPushWithPayload:payload forType:(NSString *)type];

  // Report has already happened above (Apple's "report before completion" rule
  // is satisfied even for a cold-killed launch).
  completion();
}
${PATCH_END}
`;

/** Return the AppDelegate contents with our three patches applied. If the
 *  patches are already present we return the input unchanged so re-runs of
 *  `expo prebuild` are truly no-op. If an anchor we depend on is missing
 *  (Expo changed the AppDelegate template), we log and return the input
 *  unchanged rather than corrupting the file. */
function patchAppDelegate(contents) {
  if (contents.includes(PATCH_BEGIN)) {
    return contents;
  }

  let out = contents;

  // 1. Imports — inject after the `#import "AppDelegate.h"` line so we're
  // at the top of the file and unaffected by future import re-ordering.
  const importAnchor = /(#import\s+"AppDelegate\.h"\s*\n)/;
  if (!importAnchor.test(out)) {
    console.warn('[withIosVoipPush] Could not find #import "AppDelegate.h" anchor — skipping AppDelegate patch.');
    return contents;
  }
  out = out.replace(importAnchor, (m) => `${m}${IMPORT_BLOCK}`);

  // 2. didFinishLaunchingWithOptions — insert the voipRegistration call
  // just before the `return [super application:...]` line, which every
  // Expo-generated AppDelegate ends with.
  const didLaunchAnchor = /(\n\s*return\s+\[super\s+application:application\s+didFinishLaunchingWithOptions:launchOptions\];)/;
  if (!didLaunchAnchor.test(out)) {
    console.warn('[withIosVoipPush] Could not find didFinishLaunchingWithOptions return anchor — skipping injection.');
    return contents;
  }
  out = out.replace(didLaunchAnchor, (m) => `\n${DID_LAUNCH_INJECT}${m}`);

  // 3. Delegate methods — insert immediately before the final `@end` of
  // the AppDelegate @implementation. Expo's AppDelegate has a single `@end`
  // at the very bottom so the lastIndexOf match is safe.
  const endIdx = out.lastIndexOf('\n@end');
  if (endIdx === -1) {
    console.warn('[withIosVoipPush] Could not find trailing @end — skipping delegate method injection.');
    return contents;
  }
  out = out.slice(0, endIdx) + `\n${DELEGATE_METHODS}\n` + out.slice(endIdx);

  return out;
}

/** Expo config plugin entry point. Chains two mods:
 *   - withAppDelegate: patches AppDelegate.mm with the PushKit wiring.
 *   - withEntitlementsPlist: currently a no-op but reserved for future
 *     entitlement work (e.g. aps-environment already handled by EAS). */
const withIosVoipPush = (config) => {
  config = withAppDelegate(config, (mod) => {
    // Expo SDK 51 emits an Objective-C++ AppDelegate.mm by default, but newer
    // templates (and some prebuild paths) emit a Swift AppDelegate. We do NOT
    // blindly assume .mm — we branch on modResults.language and FAIL LOUDLY for
    // anything we can't safely patch, because a silently-skipped patch means a
    // fully cold-killed iPhone will not ring (the native CallKit report is the
    // only Apple-compliant way to wake a terminated app).
    const language = mod.modResults.language;
    if (language === 'objc' || language === 'objcpp') {
      const before = mod.modResults.contents;
      const after = patchAppDelegate(before);
      mod.modResults.contents = after;
      if (after.includes(PATCH_BEGIN)) {
        console.log(
          '[withIosVoipPush] Objective-C++ AppDelegate patched: PushKit + native CallKit reportNewIncomingCall wired.'
        );
      } else {
        console.error(
          '[withIosVoipPush] ERROR: Objective-C++ AppDelegate patch did NOT apply (anchors not found). ' +
          'Cold-killed VoIP calls will NOT ring. Inspect the generated ios/*/AppDelegate.mm and update the ' +
          'anchors in plugins/withIosVoipPush.js before shipping.'
        );
      }
    } else if (language === 'swift') {
      // Swift AppDelegate detected. We do not auto-patch Swift here because the
      // PushKit + RNCallKeep bridging differs substantially and cannot be
      // verified without an EAS/prebuild on macOS. Surface a loud, actionable
      // failure rather than a silent no-op.
      console.error(
        '\n========================================================================\n' +
        '[withIosVoipPush] SWIFT AppDelegate DETECTED — native VoIP/CallKit NOT wired.\n' +
        'A Swift AppDelegate requires a Swift port of the PushKit handler that calls\n' +
        'RNCallKeep.reportNewIncomingCall(...) with the deterministic UUID derived from\n' +
        'the push `callId` (see apps/mobile/src/sip/callkitUuid.ts) BEFORE the PushKit\n' +
        'completion handler returns. Until that port exists, fully COLD-KILLED incoming\n' +
        'calls will NOT ring on iOS (foreground/warm-background still work via JS).\n' +
        'Action: add a Swift branch to plugins/withIosVoipPush.js after confirming the\n' +
        'generated AppDelegate.swift structure on the first EAS ios-dev-device build.\n' +
        '========================================================================\n'
      );
    } else {
      console.error(
        `[withIosVoipPush] ERROR: Unrecognized AppDelegate language "${language}" — patch skipped. ` +
        'Cold-killed VoIP calls will not ring. Update plugins/withIosVoipPush.js.'
      );
    }
    return mod;
  });

  // Keep this mod chained even when no-op: future VoIP entitlements (e.g.
  // App Group for call history sharing) can be added here without touching
  // app.config.ts or AppDelegate.
  config = withEntitlementsPlist(config, (mod) => {
    return mod;
  });

  return config;
};

module.exports = withIosVoipPush;

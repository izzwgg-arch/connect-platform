// Expo config plugin that wires react-native-voip-push-notification into the
// iOS AppDelegate produced by `expo prebuild -p ios`. The library itself
// auto-links via CocoaPods (no Podfile patches needed) but PushKit does NOT
// auto-deliver tokens — Apple requires the app's AppDelegate to implement
// PKPushRegistryDelegate and forward events to RNVoipPushNotificationManager.
// Expo regenerates AppDelegate.mm on every prebuild, so we inject those
// forwards here with sentinel-guarded idempotent patches. Re-runs are no-ops.
//
// IMPORTANT: this plugin is iOS-only. Android builds that import it will get
// the unchanged config object back (the `withMod` wrappers below do nothing
// when platform === 'android'). Android's incoming-call story lives in
// plugins/withIncomingCallService.js — this plugin deliberately does not
// touch it.
//
// Post-prebuild checklist (the pieces outside this plugin's reach):
//   1. `UIBackgroundModes` includes 'voip' — already declared in
//      apps/mobile/app.config.ts (ios.infoPlist).
//   2. Your Apple Developer team must issue a VoIP Services Certificate OR
//      enable VoIP topic on your APNs Auth Key. The VoIP topic is
//      `<bundleId>.voip` (i.e. com.connectcommunications.mobile.voip).
//   3. The Connect worker must send VoIP pushes directly to APNs (Expo's
//      push relay does not carry VoIP push type). TODO in apps/worker.
//
// If any of those three are missing, the token will still register on iOS
// but no actual inbound push will wake the app when it's backgrounded or
// killed. That's the expected dependency chain — this plugin is step 1.
const { withAppDelegate, withEntitlementsPlist } = require('@expo/config-plugins');

/** Begin/end sentinels let us detect and re-apply the patch safely even if
 *  an engineer hand-edits AppDelegate.mm between prebuilds. */
const PATCH_BEGIN = '// CONNECT_VOIP_PUSH_BEGIN';
const PATCH_END = '// CONNECT_VOIP_PUSH_END';

const IMPORT_BLOCK = `
${PATCH_BEGIN}
#import <PushKit/PushKit.h>
#import <RNVoipPushNotificationManager.h>
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
  // Deliver to JS first so the app can post the CallKit call update, then
  // invoke completion() so iOS doesn't terminate us for a late report.
  [RNVoipPushNotificationManager didReceiveIncomingPushWithPayload:payload forType:(NSString *)type];
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
    // AppDelegate.mm is Objective-C++; Expo may also emit AppDelegate.swift
    // in the future. The modResults.language field distinguishes them.
    if (mod.modResults.language === 'objc' || mod.modResults.language === 'objcpp') {
      mod.modResults.contents = patchAppDelegate(mod.modResults.contents);
    } else {
      console.warn(
        `[withIosVoipPush] AppDelegate language is "${mod.modResults.language}" — patch skipped. ` +
        'Update plugins/withIosVoipPush.js to support Swift before shipping.'
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

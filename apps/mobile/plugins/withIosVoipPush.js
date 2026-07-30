// iOS VoIP push wiring — SDK 54+ shape.
//
// HISTORY: through Expo SDK 51 this plugin string-patched the Objective-C++
// AppDelegate.mm with the whole PushKit + CallKit handler. SDK 54 generates a
// SWIFT AppDelegate, so the battle-tested ObjC++ code moved VERBATIM into the
// local Expo module at modules/connect-voip/ (ConnectVoipPushHandler.mm), and
// is installed at launch by ConnectVoipAppDelegateSubscriber via Expo's
// AppDelegateSubscriber mechanism. The module owns its own PKPushRegistry —
// the app delegate is no longer involved at all.
//
// This plugin now only:
//   1. FAILS THE PREBUILD LOUDLY if the local module is missing (a silently
//      absent module means fully cold-killed iPhones will not ring — the exact
//      failure mode the old fail-loud Swift branch guarded against).
//   2. Keeps the entitlements chain (reserved for future VoIP entitlements —
//      aps-environment itself is handled by EAS).
//
// Post-prebuild checklist (unchanged):
//   1. `UIBackgroundModes` includes 'voip' — app.config.ts ios.infoPlist.
//   2. Apple VoIP topic = <bundleId>.voip on the APNs key.
//   3. Server sends VoIP pushes with `apns-push-type: voip` (worker/api).
const { withEntitlementsPlist } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const withIosVoipPush = (config) => {
  const moduleDir = path.join(__dirname, '..', 'modules', 'connect-voip');
  const required = [
    'expo-module.config.json',
    path.join('ios', 'ConnectVoip.podspec'),
    path.join('ios', 'ConnectVoipPushHandler.mm'),
    path.join('ios', 'ConnectVoipAppDelegateSubscriber.swift'),
  ];
  const missing = required.filter((f) => !fs.existsSync(path.join(moduleDir, f)));
  if (missing.length > 0) {
    throw new Error(
      '[withIosVoipPush] FATAL: local module modules/connect-voip is incomplete — missing: ' +
        missing.join(', ') +
        '. Without it PushKit is not wired and cold-killed iPhones will NOT ring. ' +
        'Restore the module before building.'
    );
  }

  // Reserved for future VoIP entitlements (e.g. App Group for call history
  // sharing) — kept chained so they can be added without touching app.config.ts.
  config = withEntitlementsPlist(config, (mod) => {
    return mod;
  });

  return config;
};

module.exports = withIosVoipPush;

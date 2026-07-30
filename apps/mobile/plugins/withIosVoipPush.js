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
#import <CallKit/CallKit.h>
#import <AVFoundation/AVFoundation.h>
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

// True when CallKit reports the given UUID as an ANSWERED, still-live call.
// Used by the server-driven cancel branch below: a cancel push can race the
// user's own answer (PBX "ANSWERED" fans out to every device, including the
// one that just picked up), and ending a connected call here would hang up on
// the user mid-sentence. Ringing (not-yet-connected) calls return NO and are
// ended as usual. Fully wrapped — any failure means "not connected" so the
// cancel still clears a stuck ring.
static BOOL ConnectCallKitCallIsConnected(NSString *uuidStr)
{
  @try {
    NSUUID *target = [[NSUUID alloc] initWithUUIDString:uuidStr];
    if (target == nil) { return NO; }
    CXCallObserver *observer = [[CXCallObserver alloc] init];
    for (CXCall *call in observer.calls) {
      if ([call.UUID isEqual:target] && call.hasConnected && !call.hasEnded) {
        return YES;
      }
    }
  } @catch (NSException *ex) {}
  return NO;
}

// ── In-call loudness guardian (2026-07-30, Izzy: "speaker and earpiece very
// quiet, sounds far away") ──────────────────────────────────────────────────
// ROOT CAUSE: expo-av's EXAudioSessionManager configures the shared
// AVAudioSession with setCategory:withOptions: and NO mode — which iOS defines
// as resetting the session mode to Default. The WebRTC voice pipeline is tuned
// for AVAudioSessionModeVoiceChat (voice-processing gain + receiver/speaker EQ
// for speech); on Default the same call plays several dB quieter and sounds
// distant. Any in-call expo-av touch (DTMF cue, ringback, a voicemail preload
// finishing late) knocked the mode off and it NEVER came back for the rest of
// the call.
// FIX: observe route changes (every category/mode flip triggers one) and snap
// the mode back to VoiceChat whenever a CallKit call is live. The re-assert
// preserves an active loudspeaker route (setCategory clears the speaker
// override, which would have yanked audio back to the earpiece mid-call).
// Self-limiting: our own re-assert triggers one more notification which
// no-ops (mode already VoiceChat). Fully wrapped — can never crash a call.
static BOOL ConnectAnyCallKitCallLive(void)
{
  @try {
    CXCallObserver *observer = [[CXCallObserver alloc] init];
    for (CXCall *call in observer.calls) {
      if (!call.hasEnded) { return YES; }
    }
  } @catch (NSException *ex) {}
  return NO;
}

static void ConnectAssertVoiceChatModeIfInCall(void)
{
  @try {
    if (!ConnectAnyCallKitCallLive()) { return; }
    AVAudioSession *session = [AVAudioSession sharedInstance];
    BOOL categoryOk = [session.category isEqualToString:AVAudioSessionCategoryPlayAndRecord];
    BOOL modeOk = [session.mode isEqualToString:AVAudioSessionModeVoiceChat];
    if (categoryOk && modeOk) { return; }
    BOOL speakerActive = NO;
    for (AVAudioSessionPortDescription *out in session.currentRoute.outputs) {
      if ([out.portType isEqualToString:AVAudioSessionPortBuiltInSpeaker]) { speakerActive = YES; break; }
    }
    NSError *err = nil;
    [session setCategory:AVAudioSessionCategoryPlayAndRecord
                    mode:AVAudioSessionModeVoiceChat
                 options:(AVAudioSessionCategoryOptionAllowBluetooth | AVAudioSessionCategoryOptionAllowBluetoothA2DP)
                   error:&err];
    if (speakerActive) {
      [session overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:nil];
    }
    NSLog(@"[CONNECT_AUDIO] voice-chat mode re-asserted (speaker=%d, categoryWas=%@, err=%@)",
          speakerActive ? 1 : 0, session.category, err);
  } @catch (NSException *ex) {}
}

static void ConnectInstallCallAudioModeGuardian(void)
{
  [[NSNotificationCenter defaultCenter] addObserverForName:AVAudioSessionRouteChangeNotification
                                                    object:nil
                                                     queue:[NSOperationQueue mainQueue]
                                                usingBlock:^(NSNotification *note) {
    // Small defer lets the change that triggered the notification settle
    // before we inspect/correct — avoids fighting a transition mid-flight.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.15 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
      ConnectAssertVoiceChatModeIfInCall();
    });
  }];
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
  // In-call loudness guardian: keeps AVAudioSession in VoiceChat mode during
  // live calls (expo-av knocks it to Default -> quiet/distant audio).
  ConnectInstallCallAudioModeGuardian();
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
  // Optional PKPushRegistryDelegate hook. react-native-voip-push-notification
  // (3.3.x) exposes NO class method for token invalidation, so there is nothing
  // to forward to JS — iOS re-registers and delivers a fresh token via
  // didUpdatePushCredentials on the next registration. (Calling a non-existent
  // +didInvalidatePushTokenForType: is what failed the first Xcode build.)
}

- (void)pushRegistry:(PKPushRegistry *)registry didReceiveIncomingPushWithPayload:(PKPushPayload *)payload forType:(PKPushType)type withCompletionHandler:(void (^)(void))completion
{
  // Apple REQUIRES that every VoIP push reports a CallKit call BEFORE the
  // completion handler returns, or iOS terminates / bans the app. We therefore
  // report to CallKit natively here — this is what makes a FULLY COLD-KILLED
  // iPhone ring, because JS has not booted yet at this point.
  NSDictionary *dict = payload.dictionaryPayload;
  // NSNull-safe: a JSON null decodes to NSNull; calling .length on it throws
  // -[NSNull length] (SIGABRT). Treat non-strings as absent.
  NSString *callId = [dict[@"callId"] isKindOfClass:[NSString class]] ? dict[@"callId"] : nil;
  if (callId == nil || callId.length == 0) {
    callId = [dict[@"inviteId"] isKindOfClass:[NSString class]] ? dict[@"inviteId"] : nil;
  }
  NSString *callerNumber = [dict[@"callerNumber"] isKindOfClass:[NSString class]] ? dict[@"callerNumber"] : @"";
  NSString *callerName = [dict[@"callerName"] isKindOfClass:[NSString class]] ? dict[@"callerName"] : nil;
  if (callerName == nil || callerName.length == 0) { callerName = callerNumber; }
  // CallKit's lock screen shows one line (Apple reserves the second for the
  // app name). NAME FIRST, number after (owner decision 2026-07-30).
  // Kept in lockstep with the JS combine in src/sip/callkeep.ts.
  if (callerName.length > 0 && callerNumber.length > 0 && ![callerName isEqualToString:callerNumber]) {
    callerName = [NSString stringWithFormat:@"%@ \\u00B7 %@", callerName, callerNumber];
  }
  NSString *handle = (callerNumber.length > 0) ? callerNumber : @"Unknown";

  // CONNECT iOS ring-diagnostic breadcrumb (killed-safe). Best-effort and fully
  // wrapped so it can never affect the CallKit report. Appends one JSON line to
  // Documents/connect_ios_ring_log.jsonl, which JS uploads on the next app open
  // (see apps/mobile/src/diagnostics/iosRingLog.ts).
  @try {
    NSArray *cbDocs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    NSString *cbPath = [[cbDocs firstObject] stringByAppendingPathComponent:@"connect_ios_ring_log.jsonl"];
    UIApplicationState cbState = [UIApplication sharedApplication].applicationState;
    NSString *cbStateStr = (cbState == UIApplicationStateActive) ? @"active" : ((cbState == UIApplicationStateBackground) ? @"background" : @"inactive");
    NSDictionary *cbRnck = [[NSUserDefaults standardUserDefaults] dictionaryForKey:@"RNCallKeepSettings"];
    NSString *cbRing = cbRnck[@"ringtoneSound"];
    NSString *cbCaf = [[NSBundle mainBundle] pathForResource:@"connect-default-ringtone" ofType:@"caf"];
    NSDictionary *cbRec = @{
      @"ts": [NSString stringWithFormat:@"%f", [[NSDate date] timeIntervalSince1970]],
      @"src": @"native",
      @"stage": @"IOS_VOIP_PUSH_NATIVE",
      @"appState": cbStateStr,
      @"callId": (callId ? callId : @""),
      @"ringtoneSound": (cbRing ? cbRing : @"<nil>"),
      @"cafPresent": (cbCaf ? @"true" : @"false")
    };
    NSData *cbJson = [NSJSONSerialization dataWithJSONObject:cbRec options:0 error:nil];
    if (cbJson != nil) {
      NSMutableData *cbLine = [NSMutableData dataWithData:cbJson];
      uint8_t cbNL = 0x0A;
      [cbLine appendBytes:&cbNL length:1];
      NSFileManager *cbFm = [NSFileManager defaultManager];
      if (![cbFm fileExistsAtPath:cbPath]) {
        [cbLine writeToFile:cbPath atomically:YES];
      } else {
        NSFileHandle *cbFh = [NSFileHandle fileHandleForWritingAtPath:cbPath];
        if (cbFh != nil) { [cbFh seekToEndOfFile]; [cbFh writeData:cbLine]; [cbFh closeFile]; }
      }
    }
  } @catch (NSException *cbEx) {}

  // COWORK build 20 (2026-07-16, owner request): server-driven CANCEL push.
  // When the caller hangs up, the call is answered on another device, or
  // voicemail takes it, the server sends a VoIP push with cancel="1" so
  // ringing stops IMMEDIATELY — even when JS is suspended (the case where the
  // INVITE_POLL / INVITE_CANCELED FCM can't run). Apple's rule that every
  // VoIP push must report a call is satisfied by re-reporting the primary
  // UUID first — a duplicate report of an already-ringing UUID is a harmless
  // CXProvider error — then ending it right away. The altCallId key covers
  // the sibling report when the same call was reported under both the PBX
  // linkedId and the invite id. Reasons follow RNCallKeep: 2=remote ended,
  // 4=answered elsewhere, 6=missed.
  NSString *cancelFlag = dict[@"cancel"];
  if (cancelFlag != nil && ([cancelFlag isEqualToString:@"1"] || [cancelFlag isEqualToString:@"true"]) && callId != nil && callId.length > 0) {
    int endReason = 2;
    NSString *cancelReason = dict[@"reason"];
    if (cancelReason != nil) {
      if ([cancelReason containsString:@"answered_elsewhere"] || [cancelReason containsString:@"claimed"]) { endReason = 4; }
      else if ([cancelReason containsString:@"voicemail"] || [cancelReason containsString:@"unanswered"] || [cancelReason containsString:@"missed"]) { endReason = 6; }
    }
    NSString *cancelUuid = ConnectDeterministicCallKitUUID(callId);
    // Caller-ID preservation (Izzy 2026-07-30): this re-report UPDATES the
    // already-ringing CallKit call's display. Passing an empty handle / nil
    // name here downgraded the caller ID to "Unknown" for the final second
    // of the ring (and into CallKit-derived history). Use the cancel
    // payload's caller fields (server sends them now), falling back to the
    // identity cached by the original INCOMING report below.
    NSString *cancelHandle = handle;
    NSString *cancelDisplayName = (callerName.length > 0 ? callerName : nil);
    if (callerNumber.length == 0) {
      @try {
        NSDictionary *idCache = [[NSUserDefaults standardUserDefaults] dictionaryForKey:@"ConnectCallerIdCache"];
        NSDictionary *cachedId = [idCache[callId] isKindOfClass:[NSDictionary class]] ? idCache[callId] : nil;
        if (cachedId == nil) {
          NSString *altForCache = [dict[@"altCallId"] isKindOfClass:[NSString class]] ? dict[@"altCallId"] : nil;
          if (altForCache != nil && [idCache[altForCache] isKindOfClass:[NSDictionary class]]) { cachedId = idCache[altForCache]; }
        }
        if (cachedId != nil) {
          NSString *ch = [cachedId[@"handle"] isKindOfClass:[NSString class]] ? cachedId[@"handle"] : nil;
          NSString *cn = [cachedId[@"name"] isKindOfClass:[NSString class]] ? cachedId[@"name"] : nil;
          if (ch.length > 0) { cancelHandle = ch; }
          if (cn.length > 0) { cancelDisplayName = cn; }
        }
      } @catch (NSException *idEx) {}
    }
    [RNCallKeep reportNewIncomingCall:cancelUuid
                               handle:(cancelHandle.length > 0 ? cancelHandle : @"Unknown")
                           handleType:@"number"
                             hasVideo:NO
                  localizedCallerName:cancelDisplayName
                      supportsHolding:NO
                         supportsDTMF:NO
                     supportsGrouping:NO
                   supportsUngrouping:NO
                          fromPushKit:YES
                              payload:dict
                withCompletionHandler:nil];
    // Connected-call guard: a cancel that races the user's own answer (PBX
    // ANSWERED fans out to every device) must never hang up a live call.
    // Only ringing / not-yet-connected calls are ended.
    if (!ConnectCallKitCallIsConnected(cancelUuid)) {
      [RNCallKeep endCallWithUUID:cancelUuid reason:endReason];
    }
    NSString *altCancelId = [dict[@"altCallId"] isKindOfClass:[NSString class]] ? dict[@"altCallId"] : nil;
    if (altCancelId != nil && altCancelId.length > 0 && ![altCancelId isEqualToString:callId]) {
      NSString *altUuid = ConnectDeterministicCallKitUUID(altCancelId);
      if (!ConnectCallKitCallIsConnected(altUuid)) {
        [RNCallKeep endCallWithUUID:altUuid reason:endReason];
      }
    }
    // Forward to JS too (when awake it clears invite state; the JS onIncoming
    // handler recognizes cancel payloads and never treats them as new calls).
    [RNVoipPushNotificationManager didReceiveIncomingPushWithPayload:payload forType:(NSString *)type];
    completion();
    return;
  }

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
    // Cache this call's caller identity so a later CANCEL push (which may
    // arrive with no caller fields, or cold after the app was killed) can
    // re-report with the SAME name/number instead of "Unknown". Small
    // NSUserDefaults dict, pruned to the newest ~24 entries. Best-effort.
    @try {
      NSUserDefaults *udCache = [NSUserDefaults standardUserDefaults];
      NSMutableDictionary *idCache = [[udCache dictionaryForKey:@"ConnectCallerIdCache"] mutableCopy];
      if (idCache == nil) { idCache = [NSMutableDictionary dictionary]; }
      idCache[callId] = @{ @"handle": handle, @"name": (callerName != nil ? callerName : @""), @"ts": @([[NSDate date] timeIntervalSince1970]) };
      if (idCache.count > 40) {
        NSArray *oldKeys = [idCache keysSortedByValueUsingComparator:^NSComparisonResult(id a, id b) {
          double ta = [[a objectForKey:@"ts"] doubleValue];
          double tb = [[b objectForKey:@"ts"] doubleValue];
          if (ta < tb) return NSOrderedAscending;
          if (ta > tb) return NSOrderedDescending;
          return NSOrderedSame;
        }];
        NSInteger removeCount = (NSInteger)idCache.count - 24;
        for (NSInteger i = 0; i < removeCount && i < (NSInteger)oldKeys.count; i++) { [idCache removeObjectForKey:oldKeys[i]]; }
      }
      [udCache setObject:idCache forKey:@"ConnectCallerIdCache"];
    } @catch (NSException *idCacheEx) {}
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

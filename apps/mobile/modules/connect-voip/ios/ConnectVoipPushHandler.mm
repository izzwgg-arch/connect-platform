// Connect VoIP PushKit handler — the SDK 54 home of the code that used to be
// string-patched into AppDelegate.mm by plugins/withIosVoipPush.js.
//
// EVERY block below is carried over VERBATIM from the proven AppDelegate patch
// (builds 20–27). The only structural change: this class owns its own
// PKPushRegistry (delegate = self) instead of riding the app delegate —
// RNVoipPushNotificationManager's voipRegistration is intentionally NOT used
// because the Swift ExpoAppDelegate cannot implement PKPushRegistryDelegate
// (the JS-side registerVoipToken() call was removed in lockstep; see
// src/sip/voipPush.ts).
//
// Behavior contract (do not change without re-reading the handoffs):
//   • Apple REQUIRES every VoIP push to report a CallKit call before the
//     completion handler returns — cold-killed iPhones ring because we report
//     natively here, before JS boots.
//   • cancel="1" pushes re-report + immediately end the ringing UUID
//     (answered-elsewhere/voicemail/hangup), never touching a CONNECTED call.
//   • Caller identity is cached per callId so a cancel push (or one arriving
//     with no caller fields) never downgrades the on-screen caller ID to
//     "Unknown" (Izzy 2026-07-30).
//   • The deterministic CallKit UUID derivation MUST stay byte-identical to
//     apps/mobile/src/sip/callkitUuid.ts (locked vector below).
//   • The in-call audio guardian keeps AVAudioSession in VoiceChat mode —
//     expo-av knocks it to Default mid-call which made calls quiet/distant.

#import "ConnectVoipPushHandler.h"

#import <CallKit/CallKit.h>
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>

#import <RNCallKeep/RNCallKeep.h>
#import <RNVoipPushNotification/RNVoipPushNotificationManager.h>

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
// the MODE back to VoiceChat when a CallKit call is live — mode only, never
// the category, and never during the call's opening seconds. See the detailed
// rules in ConnectAssertVoiceChatModeIfInCall: the first version of this
// guardian used setCategory and caused a one-way-audio regression on incoming
// calls (2026-07-31). Self-limiting: our own re-assert triggers one more
// notification which no-ops (mode already VoiceChat). Fully wrapped — can
// never crash a call.
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

// When the current CallKit call was first seen alive. Used to keep our hands
// completely off the audio session during the answer handoff (see below).
static NSTimeInterval gConnectCallLiveSince = 0;

// Hands-off window after a call goes live. The CallKit -> WebRTC audio handoff
// (session activation, audio-unit start, initial route settle) happens inside
// this window and MUST NOT be disturbed.
static const NSTimeInterval kConnectAudioSettleSeconds = 6.0;

static void ConnectAssertVoiceChatModeIfInCall(void)
{
  @try {
    if (!ConnectAnyCallKitCallLive()) { gConnectCallLiveSince = 0; return; }

    const NSTimeInterval nowTs = [[NSDate date] timeIntervalSince1970];
    if (gConnectCallLiveSince == 0) { gConnectCallLiveSince = nowTs; }

    // ── ONE-WAY AUDIO REGRESSION FIX (Izzy 2026-07-31) ──────────────────────
    // Reported live: caller could hear the app user, the app user could NOT
    // hear the caller, on incoming calls, 3/3 reproductions. Cause was this
    // guardian's previous implementation calling
    // `setCategory:mode:options:` from the route-change handler. setCategory
    // RECONFIGURES THE WHOLE SESSION and can restart the audio I/O unit — and
    // route changes fire exactly during the CallKit->WebRTC answer handoff, so
    // it could orphan the playback side that WebRTC had just started while the
    // capture side kept running. That is precisely "they hear me, I don't hear
    // them".
    //
    // Two rules now, both essential:
    //  1. NEVER call setCategory here. During a call the category is already
    //     PlayAndRecord; only the MODE gets clobbered (expo-av's session
    //     manager sets a category with no mode, which iOS defines as resetting
    //     the mode to Default — the original quiet/distant-audio bug). setMode:
    //     alone is a light-touch change that does not reconfigure the category
    //     or its options, and does not clear the speaker override.
    //  2. If the category is NOT PlayAndRecord, do NOTHING. That means CallKit
    //     or WebRTC is mid-setup, or something else owns the session — fighting
    //     it is what broke inbound audio in the first place.
    //
    // Plus a settle window: no touching the session at all for the first few
    // seconds of a call. A mid-call expo-av clobber (DTMF cue, late voicemail
    // preload) happens well after that and is still corrected.
    if (nowTs - gConnectCallLiveSince < kConnectAudioSettleSeconds) { return; }

    AVAudioSession *session = [AVAudioSession sharedInstance];
    if (![session.category isEqualToString:AVAudioSessionCategoryPlayAndRecord]) { return; }
    if ([session.mode isEqualToString:AVAudioSessionModeVoiceChat]) { return; }

    NSError *err = nil;
    const BOOL ok = [session setMode:AVAudioSessionModeVoiceChat error:&err];
    NSLog(@"[CONNECT_AUDIO] mode-only re-assert -> VoiceChat (ok=%d, err=%@)", ok ? 1 : 0, err);
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

@implementation ConnectVoipPushHandler {
  PKPushRegistry *_registry;
}

static ConnectVoipPushHandler *gConnectVoipPushHandler = nil;

+ (void)install
{
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    gConnectVoipPushHandler = [[ConnectVoipPushHandler alloc] init];
    [gConnectVoipPushHandler start];
    ConnectInstallCallAudioModeGuardian();
    NSLog(@"[CONNECT_VOIP] PushKit handler installed");
  });
}

- (void)start
{
  _registry = [[PKPushRegistry alloc] initWithQueue:dispatch_get_main_queue()];
  _registry.delegate = self;
  _registry.desiredPushTypes = [NSSet setWithObject:PKPushTypeVoIP];
}

// --- PKPushRegistryDelegate (VoIP push → RNVoipPushNotification) ---------
- (void)pushRegistry:(PKPushRegistry *)registry didUpdatePushCredentials:(PKPushCredentials *)credentials forType:(PKPushType)type
{
  [RNVoipPushNotificationManager didUpdatePushCredentials:credentials forType:(NSString *)type];
}

- (void)pushRegistry:(PKPushRegistry *)registry didInvalidatePushTokenForType:(PKPushType)type
{
  // react-native-voip-push-notification (3.3.x) exposes NO class method for
  // token invalidation, so there is nothing to forward to JS — iOS
  // re-registers and delivers a fresh token via didUpdatePushCredentials on
  // the next registration.
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
    callerName = [NSString stringWithFormat:@"%@ · %@", callerName, callerNumber];
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

@end

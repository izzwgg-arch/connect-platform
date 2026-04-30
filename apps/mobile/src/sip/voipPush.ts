import { Platform } from 'react-native';

// iOS-only VoIP push plumbing. Kept in a separate module so Android bundles
// don't evaluate the native module lazy-require and don't carry any dead code
// from react-native-voip-push-notification. Every export is a no-op on
// Android so callers can use them unconditionally.
//
// The flow this enables:
//   1. `initVoipPushListener({ onToken, onIncoming })` is called once from
//      NotificationsContext after CallKeep is set up.
//   2. The library's `register` event fires with a hex device token once iOS
//      issues it. We forward it to the caller's `onToken` so it can be
//      included in registerMobileDevice({ voipPushToken }).
//   3. The library's `notification` event fires on `didReceiveIncomingPush`.
//      We pass the payload to `onIncoming` so the app can map it onto a
//      CallKit report + bring up the in-app incoming UI.
//
// Hard requirements for real delivery (outside this file):
//   - AppDelegate must call `[RNVoipPushNotificationManager voipRegistration]`
//     and forward `PKPushRegistryDelegate` events. Handled by
//     plugins/withIosVoipPush.js at prebuild time.
//   - Apple Developer team must have a VoIP Services Cert OR VoIP-capable
//     APNs Auth Key with topic `<bundleId>.voip`.
//   - Server side (apps/worker) must send VoIP push payloads directly to
//     APNs with `apns-push-type: voip`. Expo's push relay CANNOT carry
//     VoIP pushes — tracked as TODO alongside registerMobileDevice.

export interface VoipPushIncomingPayload {
  /** Connect-specific invite id. Set server-side when constructing the push
   *  so we can correlate CallKit / SIP / in-app UI with the same UUID. */
  inviteId?: string;
  callerName?: string;
  callerNumber?: string;
  // The library passes the raw APNs payload through as an arbitrary object;
  // keep it `any` so future server-side fields work without a schema bump.
  [key: string]: any;
}

export interface VoipPushHandlers {
  onToken: (hexToken: string) => void;
  onIncoming: (payload: VoipPushIncomingPayload) => void;
}

// Cache the token so late subscribers (e.g. retry registration after network
// recovery) can pull it synchronously instead of re-registering with
// PushKit, which would trigger a redundant token rotate.
let cachedVoipToken: string | null = null;

/** Last known VoIP push token. Empty on Android or before registration. */
export function getCachedVoipPushToken(): string | null {
  return cachedVoipToken;
}

/** Subscribe to VoIP push events. iOS only — Android returns a no-op
 *  teardown. Safe to call multiple times; duplicates are filtered by the
 *  upstream library. The returned function should be called on unmount /
 *  sign-out to release native listeners. */
export function initVoipPushListener(handlers: VoipPushHandlers): () => void {
  if (Platform.OS !== 'ios') {
    return () => undefined;
  }

  let Voip: any;
  try {
    Voip = require('react-native-voip-push-notification').default
      ?? require('react-native-voip-push-notification');
  } catch (e) {
    // Library not installed (e.g. dev checkout without native rebuild). Log
    // once and degrade gracefully — the rest of the app still works via
    // Expo push, which handles foreground/short-background on iOS.
    console.warn(
      '[voipPush] react-native-voip-push-notification not available on this build — VoIP push will not fire.',
      e instanceof Error ? e.message : String(e),
    );
    return () => undefined;
  }

  // `register` fires when iOS issues (or re-issues) a VoIP push token. The
  // payload is a hex string suitable for APNs without further encoding.
  const onRegister = (token: string) => {
    cachedVoipToken = token;
    try {
      handlers.onToken(token);
    } catch (e) {
      console.warn('[voipPush] onToken handler threw:', e);
    }
  };

  // `notification` fires each time PushKit delivers a payload while the app
  // is foreground OR backgrounded (not killed — killed-state delivery flows
  // through AppDelegate before JS boots and is handled by the native side).
  const onNotification = (notification: any) => {
    try {
      handlers.onIncoming(notification ?? {});
    } catch (e) {
      console.warn('[voipPush] onIncoming handler threw:', e);
    }
  };

  Voip.addEventListener('register', onRegister);
  Voip.addEventListener('notification', onNotification);

  // Trigger the native voipRegistration if the AppDelegate patch already ran
  // it (the call is idempotent on iOS). Without this, token delivery on a
  // fresh install is delayed until the user backgrounds + foregrounds the app.
  try {
    Voip.registerVoipToken?.();
  } catch (e) {
    console.warn('[voipPush] registerVoipToken failed:', e);
  }

  return () => {
    try {
      Voip.removeEventListener('register');
      Voip.removeEventListener('notification');
    } catch {
      // Older versions of the library throw on removeEventListener without
      // a handler ref — safe to swallow since unmount is tearing the app
      // down anyway.
    }
  };
}

import { Platform, PermissionsAndroid, Alert } from 'react-native';

/** Result of a mic-permission pre-check. `granted` is authoritative; `message`
 *  is optional human-readable context (why we asked, what platform). */
export interface MicPermissionResult {
  granted: boolean;
  message?: string;
}

/** Cross-platform microphone-permission preflight.
 *
 *  Android: has always gone through `PermissionsAndroid.request(RECORD_AUDIO)`
 *  before dial. We preserve that exact path so Android behavior doesn't change.
 *
 *  iOS: `NSMicrophoneUsageDescription` is already declared in app.config.ts.
 *  Historically the only mic prompt on iOS came *mid-call* when WebRTC's
 *  `getUserMedia` ran inside jssip. If the user denied, the call failed
 *  silently with a confusing "no audio" experience. Here we proactively call
 *  `mediaDevices.getUserMedia({audio:true})` as a preflight — this triggers
 *  the same native iOS prompt BEFORE we try to dial, then immediately stops
 *  the stream so no audio session is actually held. Uses `react-native-webrtc`
 *  which is already a dependency, so no new native pods.
 *
 *  On any other platform we return granted:true — this is called from user
 *  actions (dial button), the worst case is that WebRTC's own prompt fires
 *  next and the UX degrades to pre-preflight behavior. */
export async function ensureMicPermission(): Promise<MicPermissionResult> {
  if (Platform.OS === 'android') {
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: 'Microphone Permission',
          message: 'Connect needs microphone access to make calls.',
          buttonPositive: 'Allow',
        },
      );
      if (granted === PermissionsAndroid.RESULTS.GRANTED) {
        return { granted: true };
      }
      return {
        granted: false,
        message: 'Microphone access is needed to make calls. Please enable it in Android Settings.',
      };
    } catch (e) {
      // Permission dialog threw (very rare) — fall through to best-effort
      // behavior rather than blocking the call. WebRTC's own prompt is
      // still there as a last line of defense.
      console.warn('[mic-perm] Android request error:', e);
      return { granted: true };
    }
  }

  if (Platform.OS === 'ios') {
    try {
      // Lazy-require so Metro doesn't eagerly evaluate react-native-webrtc
      // in surfaces that never touch calling (e.g. tests, storybook).
      const { mediaDevices } = require('react-native-webrtc');
      const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      try {
        stream.getTracks().forEach((t: any) => t.stop());
      } catch {
        // ignore — stopping the probe stream is best-effort
      }
      return { granted: true };
    } catch (e: any) {
      // iOS throws "Permission denied" when the user tapped Don't Allow,
      // or "NotFoundError"/"NotAllowedError" in other denial cases. All
      // of these map to "user needs to open Settings → Connect → Microphone".
      const msg = typeof e?.message === 'string' ? e.message : String(e);
      console.warn('[mic-perm] iOS getUserMedia denied:', msg);
      return {
        granted: false,
        message: 'Microphone access is needed to make calls. Enable it in iOS Settings → Connect → Microphone.',
      };
    }
  }

  // Web / other: assume granted — browser will prompt on getUserMedia.
  return { granted: true };
}

/** Convenience wrapper: runs the preflight and, on denial, shows a
 *  platform-appropriate Alert explaining how to recover. Returns the same
 *  `granted` boolean so callers can short-circuit the dial. */
export async function ensureMicPermissionOrAlert(): Promise<boolean> {
  const res = await ensureMicPermission();
  if (res.granted) return true;
  Alert.alert('Microphone Required', res.message ?? 'Microphone access is needed to make calls.');
  return false;
}

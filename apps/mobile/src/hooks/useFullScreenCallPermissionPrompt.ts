import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { showAppAlert } from '../components/ui/appAlert';
import {
  getCallWakePermissionState,
  requestFullScreenIntentPermission,
} from '../diagnostics/callWakeDiagnostics';

const PROMPTED_KEY = 'cc_fsi_onboard_prompted_v1';

/**
 * One-time onboarding nudge for the Android 14+ "full-screen intent"
 * permission.
 *
 * Without it the OS silently demotes our incoming-call full-screen UI to a
 * plain heads-up notification, so calls no longer take over the screen (and
 * never appear over the lock screen). The permission can't be granted
 * programmatically — only the user can flip it in system Settings — so when a
 * device is first set up we surface a themed popup that deep-links straight to
 * that settings page via the native `requestFullScreenIntentPermission()`
 * (ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).
 *
 * Shown at most once (guarded by a persisted flag); the user can always
 * re-enable later from Diagnostics. No-op on iOS / pre-Android-14, or when the
 * permission is already granted.
 *
 * @param enabled gate so callers only arm it once authenticated.
 */
export function useFullScreenCallPermissionPrompt(enabled: boolean): void {
  const ranRef = useRef(false);

  useEffect(() => {
    if (!enabled || Platform.OS !== 'android' || ranRef.current) return;
    ranRef.current = true;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    (async () => {
      try {
        const alreadyPrompted = await AsyncStorage.getItem(PROMPTED_KEY).catch(() => null);
        if (alreadyPrompted || cancelled) return;

        const perms = await getCallWakePermissionState();
        // null => not Android 14+ / couldn't determine => nothing to ask for.
        // true => already granted. Only `false` means "ungranted, ask".
        if (perms.canUseFullScreenIntent !== false || cancelled) return;

        await AsyncStorage.setItem(PROMPTED_KEY, '1').catch(() => undefined);

        // Small delay so this lands after any first-run system prompts
        // (notifications / camera) have settled, instead of stacking on top.
        timer = setTimeout(() => {
          if (cancelled) return;
          showAppAlert(
            'Allow full-screen calls',
            'So incoming calls can take over your screen — even when your phone is locked — Connect needs the "full-screen notifications" permission. Tap Enable, then turn it on for Connect.',
            [
              { text: 'Not now', style: 'cancel' },
              {
                text: 'Enable',
                onPress: () => {
                  requestFullScreenIntentPermission().catch(() => undefined);
                },
              },
            ],
          );
        }, 1500);
      } catch {
        /* best-effort onboarding nudge — never block app startup */
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}

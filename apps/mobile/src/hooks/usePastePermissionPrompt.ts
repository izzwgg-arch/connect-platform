import { useEffect, useRef } from 'react';
import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { showAppAlert } from '../components/ui/appAlert';

export const PASTE_PERM_ONBOARD_PROMPTED_KEY = 'cc_paste_perm_onboard_prompted_v1';

/**
 * One-time, first-run explainer for iOS's per-app paste permission.
 *
 * iOS (16+) gates cross-app pasting behind "Paste from Other Apps"
 * (Ask / Deny / Allow) in the app's Settings page. There is NO API to request
 * it like mic/notifications — the system only prompts when the app reads the
 * pasteboard, tapping "Allow Paste" grants that single read, and a user who
 * taps "Don't Allow" (or flips the setting to Deny) silently loses paste in
 * EVERY field of the app. That "paste does nothing, everywhere" state is
 * exactly what a tester hit on build 48 (2026-08-05) and it is invisible to
 * us — nothing in JS can read the setting's value.
 *
 * So instead of a fake permission request, this shows a single friendly popup
 * after first sign-in telling the user to tap "Allow Paste" when iPhone asks,
 * with a one-tap jump to our Settings page for the durable "Allow".
 *
 * Deliberately NOT done here: reading the clipboard to force the system
 * prompt. The prompt would name whatever app the user last copied from
 * (confusing at setup), only appears if the pasteboard currently holds
 * other-app content, and each "Don't Allow" tap is a step toward the wedged
 * Deny state — the opposite of what this hook exists for.
 *
 * Shown at most once (persisted flag). No-op on Android (paste needs no
 * permission there).
 *
 * @param enabled gate so callers only arm it once authenticated/provisioned.
 */
export function usePastePermissionPrompt(enabled: boolean): void {
  const ranRef = useRef(false);

  useEffect(() => {
    if (!enabled || Platform.OS !== 'ios' || ranRef.current) return;
    ranRef.current = true;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    (async () => {
      try {
        const alreadyPrompted = await AsyncStorage.getItem(PASTE_PERM_ONBOARD_PROMPTED_KEY).catch(() => null);
        if (alreadyPrompted || cancelled) return;
        await AsyncStorage.setItem(PASTE_PERM_ONBOARD_PROMPTED_KEY, '1').catch(() => undefined);

        // Land after the first-run mic/notification system dialogs so the
        // popups don't stack (same staggering as the Android battery nudge).
        timer = setTimeout(() => {
          if (cancelled) return;
          showAppAlert(
            'Enable pasting',
            'To paste names or numbers you copied in another app, tap "Allow Paste" whenever iPhone asks.\n\nTo never be asked again, open Settings and set "Paste from Other Apps" to Allow.',
            [
              { text: 'Got it', style: 'cancel' },
              {
                text: 'Open Settings',
                onPress: () => {
                  Linking.openSettings().catch(() => undefined);
                },
              },
            ],
          );
        }, 3200);
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

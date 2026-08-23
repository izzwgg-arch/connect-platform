import { useEffect, useRef } from 'react';
import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { showAppAlert } from '../components/ui/appAlert';

/** Shared with the recurring reminder in SipContext so the two never collide:
 *  while this is unset, SipContext defers and lets this first-run prompt go
 *  first; once set, SipContext takes over the occasional "still optimized"
 *  reminder. */
export const BATTERY_OPT_ONBOARD_PROMPTED_KEY = 'cc_batt_opt_onboard_prompted_v1';

/**
 * One-time, first-run nudge to take Connect off Android battery optimization.
 *
 * Aggressive OEM skins (Samsung One UI, Xiaomi, OPPO, Huawei…) kill our
 * foreground keep-alive service after ~16–24 s once the app is in the
 * background, which silently breaks incoming-call wake-up. The single reliable
 * fix is the system "Don't optimize / Unrestricted" toggle for our package.
 *
 * Previously the only nudge lived in SipContext and re-fired on every
 * foreground (a nag), and older builds had no first-run prompt at all — so new
 * users had to discover the setting manually. This surfaces a clear popup the
 * first time the device is set up that deep-links straight to the system
 * exemption dialog (single-tap "Allow" on most OEMs) via the native
 * `requestBatteryOptimizationExclusion()`.
 *
 * Shown at most once (persisted flag). No-op on iOS, pre-Android-6, or when the
 * app is already exempt. The user can re-trigger later from Settings.
 *
 * @param enabled gate so callers only arm it once authenticated/provisioned.
 */
export function useBatteryOptimizationPrompt(enabled: boolean): void {
  const ranRef = useRef(false);

  useEffect(() => {
    if (!enabled || Platform.OS !== 'android' || ranRef.current) return;
    ranRef.current = true;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    (async () => {
      try {
        const alreadyPrompted = await AsyncStorage.getItem(BATTERY_OPT_ONBOARD_PROMPTED_KEY).catch(() => null);
        if (alreadyPrompted || cancelled) return;

        const mod: any = (NativeModules as any)?.IncomingCallUi;
        if (
          !mod ||
          typeof mod.isBatteryOptimizationIgnored !== 'function' ||
          typeof mod.requestBatteryOptimizationExclusion !== 'function'
        ) {
          return;
        }

        const alreadyIgnored: boolean = await mod.isBatteryOptimizationIgnored().catch(() => false);
        // Already exempt — mark onboarding done (so SipContext won't nag) and
        // never show the popup.
        if (alreadyIgnored || cancelled) {
          await AsyncStorage.setItem(BATTERY_OPT_ONBOARD_PROMPTED_KEY, '1').catch(() => undefined);
          return;
        }

        await AsyncStorage.setItem(BATTERY_OPT_ONBOARD_PROMPTED_KEY, '1').catch(() => undefined);

        // Land after the full-screen-intent (1500ms) and any first-run system
        // dialogs so the prompts don't stack on top of one another.
        timer = setTimeout(() => {
          if (cancelled) return;
          showAppAlert(
            'Keep calls ringing reliably',
            'So Loopcom can ring for incoming calls while running in the background, allow it to ignore battery optimization. Tap Allow, then choose "Don\'t optimize" / "Allow".',
            [
              { text: 'Not now', style: 'cancel' },
              {
                text: 'Allow',
                onPress: () => {
                  mod.requestBatteryOptimizationExclusion().catch(() => undefined);
                },
              },
            ],
          );
        }, 2600);
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

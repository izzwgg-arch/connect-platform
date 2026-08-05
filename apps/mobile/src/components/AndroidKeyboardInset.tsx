import React, { useEffect, useState } from 'react';
import { Keyboard, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Re-creates `android:windowSoftInputMode="adjustResize"` in JS, for the Android
 * versions that stopped honoring it.
 *
 * Android 15 (API 35) enforces edge-to-edge for every app that targets SDK 35 or
 * newer, and part of that enforcement is dropping the automatic window resize
 * for the soft keyboard: the window keeps its full height and the IME draws ON
 * TOP of it. The manifest still says `adjustResize`; the system ignores it.
 *
 * This app moved from targetSdk 34 to 36 in `d111c179` (Android toolchain
 * upgrade for Expo SDK 54). No screen code changed — but from that build onward
 * the keyboard covered every bottom-anchored control, the chat composer and the
 * newest message bubbles most visibly, because the chat screen had always
 * relied on the OS resize (its KeyboardAvoidingView is iOS-only).
 *
 * Two things this has to get exactly right:
 *
 * 1. ONLY on API 35+. Android 14 and older still resize the window themselves,
 *    and padding on top of that resize would shift every screen up by a second
 *    keyboard height. The fleet runs Android 12 through 16.
 * 2. Pad by the keyboard height PLUS the bottom safe-area inset. React Native
 *    measures the keyboard from the top of the gesture/navigation bar, not from
 *    the bottom of the window, so its number is short by exactly that inset —
 *    measured at 45px (15dp) on the S24 test device, which is what left the
 *    composer's bottom edge clipped by the keyboard.
 *
 * iOS never had the system resize and is left untouched.
 *
 * NOTE: React Native `<Modal>` renders in its own native window, so it is NOT a
 * child of this view — modals still need their own KeyboardAvoidingView.
 */
const NEEDS_JS_KEYBOARD_RESIZE = Platform.OS === 'android' && Number(Platform.Version) >= 35;

export function AndroidKeyboardInset({ children }: { children: React.ReactNode }) {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!NEEDS_JS_KEYBOARD_RESIZE) return undefined;
    // `didShow` (not `willShow`) — Android only reports a trustworthy height
    // once the IME has finished animating in, and it fires again whenever the
    // height changes (keyboard swap, emoji/handwriting panels, split view).
    const showSub = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  if (!NEEDS_JS_KEYBOARD_RESIZE) return <>{children}</>;
  return (
    <View style={{ flex: 1, paddingBottom: keyboardHeight > 0 ? keyboardHeight + insets.bottom : 0 }}>
      {children}
    </View>
  );
}

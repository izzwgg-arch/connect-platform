# AGENT HANDOFF — Android keyboard covers the screen (2026-08-04)

Read this before touching any Android layout that sits at the bottom of a
screen: the chat composer, the keypad, login, search bars, or anything that has
to stay above the soft keyboard.

Owner's report: *"When I open the keyboard, it goes on top of the chat bubble,
and the chat bubble disappears."* Android only; iPhone fine.

---

## 1. What broke, and why it was not a chat bug

`d111c179` (2026-07-31, Android toolchain for Expo SDK 54) moved the app from
**targetSdk 34 to 36**.

**Android 15 (API 35) enforces edge-to-edge for every app that targets SDK 35 or
newer, and that enforcement drops the automatic window resize for the soft
keyboard.** The window keeps its full height and the IME simply draws on top of
it. `AndroidManifest.xml` still says `android:windowSoftInputMode="adjustResize"`
— the system ignores it. Proof from the device with the keyboard up:

```
Requested w=1080 h=2340     # app window, full screen height, never shrinks
```

Nothing in `ChatTab.tsx` changed. The chat screen had always leaned on the OS
resize: its `KeyboardAvoidingView` is `behavior={Platform.OS === 'ios' ? 'padding' : undefined}`
— i.e. a no-op on Android. So did every other bottom-anchored control in the app.
The 2026-08-02 comment inside `NewChatModal` ("Android is unaffected because its
window soft-input mode resizes automatically") was true when written and false
one build later.

**On Android 14 and older the OS still resizes.** The fleet runs Android 12–16,
so any fix must not double-apply. That is the trap in §3.

## 2. The device evidence (how this was proven, not guessed)

Test device: Izzy's **SM-S921U, Android 16 (API 36), density 3.0** over USB
(`adb`, serial `RFCXC0CEZ6V`).

Repro is a screenshot, not a report: `adb shell am start`, drive to a chat
thread, tap the composer, `adb exec-out screencap -p`. On the broken build the
composer and the newest bubbles are entirely behind the keyboard.

Numbers were measured off the PNGs with a System.Drawing pixel scan (find the
send/mic circle's blue bounding box, find the keyboard's top row, subtract) —
this is what caught the second-round error that eyeballing missed:

| build | send-circle bottom | keyboard top | verdict |
|---|---|---|---|
| `1.0.0+20260802-140820` (first fix) | 1329 px (extrapolated) | 1314 px | 45 px (15 dp) too low — **still clipped** |
| `1.0.0+20260802-141958` (final) | — | — | full composer + newest bubble visible |

⚠️ The `20260802` in those version strings is real: the Windows shell that runs
`android-ship.ps1` has a clock two days behind git. Do not hunt for a phantom
Aug-2 build.

## 3. The fix — `apps/mobile/src/components/AndroidKeyboardInset.tsx`

Wraps `DeferredRootNavigator` in `App.tsx` and re-creates `adjustResize` in JS by
padding the whole navigation tree. One place, so every screen is fixed at once
instead of bolting a `KeyboardAvoidingView` onto each.

Two rules in it that are not obvious and must not be "simplified" away:

1. **Only on API 35+** (`Platform.Version >= 35`). Android 12–14 still resize the
   window themselves; padding on top of that shifts every screen up by a second
   keyboard height. The first version of this fix had that bug and would have
   shipped a huge empty band to most of the fleet.
2. **Pad by `keyboardHeight + insets.bottom`.** React Native measures the
   keyboard from the top of the gesture/navigation bar, not from the bottom of
   the window, so its number is short by exactly that inset — **45 px (15 dp) on
   the S24**, which is precisely what left the composer's bottom edge clipped.
   The same 15 dp shows up independently as `useSafeAreaInsets().bottom`.

**React Native `<Modal>` renders in its own native window and is NOT a child of
this view.** Modals still need their own `KeyboardAvoidingView`, and it must now
be active on Android too — `NewChatModal` was flipped from
`behavior={Platform.OS === 'ios' ? 'padding' : undefined}` to `behavior="padding"`.
There is no double-shift, precisely because the modal is a separate window.

⚠️ Still un-audited: `ContactPicker` (bottom-pinned sheet with a `TextInput`, no
`KeyboardAvoidingView` at all) and any other modal with an input.

## 4. Composer spacing (owner request, same session)

With the keyboard **down**, the composer was 15 dp above the tab bar because it
padded itself by the safe-area inset — which the tab bar underneath already
carries, so the gesture strip was reserved twice. Now a flat **8 dp**
(`bottomInset={keyboardOpen ? 10 : Platform.OS === 'ios' ? 12 : 8}`), measured on
device at 25 px vs the old 46 px. Owner asked for "a tiny bit closer"; this is
that change, not a layout rewrite.

## 5. Build gotcha — `-SkipJunction` is required

`scripts/android-ship.ps1` builds through a junction at
`%USERPROFILE%\.connect-mobile-build\repo`. Metro now fails there:

```
Unable to resolve module C:/Users/izzyw/.connect-mobile-build/repo/apps/mobile/index.js
from C:\dev\projects\Connect 2/.
```

Metro resolves the project root to the real path, so the junction entry path is
outside every watched root. Build with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/android-ship.ps1 -SkipJunction
```

`apps/mobile/ship-proof.json` from the last good build already showed
`buildRoot == realRepo` — check it before assuming the junction path works. This
matches the existing CLAUDE.md rule (`-SkipJunction`; the MAX_PATH problem the
junction existed for is handled by the pnpm patches).

## 6. State at handoff

- Installed and **verified on Izzy's device**: keyboard opens/closes correctly,
  composer and newest bubble fully visible, spacing accepted
  (`1.0.0+20260802-143118`, versionCode 1785695478).
- `tsc` clean. Not committed at time of writing; not published to the download
  page; **no other Android version has been tested** — the API-35 gate means
  Android 12–14 devices take the old path, but that has not been observed on a
  real phone.
- Files touched: `apps/mobile/src/components/AndroidKeyboardInset.tsx` (new),
  `apps/mobile/App.tsx`, `apps/mobile/src/screens/tabs/ChatTab.tsx`.

## 7. If a "keyboard covers X" report comes in for another screen

It is the same root cause and the root fix already covers ordinary screens.
Check, in order: is the screen inside a `<Modal>` (then it needs its own
`KeyboardAvoidingView`)? Is the device on Android 15+ (`adb shell getprop
ro.build.version.sdk`)? Then screenshot and measure — do not adjust padding by
eye, that is what produced the clipped second build.

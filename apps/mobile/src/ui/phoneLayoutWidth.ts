/**
 * Pure layout-width maths (no react-native import, so node:test can run it).
 *
 * WHY THIS EXISTS. `Dimensions.get('window')` read once at module load is
 * evaluated the moment the JavaScript bundle starts. That moment is usually
 * NOT a tap on the icon: the process is created headless by a ring/wake push
 * or the keep-alive service, with no Activity and therefore no portrait lock.
 * If the phone is physically sideways at that instant, React Native reports
 * the LANDSCAPE width, the constant is baked in, and the foreground service
 * keeps that process alive for days. On 2026-09-06 that left Secro ext 301
 * with a dial pad whose left and right columns sat off-screen (only 2/5/8/0
 * visible) until the app was force-stopped.
 *
 * Rule: never derive a layout width from `Dimensions.get()` at module scope.
 * Call `usePhoneLayoutWidth()` (./usePhoneLayoutWidth.ts) inside the
 * component and feed the value to the helpers here. `windowWidth.test.ts`
 * reads every screen's source and fails if a module-scope read comes back.
 */

/** Sanity floor: a window narrower than this is a measurement glitch, not a phone. */
const MIN_SANE_WIDTH = 240;
/** A phone held upright is never wider than this; anything above is landscape,
 *  a tablet, or a foldable opened flat — and a phone dial pad must not be
 *  sized for it. */
const MAX_PHONE_PORTRAIT_WIDTH = 520;

/**
 * The width a phone-shaped layout may assume. Clamps to the SHORT side of the
 * window, so a landscape or headless-rotated reading still yields the width a
 * portrait screen will actually have once the Activity comes up.
 */
export function phoneLayoutWidth(windowWidth: number, windowHeight: number): number {
  const w = Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 0;
  const h = Number.isFinite(windowHeight) && windowHeight > 0 ? windowHeight : 0;
  const shortSide = w > 0 && h > 0 ? Math.min(w, h) : Math.max(w, h);
  if (shortSide <= 0) return 360;
  return Math.max(MIN_SANE_WIDTH, Math.min(MAX_PHONE_PORTRAIT_WIDTH, shortSide));
}

// ── Dial pad (KeypadTab) ────────────────────────────────────────────────
export const KEYPAD_PAD_H_PADDING = 14;
export const KEYPAD_KEY_GAP = 8;

/** One key's width so that three keys plus two gaps fill the padded row. */
export function keypadCellWidth(layoutWidth: number): number {
  return Math.floor((layoutWidth - KEYPAD_PAD_H_PADDING * 2 - KEYPAD_KEY_GAP * 2) / 3);
}

/** The keypad grid's width: three cells + two gaps. Must be ≤ the window. */
export function keypadGridWidth(layoutWidth: number): number {
  return keypadCellWidth(layoutWidth) * 3 + KEYPAD_KEY_GAP * 2;
}

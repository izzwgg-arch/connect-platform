/**
 * LoopcomMark — the Loopcom infinity mark.
 *
 * Replaces the old hand-drawn ConnectIcon (a blue rounded square with a phone
 * handset), which was a vector rendition of the Connect app icon and became
 * wrong the day the app was renamed.
 *
 * ⛔ The asset is CROPPED TO ITS INK, so it is wide (≈2.12:1), not square. The
 * brand's own PNG is a square canvas that is mostly transparent padding — sizing
 * by that square lays out a large invisible gap under the mark and makes it read
 * far smaller than the number suggests. Give this component a WIDTH; the height
 * follows from the real artwork.
 *
 * ⛔⛔ THE ASSET WAS CLEANED 2026-08-23 AND MUST STAY CLEAN. The shipped PNG was
 * authored on a dark ground and carried a faint DARK navy bleed across its whole
 * rectangle (~59% of pixels, alpha ~3–70). Invisible on navy — and a grey PLATE
 * around the mark the moment the splash gained a light theme. It was keyed out by
 * clearing every LARGE CONNECTED faint-and-dark region (the border field plus both
 * enclosed loop interiors), which leaves the ring, circuit detail, star and glow
 * untouched. ⛔ A naive global alpha/luminance threshold ate holes in the ring —
 * do not "simplify" the cleaning that way. Recipe + rationale in CLAUDE.md.
 *
 * ⛔ Regenerating via scripts/mobile-loopcom-android-assets.py would restore the
 * UNCLEANED mark (it re-derives from the brand master) — re-key it afterwards.
 */
import React from 'react';
import { Image, StyleSheet } from 'react-native';
import type { ImageStyle, StyleProp } from 'react-native';

const MARK = require('../../assets/loopcom-mark.png');
/**
 * Light-ground variant (Izzy 2026-08-23: the chrome mark "doesn't look good in
 * light mode"). This is the Blue 2B icon's own mark — white-outlined, blue
 * bands with light ticks — extracted at high resolution from the 1024 icon by
 * difference-keying it against the icon's reconstructed gradient background
 * (the transparent kit foreground is only 222px of ink — too soft to upscale).
 * Recipe in CLAUDE.md. Used by the light-theme splash; the chrome mark stays
 * the dark-theme art.
 */
const MARK_LIGHT = require('../../assets/loopcom-mark-light.png');

/** Intrinsic aspect of assets/loopcom-mark.png (640 × 302, ink-cropped). */
export const LOOPCOM_MARK_ASPECT = 640 / 302;
/** Intrinsic aspect of assets/loopcom-mark-light.png (821 × 387, ink-cropped). */
export const LOOPCOM_MARK_LIGHT_ASPECT = 821 / 387;

interface LoopcomMarkProps {
  /** Width of the mark in dp. Height is derived from the artwork's aspect. */
  width: number;
  /** 'chrome' (default) = the dark-ground glow art; 'light' = the Blue 2B ink mark. */
  variant?: 'chrome' | 'light';
  style?: StyleProp<ImageStyle>;
}

export function LoopcomMark({ width, variant = 'chrome', style }: LoopcomMarkProps) {
  const light = variant === 'light';
  const aspect = light ? LOOPCOM_MARK_LIGHT_ASPECT : LOOPCOM_MARK_ASPECT;
  return (
    <Image
      source={light ? MARK_LIGHT : MARK}
      resizeMode="contain"
      accessible={false}
      accessibilityIgnoresInvertColors
      style={[styles.mark, { width, height: width / aspect }, style]}
    />
  );
}

const styles = StyleSheet.create({
  mark: {
    // The artwork carries its own glow; nothing else should be added behind it.
    backgroundColor: 'transparent',
  },
});

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
 * Regenerate the asset with:  python scripts/mobile-loopcom-android-assets.py
 */
import React from 'react';
import { Image, StyleSheet } from 'react-native';
import type { ImageStyle, StyleProp } from 'react-native';

const MARK = require('../../assets/loopcom-mark.png');

/** Intrinsic aspect of assets/loopcom-mark.png (640 × 302, ink-cropped). */
export const LOOPCOM_MARK_ASPECT = 640 / 302;

interface LoopcomMarkProps {
  /** Width of the mark in dp. Height is derived from the artwork's aspect. */
  width: number;
  style?: StyleProp<ImageStyle>;
}

export function LoopcomMark({ width, style }: LoopcomMarkProps) {
  return (
    <Image
      source={MARK}
      resizeMode="contain"
      accessible={false}
      accessibilityIgnoresInvertColors
      style={[styles.mark, { width, height: width / LOOPCOM_MARK_ASPECT }, style]}
    />
  );
}

const styles = StyleSheet.create({
  mark: {
    // The artwork carries its own glow; nothing else should be added behind it.
    backgroundColor: 'transparent',
  },
});

/**
 * LoopcomLogo — the real Loopcom logo: the chrome LOOPCOM wordmark with the
 * infinity mark built in as the double-O.
 *
 * ⛔ THIS, not LoopcomMark, is what a customer means by "the logo". The bare
 * infinity is the app-icon mark; a screen that shows the mark plus the word
 * "Loopcom" typed in the system font is NOT showing the logo, and that is
 * exactly what shipped on 2026-08-21 before Izzy pointed it out.
 *
 * ⛔ The asset is CROPPED TO ITS INK and is therefore very wide (≈6.17:1).
 * Give this component a WIDTH; the height follows from the artwork.
 *
 * ⛔ This variant carries NO tagline — the kit's other lockups have
 * "THE AI COMMUNICATIONS PLATFORM" baked into the pixels and it cannot be
 * removed or translated. If a screen needs a tagline, set it as real text.
 *
 * Source: docs/brand/loopcom/derived/loopcom-wordmark.png
 */
import React from 'react';
import { Image, StyleSheet } from 'react-native';
import type { ImageStyle, StyleProp } from 'react-native';

const LOGO = require('../../assets/loopcom-wordmark.png');

/** Intrinsic aspect of assets/loopcom-wordmark.png (1000 × 162, ink-cropped). */
export const LOOPCOM_LOGO_ASPECT = 1000 / 162;

interface LoopcomLogoProps {
  /** Width of the logo in dp. Height is derived from the artwork's aspect. */
  width: number;
  style?: StyleProp<ImageStyle>;
}

export function LoopcomLogo({ width, style }: LoopcomLogoProps) {
  return (
    <Image
      source={LOGO}
      resizeMode="contain"
      accessible
      accessibilityRole="image"
      accessibilityLabel="Loopcom"
      accessibilityIgnoresInvertColors
      style={[styles.logo, { width, height: width / LOOPCOM_LOGO_ASPECT }, style]}
    />
  );
}

const styles = StyleSheet.create({
  logo: {
    backgroundColor: 'transparent',
  },
});

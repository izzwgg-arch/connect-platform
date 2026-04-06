import { Platform, TextStyle } from 'react-native';

const baseFont = Platform.select({
  ios: 'SF Pro Display',
  android: 'Roboto',
  default: 'System',
});

const monoFont = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

export const typography = {
  displayXl: {
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -1.5,
    lineHeight: 48,
    fontFamily: baseFont,
  } as TextStyle,

  displayLg: {
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -1,
    lineHeight: 40,
    fontFamily: baseFont,
  } as TextStyle,

  displayMd: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.8,
    lineHeight: 36,
    fontFamily: baseFont,
  } as TextStyle,

  h1: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.5,
    lineHeight: 32,
    fontFamily: baseFont,
  } as TextStyle,

  h2: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
    lineHeight: 28,
    fontFamily: baseFont,
  } as TextStyle,

  h3: {
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: -0.2,
    lineHeight: 26,
    fontFamily: baseFont,
  } as TextStyle,

  h4: {
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.1,
    lineHeight: 24,
    fontFamily: baseFont,
  } as TextStyle,

  bodyLg: {
    fontSize: 16,
    fontWeight: '400',
    letterSpacing: 0,
    lineHeight: 26,
    fontFamily: baseFont,
  } as TextStyle,

  body: {
    fontSize: 14,
    fontWeight: '400',
    letterSpacing: 0,
    lineHeight: 22,
    fontFamily: baseFont,
  } as TextStyle,

  bodySm: {
    fontSize: 13,
    fontWeight: '400',
    letterSpacing: 0,
    lineHeight: 20,
    fontFamily: baseFont,
  } as TextStyle,

  labelLg: {
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.1,
    lineHeight: 20,
    fontFamily: baseFont,
  } as TextStyle,

  label: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
    lineHeight: 18,
    fontFamily: baseFont,
  } as TextStyle,

  labelSm: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    lineHeight: 16,
    fontFamily: baseFont,
  } as TextStyle,

  caption: {
    fontSize: 11,
    fontWeight: '400',
    letterSpacing: 0.2,
    lineHeight: 16,
    fontFamily: baseFont,
  } as TextStyle,

  tabLabel: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.3,
    lineHeight: 14,
    fontFamily: baseFont,
  } as TextStyle,

  mono: {
    fontSize: 13,
    fontWeight: '400',
    letterSpacing: 0,
    lineHeight: 20,
    fontFamily: monoFont,
  } as TextStyle,

  monoBold: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0,
    lineHeight: 20,
    fontFamily: monoFont,
  } as TextStyle,

  // Call screen specific
  callTimer: {
    fontSize: 22,
    fontWeight: '300',
    letterSpacing: 2,
    lineHeight: 30,
    fontFamily: monoFont,
  } as TextStyle,

  callName: {
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -0.5,
    lineHeight: 38,
    fontFamily: baseFont,
  } as TextStyle,

  dialpadKey: {
    fontSize: 28,
    fontWeight: '300',
    letterSpacing: 0,
    lineHeight: 34,
    fontFamily: baseFont,
  } as TextStyle,

  dialpadSub: {
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1.5,
    lineHeight: 12,
    fontFamily: baseFont,
  } as TextStyle,
} as const;

export type TypographyKey = keyof typeof typography;

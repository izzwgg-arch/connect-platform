import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { phoneLayoutWidth, keypadCellWidth, keypadGridWidth } from './phoneLayoutWidth';

// Galaxy S24+ (SM-S926B, the phone that hit this): 412 × 915 dp.
const S24_PORTRAIT = { w: 412, h: 915 };
const S24_LANDSCAPE = { w: 915, h: 412 };

test('portrait width passes through unchanged', () => {
  assert.equal(phoneLayoutWidth(S24_PORTRAIT.w, S24_PORTRAIT.h), 412);
});

test('a landscape (headless-rotated) reading yields the portrait width', () => {
  // This is the exact failure: the bundle loaded while the phone lay sideways.
  assert.equal(phoneLayoutWidth(S24_LANDSCAPE.w, S24_LANDSCAPE.h), 412);
});

test('the keypad grid always fits inside the real portrait window', () => {
  for (const [w, h] of [[412, 915], [915, 412], [360, 800], [800, 360], [393, 852], [1280, 800]]) {
    const layout = phoneLayoutWidth(w, h);
    const portrait = Math.min(w, h);
    assert.ok(keypadGridWidth(layout) <= Math.min(portrait, 520), `grid ${keypadGridWidth(layout)} overflows ${portrait} (window ${w}x${h})`);
  }
});

test('the old module-load constant would have overflowed the screen on the landscape read', () => {
  // Pre-fix maths, verbatim: width read at module load = 915 in landscape.
  const oldCell = Math.floor((915 - 14 * 2 - 8 * 2) / 3);
  const oldGrid = oldCell * 3 + 8 * 2;
  assert.ok(oldGrid > 412, 'the pre-fix grid must exceed the portrait screen, or this test proves nothing');
  assert.ok(keypadGridWidth(phoneLayoutWidth(915, 412)) <= 412);
});

test('garbage measurements fall back to a sane phone width', () => {
  assert.equal(phoneLayoutWidth(0, 0), 360);
  assert.equal(phoneLayoutWidth(NaN, NaN), 360);
  assert.equal(phoneLayoutWidth(50, 100), 240);
  assert.equal(phoneLayoutWidth(2000, 1200), 520);
});

test('cell width is a third of the padded row', () => {
  assert.equal(keypadCellWidth(412), Math.floor((412 - 28 - 16) / 3));
});

// ── Source guard: no screen may read the window width at module scope ──
// The defect was a module-scope constant, which no unit test of a helper can
// see; this reads the SOURCE of every screen that used to do it.
const GUARD_ROOT = process.env.MOBILE_GUARD_ROOT
  ? path.resolve(process.env.MOBILE_GUARD_ROOT)
  : path.join(__dirname, '..');
const GUARDED_SCREENS = [
  'screens/tabs/KeypadTab.tsx',
  'screens/tabs/ChatTab.tsx',
  'screens/call/ActiveCallScreen.tsx',
  'screens/call/IncomingCallScreen.tsx',
  'screens/call/CallsDrawer.tsx',
];

function codeOnly(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

test('no screen computes a layout width from Dimensions.get() at module scope', () => {
  for (const rel of GUARDED_SCREENS) {
    const code = codeOnly(readFileSync(path.join(GUARD_ROOT, rel), 'utf8'));
    assert.ok(!/Dimensions\.get\(/.test(code), `${rel} still reads Dimensions.get() — use usePhoneLayoutWidth() inside the component`);
    assert.ok(!/^\s*Dimensions,\s*$/m.test(code), `${rel} still imports Dimensions from react-native`);
  }
});

test('the keypad sizes its keys from the live width, never a module constant', () => {
  const code = codeOnly(readFileSync(path.join(GUARD_ROOT, 'screens/tabs/KeypadTab.tsx'), 'utf8'));
  assert.ok(/usePhoneLayoutWidth\(\)/.test(code), 'KeypadTab must call usePhoneLayoutWidth()');
  assert.ok(!/^const KEY_CELL_WIDTH\b/m.test(code), 'KEY_CELL_WIDTH must not be a module constant');
});

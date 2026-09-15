import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * ⛔⛔ THE PLAY STORE READ "not compatible" ON EVERY TABLET, AND NOTHING IN THE
 * REPO SAID SO. Google Play turns a requested permission into a REQUIRED
 * <uses-feature> unless the manifest declares it required="false". The shipped
 * build (fleet APK 1.0.0+20260906-115729, and Play vc100/101/102) implied SIX:
 *
 *   aapt2 dump badging <apk> | grep uses-implied-feature
 *     android.hardware.telephony       'requested a telephony permission'
 *     android.hardware.camera          'requested android.permission.CAMERA'
 *     android.hardware.microphone      'requested android.permission.RECORD_AUDIO'
 *     android.hardware.bluetooth       'requested android.permission.BLUETOOTH'
 *     android.hardware.location        'requested ACCESS_COARSE/FINE_LOCATION'
 *     android.hardware.screen.portrait 'one or more activities have specified
 *                                       a portrait orientation'
 *
 * `telephony` alone excludes every Wi-Fi-only tablet; `camera` (the REAR
 * camera) excludes front-camera-only tablets on top of that.
 *
 * This test is the guard. It reads the SOURCE of the two places that decide it
 * — the bare-project manifest that actually ships, and the config plugin that a
 * future `expo prebuild` would regenerate from — because no unit test of app
 * code can see a store-side filter. It fails if either list loses an entry, if
 * an entry is declared required="true", or if the two drift apart.
 *
 * ⛔ Re-check with `aapt2 dump badging` on the built APK after any permission
 * is added: a NEW permission can imply a NEW required feature that is on
 * neither list, and the store goes quiet about it.
 */
const GUARD_ROOT = process.env.MOBILE_GUARD_ROOT
  ? path.resolve(process.env.MOBILE_GUARD_ROOT)
  : path.join(__dirname, '..', '..');

const MANIFEST = path.join(GUARD_ROOT, 'android/app/src/main/AndroidManifest.xml');
const APP_CONFIG = path.join(GUARD_ROOT, 'app.config.ts');

/** Every feature Play would otherwise imply as REQUIRED from our permissions. */
const MUST_BE_OPTIONAL = [
  'android.hardware.telephony',
  'android.hardware.camera',
  'android.hardware.camera.any',
  'android.hardware.camera.front',
  'android.hardware.camera.autofocus',
  'android.hardware.microphone',
  'android.hardware.bluetooth',
  'android.hardware.bluetooth_le',
  'android.hardware.location',
  'android.hardware.location.gps',
  'android.hardware.location.network',
  'android.hardware.screen.portrait',
  'android.hardware.screen.landscape',
  'android.hardware.touchscreen',
  'android.hardware.faketouch',
  'android.hardware.wifi',
];

function manifestSource(): string {
  return readFileSync(MANIFEST, 'utf8').replace(/\r\n/g, '\n');
}

test('the shipped manifest declares every implied feature as NOT required', () => {
  const src = manifestSource();
  for (const name of MUST_BE_OPTIONAL) {
    const tag = new RegExp(
      `<uses-feature[^>]*android:name="${name.replace(/\./g, '\.')}"[^>]*/>`,
    ).exec(src)?.[0];
    assert.ok(tag, `AndroidManifest.xml has no <uses-feature> for ${name} — Play will imply it as REQUIRED and hide the app from devices without it`);
    assert.ok(
      /android:required="false"/.test(tag!),
      `${name} is declared required="true" — that excludes every device without it from the Play listing`,
    );
  }
});

test('no feature is declared required="true" anywhere in the manifest', () => {
  const src = manifestSource();
  const required = src.match(/<uses-feature[^>]*android:required="true"[^>]*\/>/g) ?? [];
  assert.deepEqual(required, [], `a required="true" feature excludes devices: ${required.join(', ')}`);
});

test('the prebuild config plugin carries the same list as the bare manifest', () => {
  // android/ is bare, so the manifest is what ships — but a prebuild would
  // regenerate it from app.config.ts. If the two drift, the tablets come back
  // the day someone runs `expo prebuild`.
  const config = readFileSync(APP_CONFIG, 'utf8').replace(/\r\n/g, '\n');
  const block = /const OPTIONAL_HARDWARE_FEATURES = \[([\s\S]*?)\];/.exec(config);
  assert.ok(block, 'app.config.ts no longer declares OPTIONAL_HARDWARE_FEATURES');
  const listed = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    [...listed].sort(),
    [...MUST_BE_OPTIONAL].sort(),
    'app.config.ts and this guard disagree about which features are optional',
  );
  assert.ok(
    /withOptionalHardwareFeatures,/.test(config),
    'withOptionalHardwareFeatures is defined but never registered in plugins[]',
  );
});

test('the portrait lock stays a lock, not a device filter', () => {
  // Keeping android:screenOrientation="portrait" is deliberate (the whole UI is
  // portrait-shaped, and phoneLayoutWidth() clamps to a 520dp short side so a
  // tablet still gets a phone-shaped layout). It must NOT cost us the listing.
  const src = manifestSource();
  assert.ok(/android:screenOrientation="portrait"/.test(src), 'MainActivity lost its portrait lock — intentional? update this guard');
  assert.ok(
    /<uses-feature[^>]*android:name="android\.hardware\.screen\.portrait"[^>]*android:required="false"/.test(src),
    'the portrait lock implies a REQUIRED screen.portrait feature unless it is declared optional',
  );
});

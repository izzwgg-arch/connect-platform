// Expo config plugin (iOS-only) that bundles a silent WAV file into the native
// iOS project so CallKit's own ringtone can be silenced when the user's
// "Incoming Ringtone" preference is Connect Default.
//
// WHY THIS EXISTS: every VoIP push reports a CallKit call natively, before JS
// runs (see plugins/withIosVoipPush.js) — this is an Apple requirement and
// cannot be skipped. CallKit plays its OWN ringtone sound the instant it
// reports the call. When the user picks "Connect Default", the JS layer
// (src/audio/telephonyAudio.ts) ALSO starts playing the bundled Connect
// ringtone, so historically both played at once (CallKit's system ringtone
// eventually "winning" over the JS one). Handing CallKit this silent file as
// its `ringtoneSound` (see src/sip/callkeep.ts) makes CallKit's own audio
// inaudible, leaving the JS Connect ringtone as the only sound — WITHOUT
// skipping the native CallKit report (still Apple-compliant) and WITHOUT
// touching the SIP/invite/answer pipeline at all.
//
// "Classic Ring" leaves `ringtoneSound` unset, so CallKit continues to use the
// user's real system ringtone exactly as before — unchanged behavior.
//
// This plugin is iOS-only: withDangerousMod(['ios', ...]) and
// withXcodeProject only ever touch the generated ios/ project. Nothing here
// runs against, or affects, the Android build in any way.
const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/** Must stay in sync with SILENT_RINGTONE_FILENAME in src/sip/callkeep.ts. */
const SILENT_RINGTONE_FILENAME = 'connect-silent-ringtone.wav';

const withIosSilentRingtone = (config) => {
  config = withDangerousMod(config, [
    'ios',
    async (mod) => {
      const source = path.join(mod.modRequest.projectRoot, 'assets', SILENT_RINGTONE_FILENAME);
      const target = path.join(mod.modRequest.platformProjectRoot, SILENT_RINGTONE_FILENAME);
      try {
        await fs.promises.copyFile(source, target);
        console.log('[withIosSilentRingtone] copied', SILENT_RINGTONE_FILENAME, 'into ios project');
      } catch (e) {
        console.warn('[withIosSilentRingtone] failed to copy silent ringtone asset:', String(e));
      }
      return mod;
    },
  ]);

  return withXcodeProject(config, (mod) => {
    try {
      const project = mod.modResults;
      // Continuous Native Generation regenerates ios/ from scratch on every
      // EAS build, so re-registration on a stale local `expo prebuild` rerun
      // (without --clean) is the only case this guards against.
      const alreadyPresent = typeof project.hasFile === 'function' && project.hasFile(SILENT_RINGTONE_FILENAME);
      if (!alreadyPresent) {
        project.addResourceFile(SILENT_RINGTONE_FILENAME, {
          target: project.getFirstTarget().uuid,
        });
        console.log('[withIosSilentRingtone] registered', SILENT_RINGTONE_FILENAME, 'as a bundle resource');
      }
    } catch (e) {
      console.warn('[withIosSilentRingtone] failed to register silent ringtone resource:', String(e));
    }
    return mod;
  });
};

module.exports = withIosSilentRingtone;
module.exports.SILENT_RINGTONE_FILENAME = SILENT_RINGTONE_FILENAME;

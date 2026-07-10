// Expo config plugin (iOS-only) that bundles the real Connect ringtone
// (connect-default-ringtone.caf) into the app so CallKit can play it for a
// backgrounded / force-quit incoming call.
//
// WHY THE REWRITE: the first version copied the file to the ios/ ROOT and used
// the raw `project.addResourceFile(...)`, which did NOT land the file in "Copy
// Bundle Resources" — device telemetry proved it (cafPresent=false: CallKit was
// told to play connect-default-ringtone.caf but the file wasn't in the bundle,
// so it fell back to the system ring). This version mirrors Expo's own
// PrivacyInfo/Locales plugins exactly: place the file INSIDE the app source
// folder (ios/<projectName>/) and register it with
// IOSConfig.XcodeUtils.addResourceFileToGroup({ isBuildFile: true }), which is
// the supported way to add a bundle resource.
//
// iOS-only. Nothing here runs against or affects the Android build.
const { withDangerousMod, withXcodeProject, IOSConfig } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/** Must stay in sync with CONNECT_RINGTONE_FILENAME in src/sip/callkeep.ts and
 *  the pathForResource lookup in plugins/withIosVoipPush.js. */
const CONNECT_RINGTONE_FILENAME = 'connect-default-ringtone.caf';

function resolveProjectName(modRequest) {
  return (
    modRequest.projectName ||
    IOSConfig.XcodeUtils.getProjectName(modRequest.projectRoot)
  );
}

const withIosConnectRingtone = (config) => {
  // 1) Copy the .caf INTO the app source folder: ios/<projectName>/<file>.
  config = withDangerousMod(config, [
    'ios',
    async (mod) => {
      try {
        const projectName = resolveProjectName(mod.modRequest);
        const source = path.join(mod.modRequest.projectRoot, 'assets', CONNECT_RINGTONE_FILENAME);
        const destDir = path.join(mod.modRequest.platformProjectRoot, projectName);
        const dest = path.join(destDir, CONNECT_RINGTONE_FILENAME);
        await fs.promises.mkdir(destDir, { recursive: true });
        await fs.promises.copyFile(source, dest);
        console.log('[withIosConnectRingtone] copied', CONNECT_RINGTONE_FILENAME, '->', path.join(projectName, CONNECT_RINGTONE_FILENAME));
      } catch (e) {
        console.warn('[withIosConnectRingtone] copy failed:', String(e));
      }
      return mod;
    },
  ]);

  // 2) Register it as a bundle resource (Copy Bundle Resources) via the
  //    supported Expo helper — the piece the first version got wrong.
  return withXcodeProject(config, (mod) => {
    try {
      const projectName = resolveProjectName(mod.modRequest);
      const filepath = path.join(projectName, CONNECT_RINGTONE_FILENAME);
      if (!mod.modResults.hasFile(filepath)) {
        mod.modResults = IOSConfig.XcodeUtils.addResourceFileToGroup({
          filepath,
          groupName: projectName,
          project: mod.modResults,
          isBuildFile: true,
          verbose: true,
        });
        console.log('[withIosConnectRingtone] registered', filepath, 'in Copy Bundle Resources');
      } else {
        console.log('[withIosConnectRingtone] already present:', filepath);
      }
    } catch (e) {
      console.warn('[withIosConnectRingtone] register failed:', String(e));
    }
    return mod;
  });
};

module.exports = withIosConnectRingtone;
module.exports.CONNECT_RINGTONE_FILENAME = CONNECT_RINGTONE_FILENAME;

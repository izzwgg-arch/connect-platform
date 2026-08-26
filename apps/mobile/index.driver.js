// ══════════════════ LOOPCOM DRIVER ENTRY ══════════════════
// Used ONLY by the driver APK (CONNECT_DRIVER_APP=1 in android/app/build.gradle
// swaps --entry-file to this). ⛔ DELIBERATELY DOES NOT IMPORT the phone app's
// background call tasks, SIP pre-register task, or sipWakeRegistrar — the
// driver app has no phone side, and those modules install module-scope side
// effects the moment they are imported. Keep this file's import list minimal.
import 'react-native-gesture-handler';

import { registerRootComponent } from 'expo';

import { markDriverApp } from './src/driver/appKind';
import DriverApp from './src/driver/DriverApp';

// Before the tree mounts, so every shared screen (RunsScreen etc.) can ask
// "am I inside the driver app?" and render its driver-only chrome.
markDriverApp();

registerRootComponent(DriverApp);

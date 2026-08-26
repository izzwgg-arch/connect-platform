// ══════════════════ LOOPCOM DRIVER — DEMO ENTRY ══════════════════
// Used ONLY by the demo APK (CONNECT_DRIVER_DEMO=1 in android/app/build.gradle
// swaps --entry-file to this). Identical to index.driver.js plus the demo
// mark: the delivery client answers from the built-in Gesheft run (real
// Kiryas Joel / Monroe addresses), the login validates locally, and location
// uploads are dropped — the GPS prompt, foreground service and map follow-me
// stay REAL. ⛔ Same rule as the driver entry: never import the phone app's
// background tasks or SIP registrars here.
import 'react-native-gesture-handler';

import { registerRootComponent } from 'expo';

import { markDriverApp, markDriverDemo } from './src/driver/appKind';
import DriverApp from './src/driver/DriverApp';

markDriverApp();
markDriverDemo();

registerRootComponent(DriverApp);

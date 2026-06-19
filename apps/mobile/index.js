// Must be first import for release build gesture handler initialization
import 'react-native-gesture-handler';

// Background notification task — MUST be imported BEFORE registerRootComponent.
// This registers the headless JS task that wakes Android when a push arrives
// and the app is fully terminated, enabling native incoming-call UI via CallKeep.
import './src/notifications/backgroundCallTask';

// SIP pre-register HeadlessJS task — MUST be imported BEFORE registerRootComponent
// so its task name is registered before IncomingCallFirebaseService starts it.
// Boots JS during the ring on a killed/swiped app so SIP registers before the
// user answers (see sipPreRegisterHeadlessTask.ts).
import './src/notifications/sipPreRegisterHeadlessTask';

import { registerRootComponent } from "expo";

import App from "./App";

registerRootComponent(App);

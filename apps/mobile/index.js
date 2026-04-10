// Must be first import for release build gesture handler initialization
import 'react-native-gesture-handler';

// Background notification task — MUST be imported BEFORE registerRootComponent.
// This registers the headless JS task that wakes Android when a push arrives
// and the app is fully terminated, enabling native incoming-call UI via CallKeep.
import './src/notifications/backgroundCallTask';

import { registerRootComponent } from "expo";

import App from "./App";

registerRootComponent(App);

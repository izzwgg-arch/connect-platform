// Must be first import for release build gesture handler initialization
import 'react-native-gesture-handler';

import { registerRootComponent } from "expo";

import App from "./App";

registerRootComponent(App);

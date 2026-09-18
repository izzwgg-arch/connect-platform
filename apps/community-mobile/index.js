// Must be first import — matches apps/mobile's convention.
import "react-native-gesture-handler";

import { registerRootComponent } from "expo";

import App from "./App";

registerRootComponent(App);

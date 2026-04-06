import type { NavigatorScreenParams } from '@react-navigation/native';

// Tab stacks
export type TabParamList = {
  QuickAction: undefined;
  Team: undefined;
  Contact: undefined;
  Keypad: undefined;
  Recent: undefined;
  Chat: undefined;
  Voicemail: undefined;
};

// Root auth stack
export type AuthStackParamList = {
  Welcome: undefined;
  Login: undefined;
  QrProvision: undefined;
};

// Authenticated root stack
export type AppStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList>;
  Settings: undefined;
  QrProvision: undefined;
  Diagnostics: undefined;
  ActiveCall: undefined;
  IncomingCall: undefined;
};

// Root
export type RootStackParamList = {
  Auth: NavigatorScreenParams<AuthStackParamList>;
  App: NavigatorScreenParams<AppStackParamList>;
};

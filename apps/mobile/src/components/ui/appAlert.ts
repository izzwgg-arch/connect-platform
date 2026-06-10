import { Alert } from 'react-native';

// Imperative, Connect-themed replacement for React Native's white system
// `Alert.alert`. Call `showAppAlert(...)` from anywhere (including outside
// React) and the themed host (mounted once near the app root) renders a
// modern modal. If the host isn't mounted yet we fall back to the OS dialog
// so an alert is never silently lost.

export type AppAlertButtonStyle = 'default' | 'cancel' | 'destructive';

export type AppAlertButton = {
  text: string;
  style?: AppAlertButtonStyle;
  onPress?: () => void;
};

export type AppAlertOptions = {
  title: string;
  message?: string;
  buttons?: AppAlertButton[];
};

type Handler = (opts: AppAlertOptions) => void;

let handler: Handler | null = null;

export function registerAppAlertHandler(h: Handler | null): void {
  handler = h;
}

export function showAppAlert(
  title: string,
  message?: string,
  buttons?: AppAlertButton[],
): void {
  if (handler) {
    handler({ title, message, buttons });
    return;
  }
  Alert.alert(title, message, buttons as Parameters<typeof Alert.alert>[2]);
}

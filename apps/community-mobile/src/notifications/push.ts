import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { api } from "../api/client";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Registers this device for push and tells the api about it
 * (POST /me/devices). Handles a denied permission gracefully — no feature in
 * this app assumes a push token exists.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (!Device.isDevice) return null; // simulators/emulators can't get a real token

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== "granted") return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", { name: "default", importance: Notifications.AndroidImportance.DEFAULT });
  }

  try {
    const token = (await Notifications.getExpoPushTokenAsync()).data;
    await api("/me/devices", { method: "POST", body: { platform: Platform.OS, token } });
    return token;
  } catch {
    return null; // no EAS project configured yet, or the api call failed — non-fatal
  }
}

export async function unregisterDevice(token: string): Promise<void> {
  try {
    await api(`/me/devices/${encodeURIComponent(token)}`, { method: "DELETE" });
  } catch {
    /* best-effort */
  }
}

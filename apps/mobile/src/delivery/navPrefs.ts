// Driver navigation preferences (Izzy, 2026-08-25):
//  * mapMode — does the route live INSIDE the Loopcom Driver app (in-app map
//    with the stops and a follow-me position) or hand off to an external
//    navigation app per leg?
//  * navApp — which external app carries the turn-by-turn: Waze, Google Maps,
//    or Apple Maps (offered on iPhone only — the option is filtered by
//    platform at the UI, never here, so a synced pref survives moving phones).
// Stored per device in AsyncStorage; defaults favor the external handoff with
// Waze — the behavior drivers already know.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

export type MapMode = "external" | "inapp";
export type NavApp = "waze" | "google" | "apple";

export interface NavPrefs {
  mapMode: MapMode;
  navApp: NavApp;
}

const KEY = "cc_driver_nav_prefs";
const DEFAULTS: NavPrefs = { mapMode: "external", navApp: "waze" };

export function normalizeNavPrefs(raw: unknown): NavPrefs {
  const p = (raw ?? {}) as Partial<NavPrefs>;
  const mapMode: MapMode = p.mapMode === "inapp" ? "inapp" : "external";
  let navApp: NavApp = p.navApp === "google" || p.navApp === "apple" ? p.navApp : "waze";
  // An "apple" pref restored onto an Android phone falls back to Waze rather
  // than handing the OS a URL no installed app owns.
  if (navApp === "apple" && Platform.OS !== "ios") navApp = "waze";
  return { mapMode, navApp };
}

export async function getNavPrefs(): Promise<NavPrefs> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? normalizeNavPrefs(JSON.parse(raw)) : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function setNavPrefs(next: Partial<NavPrefs>): Promise<NavPrefs> {
  const merged = normalizeNavPrefs({ ...(await getNavPrefs()), ...next });
  await AsyncStorage.setItem(KEY, JSON.stringify(merged)).catch(() => {});
  return merged;
}

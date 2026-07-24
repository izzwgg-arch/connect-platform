// Driver navigation handoff. Opens Waze (preferred) for the current stop; falls back to Google
// Maps if Waze isn't installed. Waze has no multi-stop API — the server sends the optimized stop
// order (route), and the driver navigates one leg at a time.

import { Linking } from "react-native";

export interface Dest {
  lat: number;
  lng: number;
}

const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));

export function wazeUrl(d: Dest): string {
  return `https://waze.com/ul?ll=${clamp(d.lat, 90)},${clamp(d.lng, 180)}&navigate=yes`;
}
export function wazeAppUrl(d: Dest): string {
  return `waze://?ll=${clamp(d.lat, 90)},${clamp(d.lng, 180)}&navigate=yes`;
}
export function googleUrl(d: Dest): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${clamp(d.lat, 90)},${clamp(d.lng, 180)}&travelmode=driving`;
}

export type NavPreference = "waze" | "google";

/** Open turn-by-turn navigation to a stop. Returns which app opened. */
export async function openStopNavigation(dest: Dest, preferred: NavPreference = "waze"): Promise<NavPreference> {
  if (preferred === "waze") {
    try {
      if (await Linking.canOpenURL("waze://")) {
        await Linking.openURL(wazeAppUrl(dest));
        return "waze";
      }
    } catch {
      /* fall through */
    }
    // Universal link opens Waze app if present, else Waze web.
    try {
      await Linking.openURL(wazeUrl(dest));
      return "waze";
    } catch {
      /* fall through to Google */
    }
  }
  await Linking.openURL(googleUrl(dest));
  return "google";
}

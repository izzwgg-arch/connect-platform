// ══════════════════ LOOPCOM DRIVER — DEMO BACKEND ══════════════════
// The demo APK's whole "server": one fully populated Gesheft run with real
// Kiryas Joel / Monroe streets and coordinates, so the map draws a real route,
// Navigate opens real turn-by-turn, and the delivery flow (scan → arrive →
// proof / exception) advances stop state locally. Nothing here ever touches
// the network — deliveryClient.ts branches to these functions when
// isDriverDemo() is true. State persists in AsyncStorage so a half-finished
// demo run survives an app restart; "Reset the demo" in Settings clears it.
//
// ⛔ Coordinates are street-accurate for the DEMO's purpose (pins on the right
// streets in the village) — they are hand-placed, not geocoded. Never copy
// them into anything that dispatches a real driver.
import AsyncStorage from "@react-native-async-storage/async-storage";

const STATE_KEY = "cc_driver_demo_state_v1";

export const DEMO_LOGIN_EMAIL = "driver@gesheftkosher.com";
export const DEMO_LOGIN_PASSWORD = "demo1234";
export const DEMO_TOKEN = "loopcom-driver-demo-token";

type StopStatus = "READY" | "SCANNED" | "ARRIVED" | "DELIVERED" | "FAILED";

interface DemoStop {
  orderId: string;
  customerName: string;
  addrLine1: string;
  addrUnit?: string;
  addrCity: string;
  instructions?: string;
  lat: number;
  lng: number;
}

// One afternoon run out of the store — 8 stops through Kiryas Joel & Monroe.
const STOPS: DemoStop[] = [
  { orderId: "demo-4512", customerName: "Rivky Braun", addrLine1: "12 Forest Rd", addrUnit: "Unit 4B", addrCity: "Monroe", instructions: "Leave by the side door", lat: 41.3296, lng: -74.1651 },
  { orderId: "demo-4513", customerName: "Y. Gluck", addrLine1: "8 Acres Rd", addrCity: "Kiryas Joel", lat: 41.3389, lng: -74.1604 },
  { orderId: "demo-4514", customerName: "M. Stern", addrLine1: "5 Van Buren Dr", addrCity: "Kiryas Joel", instructions: "Ring apartment 2 — WIC order", lat: 41.3427, lng: -74.1688 },
  { orderId: "demo-4515", customerName: "D. Katz", addrLine1: "51 Bakertown Rd", addrCity: "Monroe", lat: 41.3314, lng: -74.1742 },
  { orderId: "demo-4516", customerName: "S. Weiss", addrLine1: "3 Israel Zupnick Dr", addrCity: "Kiryas Joel", instructions: "Call when you're outside", lat: 41.3407, lng: -74.1623 },
  { orderId: "demo-4517", customerName: "C. Gruber", addrLine1: "18 Satmar Dr", addrCity: "Kiryas Joel", lat: 41.3438, lng: -74.1657 },
  { orderId: "demo-4518", customerName: "R. Lefkowitz", addrLine1: "7 Getzel Berger Blvd", addrCity: "Kiryas Joel", instructions: "Frozen items — don't leave outside", lat: 41.3452, lng: -74.1707 },
  { orderId: "demo-4519", customerName: "B. Friedman", addrLine1: "22 Seven Springs Rd", addrCity: "Monroe", lat: 41.3241, lng: -74.1582 },
];

let statuses: Record<string, StopStatus> = {};
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY);
    if (raw) statuses = JSON.parse(raw);
  } catch {
    statuses = {};
  }
}

async function save(): Promise<void> {
  await AsyncStorage.setItem(STATE_KEY, JSON.stringify(statuses)).catch(() => {});
}

function statusOf(orderId: string): StopStatus {
  return statuses[orderId] ?? "READY";
}

export async function demoResetState(): Promise<void> {
  statuses = {};
  await AsyncStorage.removeItem(STATE_KEY).catch(() => {});
}

/** Same shape as GET /mobile/delivery/runs. */
export async function demoGetRuns(): Promise<any[]> {
  await ensureLoaded();
  return [
    {
      id: "demo-run-000088",
      status: "ACTIVE",
      stops: STOPS.map((s, i) => ({
        orderId: s.orderId,
        sequence: i + 1,
        status: statusOf(s.orderId),
        order: {
          id: s.orderId,
          status: statusOf(s.orderId),
          addrLine1: s.addrLine1,
          addrUnit: s.addrUnit ?? null,
          addrCity: s.addrCity,
          customerName: s.customerName,
          instructions: s.instructions ?? null,
          lat: s.lat,
          lng: s.lng,
        },
      })),
    },
  ];
}

/** Any scanned code attaches the next un-scanned stop — the demo is about the
 *  motion (point, beep, assigned), not label bookkeeping. */
export async function demoScan(): Promise<any> {
  await ensureLoaded();
  const next = STOPS.find((s) => statusOf(s.orderId) === "READY");
  if (!next) {
    return { ok: true, idempotent: true, decision: { outcome: "duplicate", code: "duplicate", canAssign: false, needsConfirmation: false, message: "Every package on this run is already scanned." } };
  }
  statuses[next.orderId] = "SCANNED";
  await save();
  const seq = STOPS.findIndex((s) => s.orderId === next.orderId) + 1;
  return { ok: true, orderId: next.orderId, decision: { outcome: "assigned", code: "assigned", canAssign: true, needsConfirmation: false, message: `Package scanned — stop ${seq}, ${next.customerName}` } };
}

export async function demoArrive(orderId: string): Promise<any> {
  await ensureLoaded();
  if (statuses[orderId] !== "DELIVERED" && statuses[orderId] !== "FAILED") statuses[orderId] = "ARRIVED";
  await save();
  return { ok: true };
}

export async function demoProof(orderId: string): Promise<any> {
  await ensureLoaded();
  statuses[orderId] = "DELIVERED";
  await save();
  return { ok: true, status: "DELIVERED" };
}

export async function demoException(orderId: string): Promise<any> {
  await ensureLoaded();
  statuses[orderId] = "FAILED";
  await save();
  return { ok: true, status: "FAILED" };
}

/** Same URLs the server's navLinks.ts builds — real turn-by-turn to the stop. */
export async function demoStopNavUrl(orderId: string, app: "waze" | "google" | "apple"): Promise<{ url: string }> {
  const s = STOPS.find((x) => x.orderId === orderId) ?? STOPS[0];
  if (app === "waze") return { url: `https://waze.com/ul?ll=${s.lat},${s.lng}&navigate=yes` };
  if (app === "apple") return { url: `https://maps.apple.com/?daddr=${s.lat},${s.lng}&dirflg=d` };
  return { url: `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving` };
}

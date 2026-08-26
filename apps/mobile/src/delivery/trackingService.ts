// Foreground location reporter (Phase 5). Runs ONLY during an active run, with a visible
// persistent notification (decision 6: foreground-service only). Batches fixes and posts
// them to the server; stops cleanly on run end / sign-out / inactivity.
//
// NOTE: native foreground-service behavior is not build-verified in this scaffold — verify
// on a real device. The manifest needs ACCESS_FINE_LOCATION + FOREGROUND_SERVICE_LOCATION
// (add via the app.config.ts plugin, not by editing AndroidManifest directly).

import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import * as Battery from "expo-battery";
import { API_BASE } from "../api/client";
import { isDriverDemo } from "../driver/appKind";
import { reportingIntervalSec } from "./adaptiveInterval";

export const DELIVERY_LOCATION_TASK = "cc-delivery-location";

type Sample = {
  lat: number;
  lng: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  batteryPct?: number | null;
  deviceTs: number;
};

// In-memory session context set by start/stop.
let session: { token: string; sessionId: string } | null = null;
let buffer: Sample[] = [];
let lastFlush = 0;

async function flush() {
  if (!session || buffer.length === 0) return;
  // Demo build: the location task, permission prompt and foreground
  // notification are all REAL — only the upload is dropped (there is no
  // server session to post against, and a 401 loop is just noise).
  if (isDriverDemo()) { buffer = []; lastFlush = Date.now(); return; }
  const batch = buffer;
  buffer = [];
  try {
    await fetch(`${API_BASE}/mobile/delivery/location`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ sessionId: session.sessionId, samples: batch }),
    });
    lastFlush = Date.now();
  } catch {
    // Offline: re-buffer (store-and-forward). Bounded to avoid unbounded growth.
    buffer = [...batch.slice(-200), ...buffer];
  }
}

// The task receives batched location updates from the OS.
TaskManager.defineTask(DELIVERY_LOCATION_TASK, async ({ data, error }: any) => {
  if (error || !data?.locations || !session) return;
  const battery = await Battery.getBatteryLevelAsync().catch(() => -1);
  for (const loc of data.locations) {
    buffer.push({
      lat: loc.coords.latitude,
      lng: loc.coords.longitude,
      accuracy: loc.coords.accuracy,
      speed: loc.coords.speed,
      heading: loc.coords.heading,
      batteryPct: battery >= 0 ? Math.round(battery * 100) : null,
      deviceTs: loc.timestamp || Date.now(),
    });
  }
  // Adaptive flush cadence (server-load friendly).
  const moving = data.locations.some((l: any) => (l.coords.speed ?? 0) >= 1);
  const intervalSec = reportingIntervalSec({ moving, approaching: false });
  if (Date.now() - lastFlush >= intervalSec * 1000) await flush();
});

export async function startTracking(token: string, sessionId: string): Promise<boolean> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return false;
  session = { token, sessionId };
  buffer = [];
  lastFlush = 0;
  await Location.startLocationUpdatesAsync(DELIVERY_LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 10_000,
    distanceInterval: 25,
    foregroundService: {
      notificationTitle: "Sharing location",
      notificationBody: "Active delivery run — customers can see your progress.",
      notificationColor: "#22a8ff",
    },
    pausesUpdatesAutomatically: false,
  });
  return true;
}

export async function stopTracking(): Promise<void> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(DELIVERY_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(DELIVERY_LOCATION_TASK);
    }
    await flush(); // final drain
  } finally {
    session = null;
    buffer = [];
  }
}

export function isTracking(): boolean {
  return session != null;
}

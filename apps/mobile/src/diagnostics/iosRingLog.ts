/**
 * iOS ring-path flight recorder.
 *
 * The Android flight recorder can't help on iOS, and — critically — when the
 * app is FORCE-QUIT no JS runs at all, so the killed-state ring (handled 100%
 * natively by CallKit via the VoIP-push handler) is invisible to any JS logging.
 *
 * This module is the JS half of a two-layer iOS recorder:
 *   - NATIVE half (plugins/withIosVoipPush.js) appends a breadcrumb to the file
 *     below on every VoIP push, EVEN when cold-killed — capturing appState, the
 *     exact ringtoneSound CallKit is about to use (from NSUserDefaults), and
 *     whether connect-default-ringtone.caf is actually in the bundle.
 *   - JS half (here) appends breadcrumbs for the warm/foreground paths and, on
 *     next app open, uploads the whole file to /mobile/flight-recorder/upload as
 *     an IOS session, then clears it.
 *
 * The file lives in the app's Documents directory so native (NSDocumentDirectory)
 * and JS (FileSystem.documentDirectory) read/write the SAME path.
 *
 * iOS-only. Every call is a best-effort no-op on Android or on any error, so it
 * can never affect the call path.
 */
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system";

const LOG_FILENAME = "connect_ios_ring_log.jsonl";

function logPath(): string | null {
  const dir = FileSystem.documentDirectory;
  if (!dir) return null;
  return dir + LOG_FILENAME;
}

/** Append one JS-side breadcrumb line (iOS only). Best-effort. */
export async function appendIosRingLog(stage: string, payload: Record<string, unknown> = {}): Promise<void> {
  if (Platform.OS !== "ios") return;
  const path = logPath();
  if (!path) return;
  try {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        src: "js",
        stage,
        ...payload,
      }) + "\n";
    let existing = "";
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) existing = await FileSystem.readAsStringAsync(path);
    } catch {
      /* file may not exist yet */
    }
    // Cap file growth so a device that never reopens doesn't grow unbounded.
    if (existing.length > 40000) {
      const lines = existing.split("\n").filter(Boolean);
      existing = lines.slice(-100).join("\n") + "\n";
    }
    await FileSystem.writeAsStringAsync(path, existing + line);
  } catch {
    /* non-critical */
  }
}

/**
 * On app open, read the ring-log file, upload it as an IOS flight session, and
 * clear it. Reuses the same endpoint the Android recorder uses so it lands in
 * the CallFlightSession table (platform = IOS). Best-effort.
 */
export async function uploadAndClearIosRingLog(opts: {
  apiBaseUrl: string;
  token: string | null;
  appVersion?: string | null;
  buildNumber?: string | null;
  extension?: string | null;
}): Promise<void> {
  if (Platform.OS !== "ios") return;
  if (!opts.token) return;
  const path = logPath();
  if (!path) return;
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return;
    const raw = await FileSystem.readAsStringAsync(path).catch(() => "");
    if (!raw || !raw.trim()) return;

    const events = raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l, i) => {
        let obj: Record<string, unknown> = {};
        try {
          obj = JSON.parse(l);
        } catch {
          obj = { raw: l };
        }
        const tsRaw = obj.ts;
        let ts: string;
        if (typeof tsRaw === "string" && tsRaw.includes("-")) {
          ts = tsRaw; // ISO from JS
        } else {
          // native writes epoch seconds as a string/number
          const secs = Number(tsRaw);
          ts = Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : new Date().toISOString();
        }
        return {
          seq: i,
          ts,
          stage: String(obj.stage || obj.event || "IOS_RING_LOG"),
          appState: (obj.appState as string) ?? null,
          payload: obj,
        };
      });

    if (events.length === 0) return;

    const sessionId = `cfs_ios_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const body = {
      session: {
        id: sessionId,
        startedAt: events[0]?.ts || new Date().toISOString(),
        endedAt: events[events.length - 1]?.ts || new Date().toISOString(),
        result: "ios_ring_log",
        uiMode: "ios-ring-recorder",
        events,
        meta: {
          platform: "IOS",
          appVersion: opts.appVersion ?? undefined,
          extension: opts.extension ?? undefined,
          networkType: opts.buildNumber ? `build ${opts.buildNumber}` : undefined,
        },
      },
      stats: {
        hadRingtone: events.some((e) => String(e.stage).toUpperCase().includes("RING")),
      },
    };

    const res = await fetch(`${opts.apiBaseUrl.replace(/\/$/, "")}/mobile/flight-recorder/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
    }
  } catch {
    /* non-critical */
  }
}

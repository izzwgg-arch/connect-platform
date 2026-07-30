/**
 * headlessDeviceReport.ts
 *
 * Module-scope (NON-React-tree) device health re-report.
 *
 * Why this exists
 * ---------------
 * MobileDevice.lastSeenAt / keepAliveSnapshot are refreshed by a 60 s interval
 * inside NotificationsContext — which only runs while the React component tree
 * is mounted. After a headless FCM wake (cold boot, no UI), the module-scope
 * SIP singleton keeps the PBX registration alive for hours while the backend's
 * view of the device goes stale: observed live 2026-07-30 (Luxure SM-X828U —
 * SIP refreshing every 10 min, lastSeenAt frozen at the wake). A stale
 * lastSeenAt eventually makes the device-registration watchdog treat the
 * device as gone (24 h recency gate) and stops the admin dashboard from
 * showing truthful health.
 *
 * This helper re-reports through the same /mobile/devices/register upsert,
 * reading the auth + push tokens from SecureStore (both are persisted by
 * AuthContext / push init), so it works with no React tree. It is throttled
 * and best-effort: failures never propagate into the register path that
 * invokes it.
 */
import { NativeModules, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

import { registerMobileDevice } from "../api/client";
import { loadKeepAliveGate } from "../sip/keepAliveGate";

const LOG = "[HEADLESS_DEVICE_REPORT]";
// Same keys AuthContext / push init persist under.
const TOKEN_KEY = "cc_mobile_token";
const EXPO_PUSH_TOKEN_KEY = "cc_mobile_expo_push_token";
const INSTALLATION_DEVICE_ID_KEY = "cc_mobile_device_id";

/** Minimum spacing between headless reports. The standing-registration
 * maintenance heartbeat ticks ~every 4 min; one report per ~5 min keeps
 * lastSeenAt continuously fresh without meaningful cost. */
const REPORT_THROTTLE_MS = 5 * 60_000;

let lastReportAtMs = 0;
let inFlight = false;

/**
 * Fire-and-forget throttled device re-report. Safe to call after every
 * successful headless SIP register — it self-throttles and never throws.
 */
export function reportDeviceHealthHeadless(reason: string): void {
  if (Platform.OS !== "android") return;
  const now = Date.now();
  if (inFlight || now - lastReportAtMs < REPORT_THROTTLE_MS) return;
  inFlight = true;
  void (async () => {
    try {
      const [authToken, expoPushToken, deviceId] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY).catch(() => null),
        SecureStore.getItemAsync(EXPO_PUSH_TOKEN_KEY).catch(() => null),
        SecureStore.getItemAsync(INSTALLATION_DEVICE_ID_KEY).catch(() => null),
      ]);
      if (!authToken || !expoPushToken) return;

      // Minimal metadata: device identity + the keep-alive FGS snapshot (the
      // health signal the admin dashboard needs). Permissions are omitted —
      // the register endpoint patch-skips absent blocks, so the last
      // UI-reported values are preserved.
      const mod: any = (NativeModules as any)?.IncomingCallUi;
      let manufacturer: string | undefined;
      let model: string | undefined;
      let osVersion: string | undefined;
      try {
        const info = mod?.getDeviceInfo?.();
        if (info && typeof info === "object") {
          manufacturer = String(info.manufacturer || "") || undefined;
          model = String(info.model || "") || undefined;
          osVersion = String(info.osVersion || "") || undefined;
        }
      } catch {
        /* optional */
      }

      let keepAlive: Record<string, unknown> | undefined;
      try {
        const diag = mod?.getCallWakeDiagnostics?.();
        if (diag && typeof diag === "object") {
          keepAlive = {
            isRunning: Boolean(diag.keepAliveIsRunning),
            serviceCreatedAtMs: Number(diag.keepAliveServiceCreatedAtMs) || 0,
            serviceDestroyedAtMs: Number(diag.keepAliveServiceDestroyedAtMs) || 0,
            lastStartResult: String(diag.keepAliveLastStartResult ?? ""),
            lastForegroundResult: String(diag.keepAliveLastForegroundResult ?? ""),
            lastForegroundTypeUsed: String(diag.keepAliveLastForegroundTypeUsed ?? ""),
            foregroundLandedAtMs: Number(diag.keepAliveForegroundLandedAtMs) || 0,
            process: String(diag.keepAliveProcess ?? ""),
            rearmCount: Number(diag.keepAliveRearmCount) || 0,
          };
        }
      } catch {
        /* optional */
      }
      try {
        const gate = await loadKeepAliveGate();
        keepAlive = {
          ...(keepAlive ?? {}),
          gateNeeded: gate.needed,
          gateReason: gate.reason,
          gateLatchedAtMs: gate.latchedAtMs,
          gateDropCount: gate.dropCount,
        };
      } catch {
        /* optional */
      }

      await registerMobileDevice(authToken, {
        platform: "ANDROID",
        expoPushToken,
        ...(deviceId ? { deviceId } : {}),
        ...(manufacturer ? { manufacturer } : {}),
        ...(model ? { model } : {}),
        ...(osVersion ? { osVersion } : {}),
        // Keys mirror the structured keepAlive input; built dynamically so a
        // missing native diag simply omits fields (server patch-skips them).
        ...(keepAlive ? { keepAlive: keepAlive as Parameters<typeof registerMobileDevice>[1]["keepAlive"] } : {}),
      });
      lastReportAtMs = Date.now();
      console.log(`${LOG} reported (${reason})`);
    } catch (e) {
      console.warn(`${LOG} failed (${reason}):`, e instanceof Error ? e.message : String(e));
    } finally {
      inFlight = false;
    }
  })();
}

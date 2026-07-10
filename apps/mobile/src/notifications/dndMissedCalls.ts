/**
 * DND missed-call reconciliation.
 *
 * When Do-Not-Disturb is ON and a call comes in, the native FCM service
 * (IncomingCallFirebaseService) suppresses the ring/UI but records a pending
 * "missed call" entry (and posts a missed-call notification). This module
 * drains those pending entries — even ones recorded while the app was fully
 * killed — and folds them into the local call history so they show up in Recent
 * as red "Missed" rows.
 *
 * appendCallRecord dedupes by `id`, so re-draining, or overlap with the live
 * jssip DND branch (which uses the same `invite:<id>` id scheme), is safe.
 */
import { useEffect } from "react";
import { AppState, DeviceEventEmitter, NativeModules, Platform } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { appendCallRecord } from "../storage/callHistory";
import { mobileQueryKeys } from "../api/client";
import type { CallRecord } from "../types";

type NativeDndMissed = {
  inviteId?: string;
  pbxCallId?: string;
  fromNumber?: string;
  fromDisplay?: string;
  toExtension?: string;
  tenantId?: string;
  ts?: number;
};

/**
 * Drain (return + clear) the native-recorded DND missed calls and append each
 * to local call history as a missed inbound call. Returns the count appended.
 */
export async function drainDndMissedCallsIntoHistory(): Promise<number> {
  if (Platform.OS !== "android") return 0;
  const mod = (NativeModules as any)?.IncomingCallUi;
  if (!mod || typeof mod.drainDndMissedCalls !== "function") return 0;

  let raw: string;
  try {
    raw = await mod.drainDndMissedCalls();
  } catch {
    return 0;
  }

  let list: NativeDndMissed[];
  try {
    list = JSON.parse(raw || "[]");
  } catch {
    return 0;
  }
  if (!Array.isArray(list) || list.length === 0) return 0;

  let appended = 0;
  for (const m of list) {
    const inviteId = (m.inviteId || "").trim();
    const pbxCallId = (m.pbxCallId || "").trim();
    const id = inviteId
      ? `invite:${inviteId}`
      : pbxCallId
        ? `dndmiss:${pbxCallId}`
        : `dndmiss:${m.ts ?? Date.now()}`;
    const tsMs = typeof m.ts === "number" && m.ts > 0 ? m.ts : Date.now();
    const record: CallRecord = {
      id,
      linkedId: pbxCallId || null,
      tenantId: m.tenantId || null,
      direction: "inbound",
      fromNumber: m.fromNumber || "",
      fromName: m.fromDisplay || null,
      toNumber: m.toExtension || "",
      startedAt: new Date(tsMs).toISOString(),
      durationSec: 0,
      disposition: "missed",
    };
    await appendCallRecord(record);
    appended += 1;
  }
  return appended;
}

/**
 * Hook: drain pending DND missed calls on mount (covers killed-state wakes) and
 * on every foreground transition (covers background-received calls), then
 * refresh the Recent list if anything was added.
 */
export function useDndMissedCallDrain(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (Platform.OS !== "android") return;
    let mounted = true;

    const run = () => {
      drainDndMissedCallsIntoHistory()
        .then((n) => {
          if (n > 0 && mounted) {
            queryClient
              .invalidateQueries({ queryKey: mobileQueryKeys.callHistory })
              .catch(() => undefined);
          }
        })
        .catch(() => undefined);
    };

    run();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") run();
    });
    // Live jssip DND branch fires this when it declines an INVITE while the app
    // is already foreground. Small delay so the native persist has flushed.
    const dndSub = DeviceEventEmitter.addListener("connect.dndMissed", () => {
      setTimeout(run, 1200);
    });
    return () => {
      mounted = false;
      sub.remove();
      dndSub.remove();
    };
  }, [queryClient]);
}

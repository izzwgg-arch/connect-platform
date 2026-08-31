import { AppState, type AppStateStatus } from "react-native";
import type { LiveCall, LiveExtensionState, TelephonySnapshot } from "../types";
import { DEFAULT_TELEPHONY_WS_URL } from "../config/publicOrigin";

type TelephonyEnvelope<T = unknown> = {
  event: string;
  ts?: string;
  data: T;
};

export type LiveTelephonyState = {
  calls: Map<string, LiveCall>;
  extensions: Map<string, LiveExtensionState>;
};

export type RealtimeSubscription = () => void;

// The platform hostname lives in ../config/publicOrigin — one constant for a Loopcom build.

function telephonyWsUrl(token: string): string {
  const fromEnv = process.env.EXPO_PUBLIC_TELEPHONY_WS_URL || DEFAULT_TELEPHONY_WS_URL;
  const base = fromEnv.trim();
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}token=${encodeURIComponent(token)}`;
}

function extKey(tenantId: string | null | undefined, extension: string): string {
  return `${tenantId ?? "__none__"}|${extension}`;
}

export function subscribeToLiveCalls(
  token: string,
  onState: (state: LiveTelephonyState) => void,
  onStatus?: (status: "connecting" | "connected" | "disconnected" | "error") => void,
): RealtimeSubscription {
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 1000;
  let ws: WebSocket | null = null;
  let calls = new Map<string, LiveCall>();
  let extensions = new Map<string, LiveExtensionState>();
  // Per-call message ordering (2026-08-31): the server stamps every call
  // message with a monotonic `seq` assigned at emit time. An upsert delivered
  // AFTER the call's remove (the server enriches upserts asynchronously) must
  // be dropped, or a hung-up call resurrects on the Team tab until the next
  // sweep. Reset on every snapshot — a reconnected/restarted server restarts
  // its counters. Messages without a seq (older server) are always applied.
  let callSeqs = new Map<string, number>();

  const emit = () => onState({ calls: new Map(calls), extensions: new Map(extensions) });

  const connect = () => {
    if (stopped) return;
    onStatus?.("connecting");
    ws = new WebSocket(telephonyWsUrl(token));

    ws.onopen = () => {
      backoffMs = 1000;
      onStatus?.("connected");
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let envelope: TelephonyEnvelope;
      try {
        envelope = JSON.parse(event.data) as TelephonyEnvelope;
      } catch {
        return;
      }

      switch (envelope.event) {
        case "telephony.snapshot": {
          const snap = envelope.data as TelephonySnapshot;
          callSeqs = new Map();
          calls = new Map((snap.calls ?? []).map((call) => [call.id, call]));
          extensions = new Map((snap.extensions ?? []).map((ext) => [extKey(ext.tenantId, ext.extension), ext]));
          emit();
          break;
        }
        case "telephony.call.upsert": {
          const call = envelope.data as LiveCall;
          if (typeof call.seq === "number" && Number.isFinite(call.seq)) {
            const last = callSeqs.get(call.id);
            if (last !== undefined && call.seq <= last) break; // stale delivery — never resurrect a removed call
            callSeqs.set(call.id, call.seq);
          }
          calls.set(call.id, call);
          emit();
          break;
        }
        case "telephony.call.remove": {
          const { callId, seq } = envelope.data as { callId: string; seq?: number };
          if (typeof seq === "number" && Number.isFinite(seq)) {
            const last = callSeqs.get(callId);
            if (last === undefined || seq > last) callSeqs.set(callId, seq);
          }
          calls.delete(callId);
          emit();
          break;
        }
        case "telephony.extension.upsert": {
          const ext = envelope.data as LiveExtensionState;
          extensions.set(extKey(ext.tenantId, ext.extension), ext);
          emit();
          break;
        }
      }
    };

    ws.onerror = () => {
      onStatus?.("error");
    };

    ws.onclose = () => {
      ws = null;
      if (stopped) return;
      onStatus?.("disconnected");
      const nextDelay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 30000);
      reconnectTimer = setTimeout(connect, nextDelay);
    };
  };

  connect();

  // Foreground reconnect (2026-08-31): RN suspends JS timers in the
  // background and the OS can kill the socket silently, so a user returning
  // to the app could stare at a FROZEN presence list — no `call.remove` ever
  // arrives and nothing reconnects until a suspended backoff timer finally
  // fires. On foreground: if the socket is not already open/connecting,
  // reconnect NOW with a fresh backoff. Reconnecting always yields a fresh
  // server snapshot, so any removes missed while backgrounded are corrected
  // immediately. ⛔ Never force-close a CONNECTING socket here — its late
  // onclose would clobber the replacement and double-connect.
  const onAppStateChange = (state: AppStateStatus) => {
    if (stopped || state !== "active") return;
    backoffMs = 1000;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  };
  const appStateSub = AppState.addEventListener("change", onAppStateChange);

  return () => {
    stopped = true;
    appStateSub.remove();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
    ws = null;
  };
}

export const subscribeToBLF = subscribeToLiveCalls;

/**
 * Web currently has no chat/voicemail websocket events. These helpers provide
 * conservative refetch triggers that match the existing web behavior without
 * introducing an aggressive polling loop or new backend contract.
 */
export function subscribeToVoicemail(onRefresh: () => void): RealtimeSubscription {
  const timer = setInterval(onRefresh, 15000);
  return () => clearInterval(timer);
}

export function subscribeToChat(onRefresh: () => void): RealtimeSubscription {
  const timer = setInterval(onRefresh, 7000);
  return () => clearInterval(timer);
}

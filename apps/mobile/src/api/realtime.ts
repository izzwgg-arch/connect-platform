import type { LiveCall, LiveExtensionState, TelephonySnapshot } from "../types";

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

const DEFAULT_TELEPHONY_WS_URL = "wss://app.connectcomunications.com/ws/telephony";

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
          calls = new Map((snap.calls ?? []).map((call) => [call.id, call]));
          extensions = new Map((snap.extensions ?? []).map((ext) => [extKey(ext.tenantId, ext.extension), ext]));
          emit();
          break;
        }
        case "telephony.call.upsert": {
          const call = envelope.data as LiveCall;
          calls.set(call.id, call);
          emit();
          break;
        }
        case "telephony.call.remove": {
          const { callId } = envelope.data as { callId: string };
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

  return () => {
    stopped = true;
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

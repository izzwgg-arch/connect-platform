"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import type {
  LiveCall,
  LiveExtensionState,
  LiveQueueState,
  TelephonyHealth,
  TelephonySnapshot,
  TelephonyEventEnvelope,
} from "../types/liveCall";

export type TelephonySocketStatus = "idle" | "connecting" | "connected" | "disconnected" | "error" | "failed";

export interface TelephonySocketState {
  status: TelephonySocketStatus;
  calls: Map<string, LiveCall>;
  extensions: Map<string, LiveExtensionState>;
  queues: Map<string, LiveQueueState>;
  health: TelephonyHealth | null;
  lastSnapshotAt: string | null;
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 20;

// Next.js replaces NEXT_PUBLIC_* references at build time. Access via string
// indexing so TypeScript doesn't complain about the unknown key in strict mode.
function wsUrl(): string {
  if (typeof window === "undefined") return "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (process as unknown as Record<string, Record<string, string>>)["env"]["NEXT_PUBLIC_TELEPHONY_WS_URL"] ?? "";
  return base;
}

function getToken(): string {
  if (typeof window === "undefined") return "";
  return (
    localStorage.getItem("token") ||
    localStorage.getItem("cc-token") ||
    localStorage.getItem("authToken") ||
    ""
  );
}

export function useTelephonySocket(): TelephonySocketState {
  const [status, setStatus] = useState<TelephonySocketStatus>("idle");
  const [calls, setCalls] = useState<Map<string, LiveCall>>(new Map());
  const [extensions, setExtensions] = useState<Map<string, LiveExtensionState>>(new Map());
  const [queues, setQueues] = useState<Map<string, LiveQueueState>>(new Map());
  const [health, setHealth] = useState<TelephonyHealth | null>(null);
  const [lastSnapshotAt, setLastSnapshotAt] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(MIN_BACKOFF_MS);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const attemptsRef = useRef(0);

  const applySnapshot = useCallback((snap: TelephonySnapshot) => {
    setCalls(new Map(snap.calls.map((c) => [c.id, c])));
    setExtensions(new Map(snap.extensions.map((e) => [e.extension, e])));
    setQueues(new Map(snap.queues.map((q) => [q.queueName, q])));
    setHealth(snap.health);
    setLastSnapshotAt(new Date().toISOString());
  }, []);

  const handleMessage = useCallback(
    (raw: string) => {
      let envelope: TelephonyEventEnvelope;
      try {
        envelope = JSON.parse(raw) as TelephonyEventEnvelope;
      } catch {
        return;
      }

      switch (envelope.event) {
        case "telephony.snapshot":
          applySnapshot(envelope.data as TelephonySnapshot);
          break;

        case "telephony.call.upsert": {
          const call = envelope.data as LiveCall;
          setCalls((prev: Map<string, LiveCall>) => {
            const next = new Map(prev);
            next.set(call.id, call);
            return next;
          });
          break;
        }

        case "telephony.call.remove": {
          const { callId } = envelope.data as { callId: string };
          setCalls((prev: Map<string, LiveCall>) => {
            const next = new Map(prev);
            next.delete(callId);
            return next;
          });
          break;
        }

        case "telephony.extension.upsert": {
          const ext = envelope.data as LiveExtensionState;
          setExtensions((prev: Map<string, LiveExtensionState>) => {
            const next = new Map(prev);
            next.set(ext.extension, ext);
            return next;
          });
          break;
        }

        case "telephony.queue.upsert": {
          const queue = envelope.data as LiveQueueState;
          setQueues((prev: Map<string, LiveQueueState>) => {
            const next = new Map(prev);
            next.set(queue.queueName, queue);
            return next;
          });
          break;
        }

        case "telephony.health":
          setHealth(envelope.data as TelephonyHealth);
          break;
      }
    },
    [applySnapshot],
  );

  const connect = useCallback(() => {
    if (stoppedRef.current) return;
    const existing = wsRef.current;
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const url = wsUrl();
    if (!url) {
      setStatus("idle");
      return;
    }

    const token = getToken();
    const fullUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;

    setStatus("connecting");

    const ws = new WebSocket(fullUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      backoffRef.current = MIN_BACKOFF_MS;
      attemptsRef.current = 0;
      setStatus("connected");
    };

    ws.onmessage = (ev) => {
      handleMessage(typeof ev.data === "string" ? ev.data : "");
    };

    ws.onerror = () => {
      setStatus("error");
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (stoppedRef.current) return;
      if (attemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setStatus("failed");
        return;
      }
      attemptsRef.current += 1;
      setStatus("disconnected");
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
      reconnectTimer.current = setTimeout(connect, delay);
    };
  }, [handleMessage]);

  useEffect(() => {
    stoppedRef.current = false;
    attemptsRef.current = 0;
    connect();

    return () => {
      stoppedRef.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { status, calls, extensions, queues, health, lastSnapshotAt };
}

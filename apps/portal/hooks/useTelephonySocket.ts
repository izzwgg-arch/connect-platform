"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { probeSessionAlive } from "../services/apiClient";
import { createCallSeqTracker } from "../services/callStreamOrder";
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
/**
 * ⛔ SAME-ORIGIN FIRST. Connect is served on more than one hostname
 * (`app.connectcomunications.com`, `app.loopcom.net`), and this used to return
 * the BUILD-TIME `NEXT_PUBLIC_TELEPHONY_WS_URL` unconditionally — baked as the
 * old host — so a user on app.loopcom.net opened their live-call feed
 * cross-origin to app.connectcomunications.com. It worked only because that
 * host still existed; the day it goes, the feed on Loopcom dies silently.
 * nginx proxies /ws/telephony on EVERY platform vhost, so the page's own origin
 * is always right. The env value is honoured only for local dev (a localhost
 * page pointing at :3003) or when it names the very host the page is on.
 */
export function resolveTelephonyWsUrl(envValue: string | undefined, loc: { protocol: string; host: string; hostname: string } | null): string {
  const env = String(envValue ?? "").trim();
  if (!loc) return env; // SSR: nothing to derive from; the client re-resolves.
  const sameOrigin = `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/ws/telephony`;
  if (!env) return sameOrigin;
  try {
    const u = new URL(env);
    const isLocalDev = loc.hostname === "localhost" || loc.hostname === "127.0.0.1";
    if (isLocalDev || u.host === loc.host) return env;
  } catch { /* fall through */ }
  return sameOrigin;
}

function wsUrl(): string {
  if (typeof window === "undefined") return "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (process as unknown as Record<string, Record<string, string>>)["env"]["NEXT_PUBLIC_TELEPHONY_WS_URL"] ?? "";
  return resolveTelephonyWsUrl(base, window.location);
}

function getToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return (
      localStorage.getItem("token") ||
      localStorage.getItem("cc-token") ||
      localStorage.getItem("authToken") ||
      ""
    );
  } catch {
    return "";
  }
}

/** The telephony server's close for a token it would not verify (TelephonySocketServer.ts). */
function isUnauthorizedClose(ev: CloseEvent): boolean {
  return ev.code === 1008 && /unauthori[sz]ed/i.test(String(ev.reason || ""));
}

// Composite keys so the Map can hold multiple tenants' same-number entries
// without overwriting. Null tenant falls back to a sentinel.
function extKey(tenantId: string | null | undefined, extension: string): string {
  return `${tenantId ?? "__none__"}|${extension}`;
}

function queueKey(tenantId: string | null | undefined, queueName: string): string {
  return `${tenantId ?? "__none__"}|${queueName}`;
}

export function useTelephonySocket(): TelephonySocketState {
  const [status, setStatus] = useState<TelephonySocketStatus>("idle");
  const [calls, setCalls] = useState<Map<string, LiveCall>>(new Map());
  const [extensions, setExtensions] = useState<Map<string, LiveExtensionState>>(new Map());
  const [queues, setQueues] = useState<Map<string, LiveQueueState>>(new Map());
  const [health, setHealth] = useState<TelephonyHealth | null>(null);
  const [lastSnapshotAt, setLastSnapshotAt] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  // Per-call message ordering — drops call.upserts that were delivered after
  // the call's remove (see services/callStreamOrder.ts). Reset on snapshot.
  const seqTrackerRef = useRef(createCallSeqTracker());
  const backoffRef = useRef(MIN_BACKOFF_MS);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const attemptsRef = useRef(0);

  const applySnapshot = useCallback((snap: TelephonySnapshot) => {
    console.log("[PIPE:5a/6] WS snapshot received", {
      callCount: snap.calls.length,
      calls: snap.calls.map((c) => ({ id: c.id, state: c.state, tenantId: c.tenantId, from: c.from, to: c.to })),
    });
    seqTrackerRef.current.reset();
    setCalls(new Map(snap.calls.map((c) => [c.id, c])));
    // Key extensions and queues by (tenantId, name) so two tenants that share
    // an extension/queue number do not overwrite each other's presence in the
    // client-side map. Without this, a SUPER_ADMIN (global) socket that
    // receives both tenants' "106" upserts would collapse them into a single
    // entry and break BLF/Team Directory tenant filtering.
    setExtensions(new Map(snap.extensions.map((e) => [extKey(e.tenantId, e.extension), e])));
    setQueues(new Map(snap.queues.map((q) => [queueKey(q.tenantId, q.queueName), q])));
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

        case "telephony.calls.snapshot": {
          const payload = envelope.data as Pick<TelephonySnapshot, "calls" | "health">;
          seqTrackerRef.current.reset();
          setCalls(new Map(payload.calls.map((c) => [c.id, c])));
          if (payload.health) setHealth(payload.health);
          setLastSnapshotAt(new Date().toISOString());
          break;
        }

        case "telephony.call.upsert": {
          const call = envelope.data as LiveCall;
          if (!seqTrackerRef.current.acceptUpsert(call.id, call.seq)) {
            // Stale delivery: this upsert was emitted BEFORE a message we
            // already applied (usually the hangup's remove). Applying it would
            // resurrect a dead call on Active Calls / Team Directory.
            console.log("[PIPE:5b/6] WS callUpsert DROPPED (stale seq)", { id: call.id, seq: call.seq });
            break;
          }
          console.log("[PIPE:5b/6] WS callUpsert received", {
            id: call.id, state: call.state, tenantId: call.tenantId,
            tenantName: call.tenantName, from: call.from, to: call.to,
          });
          setCalls((prev: Map<string, LiveCall>) => {
            const next = new Map(prev);
            next.set(call.id, call);
            return next;
          });
          break;
        }

        case "telephony.call.remove": {
          const { callId, seq } = envelope.data as { callId: string; seq?: number };
          seqTrackerRef.current.noteRemove(callId, seq);
          console.log("[PIPE:5c/6] WS callRemove received", { callId });
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
            next.set(extKey(ext.tenantId, ext.extension), ext);
            return next;
          });
          break;
        }

        case "telephony.queue.upsert": {
          const queue = envelope.data as LiveQueueState;
          setQueues((prev: Map<string, LiveQueueState>) => {
            const next = new Map(prev);
            next.set(queueKey(queue.tenantId, queue.queueName), queue);
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

    // Signed out (login page, public pages, a session the api just refused):
    // there is nobody to stream calls to. Do not open a socket the server will
    // only close `1008 Unauthorized` — the token-arrival listener in the effect
    // below connects the moment a sign-in writes one.
    const token = getToken();
    if (!token) {
      setStatus("idle");
      return;
    }
    const fullUrl = `${url}?token=${encodeURIComponent(token)}`;

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

    const scheduleReconnect = () => {
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

    ws.onclose = (ev) => {
      wsRef.current = null;
      if (stoppedRef.current) return;
      if (isUnauthorizedClose(ev)) {
        // The server refused our token. That is USUALLY a dead session — but
        // TelephonySocketServer also closes 1008 when its own extension lookup
        // throws, so a close alone is not proof. Ask the api (`/me`) once: a
        // dead session answers 401, the global handler in apiClient clears it
        // and sends the window to /login, and we simply stop reconnecting; a
        // live session means the refusal was telephony-side and the normal
        // backoff continues. ⛔ Never keep hammering a socket that just said
        // "unauthorized" without asking — that loop is what this file exists
        // to avoid.
        setStatus("disconnected");
        void probeSessionAlive().then((verdict) => {
          if (stoppedRef.current) return;
          if (verdict === "dead") {
            setStatus("failed");
            return;
          }
          scheduleReconnect();
        });
        return;
      }
      scheduleReconnect();
    };
  }, [handleMessage]);

  useEffect(() => {
    stoppedRef.current = false;
    attemptsRef.current = 0;
    connect();

    // A sign-in in THIS window fires `cc-portal-permissions-saved`; one in
    // another window (the desktop main window signing in while a passive window
    // waits) fires `storage`. Either way: if we are idle/failed and a token now
    // exists, start over with a fresh backoff.
    const onTokenMaybeArrived = () => {
      if (stoppedRef.current) return;
      if (!getToken()) return;
      const existing = wsRef.current;
      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      attemptsRef.current = 0;
      backoffRef.current = MIN_BACKOFF_MS;
      connect();
    };
    window.addEventListener("storage", onTokenMaybeArrived);
    window.addEventListener("cc-portal-permissions-saved", onTokenMaybeArrived);

    return () => {
      stoppedRef.current = true;
      window.removeEventListener("storage", onTokenMaybeArrived);
      window.removeEventListener("cc-portal-permissions-saved", onTokenMaybeArrived);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { status, calls, extensions, queues, health, lastSnapshotAt };
}

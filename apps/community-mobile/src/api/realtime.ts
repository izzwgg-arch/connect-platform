import { AppState, type AppStateStatus } from "react-native";
import EventSource from "react-native-sse";
import { API_URL, api, getAccessToken, refreshTokens } from "./client";
import { backoffSchedule } from "./backoff";
import { parseSseData } from "./sse";

export { backoffSchedule };

/**
 * Realtime. GET /realtime/stream (Server-Sent Events — see
 * apps/community-api/src/core/routes.ts) pushes `hello`, `notification`,
 * `message`, `thread`, `typing` and `ping` events addressed to the signed-in
 * person.
 *
 * React Native ships no `EventSource`, and RN's own `fetch` doesn't reliably
 * expose a readable `response.body` stream on both platforms (see git
 * history on this file for the previous polling-only client and why). This
 * client uses `react-native-sse`, which sidesteps that entirely: it drives a
 * plain `XMLHttpRequest` in streaming mode and re-reads `responseText` as it
 * grows, which both iOS's and Android's XHR implementations support. That is
 * a real, live push connection on both platforms, not a poll.
 *
 * Reconnection: the library has its own fixed-interval retry, but this
 * client takes over on every `error` — it closes the dead connection
 * immediately (which cancels the library's own retry timer) and opens a
 * fresh one after `backoffSchedule(attempt)`, so a flaky connection backs off
 * exponentially instead of hammering the server every 5s.
 *
 * Fallback: if `react-native-sse` throws constructing the connection (no
 * native `XMLHttpRequest`, e.g. an exotic runtime) or an app is simply too
 * old to have the dependency linked, `sseSupported` flips to `false` for the
 * rest of the session and this client falls back to the original polling
 * behavior — GET /notifications/unread-count + /threads/unread-count every
 * POLL_INTERVAL_MS while foregrounded. Either path is paused entirely in
 * background/inactive via AppState.
 */
export const POLL_INTERVAL_MS = 15_000;

export type RealtimeCounts = { notifications: number; messages: number };
export type RealtimeEventType = "notification" | "message" | "thread" | "typing";
type CountsListener = (c: RealtimeCounts) => void;
type EventListener = (type: RealtimeEventType, data: any) => void;

export class RealtimeClient {
  private timer: ReturnType<typeof setInterval> | null = null;
  private appStateSub: { remove: () => void } | null = null;
  private countsListeners = new Set<CountsListener>();
  private eventListeners = new Set<EventListener>();
  private running = false;

  private es: InstanceType<typeof EventSource> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** Flips permanently false for this session if constructing an EventSource throws. */
  private sseSupported = true;
  private counts: RealtimeCounts = { notifications: 0, messages: 0 };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.appStateSub = AppState.addEventListener("change", this.onAppState);
    if (AppState.currentState === "active") this.resume();
  }

  stop(): void {
    this.running = false;
    this.pause();
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.countsListeners.clear();
    this.eventListeners.clear();
  }

  /** Notified whenever the notifications/messages badge counts change, from either transport. */
  onCounts(cb: CountsListener): () => void {
    this.countsListeners.add(cb);
    return () => this.countsListeners.delete(cb);
  }

  /** Notified on every live `notification` | `message` | `thread` | `typing` event (SSE only — the polling fallback carries no per-event payload). */
  onEvent(cb: EventListener): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  private onAppState = (state: AppStateStatus) => {
    if (state === "active") this.resume();
    else this.pause();
  };

  private resume(): void {
    if (this.timer || this.es) return;
    if (this.sseSupported) void this.connectSse();
    else this.startPolling();
  }

  private pause(): void {
    this.stopPolling();
    this.disconnectSse();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }

  private startPolling(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (!getAccessToken()) return;
    try {
      // Note: the two endpoints don't share a field name — notifications
      // returns `unread`, threads returns `count`. Not a typo.
      const [n, t] = await Promise.all([
        api<{ unread: number }>("/notifications/unread-count"),
        api<{ count: number }>("/threads/unread-count"),
      ]);
      this.setCounts({ notifications: n.unread, messages: t.count });
    } catch {
      /* a missed poll just waits for the next tick */
    }
  }

  private setCounts(next: RealtimeCounts): void {
    this.counts = next;
    for (const cb of this.countsListeners) cb(this.counts);
  }

  private async connectSse(): Promise<void> {
    let token = getAccessToken();
    if (!token) {
      await refreshTokens();
      token = getAccessToken();
    }
    if (!token) {
      // Not signed in yet — fall back to polling's own no-op guard rather
      // than spinning up a connection that would 401 immediately.
      this.startPolling();
      return;
    }

    try {
      this.es = new EventSource(`${API_URL}/realtime/stream?access_token=${encodeURIComponent(token)}`, {
        headers: { accept: "text/event-stream" },
        // We drive our own exponential backoff on 'error' (see below), so
        // the library's own fixed-interval retry is irrelevant — it never
        // gets the chance to fire because we close() before it would.
        pollingInterval: 5000,
        debug: false,
      });
    } catch {
      // Constructing an EventSource threw (e.g. no XMLHttpRequest on this
      // runtime) — this is not a per-connection hiccup, it means the
      // library can never work here. Stop trying it for the rest of the
      // session and use the always-available polling path instead.
      this.sseSupported = false;
      this.es = null;
      this.startPolling();
      return;
    }

    const es = this.es;
    es.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      // A fresh connection may have missed events while it was down —
      // reconcile the badge counts once on (re)connect.
      void this.poll();
    });
    (["hello", "notification", "message", "thread", "typing", "ping"] as const).forEach((type) => {
      es.addEventListener(type as any, (e: any) => this.handleFrame(type, e?.data));
    });
    es.addEventListener("error", () => this.scheduleReconnect());
  }

  private handleFrame(type: string, raw: string | null | undefined): void {
    const data = typeof raw === "string" ? parseSseData<any>(raw) : raw;
    if (type === "ping") return;
    if (type === "hello") {
      if (data && typeof data === "object" && typeof data.unread === "number") {
        this.setCounts({ ...this.counts, notifications: data.unread });
      }
      return;
    }
    if (type === "notification" || type === "message" || type === "thread" || type === "typing") {
      for (const cb of this.eventListeners) cb(type, data);
    }
    if (type === "notification") {
      this.setCounts({ ...this.counts, notifications: this.counts.notifications + 1 });
    } else if (type === "message" && data && typeof data === "object" && typeof data.unreadDelta === "number") {
      this.setCounts({ ...this.counts, messages: Math.max(0, this.counts.messages + data.unreadDelta) });
    }
  }

  private disconnectSse(): void {
    if (this.es) {
      try {
        this.es.removeAllEventListeners();
        this.es.close();
      } catch {
        /* already closed */
      }
      this.es = null;
    }
  }

  private scheduleReconnect(): void {
    this.disconnectSse();
    if (!this.running) return;
    const delay = backoffSchedule(this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) void this.connectSse();
    }, delay);
  }
}

export const realtime = new RealtimeClient();

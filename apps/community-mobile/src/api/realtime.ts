import { AppState, type AppStateStatus } from "react-native";
import { API_URL, api, getAccessToken, refreshTokens } from "./client";
import { backoffSchedule } from "./backoff";

export { backoffSchedule };

/**
 * Realtime. The web uses a browser EventSource against GET /realtime/stream
 * (Server-Sent Events). React Native ships no EventSource, and RN's `fetch`
 * (the whatwg-fetch/XHR polyfill under Hermes) does not reliably expose a
 * readable `response.body` stream on both platforms — Android's OkHttp-backed
 * fetch DOES support incremental text via the `textStreaming` XHR extension,
 * but iOS's does not, so a single streaming implementation cannot be trusted
 * across both. Rather than ship a half-working stream, this client always
 * uses the polling path: it is the one that is actually running on both
 * platforms, described honestly.
 *
 * ACTUALLY RUNNING: poll /notifications/unread-count and /threads/unread-count
 * every POLL_INTERVAL_MS while the app is foregrounded; paused entirely in
 * background/inactive via AppState. Backoff applies only to the (currently
 * unused) streaming attempt below, kept because a future RN/Expo fetch
 * upgrade may make it viable — see attemptStream().
 */
export const POLL_INTERVAL_MS = 15_000;

export type RealtimeCounts = { notifications: number; messages: number };
type CountsListener = (c: RealtimeCounts) => void;

export class RealtimeClient {
  private timer: ReturnType<typeof setInterval> | null = null;
  private appStateSub: { remove: () => void } | null = null;
  private listeners = new Set<CountsListener>();
  private running = false;

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
    this.listeners.clear();
  }

  onCounts(cb: CountsListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private onAppState = (state: AppStateStatus) => {
    if (state === "active") this.resume();
    else this.pause();
  };

  private resume(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private pause(): void {
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
      const counts: RealtimeCounts = { notifications: n.unread, messages: t.count };
      for (const cb of this.listeners) cb(counts);
    } catch {
      /* a missed poll just waits for the next tick */
    }
  }

  /**
   * Documented-but-dormant streaming path. Not wired into start()/resume() —
   * kept here, tested via backoffSchedule() above, for the day RN's fetch
   * exposes a real ReadableStream on both platforms.
   */
  async attemptStream(onEvent: (type: string, data: unknown) => void, signal: AbortSignal): Promise<void> {
    let token = getAccessToken();
    if (!token) {
      await refreshTokens();
      token = getAccessToken();
    }
    if (!token) return;
    const res = await fetch(`${API_URL}/realtime/stream?access_token=${encodeURIComponent(token)}`, { signal });
    const body: any = (res as any).body;
    if (!body || typeof body.getReader !== "function") throw new Error("streaming not supported on this runtime");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const chunk of events) {
        const lines = chunk.split("\n");
        const type = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
        const dataLine = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
        if (!dataLine) continue;
        try {
          onEvent(type, JSON.parse(dataLine));
        } catch {
          onEvent(type, dataLine);
        }
      }
    }
  }
}

export const realtime = new RealtimeClient();

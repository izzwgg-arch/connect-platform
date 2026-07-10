/**
 * useVoicemailAudioCache
 *
 * Bounded preload/cache for voicemail audio.
 *
 * Strategy
 * --------
 * When the voicemail list loads, automatically download the top
 * MAX_PRELOAD_COUNT unread (or newest) voicemails to the app's cache
 * directory using the `?raw=1` stream endpoint (skips ffmpeg, saves
 * 500ms–2s per download).  The cached local file URI is handed to
 * the caller so Audio.Sound can play from a local path, giving
 * instant playback instead of waiting for the full API pipeline.
 *
 * Bounds
 * ------
 *  MAX_PRELOAD_COUNT  = 5  concurrent preloads kicked off per rows update
 *  MAX_CACHED_FILES   = 10 LRU entries kept in the in-memory registry
 *  MAX_TOTAL_BYTES    = 30 MB across all cached files combined
 *  MAX_FILE_BYTES     = 5 MB per file (very long voicemails are skipped)
 *
 * Safety
 * ------
 *  - Cached files live in FileSystem.cacheDirectory (app-private, not
 *    accessible to other apps, cleared by OS under storage pressure).
 *  - Token is embedded in the download request URL but is NOT stored
 *    in the cached file.  Re-preloading happens when the token changes.
 *  - All in-flight DownloadResumable tasks are cancelled on unmount.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system";
import { Audio } from "expo-av";
import { buildVoicemailPreloadUri, buildVoicemailStreamUri } from "../api/client";

// ── Tuneable constants ────────────────────────────────────────────────────────
// Preload the newest/unread voicemails so Play starts instantly. Downloads are
// throttled to MAX_CONCURRENT_DOWNLOADS at a time so we don't saturate the
// radio or drain the battery while still warming a healthy working set.
const MAX_PRELOAD_COUNT = 15;
const MAX_CACHED_FILES  = 25;
const MAX_TOTAL_BYTES   = 60 * 1024 * 1024; // 60 MB
const MAX_FILE_BYTES    =  5 * 1024 * 1024; //  5 MB per file
const MAX_CONCURRENT_DOWNLOADS = 3;
// Smallest plausible audio payload. The `raw=1` endpoint sometimes returns a
// tiny placeholder/error body (observed: 44 bytes) for very recent voicemails
// whose raw file isn't ready yet. Anything below this is not real audio.
const MIN_AUDIO_BYTES = 512;
// A voicemail that failed to preload (commonly a genuinely empty 0:00
// recording) must NOT be retried on every list refetch — that floods the JS
// thread with doomed downloads and starves real playback. Back off instead:
// retry at most this many times, and only after this cooldown.
const MAX_PRELOAD_RETRIES = 2;
const PRELOAD_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
// How many top voicemails to keep fully decoded as paused Audio.Sound objects
// in memory. Tapping one of these plays *instantly* (just replayAsync) instead
// of paying expo-av's ~0.4–1s loadAsync prepare cost. Bounded so we never hold
// more than a handful of native MediaPlayer instances.
const PRELOAD_SOUND_COUNT = 4;

// ── Types ─────────────────────────────────────────────────────────────────────
export type PreloadStatus = "idle" | "loading" | "ready" | "error";

interface CacheEntry {
  localUri:    string;
  sizeBytes:   number;
  cachedAtMs:  number;
  status:      "ready" | "error";
}

export interface VoicemailAudioCache {
  /** Local file URI if preloaded; null otherwise. */
  getLocalUri: (vmId: string) => string | null;
  /** Current preload status for a voicemail. */
  preloadStatus: (vmId: string) => PreloadStatus;
  /**
   * Hand off a fully-decoded, paused Audio.Sound for this voicemail if one was
   * pre-warmed. Ownership transfers to the caller (who must unload it). Returns
   * null when not pre-warmed — caller should loadAsync as usual.
   */
  takeSound: (vmId: string) => Audio.Sound | null;
}

// Minimal Voicemail shape this hook needs — intentionally narrow.
export interface CacheableVoicemail {
  id:       string;
  listened: boolean;
  receivedAt: string | Date;
  // Recording length in seconds. 0 means an empty voicemail with no audio —
  // we must never try to preload those (they only ever return a tiny error
  // body and waste the radio + JS thread, slowing real playback).
  durationSec?: number;
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useVoicemailAudioCache(
  rows:  CacheableVoicemail[],
  token: string | null | undefined,
): VoicemailAudioCache {
  // in-memory registry: vmId → entry
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  // vmId → status (including "loading" state not in cacheRef)
  const statusRef = useRef<Map<string, PreloadStatus>>(new Map());
  // active DownloadResumable tasks for cancellation on unmount
  const inflightRef = useRef<Map<string, FileSystem.DownloadResumable>>(new Map());
  // vmId → { at, tries } for failed preloads, to throttle pointless retries.
  const errorMetaRef = useRef<Map<string, { at: number; tries: number }>>(new Map());
  // vmId → pre-warmed, paused Audio.Sound for instant playback.
  const soundsRef = useRef<Map<string, Audio.Sound>>(new Map());
  // vmIds currently being decoded into a sound, to dedupe concurrent warms.
  const warmingRef = useRef<Set<string>>(new Set());
  // last token used for preloading — when it changes, clear stale cached URIs
  const lastTokenRef = useRef<string | null | undefined>(null);

  // ── evict LRU entries when cache is too large ──────────────────────────────
  const evictIfNeeded = useCallback(() => {
    const cache = cacheRef.current;
    const dropSound = (vmId: string) => {
      const snd = soundsRef.current.get(vmId);
      if (snd) {
        soundsRef.current.delete(vmId);
        snd.unloadAsync().catch(() => undefined);
      }
    };
    // Sort by oldest-first
    const entries = [...cache.entries()].sort((a, b) => a[1].cachedAtMs - b[1].cachedAtMs);

    // Evict by file count
    while (entries.length > MAX_CACHED_FILES) {
      const oldest = entries.shift();
      if (!oldest) break;
      const [vmId, entry] = oldest;
      cache.delete(vmId);
      statusRef.current.delete(vmId);
      dropSound(vmId);
      FileSystem.deleteAsync(entry.localUri, { idempotent: true }).catch(() => undefined);
    }

    // Evict by total bytes
    let totalBytes = [...cache.values()].reduce((s, e) => s + e.sizeBytes, 0);
    const byAge = [...cache.entries()].sort((a, b) => a[1].cachedAtMs - b[1].cachedAtMs);
    for (const [vmId, entry] of byAge) {
      if (totalBytes <= MAX_TOTAL_BYTES) break;
      totalBytes -= entry.sizeBytes;
      cache.delete(vmId);
      statusRef.current.delete(vmId);
      dropSound(vmId);
      FileSystem.deleteAsync(entry.localUri, { idempotent: true }).catch(() => undefined);
    }
  }, []);

  // ── pre-warm a decoded, paused Audio.Sound for instant playback ────────────
  const ensureSound = useCallback(async (vmId: string, localUri: string): Promise<void> => {
    if (soundsRef.current.has(vmId) || warmingRef.current.has(vmId)) return;
    if (soundsRef.current.size + warmingRef.current.size >= PRELOAD_SOUND_COUNT) return;
    warmingRef.current.add(vmId);
    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: localUri },
        { shouldPlay: false, progressUpdateIntervalMillis: 80 },
      );
      // Re-check after the await — we may have been cleared (token change) or
      // the slot may have been taken in the meantime.
      if (!warmingRef.current.has(vmId) || soundsRef.current.has(vmId)) {
        await sound.unloadAsync().catch(() => undefined);
        return;
      }
      soundsRef.current.set(vmId, sound);
      console.log(`[VOICEMAIL_AUDIO] sound_prewarm vmId=${vmId} count=${soundsRef.current.size}`);
    } catch (err: any) {
      console.warn(`[VOICEMAIL_AUDIO] sound_prewarm_failed vmId=${vmId} error=${String(err?.message ?? err)}`);
    } finally {
      warmingRef.current.delete(vmId);
    }
  }, []);

  // ── preload a single voicemail ─────────────────────────────────────────────
  const preloadOne = useCallback(async (vmId: string, tok: string, wantSound: boolean): Promise<void> => {
    const cache = cacheRef.current;
    const status = statusRef.current;

    const prewarm = (uri: string) => { if (wantSound) void ensureSound(vmId, uri); };

    // Already cached — make sure the in-memory sound is warm, then skip. If
    // currently in-flight, skip entirely.
    if (status.get(vmId) === "ready") {
      const entry = cache.get(vmId);
      if (entry) prewarm(entry.localUri);
      return;
    }
    if (status.get(vmId) === "loading") return;

    const markError = () => {
      status.set(vmId, "error");
      const m = errorMetaRef.current.get(vmId);
      errorMetaRef.current.set(vmId, { at: Date.now(), tries: (m?.tries ?? 0) + 1 });
    };
    const markReady = (entry: CacheEntry) => {
      cache.set(vmId, entry);
      status.set(vmId, "ready");
      errorMetaRef.current.delete(vmId);
    };

    // iOS gets a distinct filename (and, below, a different source URL) from
    // Android. The PBX's native raw/WAV49 recording — which Android's
    // MediaPlayer decodes fine — fails on iOS's AVFoundation with
    // "media format is not supported" (AVFoundationErrorDomain -11828). Using
    // a different filename also guarantees a stale pre-fix `.raw` cache file
    // already on a test device is never mistaken for valid iOS audio.
    const localUri = `${FileSystem.cacheDirectory ?? ""}vm-audio-${vmId}${Platform.OS === "ios" ? ".mp3" : ".raw"}`;

    // Check if the file is already on disk from a previous session.
    // Require at least 512 bytes to guard against stale zero-byte / partial
    // downloads that would cause cache_play_failed on every play.
    try {
      const info = await FileSystem.getInfoAsync(localUri, { size: true });
      if (info.exists && ((info as any).size ?? 0) >= MIN_AUDIO_BYTES) {
        markReady({
          localUri,
          sizeBytes:  (info as any).size ?? 0,
          cachedAtMs: Date.now(),
          status:     "ready",
        });
        prewarm(localUri);
        console.log(`[VOICEMAIL_AUDIO] preload_done vmId=${vmId} source=disk sizeBytes=${(info as any).size ?? 0}`);
        return;
      } else if (info.exists) {
        // Delete the stale/empty file so a fresh download is attempted
        await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => undefined);
      }
    } catch {
      // getInfoAsync failure is non-fatal
    }

    status.set(vmId, "loading");
    const startMs = Date.now();
    console.log(`[VOICEMAIL_AUDIO] preload_start vmId=${vmId}`);

    // Download a URL into `localUri`. Returns the on-disk byte count, -1 on a
    // non-2xx response, or -2 if the task was cancelled (unmount/token change).
    const attempt = async (url: string): Promise<number> => {
      const task = FileSystem.createDownloadResumable(url, localUri, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      inflightRef.current.set(vmId, task);
      const result = await task.downloadAsync();
      inflightRef.current.delete(vmId);
      if (!result) return -2;
      if (result.status < 200 || result.status >= 300) {
        await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => undefined);
        return -1;
      }
      const info = await FileSystem.getInfoAsync(result.uri, { size: true });
      return (info as any).size ?? 0;
    };

    try {
      // 1) Fast path: raw audio (skips the server-side ffmpeg transcode) —
      //    Android only. Android's MediaPlayer decodes the PBX's native
      //    raw/WAV49 recording directly. iOS's AVFoundation cannot (observed:
      //    AVFoundationErrorDomain -11828 "media format is not supported" on
      //    every cached-play attempt), so on iOS we go straight to the
      //    transcoded MP3 stream below — the only format guaranteed to decode
      //    there — instead of wasting a download on a file that can never play.
      let sizeBytes = Platform.OS === "ios"
        ? await attempt(buildVoicemailStreamUri(tok, vmId))
        : await attempt(buildVoicemailPreloadUri(tok, vmId));
      if (sizeBytes === -2) return; // cancelled

      // 2) If that produced a tiny / non-audio body (recent voicemail whose
      //    file isn't ready), it would fail to decode and force a slow remote
      //    stream at play time. Re-fetch via the transcoded stream URL, which
      //    always returns real playable audio, so Play stays instant.
      //    (No-op on iOS, which already used the transcoded URL above.)
      if (sizeBytes < MIN_AUDIO_BYTES && Platform.OS !== "ios") {
        if (sizeBytes >= 0) {
          await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => undefined);
          console.warn(`[VOICEMAIL_AUDIO] preload_raw_too_small vmId=${vmId} sizeBytes=${sizeBytes} retrying=transcoded`);
        }
        sizeBytes = await attempt(buildVoicemailStreamUri(tok, vmId));
        if (sizeBytes === -2) return; // cancelled
      }

      const elapsedMs = Date.now() - startMs;

      if (sizeBytes < MIN_AUDIO_BYTES) {
        await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => undefined);
        markError();
        console.warn(`[VOICEMAIL_AUDIO] preload_failed vmId=${vmId} reason=too_small sizeBytes=${sizeBytes} elapsedMs=${elapsedMs}`);
        return;
      }

      if (sizeBytes > MAX_FILE_BYTES) {
        // File too large — delete and mark as error so we stream instead
        await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => undefined);
        markError();
        console.warn(`[VOICEMAIL_AUDIO] preload_failed vmId=${vmId} reason=file_too_large sizeBytes=${sizeBytes} elapsedMs=${elapsedMs}`);
        return;
      }

      markReady({
        localUri,
        sizeBytes,
        cachedAtMs: Date.now(),
        status:     "ready",
      });
      evictIfNeeded();
      prewarm(localUri);
      console.log(`[VOICEMAIL_AUDIO] preload_done vmId=${vmId} sizeBytes=${sizeBytes} elapsedMs=${elapsedMs}`);
    } catch (err: any) {
      inflightRef.current.delete(vmId);
      if (status.get(vmId) === "loading") {
        markError();
      }
      console.warn(`[VOICEMAIL_AUDIO] preload_failed vmId=${vmId} error=${String(err?.message ?? err)} elapsedMs=${Date.now() - startMs}`);
    }
  }, [evictIfNeeded, ensureSound]);

  // ── kick off preloads when rows / token change ─────────────────────────────
  useEffect(() => {
    if (!token || rows.length === 0) return;

    // Token changed — clear any stale local URIs (not the files, they'll be
    // overwritten or evicted; the old download URLs are no longer valid anyway
    // because they embed the old token).
    if (lastTokenRef.current !== token) {
      statusRef.current.clear();
      cacheRef.current.clear();
      errorMetaRef.current.clear();
      // Cancel in-flight tasks from the old token
      inflightRef.current.forEach((task) => task.cancelAsync().catch(() => undefined));
      inflightRef.current.clear();
      // Pre-warmed sounds embed the old token's file; free them.
      soundsRef.current.forEach((snd) => snd.unloadAsync().catch(() => undefined));
      soundsRef.current.clear();
      warmingRef.current.clear();
      lastTokenRef.current = token;
    }

    // Pick top MAX_PRELOAD_COUNT candidates: unread first, then newest.
    // Empty (0:00) voicemails are excluded outright — there's no audio to
    // fetch, and attempting it only churns the network + JS thread.
    const ordered = [...rows]
      .filter((vm) => (vm.durationSec ?? 1) > 0)
      .sort((a, b) => {
        if (a.listened !== b.listened) return a.listened ? 1 : -1;
        return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
      })
      .slice(0, MAX_PRELOAD_COUNT);

    // The very top entries are kept as decoded Audio.Sound objects for instant
    // playback. Drop any pre-warmed sounds that are no longer in this set.
    const topSoundIds = new Set(ordered.slice(0, PRELOAD_SOUND_COUNT).map((vm) => vm.id));
    soundsRef.current.forEach((snd, id) => {
      if (!topSoundIds.has(id)) {
        soundsRef.current.delete(id);
        snd.unloadAsync().catch(() => undefined);
      }
    });
    // Pre-warm sounds for top entries whose file is already cached on disk.
    topSoundIds.forEach((id) => {
      if (statusRef.current.get(id) === "ready") {
        const entry = cacheRef.current.get(id);
        if (entry) void ensureSound(id, entry.localUri);
      }
    });

    const candidates = ordered.filter((vm) => {
      const st = statusRef.current.get(vm.id);
      if (st === "ready" || st === "loading") return false;
      // Don't re-hammer voicemails that already failed (usually empty 0:00
      // recordings). Allow a bounded retry only after a cooldown.
      if (st === "error") {
        const meta = errorMetaRef.current.get(vm.id);
        if (!meta) return false;
        if (meta.tries >= MAX_PRELOAD_RETRIES) return false;
        if (Date.now() - meta.at < PRELOAD_RETRY_COOLDOWN_MS) return false;
      }
      return true;
    });

    // Throttled worker pool: at most MAX_CONCURRENT_DOWNLOADS run at once so a
    // large preload set warms gradually rather than firing a burst of requests.
    let cancelled = false;
    const queue = [...candidates];
    const runWorker = async () => {
      while (!cancelled) {
        const vm = queue.shift();
        if (!vm) return;
        await preloadOne(vm.id, token, topSoundIds.has(vm.id)).catch(() => undefined);
      }
    };
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_DOWNLOADS, queue.length) },
      () => runWorker(),
    );
    void Promise.all(workers);
    return () => {
      cancelled = true;
    };
  }, [rows, token, preloadOne, ensureSound]);

  // ── cancel all in-flight downloads + free pre-warmed sounds on unmount ──────
  useEffect(() => {
    const inflight = inflightRef.current;
    const sounds = soundsRef.current;
    const warming = warmingRef.current;
    return () => {
      inflight.forEach((task) => task.cancelAsync().catch(() => undefined));
      inflight.clear();
      sounds.forEach((snd) => snd.unloadAsync().catch(() => undefined));
      sounds.clear();
      warming.clear();
    };
  }, []);

  // ── public API ────────────────────────────────────────────────────────────
  const getLocalUri = useCallback((vmId: string): string | null => {
    const entry = cacheRef.current.get(vmId);
    return entry?.status === "ready" ? entry.localUri : null;
  }, []);

  const preloadStatus = useCallback((vmId: string): PreloadStatus => {
    return statusRef.current.get(vmId) ?? "idle";
  }, []);

  const takeSound = useCallback((vmId: string): Audio.Sound | null => {
    const snd = soundsRef.current.get(vmId);
    if (!snd) return null;
    soundsRef.current.delete(vmId);
    return snd;
  }, []);

  return useMemo(
    () => ({ getLocalUri, preloadStatus, takeSound }),
    [getLocalUri, preloadStatus, takeSound],
  );
}

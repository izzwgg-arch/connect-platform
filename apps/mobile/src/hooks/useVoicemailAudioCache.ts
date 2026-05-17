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

import { useCallback, useEffect, useRef } from "react";
import * as FileSystem from "expo-file-system";
import { buildVoicemailPreloadUri } from "../api/client";

// ── Tuneable constants ────────────────────────────────────────────────────────
const MAX_PRELOAD_COUNT = 5;
const MAX_CACHED_FILES  = 10;
const MAX_TOTAL_BYTES   = 30 * 1024 * 1024; // 30 MB
const MAX_FILE_BYTES    =  5 * 1024 * 1024; //  5 MB per file

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
}

// Minimal Voicemail shape this hook needs — intentionally narrow.
export interface CacheableVoicemail {
  id:       string;
  listened: boolean;
  receivedAt: string | Date;
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
  // last token used for preloading — when it changes, clear stale cached URIs
  const lastTokenRef = useRef<string | null | undefined>(null);

  // ── evict LRU entries when cache is too large ──────────────────────────────
  const evictIfNeeded = useCallback(() => {
    const cache = cacheRef.current;
    // Sort by oldest-first
    const entries = [...cache.entries()].sort((a, b) => a[1].cachedAtMs - b[1].cachedAtMs);

    // Evict by file count
    while (entries.length > MAX_CACHED_FILES) {
      const oldest = entries.shift();
      if (!oldest) break;
      const [vmId, entry] = oldest;
      cache.delete(vmId);
      statusRef.current.delete(vmId);
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
      FileSystem.deleteAsync(entry.localUri, { idempotent: true }).catch(() => undefined);
    }
  }, []);

  // ── preload a single voicemail ─────────────────────────────────────────────
  const preloadOne = useCallback(async (vmId: string, tok: string): Promise<void> => {
    const cache = cacheRef.current;
    const status = statusRef.current;

    // Already cached or in-flight — skip
    if (status.get(vmId) === "ready" || status.get(vmId) === "loading") return;

    const localUri = `${FileSystem.cacheDirectory ?? ""}vm-audio-${vmId}.raw`;

    // Check if the file is already on disk from a previous session
    try {
      const info = await FileSystem.getInfoAsync(localUri, { size: true });
      if (info.exists && (info as any).size > 0) {
        cache.set(vmId, {
          localUri,
          sizeBytes:  (info as any).size ?? 0,
          cachedAtMs: Date.now(),
          status:     "ready",
        });
        status.set(vmId, "ready");
        console.log(`[VOICEMAIL_AUDIO] preload_done vmId=${vmId} source=disk sizeBytes=${(info as any).size ?? 0}`);
        return;
      }
    } catch {
      // getInfoAsync failure is non-fatal
    }

    status.set(vmId, "loading");
    const url = buildVoicemailPreloadUri(tok, vmId);
    const startMs = Date.now();
    console.log(`[VOICEMAIL_AUDIO] preload_start vmId=${vmId}`);

    const task = FileSystem.createDownloadResumable(
      url,
      localUri,
      { headers: { Authorization: `Bearer ${tok}` } },
    );
    inflightRef.current.set(vmId, task);

    try {
      const result = await task.downloadAsync();
      inflightRef.current.delete(vmId);

      if (!result) {
        // Cancelled by unmount — do not mark error
        return;
      }

      const info = await FileSystem.getInfoAsync(result.uri, { size: true });
      const sizeBytes = (info as any).size ?? 0;
      const elapsedMs = Date.now() - startMs;

      if (sizeBytes > MAX_FILE_BYTES) {
        // File too large — delete and mark as error so we stream instead
        await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined);
        status.set(vmId, "error");
        console.warn(`[VOICEMAIL_AUDIO] preload_failed vmId=${vmId} reason=file_too_large sizeBytes=${sizeBytes} elapsedMs=${elapsedMs}`);
        return;
      }

      cache.set(vmId, {
        localUri:   result.uri,
        sizeBytes,
        cachedAtMs: Date.now(),
        status:     "ready",
      });
      status.set(vmId, "ready");
      evictIfNeeded();
      console.log(`[VOICEMAIL_AUDIO] preload_done vmId=${vmId} sizeBytes=${sizeBytes} elapsedMs=${elapsedMs}`);
    } catch (err: any) {
      inflightRef.current.delete(vmId);
      if (status.get(vmId) === "loading") {
        status.set(vmId, "error");
      }
      console.warn(`[VOICEMAIL_AUDIO] preload_failed vmId=${vmId} error=${String(err?.message ?? err)} elapsedMs=${Date.now() - startMs}`);
    }
  }, [evictIfNeeded]);

  // ── kick off preloads when rows / token change ─────────────────────────────
  useEffect(() => {
    if (!token || rows.length === 0) return;

    // Token changed — clear any stale local URIs (not the files, they'll be
    // overwritten or evicted; the old download URLs are no longer valid anyway
    // because they embed the old token).
    if (lastTokenRef.current !== token) {
      statusRef.current.clear();
      cacheRef.current.clear();
      // Cancel in-flight tasks from the old token
      inflightRef.current.forEach((task) => task.cancelAsync().catch(() => undefined));
      inflightRef.current.clear();
      lastTokenRef.current = token;
    }

    // Pick top MAX_PRELOAD_COUNT candidates: unread first, then newest
    const candidates = [...rows]
      .sort((a, b) => {
        if (a.listened !== b.listened) return a.listened ? 1 : -1;
        return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
      })
      .slice(0, MAX_PRELOAD_COUNT);

    for (const vm of candidates) {
      if (
        statusRef.current.get(vm.id) === "ready" ||
        statusRef.current.get(vm.id) === "loading"
      ) continue;
      // Fire-and-forget; errors are logged internally
      preloadOne(vm.id, token).catch(() => undefined);
    }
  }, [rows, token, preloadOne]);

  // ── cancel all in-flight downloads on unmount ──────────────────────────────
  useEffect(() => {
    return () => {
      inflightRef.current.forEach((task) => task.cancelAsync().catch(() => undefined));
      inflightRef.current.clear();
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

  return { getLocalUri, preloadStatus };
}

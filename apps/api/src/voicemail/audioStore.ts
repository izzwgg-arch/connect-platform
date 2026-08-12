import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Local voicemail audio store — fetch once from the PBX, serve forever.
 *
 * Voicemail audio is immutable after recording, so each message needs to be
 * fetched from the PBX at most once in its lifetime. Every successful PBX
 * fetch lands here (original bytes, pre-transcode); every later play,
 * download, or preloader warm-up is served from Connect's own disk with zero
 * PBX traffic.
 *
 * VOICEMAIL_AUDIO_STORAGE_DIR must point at a volume-backed directory in
 * production — docker-compose.app.yml mounts the voicemail-audio volume at
 * /var/lib/connect/voicemail-audio for both api and api_candidate (same
 * two-block rule as onboarding-files: a mount added to only one block loses
 * the cache on every blue/green cutover). Losing this dir is a re-fetch cost,
 * never data loss — the PBX keeps the original — but a silent wipe per deploy
 * would quietly reinstate the exact PBX load this store exists to remove.
 */
export function voicemailAudioStoreRoot(): string {
  return (process.env.VOICEMAIL_AUDIO_STORAGE_DIR || path.resolve(process.cwd(), "data/voicemail-audio")).replace(/\\/g, "/");
}

// Filenames are always "<cuid>.<ext>" built by us; anything else is refused so
// a poisoned DB value can never walk the filesystem.
const SAFE_AUDIO_FILENAME = /^[a-z0-9]+\.[a-z0-9]{1,6}$/;

/** Max stored size — a voicemail is minutes of 8 kHz audio; anything bigger is not one. */
const MAX_STORED_AUDIO_BYTES = 25 * 1024 * 1024;

export function voicemailAudioFilename(vmId: string, ext: string): string | null {
  const id = String(vmId || "").toLowerCase();
  const cleanExt = String(ext || "wav").toLowerCase().replace(/[^a-z0-9]/g, "") || "wav";
  const filename = `${id}.${cleanExt.slice(0, 6)}`;
  return SAFE_AUDIO_FILENAME.test(filename) ? filename : null;
}

/** Resolve a stored filename to an absolute path, refusing anything outside the root. */
export function resolveVoicemailAudioPath(filename: string): string | null {
  const clean = String(filename || "");
  if (!SAFE_AUDIO_FILENAME.test(clean)) return null;
  const root = path.resolve(voicemailAudioStoreRoot());
  const full = path.resolve(root, clean);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

/**
 * Persist a fetched voicemail's original bytes. Returns the stored filename,
 * or null when the write failed or was refused — callers treat null as "keep
 * streaming from the PBX", never as an error, so a full disk degrades to the
 * old behaviour instead of breaking playback.
 */
export async function saveVoicemailAudio(vmId: string, ext: string, audio: Buffer): Promise<string | null> {
  if (!audio || audio.byteLength === 0 || audio.byteLength > MAX_STORED_AUDIO_BYTES) return null;
  const filename = voicemailAudioFilename(vmId, ext);
  if (!filename) return null;
  const full = resolveVoicemailAudioPath(filename);
  if (!full) return null;
  try {
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    // Write-then-rename so a crashed write never leaves a readable half-file.
    const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmp, audio);
    await fs.promises.rename(tmp, full);
    return filename;
  } catch {
    return null;
  }
}

/** Read a stored voicemail's bytes; null when missing/unreadable (caller re-fetches from the PBX). */
export function readVoicemailAudio(filename: string | null | undefined): Buffer | null {
  if (!filename) return null;
  const full = resolveVoicemailAudioPath(String(filename));
  if (!full) return null;
  try {
    const buf = fs.readFileSync(full);
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

/** Extension carried by a stored filename ("cmxyz.wav" → "wav"); drives the mime type on serve. */
export function voicemailAudioExtFromFilename(filename: string): string {
  const parts = String(filename || "").split(".");
  const ext = parts.length > 1 ? parts[parts.length - 1] : "";
  return /^[a-z0-9]{1,6}$/.test(ext) ? ext : "wav";
}

/**
 * Startup guard — same failure family as onboarding uploads: without the env
 * the store lands in the container's ephemeral layer and every deploy wipes
 * it, silently re-creating the per-play PBX load this store exists to remove.
 */
export function warnIfVoicemailAudioStoreEphemeral(log: { warn: (obj: unknown, msg?: string) => void }): void {
  if (!process.env.VOICEMAIL_AUDIO_STORAGE_DIR) {
    log.warn(
      { fallbackDir: voicemailAudioStoreRoot() },
      "VOICEMAIL_AUDIO_STORAGE_DIR is not set — the voicemail audio store is ephemeral and every deploy wipes it, so every voicemail's audio will be re-fetched from the PBX. Set it to a volume-backed path (see docker-compose.app.yml).",
    );
  }
}

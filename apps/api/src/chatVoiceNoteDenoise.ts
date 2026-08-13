/**
 * Light, voice-preserving noise reduction for chat voice notes.
 *
 * Applied at upload time (see connectChatRoutes `/attachments/upload`) so the
 * *stored original* is already clean. That means in-app playback (Connect ↔
 * Connect and the sender's own playback) AND the MMS copy (derived from the
 * stored original by the worker) all get the denoised audio.
 *
 * Implementation: shells out to ffmpeg (already present in the API container).
 *
 * ⛔ The noise floor is the parameter that decides whether this helps or ruins
 * the recording. `afftdn`'s `nf` is "everything below this level is noise",
 * valid -80..-20, DEFAULT -50. This chain used to pass **nf=-25** — nearly the
 * most destructive value available. Ordinary speech averages about -20 dB, so
 * the denoiser ate the body and tails of the voice and produced the hollow,
 * watery "talking from inside a dungeon" sound Izzy reported on 2026-08-13.
 * Measured on that real voice note: -18.4 LUFS with an 11.0 LU range, quiet
 * passages sitting at -27 LUFS. Keep `nf` at the default unless you have
 * measured a specific recording and can justify moving it.
 *
 * The chain, in order (order matters — clean, then shape, then level):
 *   - highpass=f=90    → low-frequency rumble / handling noise
 *   - afftdn nf=-50    → gentle hiss removal at the SAFE default floor
 *   - equalizer 300Hz  → -2dB, takes out boxy "mud"
 *   - equalizer 2.6kHz → +3dB presence, this is what makes speech intelligible
 *   - acompressor      → lifts quiet syllables so they stop sounding distant
 *   - loudnorm LRA=7   → consistent level, tighter range than the old LRA=11
 *
 * ⛔ Force `-ar 48000`. Without it the output inherits the source rate; a real
 * upload arrived at 96 kHz, which is pointless for mono speech and an odd
 * decode path for browsers.
 *
 * Failure mode: never throws. Returns null when ffmpeg is unavailable or the
 * conversion fails, and the caller keeps the original upload untouched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A voice note filename, independent of whatever MIME the client/OS reported.
 * Both the mobile app (ChatTab.tsx) and the portal composer name every voice
 * note `voice-note-<timestamp>.<ext>` — this is the one signal we fully
 * control and can trust even when the reported MIME is wrong.
 */
export function isVoiceNoteFilename(filename: string): boolean {
  return /(^|[\/\\])?voice-note[-._]/i.test(String(filename || "").toLowerCase());
}

/** A voice note is recognised by its client-assigned filename + audio MIME. */
export function isVoiceNoteUpload(filename: string, mimeType: string): boolean {
  const mime = String(mimeType || "").toLowerCase();
  return mime.startsWith("audio/") && isVoiceNoteFilename(filename);
}

/**
 * Exported so the chain itself is assertable — the destructive setting that
 * caused the "dungeon" recording was a single number buried in an arg array.
 */
export const VOICE_NOTE_FILTER_CHAIN = [
  "highpass=f=90",
  "afftdn=nr=12:nf=-50",
  "equalizer=f=300:t=q:w=1.0:g=-2",
  "equalizer=f=2600:t=q:w=1.2:g=3",
  "acompressor=threshold=-20dB:ratio=3:attack=10:release=180:makeup=2",
  "loudnorm=I=-16:TP=-1.5:LRA=7",
].join(",");

export async function denoiseVoiceNote(input: Buffer): Promise<Buffer | null> {
  const id = crypto.randomBytes(6).toString("hex");
  const inPath = path.join(os.tmpdir(), `cc-vn-in-${id}`);
  const outPath = path.join(os.tmpdir(), `cc-vn-out-${id}.m4a`);
  await fs.promises.writeFile(inPath, input);
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        inPath,
        "-af",
        VOICE_NOTE_FILTER_CHAIN,
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-ac",
        "1",
        // Never inherit the source rate — see the note above about a real 96 kHz upload.
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        outPath,
      ],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const out = await fs.promises.readFile(outPath);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  } finally {
    fs.promises.unlink(inPath).catch(() => undefined);
    fs.promises.unlink(outPath).catch(() => undefined);
  }
}

/**
 * Light, voice-preserving noise reduction for chat voice notes.
 *
 * Applied at upload time (see connectChatRoutes `/attachments/upload`) so the
 * *stored original* is already clean. That means in-app playback (Connect ↔
 * Connect and the sender's own playback) AND the MMS copy (derived from the
 * stored original by the worker) all get the denoised audio.
 *
 * Implementation: shells out to ffmpeg (already present in the API container).
 * The chain is intentionally gentle so natural voice is preserved:
 *   - highpass=f=80   → removes low-frequency rumble / handling noise
 *   - afftdn=nr=10    → light FFT denoiser for steady background hiss
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

/** A voice note is recognised by its client-assigned filename + audio MIME. */
export function isVoiceNoteUpload(filename: string, mimeType: string): boolean {
  const name = String(filename || "").toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  return mime.startsWith("audio/") && /(^|[\/\\])?voice-note[-._]/.test(name);
}

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
        "highpass=f=80,afftdn=nr=10:nf=-25",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-ac",
        "1",
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

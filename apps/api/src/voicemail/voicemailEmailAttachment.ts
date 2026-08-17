/**
 * Turning a stored voicemail into the file that rides on the email.
 *
 * ⛔ THE RULE: no audio, no email. The caller must treat a null return as
 * "do not send", never as "send without the attachment" — an email promising a
 * recording that isn't there is worse than no email at all.
 *
 * Mirrors `loadBillingPdfAttachmentsForEmailJob`: the job body carries a marker,
 * the file is produced at SEND time rather than stored on the job row.
 */
import { spawn } from "node:child_process";

import { extractVoicemailIdFromEmailBody } from "./voicemailEmail";
import { readVoicemailAudio, voicemailAudioExtFromFilename } from "./audioStore";

export type VoicemailAudioAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

/** ffmpeg lives in the api image and carries libmp3lame — verified 2026-08-16. */
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/**
 * Voicemail is 8 kHz mono speech. 32 kbps is transparent for that and keeps a
 * 4-minute message near 1 MB instead of 4 MB — the difference between ~7 MB and
 * ~29 MB of attachments landing in customers' mailboxes each day at 63/day.
 */
export async function encodeVoicemailMp3(wav: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Buffer | null) => { if (!done) { done = true; resolve(v); } };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(FFMPEG, [
        "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0",
        "-vn", "-ac", "1", "-ar", "8000",
        "-codec:a", "libmp3lame", "-b:a", "32k",
        "-f", "mp3", "pipe:1",
      ]);
    } catch {
      return finish(null);
    }
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (c: Buffer) => chunks.push(c));
    // ⛔ Bound it. A wedged ffmpeg must never hold an email job open forever.
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } finish(null); }, 30_000);
    proc.on("error", () => { clearTimeout(timer); finish(null); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      finish(code === 0 && out.length > 0 ? out : null);
    });
    proc.stdin?.on("error", () => { /* closed early; `close` decides the outcome */ });
    proc.stdin?.end(wav);
  });
}

/** `voicemail-2026-08-16-1415.mp3` — sortable, and obvious in a crowded inbox. */
export function voicemailAttachmentName(receivedAt: Date | string | null | undefined, ext = "mp3"): string {
  const d = receivedAt ? new Date(receivedAt) : new Date();
  const valid = !Number.isNaN(d.getTime());
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = valid
    ? `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
    : "recording";
  return `voicemail-${stamp}.${ext}`;
}

/**
 * Produce the attachment for a queued voicemail email.
 *
 * ⛔ Returns null when there is no usable audio. The send door must then leave
 * the job to retry rather than send an email with nothing attached.
 */
export async function loadVoicemailAudioAttachmentForEmailJob(
  job: { type: string; htmlBody?: string | null; textBody?: string | null },
  deps: {
    findVoicemail: (id: string) => Promise<{ localAudioPath: string | null; receivedAt: Date | null } | null>;
  },
): Promise<VoicemailAudioAttachment | null> {
  const id = extractVoicemailIdFromEmailBody(`${job.htmlBody || ""}\n${job.textBody || ""}`);
  if (!id) return null;

  const vm = await deps.findVoicemail(id);
  if (!vm?.localAudioPath) return null;

  // ⛔ The stored path proves intent, not existence — read the bytes.
  const raw = readVoicemailAudio(vm.localAudioPath);
  if (!raw || raw.length === 0) return null;

  const sourceExt = voicemailAudioExtFromFilename(vm.localAudioPath).toLowerCase();
  if (sourceExt === "mp3") {
    return {
      filename: voicemailAttachmentName(vm.receivedAt, "mp3"),
      content: raw,
      contentType: "audio/mpeg",
    };
  }

  const mp3 = await encodeVoicemailMp3(raw);
  if (mp3) {
    return {
      filename: voicemailAttachmentName(vm.receivedAt, "mp3"),
      content: mp3,
      contentType: "audio/mpeg",
    };
  }

  // ⛔ Transcode failed but we DO have real audio. Send the wav rather than
  // withhold the message — the rule is "no audio, no email", not "no mp3, no
  // email". A 4 MB wav beats a customer never hearing the message.
  return {
    filename: voicemailAttachmentName(vm.receivedAt, "wav"),
    content: raw,
    contentType: "audio/wav",
  };
}

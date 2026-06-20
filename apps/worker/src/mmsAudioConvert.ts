/**
 * MMS audio converter for Connect Chat voice notes.
 *
 * Why this exists: VoIP.ms `sendMMS` happily accepts arbitrary audio URLs but
 * downstream carrier MMS gateways (T-Mobile, AT&T, Verizon, Bell, Rogers …)
 * have wildly inconsistent codec support. The combination that actually
 * is most likely to survive the provider/carrier MMS path:
 *   - container : `.mp4`
 *   - codec     : AAC audio plus a tiny black H.264 video track
 *   - size      : low bitrate, so a 30 s voice note stays below the MMS budget
 *
 * Total file budget: 590 KB hard cap. Most carriers reject above ~600 KB,
 * a few above 1 MB. We size to the worst case so a 30 s voice note still
 * fits in one MMS.
 *
 * The original (typically 44.1 kHz stereo `.m4a` from expo-av or `.webm`
 * from the browser MediaRecorder) is preserved unchanged in chat
 * attachment storage — the converted artefact lives as a *new*
 * attachment row referenced via `metadata.convertedFromAttachmentId`. That
 * way the in-app player still hears the high-quality original while the
 * provider sees only the small one, and the SMS+link fallback still
 * points at the original (better quality) file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "@connect/db";
import {
  readChatAttachmentBuffer,
  sanitizePathSegment,
  writeChatAttachmentFile,
} from "@connect/shared/chatAttachmentStorage";

const execFileAsync = promisify(execFile);

const MMS_AUDIO_BUDGET_BYTES = 590 * 1024;
const MMS_AUDIO_FALLBACK_BUDGET_BYTES = 590 * 1024;

export type ConvertedAudioAttachment = {
  /** New attachment row id; safe to feed into buildChatSignedDownloadUrl + provider. */
  attachmentId: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Source attachment that was converted; preserved for the SMS+link fallback path. */
  convertedFromAttachmentId: string;
};

export type AudioAttachmentInput = {
  id: string;
  tenantId: string;
  messageId: string;
  storageKey: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
};

export class MmsAudioTooLargeError extends Error {
  constructor(message: string, public readonly bytes: number) {
    super(message);
    this.name = "MmsAudioTooLargeError";
  }
}

/**
 * Convert each audio attachment to an MMS-friendly `.mp4` file and persist
 * it as a new attachment row. Returns the converted attachment metadata
 * (one per input). On any failure, throws — the caller is expected to fall
 * back to the SMS + signed link path.
 */
export async function convertAudioAttachmentsForMms(
  attachments: AudioAttachmentInput[],
  threadId: string,
): Promise<ConvertedAudioAttachment[]> {
  const out: ConvertedAudioAttachment[] = [];
  for (const att of attachments) {
    if (!String(att.mimeType || "").toLowerCase().startsWith("audio/")) continue;
    const converted = await convertSingleAttachment(att, threadId);
    out.push(converted);
  }
  return out;
}

async function convertSingleAttachment(
  att: AudioAttachmentInput,
  threadId: string,
): Promise<ConvertedAudioAttachment> {
  const sourceBuffer = await readChatAttachmentBuffer(att.storageKey);
  if (!sourceBuffer) {
    throw new Error(`mms_audio_source_missing:${att.storageKey}`);
  }

  let convertedBuffer: Buffer;
  try {
    convertedBuffer = await ffmpegToMmsMp4(sourceBuffer);
  } catch (err: any) {
    throw new Error(`mms_audio_ffmpeg_failed:${err?.message || err}`);
  }

  if (convertedBuffer.length > MMS_AUDIO_BUDGET_BYTES) {
    throw new MmsAudioTooLargeError(
      `mms_audio_too_large:${convertedBuffer.length}`,
      convertedBuffer.length,
    );
  }

  const baseName = path.basename(att.fileName || "voice-note", path.extname(att.fileName || ""));
  const written = await writeChatAttachmentFile({
    tenantKey: att.tenantId,
    threadId,
    originalFilename: `${sanitizePathSegment(baseName) || "voice-note"}.mp4`,
    buffer: convertedBuffer,
    mimeType: "video/mp4",
    maxBytes: MMS_AUDIO_BUDGET_BYTES + 64 * 1024,
  });

  const created = await db.connectChatMessageAttachment.create({
    data: {
      messageId: att.messageId,
      tenantId: att.tenantId,
      fileName: written.fileName,
      mimeType: written.mimeType,
      sizeBytes: written.sizeBytes,
      storageKey: written.storageKey,
      scanStatus: "pending",
      mediaKind: "video",
      // Pointer back to the original so the SMS+link fallback can keep
      // sending the higher-quality file. Persisted on the attachment row's
      // own metadata via raw JSON since the model has no relational FK
      // for "converted-from".
      // NOTE: ConnectChatMessageAttachment has no `metadata` column; the
      // pointer therefore lives in the parent message's metadata where it's
      // already merged at send time. We just set fileName to a stable
      // pattern the worker can recognise.
    },
  });

  return {
    attachmentId: created.id,
    storageKey: created.storageKey,
    fileName: created.fileName,
    mimeType: created.mimeType,
    sizeBytes: created.sizeBytes,
    convertedFromAttachmentId: att.id,
  };
}

async function ffmpegToMmsMp4(input: Buffer): Promise<Buffer> {
  const id = crypto.randomBytes(6).toString("hex");
  const inPath = path.join(os.tmpdir(), `cc-mms-in-${id}`);
  const outPath = path.join(os.tmpdir(), `cc-mms-out-${id}.mp4`);
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
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=160x90:r=1",
        "-shortest",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "aac",
        "-b:a",
        "24k",
        "-c:v",
        "libx264",
        "-tune",
        "stillimage",
        "-profile:v",
        "baseline",
        "-level",
        "3.0",
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        "8k",
        "-movflags",
        "+faststart",
        outPath,
      ],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return await fs.promises.readFile(outPath);
  } finally {
    fs.promises.unlink(inPath).catch(() => undefined);
    fs.promises.unlink(outPath).catch(() => undefined);
  }
}

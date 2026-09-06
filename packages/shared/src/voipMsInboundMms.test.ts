/**
 * Inbound MMS media mirror — carrier-only audio (AMR / 3GPP) must be
 * transcoded to AAC/M4A before it is written, or it is never mirrored at all.
 *
 * Fixup Group, 2026-09-06: two voice-memo MMS (`media.amr` from VoIP.ms)
 * were the ONLY unmirrored inbound media on the platform in 14 days (36 of
 * 38 mirrored — all the photos). The mirror refused them on
 * `mime_not_allowed`, logged nothing about why, and the Windows app then
 * drew an <audio> player over the raw carrier URL, which no browser decodes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CARRIER_AUDIO_TRANSCODE_ARGS,
  inferMmsFileNameAndMime,
  isCarrierOnlyAudio,
  transcodeCarrierAudioToM4a,
} from "./voipMsInboundMms";
import { isAllowedChatMime } from "./chatAttachmentStorage";

// The real VoIP.ms URL shape (Fixup, 2026-09-04 03:15Z) — an iPhone voice memo.
const REAL_AMR_URL = "https://voip.ms/media/MTc4ODQ5MTc1MzZhOWEzN2U5YmExYTQ2YTlhMzdlOWJhMWRmfDJ8YXVkaW8vYW1yfE1NUw==/media.amr";
const REAL_JPEG_URL = "https://voip.ms/media/MTc4ODM3NjczNDZhOTg3NjllNWZlMGQ2YTk4NzY5ZTVmZTJjfDJ8aW1hZ2UvanBlZ3xNTVM=/media.jpeg";

test("the real Fixup MMS infers audio/amr — which chat storage refuses (the old silent failure)", () => {
  const { fileName, mimeType } = inferMmsFileNameAndMime(REAL_AMR_URL, "audio/amr");
  assert.equal(mimeType, "audio/amr");
  assert.equal(fileName, "media.amr");
  assert.equal(isAllowedChatMime("audio/amr"), false, "storage refuses AMR — so without a transcode the mirror can never succeed");
  assert.equal(isAllowedChatMime("audio/mp4"), true, "the transcode target is accepted");
});

test("isCarrierOnlyAudio: AMR/3GPP by mime or by extension; photos and voice notes are not", () => {
  assert.equal(isCarrierOnlyAudio("audio/amr", "media.amr"), true);
  assert.equal(isCarrierOnlyAudio("audio/amr; charset=binary", "x.bin"), true);
  assert.equal(isCarrierOnlyAudio("audio/amr-wb", "media.awb"), true);
  assert.equal(isCarrierOnlyAudio("audio/3gpp", "clip.3ga"), true);
  assert.equal(isCarrierOnlyAudio("application/octet-stream", "media.amr"), true, "extension alone is enough");
  assert.equal(isCarrierOnlyAudio("image/jpeg", "media.jpeg"), false);
  assert.equal(isCarrierOnlyAudio("audio/mp4", "voice-note-1.m4a"), false);
  assert.equal(isCarrierOnlyAudio("audio/mpeg", "clip.mp3"), false);
  const jpeg = inferMmsFileNameAndMime(REAL_JPEG_URL, "image/jpeg");
  assert.equal(isCarrierOnlyAudio(jpeg.mimeType, jpeg.fileName), false, "a photo takes the unchanged path");
});

test("transcode args: audio-only AAC in a fast-start M4A", () => {
  assert.ok(CARRIER_AUDIO_TRANSCODE_ARGS.includes("-vn"));
  assert.deepEqual(CARRIER_AUDIO_TRANSCODE_ARGS.slice(CARRIER_AUDIO_TRANSCODE_ARGS.indexOf("-c:a"), CARRIER_AUDIO_TRANSCODE_ARGS.indexOf("-c:a") + 2), ["-c:a", "aac"]);
  assert.ok(CARRIER_AUDIO_TRANSCODE_ARGS.includes("+faststart"));
});

function localFfmpegCanEncodeAmr(): boolean {
  try {
    const out = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /libopencore_amrnb/.test(out);
  } catch {
    return false;
  }
}

test("a real AMR-NB clip transcodes to a playable M4A (real ffmpeg)", { skip: !localFfmpegCanEncodeAmr() && "ffmpeg with libopencore_amrnb not on PATH" }, async () => {
  const amrPath = path.join(os.tmpdir(), `cc-test-${process.pid}-${Date.now()}.amr`);
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "8000", "-ac", "1", "-c:a", "libopencore_amrnb", "-b:a", "12.2k", amrPath],
    { stdio: "ignore" },
  );
  const amr = readFileSync(amrPath);
  assert.equal(amr.subarray(0, 6).toString("ascii"), "#!AMR\n", "fixture really is AMR-NB");
  const m4a = await transcodeCarrierAudioToM4a(amr, ".amr");
  assert.ok(m4a && m4a.length > 0, "transcode produced bytes");
  assert.equal(m4a!.subarray(4, 8).toString("ascii"), "ftyp", "output is an ISO-BMFF (M4A) container");
});

test("transcode failure returns null, never throws", async () => {
  const out = await transcodeCarrierAudioToM4a(Buffer.from("this is not audio"), ".amr");
  assert.equal(out, null);
});

// ── Source guard: the fetcher must transcode BEFORE it writes ───────────────
test("guard: fetchVoipMsMmsToChatFile transcodes carrier audio before writeChatAttachmentFile", () => {
  const src = readFileSync(path.join(__dirname, "voipMsInboundMms.ts"), "utf8").replace(/\r\n/g, "\n");
  const fn = src.slice(src.indexOf("export async function fetchVoipMsMmsToChatFile("));
  const iCheck = fn.indexOf("isCarrierOnlyAudio(mimeType, fileName)");
  const iTranscode = fn.indexOf("transcodeCarrierAudioToM4a(buffer");
  const iWrite = fn.indexOf("writeChatAttachmentFile({");
  assert.ok(iCheck > 0 && iTranscode > iCheck && iWrite > iTranscode, "order must be: detect → transcode → write");
  assert.ok(/mimeType = "audio\/mp4";/.test(fn), "the written mime must be audio/mp4");
  assert.ok(/\.m4a"/.test(fn), "the written file must be named .m4a");
  assert.ok(fn.includes('event: "voipms_mms_fetch_failed"'), "every failure must log its reason");
});

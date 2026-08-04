import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  pcmToWav,
  pcmDurationSeconds,
  isTtsModelId,
  IVR_VOICE_TUNING,
  TTS_MODELS,
  MAX_TTS_CHARS,
  classify,
} from "./elevenLabs";

describe("pcmToWav", () => {
  it("writes a RIFF/WAVE header Asterisk can read", () => {
    const pcm = Buffer.alloc(1600); // 0.1s at 8 kHz
    const wav = pcmToWav(pcm, 8000);

    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.subarray(12, 16).toString()).toBe("fmt ");
    expect(wav.subarray(36, 40).toString()).toBe("data");
  });

  it("declares mono 16-bit at the rate it was given", () => {
    const wav = pcmToWav(Buffer.alloc(800), 8000);
    expect(wav.readUInt16LE(20)).toBe(1);      // PCM
    expect(wav.readUInt16LE(22)).toBe(1);      // mono
    expect(wav.readUInt32LE(24)).toBe(8000);   // sample rate
    expect(wav.readUInt16LE(34)).toBe(16);     // bits per sample
  });

  it("gets the byte rate and block align right, or players stretch the audio", () => {
    const wav = pcmToWav(Buffer.alloc(800), 8000);
    expect(wav.readUInt32LE(28)).toBe(16000); // 8000 * 1 * 2
    expect(wav.readUInt16LE(32)).toBe(2);
  });

  it("sizes both length fields against the real payload", () => {
    const pcm = Buffer.alloc(2222);
    const wav = pcmToWav(pcm, 16000);
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // RIFF size
    expect(wav.readUInt32LE(40)).toBe(pcm.length);     // data size
    expect(wav.length).toBe(44 + pcm.length);
  });

  it("keeps the samples byte-for-byte", () => {
    const pcm = Buffer.from([1, 2, 3, 4, 250, 251, 252, 253]);
    const wav = pcmToWav(pcm, 8000);
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });

  it("handles a 16 kHz fallback response", () => {
    const wav = pcmToWav(Buffer.alloc(3200), 16000);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(28)).toBe(32000);
  });
});

describe("pcmDurationSeconds", () => {
  it("reads one second of 8 kHz audio as one second", () => {
    expect(pcmDurationSeconds(Buffer.alloc(16000), 8000)).toBe(1);
  });

  it("reads one second of 16 kHz audio as one second", () => {
    expect(pcmDurationSeconds(Buffer.alloc(32000), 16000)).toBe(1);
  });

  it("rounds to a tenth, because nobody needs more precision than that", () => {
    expect(pcmDurationSeconds(Buffer.alloc(16000 * 12.34), 8000)).toBe(12.3);
  });

  it("never divides by zero", () => {
    expect(pcmDurationSeconds(Buffer.alloc(1000), 0)).toBe(0);
  });
});

describe("model ids", () => {
  it("accepts every model we offer", () => {
    for (const m of TTS_MODELS) expect(isTtsModelId(m.id)).toBe(true);
  });

  it("rejects anything else, so a bad body can't reach the provider", () => {
    expect(isTtsModelId("eleven_made_up")).toBe(false);
    expect(isTtsModelId("")).toBe(false);
    expect(isTtsModelId(null)).toBe(false);
    expect(isTtsModelId(undefined)).toBe(false);
    expect(isTtsModelId({ id: "eleven_flash_v2_5" })).toBe(false);
  });

  it("defaults to the fast model first in the list", () => {
    expect(TTS_MODELS[0].id).toBe("eleven_flash_v2_5");
  });
});

describe("the IVR preset", () => {
  it("is steady rather than expressive — a menu is read, not performed", () => {
    expect(IVR_VOICE_TUNING.stability).toBeGreaterThanOrEqual(0.7);
    expect(IVR_VOICE_TUNING.style).toBe(0);
  });

  it("speaks slightly slower than natural, for callers on a bad line", () => {
    expect(IVR_VOICE_TUNING.speed).toBeLessThan(1);
    expect(IVR_VOICE_TUNING.speed).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps every setting inside the range the provider accepts", () => {
    for (const k of ["stability", "similarityBoost", "style"] as const) {
      expect(IVR_VOICE_TUNING[k]).toBeGreaterThanOrEqual(0);
      expect(IVR_VOICE_TUNING[k]).toBeLessThanOrEqual(1);
    }
    expect(IVR_VOICE_TUNING.speed).toBeGreaterThanOrEqual(0.7);
    expect(IVR_VOICE_TUNING.speed).toBeLessThanOrEqual(1.2);
  });
});

describe("length cap", () => {
  it("is long enough for a real greeting and short enough to stop an essay", () => {
    expect(MAX_TTS_CHARS).toBeGreaterThan(500);
    expect(MAX_TTS_CHARS).toBeLessThanOrEqual(5000);
  });
});

describe("classifying provider failures", () => {
  // The real body ElevenLabs returned on 2026-08-04, verbatim. A valid key,
  // /voices answering 200, and synthesis refused — reported by status code
  // alone this reads as "bad key" and sends someone to re-paste a key that was
  // never wrong.
  const PAYMENT_ISSUE = JSON.stringify({
    detail: {
      type: "payment_required",
      code: "payment_issue",
      message: "Your subscription has a failed or incomplete payment. Complete the latest invoice to continue usage.",
      status: "payment_issue",
      request_id: "ce1da67573a307d04360d8addcaaf61b",
    },
  });

  it("names the unpaid invoice rather than blaming the key", () => {
    const msg = classify(PAYMENT_ISSUE);
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/unpaid invoice/i);
    expect(msg).toMatch(/key is fine/i);
    expect(msg).not.toMatch(/rejected/i);
  });

  it("tells someone where to go about it", () => {
    expect(classify(PAYMENT_ISSUE)).toMatch(/elevenlabs\.io/);
  });

  it("separates running out of characters from not paying", () => {
    const quota = JSON.stringify({ detail: { status: "quota_exceeded", message: "character limit reached" } });
    expect(classify(quota)).toMatch(/characters for this month/i);
    expect(classify(quota)).not.toMatch(/unpaid/i);
  });

  it("still calls a genuinely bad key a bad key", () => {
    const bad = JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } });
    expect(classify(bad)).toMatch(/rejected/i);
  });

  it("points at the voice picker when a voice has been deleted", () => {
    expect(classify(JSON.stringify({ detail: { status: "voice_not_found" } }))).toMatch(/Pick another one/i);
  });

  it("reads plain-text bodies too, not just JSON", () => {
    expect(classify("Your subscription has a failed or incomplete payment.")).toMatch(/unpaid invoice/i);
  });

  it("says nothing when it recognises nothing, so the status code still decides", () => {
    expect(classify("")).toBeNull();
    expect(classify("some unrelated upstream error")).toBeNull();
    expect(classify("<html>502 Bad Gateway</html>")).toBeNull();
  });

  it("never throws on a malformed body", () => {
    expect(() => classify("{not json")).not.toThrow();
    expect(classify("{not json")).toBeNull();
  });
});

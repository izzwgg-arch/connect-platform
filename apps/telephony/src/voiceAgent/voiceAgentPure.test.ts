/**
 * Pure-layer tests: μ-law transcode, AudioSocket framing, announcement
 * parsing + registry. No sockets, no timers beyond the injected clock.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { linearToUlaw, ulawToLinear, slinToUlawBuffer, ulawToSlinBuffer } from "./ulaw";
import {
  AudioSocketParser,
  encodeFrame,
  uuidBytesToString,
  FRAME_AUDIO,
  FRAME_TERMINATE,
  FRAME_UUID,
} from "./audioSocketFrames";
import { parseVoiceAgentAnnouncement, AnnouncementRegistry } from "./voiceAgentEvents";

describe("ulaw", () => {
  it("zero encodes to 0xff and decodes back to ~0", () => {
    assert.equal(linearToUlaw(0), 0xff);
    assert.equal(ulawToLinear(0xff), 0);
  });

  it("round-trips within μ-law quantization error across the range", () => {
    for (let s = -32000; s <= 32000; s += 997) {
      const dec = ulawToLinear(linearToUlaw(s));
      // μ-law quantization error grows with amplitude; 3% + 32 covers the
      // whole companding curve.
      const tolerance = Math.abs(s) * 0.04 + 40;
      assert.ok(Math.abs(dec - s) <= tolerance, `sample ${s} decoded to ${dec}`);
    }
  });

  it("is sign-symmetric", () => {
    for (const s of [100, 1000, 8000, 30000]) {
      assert.equal(ulawToLinear(linearToUlaw(-s)), -ulawToLinear(linearToUlaw(s)));
    }
  });

  it("clips beyond the clip point instead of wrapping", () => {
    const atClip = ulawToLinear(linearToUlaw(32635));
    const beyond = ulawToLinear(linearToUlaw(32767));
    assert.equal(atClip, beyond);
  });

  it("buffer helpers are inverse-shaped (length + content)", () => {
    const slin = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) slin.writeInt16LE(((i * 391) % 16000) - 8000, i * 2);
    const ulaw = slinToUlawBuffer(slin);
    assert.equal(ulaw.length, 160);
    const back = ulawToSlinBuffer(ulaw);
    assert.equal(back.length, 320);
    // Spot check a few samples round-trip within tolerance.
    for (const i of [0, 50, 159]) {
      const a = slin.readInt16LE(i * 2);
      const b = back.readInt16LE(i * 2);
      assert.ok(Math.abs(a - b) <= Math.abs(a) * 0.04 + 40);
    }
  });
});

describe("audioSocketFrames", () => {
  it("parses frames split across arbitrary chunk boundaries", () => {
    const audio = Buffer.alloc(320, 7);
    const wire = Buffer.concat([
      encodeFrame(FRAME_UUID, Buffer.alloc(16, 0xab)),
      encodeFrame(FRAME_AUDIO, audio),
      encodeFrame(FRAME_TERMINATE),
    ]);
    // Feed one byte at a time — the cruellest TCP segmentation possible.
    const parser = new AudioSocketParser();
    const frames = [];
    for (let i = 0; i < wire.length; i++) {
      frames.push(...parser.push(wire.subarray(i, i + 1)));
    }
    assert.equal(frames.length, 3);
    assert.equal(frames[0].type, FRAME_UUID);
    assert.equal(frames[1].type, FRAME_AUDIO);
    assert.equal(frames[1].payload.length, 320);
    assert.equal(frames[2].type, FRAME_TERMINATE);
  });

  it("parses glued frames in one chunk", () => {
    const wire = Buffer.concat([
      encodeFrame(FRAME_AUDIO, Buffer.alloc(320, 1)),
      encodeFrame(FRAME_AUDIO, Buffer.alloc(320, 2)),
    ]);
    const parser = new AudioSocketParser();
    const frames = parser.push(wire);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].payload[0], 1);
    assert.equal(frames[1].payload[0], 2);
  });

  it("throws on hostile unbounded buffering", () => {
    const parser = new AudioSocketParser(1024);
    // A header promising 60 KB then trickling garbage below the length keeps
    // the buffer growing without ever completing a frame.
    const header = Buffer.from([FRAME_AUDIO, 0xff, 0xff]);
    parser.push(header);
    assert.throws(() => {
      for (let i = 0; i < 10; i++) parser.push(Buffer.alloc(256, 0));
    }, /audiosocket_buffer_overflow/);
  });

  it("formats UUID bytes canonically and refuses wrong lengths", () => {
    const bytes = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    assert.equal(uuidBytesToString(bytes), "01234567-89ab-cdef-0123-456789abcdef");
    assert.equal(uuidBytesToString(Buffer.alloc(15)), null);
  });
});

describe("voiceAgentEvents", () => {
  const good = {
    Event: "UserEvent",
    UserEvent: "ConnectVoiceAgent",
    UUID: "01234567-89AB-cdef-0123-456789abcdef",
    Tenant: "102",
    Did: "8457231213",
    CallerNum: "3479780090",
  };

  it("parses a well-formed announcement (uuid lowercased)", () => {
    const ann = parseVoiceAgentAnnouncement(good);
    assert.ok(ann);
    assert.equal(ann!.uuid, "01234567-89ab-cdef-0123-456789abcdef");
    assert.equal(ann!.pbxTenant, "102");
    assert.equal(ann!.did, "8457231213");
    assert.equal(ann!.callerNumber, "3479780090");
  });

  it("refuses missing/bad uuid or tenant, tolerates missing did/caller", () => {
    assert.equal(parseVoiceAgentAnnouncement({ ...good, UUID: "not-a-uuid" }), null);
    assert.equal(parseVoiceAgentAnnouncement({ ...good, Tenant: "abc" }), null);
    assert.equal(parseVoiceAgentAnnouncement({ ...good, UserEvent: "SomethingElse" }), null);
    const ann = parseVoiceAgentAnnouncement({ ...good, Did: "", CallerNum: "<garbage>" });
    assert.ok(ann);
    assert.equal(ann!.did, null);
    assert.equal(ann!.callerNumber, null);
  });

  it("registry: take consumes; TTL expires entries", () => {
    let t = 1_000_000;
    const reg = new AnnouncementRegistry({ ttlMs: 60_000, now: () => t });
    const ann = parseVoiceAgentAnnouncement(good)!;
    reg.put(ann);
    assert.equal(reg.take(ann.uuid)?.pbxTenant, "102");
    assert.equal(reg.take(ann.uuid), null, "take consumes");
    reg.put(ann);
    t += 61_000;
    assert.equal(reg.take(ann.uuid), null, "expired after TTL");
  });
});

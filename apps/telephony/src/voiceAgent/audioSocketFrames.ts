/**
 * Asterisk AudioSocket wire protocol — pure framing, no sockets.
 *
 * Every frame is `type(1) length(2, big-endian) payload(length)`.
 *   0x00 TERMINATE — either side ends the stream (Asterisk: caller hung up;
 *                    us: hang the call up / return to dialplan).
 *   0x01 UUID      — first frame Asterisk sends; payload is the 16 RAW BYTES
 *                    of the UUID the dialplan passed to AudioSocket(). This is
 *                    the session's bearer token: the dialplan announced it to
 *                    telephony via AMI UserEvent moments earlier, so a
 *                    connection presenting an unknown UUID is refused.
 *   0x10 AUDIO     — 8 kHz 16-bit LE signed-linear PCM. Asterisk sends 20 ms
 *                    (320-byte) frames; we send the same shape back.
 *   0xff ERROR     — Asterisk-side error indication.
 *
 * The parser is an incremental byte-stream accumulator because TCP has no
 * message boundaries — a frame can arrive split across any number of chunks,
 * and several frames can arrive glued together. `push()` returns every
 * complete frame available so far and keeps the remainder.
 */

export const FRAME_TERMINATE = 0x00;
export const FRAME_UUID = 0x01;
export const FRAME_AUDIO = 0x10;
export const FRAME_ERROR = 0xff;

/** 20 ms of 8 kHz 16-bit mono = the frame size Asterisk uses. */
export const SLIN_FRAME_BYTES = 320;
export const FRAME_INTERVAL_MS = 20;

export interface AudioSocketFrame {
  type: number;
  payload: Buffer;
}

/** Serialize one frame. */
export function encodeFrame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > 0xffff) throw new Error("audiosocket_frame_too_large");
  const out = Buffer.allocUnsafe(3 + payload.length);
  out[0] = type & 0xff;
  out.writeUInt16BE(payload.length, 1);
  payload.copy(out, 3);
  return out;
}

/** Format the 16 raw UUID bytes as the canonical 8-4-4-4-12 string. */
export function uuidBytesToString(bytes: Buffer): string | null {
  if (bytes.length !== 16) return null;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Incremental frame parser. Feed raw socket chunks in; complete frames come
 * out. A hard cap on the buffered remainder guards against a hostile peer
 * streaming garbage that never forms a frame.
 */
export class AudioSocketParser {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxBuffered: number;

  constructor(maxBuffered = 256 * 1024) {
    this.maxBuffered = maxBuffered;
  }

  /** Returns all complete frames now available; throws on overflow. */
  push(chunk: Buffer): AudioSocketFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxBuffered) {
      throw new Error("audiosocket_buffer_overflow");
    }
    const frames: AudioSocketFrame[] = [];
    for (;;) {
      if (this.buffer.length < 3) break;
      const len = this.buffer.readUInt16BE(1);
      if (this.buffer.length < 3 + len) break;
      frames.push({ type: this.buffer[0], payload: this.buffer.subarray(3, 3 + len) });
      this.buffer = this.buffer.subarray(3 + len);
    }
    return frames;
  }
}

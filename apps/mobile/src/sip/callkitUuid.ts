// Deterministic CallKit UUID derivation — shared contract between JS and the
// native iOS PushKit handler injected by plugins/withIosVoipPush.js.
//
// WHY: CallKit (iOS) requires a valid RFC-4122 UUID for every call. The Connect
// backend identifies a call by `callId`/`inviteId` (a cuid like "clx…"), which
// is NOT a valid UUID. For a fully cold-killed app, the NATIVE PushKit handler
// must report the incoming call to CallKit *before* the PushKit completion
// handler returns (Apple requirement) — and then the JS layer reconciles with
// the same call. For native and JS to agree on the SAME CallKit UUID without
// any shared state, both derive it deterministically from `callId` using the
// identical algorithm below.
//
// ALGORITHM (must stay byte-for-byte identical to the Obj-C version in
// plugins/withIosVoipPush.js → ConnectDeterministicCallKitUUID):
//   1. Take the UTF-8 bytes of `callId`.
//   2. For each output byte index i in 0..15:
//        h = FNV-1a-32 over the sequence [ i, ...utf8(callId) ]
//          (FNV-1a-32: offset basis 0x811c9dc5, prime 0x01000193, 32-bit wrap)
//        out[i] = (h ^ (h>>>8) ^ (h>>>16) ^ (h>>>24)) & 0xFF
//   3. Set RFC-4122 version 5 nibble:  out[6] = (out[6] & 0x0F) | 0x50
//      Set RFC-4122 variant bits:      out[8] = (out[8] & 0x3F) | 0x80
//   4. Format as canonical 8-4-4-4-12 lowercase hex.
//
// No external dependencies. Deterministic. Same callId ⇒ same UUID, forever.

/** UTF-8 encode a string to bytes so JS matches native `[str UTF8String]`.
 *  Connect callIds are ASCII cuids, but full UTF-8 keeps parity for any input. */
export function utf8Bytes(str: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f),
        );
        i++;
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

/** FNV-1a 32-bit hash over a byte array (32-bit wraparound via Math.imul). */
export function fnv1a32(bytes: number[]): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic, dependency-free CallKit UUID for a backend callId.
 * MUST match plugins/withIosVoipPush.js ConnectDeterministicCallKitUUID.
 */
export function deterministicCallKitUuid(callId: string): string {
  const base = utf8Bytes(callId);
  const out: number[] = new Array(16);
  for (let i = 0; i < 16; i++) {
    const h = fnv1a32([i, ...base]);
    out[i] = (h ^ (h >>> 8) ^ (h >>> 16) ^ (h >>> 24)) & 0xff;
  }
  out[6] = (out[6] & 0x0f) | 0x50; // version 5 nibble
  out[8] = (out[8] & 0x3f) | 0x80; // RFC-4122 variant
  const hex = out.map((b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

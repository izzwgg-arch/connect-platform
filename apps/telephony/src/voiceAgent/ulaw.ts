/**
 * G.711 μ-law ⇄ 16-bit linear PCM, pure and dependency-free.
 *
 * Why this exists: the PBX's AudioSocket streams 8 kHz **signed linear**
 * (slin, 16-bit LE) frames, while the OpenAI realtime session is configured
 * for **g711 μ-law** at the same 8 kHz — so the bridge only ever transcodes
 * companding, never resamples. That choice is deliberate: matching sample
 * rates end to end removes the whole resampling problem (and its latency and
 * artifacts) from the call path.
 *
 * Standard G.711 μ-law with the 0x84 bias and 32635 clip. The decoder is a
 * 256-entry table built once at module load from the inverse transform, so
 * decoding is a single array read per sample.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** Encode one 16-bit signed linear sample to one μ-law byte. */
export function linearToUlaw(sample: number): number {
  let s = sample | 0;
  const sign = s < 0 ? 0x80 : 0x00;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {
    // walk down until the top set bit is found
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Inverse transform for one μ-law byte (used to build the table). */
function ulawByteToLinear(u: number): number {
  const inv = ~u & 0xff;
  const sign = inv & 0x80;
  const exponent = (inv >> 4) & 0x07;
  const mantissa = inv & 0x0f;
  let sample = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -sample : sample;
}

const DECODE_TABLE: Int16Array = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) t[i] = ulawByteToLinear(i);
  return t;
})();

/** Decode one μ-law byte to a 16-bit signed linear sample. */
export function ulawToLinear(ulawByte: number): number {
  return DECODE_TABLE[ulawByte & 0xff];
}

/** Encode a buffer of 16-bit LE slin samples into a μ-law byte buffer. */
export function slinToUlawBuffer(slin: Buffer): Buffer {
  const samples = slin.length >> 1;
  const out = Buffer.allocUnsafe(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = linearToUlaw(slin.readInt16LE(i << 1));
  }
  return out;
}

/** Decode a μ-law byte buffer into 16-bit LE slin samples. */
export function ulawToSlinBuffer(ulaw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(ulaw.length << 1);
  for (let i = 0; i < ulaw.length; i++) {
    out.writeInt16LE(DECODE_TABLE[ulaw[i]], i << 1);
  }
  return out;
}

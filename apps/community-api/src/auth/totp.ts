import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 6238 TOTP, SHA-1, 6 digits, 30s — what every authenticator app expects. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

/** Accepts the current step and one either side (clock drift). */
export function verifyTotp(secret: string, code: string): boolean {
  const c = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  const now = Math.floor(Date.now() / 30_000);
  for (const step of [now, now - 1, now + 1]) {
    const expected = totpCode(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
  }
  return false;
}

export function otpauthUrl(secret: string, account: string, issuer = "Loopcom Community"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

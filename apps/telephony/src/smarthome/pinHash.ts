// PIN hashing — scrypt (node:crypto, no new dependencies).
// Stored form: "scrypt:<saltHex>:<hashHex>".

import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

const KEYLEN = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (expected.length !== KEYLEN) return false;
    const actual = scryptSync(pin, salt, KEYLEN, SCRYPT_OPTS);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

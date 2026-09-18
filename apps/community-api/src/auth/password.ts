import { hash, verify } from "@node-rs/argon2";

/** argon2id, OWASP-recommended parameters. */
const OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

const COMMON = new Set([
  "password", "password1", "12345678", "123456789", "qwerty123", "letmein1", "welcome1", "iloveyou", "admin123", "loopcom123",
]);

/** Returns a human sentence when the password is not acceptable, else null. */
export function passwordProblem(plain: string, hints: string[] = []): string | null {
  if (typeof plain !== "string" || plain.length < 10) return "Use at least 10 characters.";
  if (plain.length > 200) return "That's too long — keep it under 200 characters.";
  if (COMMON.has(plain.toLowerCase())) return "That password is on every breach list. Pick something less common.";
  const lower = plain.toLowerCase();
  for (const h of hints) {
    const hh = String(h || "").toLowerCase();
    if (hh.length >= 4 && lower.includes(hh)) return "Don't use your name or email inside the password.";
  }
  return null;
}

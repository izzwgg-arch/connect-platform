import { randomBytes, createHash } from "node:crypto";

export const token = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const sixDigits = () => String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");

/** URL-safe slug from a name; the caller de-dupes with a suffix. */
export function slugify(input: string): string {
  const base = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "item";
}

export function shortSuffix(): string {
  return randomBytes(3).toString("hex");
}

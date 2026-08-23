/**
 * Dialpad display formatting — pure helper for UI + tests.
 *
 * ⛔ THE RULE: only an ALL-DIGIT string is ever regrouped. Anything carrying a
 * non-digit dialable character (`*`, `#`, a leading `+`) renders EXACTLY as
 * typed.
 *
 * Why this file exists (Izzy, 2026-08-23: "from the iPhone and mobile Android
 * app I'm not able to dial # or *"): the old inline formatter built its output
 * from `n.replace(/\D/g, '')`, so every non-digit was stripped before it ever
 * reached the screen. Pressing `*` showed an EMPTY field; `*97` rendered as
 * `97`; a long-pressed `+` vanished until the number passed 10 digits. The
 * character was in state and really was dialled — the keypad just never
 * admitted it, so the only reasonable read was "the key does nothing".
 *
 * Grouping is also simply wrong for these strings: `*67`, `*97` and
 * `8005551212#123` are feature codes and post-dial digits, not phone-shaped
 * numbers, and splitting them into 3-3-4 makes them harder to read, not
 * easier.
 *
 * ⛔ Do NOT reintroduce a `replace(/\D/g, '')` on the way to the screen. The
 * dialled value comes from `number` and is normalised by
 * `normalizeMobileDialTarget`; this function is presentation ONLY and must
 * never be the thing that decides what gets dialled.
 */

/** Longest string that is treated as an internal extension and shown raw. */
const MAX_EXTENSION_LENGTH = 5;

export function formatDialDisplay(n: string): string {
  if (!n) return "";

  // Feature codes, post-dial digits and international `+` — as typed.
  if (!/^\d+$/.test(n)) return n;

  // Internal extension — no grouping.
  if (n.length <= MAX_EXTENSION_LENGTH) return n;

  if (n.length <= 6) return `${n.slice(0, 3)} ${n.slice(3)}`;
  if (n.length <= 10) return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;

  // Longer than a NANP number (country code, or a mistype) — show it raw
  // rather than guess at a grouping.
  return n;
}

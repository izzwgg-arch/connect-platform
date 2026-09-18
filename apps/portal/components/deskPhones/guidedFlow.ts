/**
 * The guided (one-phone-at-a-time) setup's decisions, kept pure so every screen
 * transition is provable without a phone on a desk.
 *
 * Izzy, 2026-09-18: "connect one phone at a time. This way, they don't get confused
 * about which phone goes where… They will probably have to check the last 4 of the
 * MAC address to make sure we're setting up the right phone."
 *
 * ⛔ Nothing here decides what happens TO a phone — the server's ladder and the driver
 * do that. This only decides which SCREEN the person is looking at, from what the
 * driver reported, and it never shows "connected" from anything but the per-device
 * `connectedNow` the server computed (2026-09-17: never fake data).
 */

import type { NeedsPerson } from "./setupDriver";

export type GuidedScreen =
  | "extension"
  | "phone"
  | "reset"
  | "connecting"
  | "connected"
  | "stuck"
  | "all_done";

export type StuckKind = "old_provider" | "password" | "not_checking_in" | "unsupported";

export type GuidedPhone = {
  id: string;
  mac: string | null;
  model: string | null;
  vendor: string | null;
  extNumber: string | null;
  displayName: string | null;
  status: string;
  note: string | null;
  needsAttention: boolean;
  connectedNow?: boolean | null;
  registeredAsExt?: string | null;
  ip?: string | null;
  serialOnFile?: boolean;
};

/** The sticker-check form of a MAC: last four hex characters, spaced in pairs. */
export function stickerEndsIn(mac: string | null | undefined): string | null {
  const hex = String(mac ?? "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length < 4) return null;
  const tail = hex.slice(-4);
  return `${tail.slice(0, 2)} ${tail.slice(2)}`;
}

/**
 * What a person typed off the sticker, as hex. ⛔ A MAC never contains the letter O —
 * only zeros — and people type O anyway (Izzy, 2026-09-18: "if somebody types an O, the
 * system should automatically take it as a zero"). Upper-cased, O→0, everything that is
 * not 0-9/A-F dropped (spaces, colons, hyphens, the word MAC itself).
 */
export function normalizeSticker(typed: string): string {
  return String(typed ?? "")
    .toUpperCase()
    // ⛔ The label itself is hex-shaped ("MAC" → A, C) — a person who types the whole
    // sticker line must not have the word counted as digits.
    .replace(/\bMAC(\s*ADDRESS)?\b\s*:?/g, "")
    .replace(/O/g, "0")
    .replace(/[^0-9A-F]/g, "");
}

/** Whether the person's typed sticker code matches this phone (last 4, any spacing/case, O = 0). */
export function stickerMatches(mac: string | null | undefined, typed: string): boolean {
  const want = String(mac ?? "").replace(/[^0-9a-f]/gi, "").toUpperCase().slice(-4);
  const got = normalizeSticker(typed).slice(-4);
  return want.length === 4 && got.length === 4 && want === got;
}

/** The demonstration: what a MAC looks like on a sticker, with the four the person reads lit up. */
export const STICKER_EXAMPLE = { prefix: "00-0B-82-1A-", tail: "2B-3C" } as const;

/**
 * Why a phone is stuck, from the server's own customer note. ⛔ Only the WORDING of the
 * stuck screen depends on this; the fact that it is stuck comes from `needsAttention`.
 */
export function classifyStuck(note: string | null | undefined): StuckKind {
  const n = String(note ?? "");
  if (/cloud|another (org|provider|company|account)|release|claimed|previous provider/i.test(n)) return "old_provider";
  if (/password|locked/i.test(n)) return "password";
  if (/model|template|by hand|can't set this|cannot set this|no way to do it|support can (connect|finish)/i.test(n)) return "unsupported";
  return "not_checking_in";
}

/**
 * The truth about "this phone is connected as THIS extension": the per-device
 * registration (its own contact), registered as the extension the person mapped.
 * A phone registered as some OTHER extension is not done — it still needs its settings.
 */
export function connectedAsMapped(p: Pick<GuidedPhone, "connectedNow" | "registeredAsExt" | "extNumber">): boolean {
  if (p.connectedNow !== true) return false;
  if (!p.extNumber) return false;
  return p.registeredAsExt == null || String(p.registeredAsExt) === String(p.extNumber);
}

/**
 * Which screen the focused phone is on. Order matters: a finished phone is "connected"
 * whatever the driver is still saying; a phone the server gave up on is "stuck";
 * a phone the driver cannot open is the person's reset; everything else is the
 * robot working.
 */
export function screenForFocused(
  p: GuidedPhone | null,
  needs: NeedsPerson[],
  opts: { ticking: boolean },
): Exclude<GuidedScreen, "extension" | "phone" | "all_done"> {
  if (!p) return "connecting";
  if (connectedAsMapped(p)) return "connected";
  if (p.needsAttention) return "stuck";
  if (needs.some((n) => n.kind === "password" && n.phoneId === p.id)) return "reset";
  return opts.ticking ? "connecting" : "reset";
}

/**
 * The phones offered on the "which phone" screen, best candidates first: fresh or
 * unassigned phones before ones already connected somewhere, never hiding any
 * (a person may deliberately move a working phone to a new desk).
 */
export function orderCandidates(phones: GuidedPhone[]): GuidedPhone[] {
  const rank = (p: GuidedPhone) => (connectedAsMapped(p) ? 2 : p.connectedNow === true ? 1 : 0);
  return [...phones].sort((a, b) => rank(a) - rank(b) || String(a.model ?? "").localeCompare(String(b.model ?? "")));
}

/** One customer-safe line about a candidate phone's state on the pick screen. */
export function candidateStateLine(p: GuidedPhone, fresh: boolean | null): { text: string; tone: "ok" | "warn" | "dim" } {
  if (p.connectedNow === true && p.registeredAsExt) return { text: `Already connected as ext ${p.registeredAsExt}`, tone: "ok" };
  if (p.connectedNow === true) return { text: "Already connected", tone: "ok" };
  if (fresh === true) return { text: "Fresh out of the box — no reset needed", tone: "ok" };
  if (fresh === false) return { text: "Still has someone's old settings", tone: "warn" };
  return { text: "Not connected yet", tone: "dim" };
}

/**
 * The extension list with what is REALLY on each one right now — from per-device
 * registrations, never from the assignment records.
 */
export function extensionsWithPhones(
  extensions: Array<{ id: string; extNumber: string; displayName: string }>,
  phones: GuidedPhone[],
): Array<{ id: string; extNumber: string; displayName: string; phone: GuidedPhone | null }> {
  return extensions.map((e) => ({
    ...e,
    phone: phones.find((p) => p.connectedNow === true && String(p.registeredAsExt ?? p.extNumber ?? "") === String(e.extNumber)) ?? null,
  }));
}

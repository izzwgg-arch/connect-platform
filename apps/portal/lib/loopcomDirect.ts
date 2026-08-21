/**
 * Loopcom Direct — shared types and pure display helpers for the portal.
 *
 * Kept out of the page components so the wording rules can be unit-tested:
 * the two that matter are that a person's phone number is shown the way a
 * human writes it, and that a person with no usable name never renders as a
 * blank card.
 */

export type DirectCard = {
  userId: string;
  name: string;
  company: string;
  phoneE164: string;
  phoneDisplay?: string;
};

export type DirectThreadSummary = {
  threadId: string;
  state: "ACTIVE" | "REQUEST_PENDING" | "DECLINED";
  lastMessageAt: string;
  unread: boolean;
  lastMessage: { body: string; kind: "TEXT" | "CALL_EVENT"; mine: boolean } | null;
  other: DirectCard | null;
};

export type DirectMessage = {
  id: string;
  mine: boolean;
  kind: "TEXT" | "CALL_EVENT";
  body: string;
  meetingCode: string | null;
  callSeconds: number | null;
  createdAt: string;
};

export type DirectThreadDetail = {
  threadId: string;
  myState: "ACTIVE" | "REQUEST_PENDING" | "DECLINED";
  other: (DirectCard & { readAt: string | null }) | null;
  canSend: boolean;
  sendBlockedReason: string | null;
  canCall: boolean;
  callBlockedReason: string | null;
  messages: DirectMessage[];
};

export type DirectMe = {
  companyEnabled: boolean;
  identity: {
    phoneE164: string;
    phoneDisplay: string;
    verifiedAt: string;
    findable: boolean;
    requireRequests: boolean;
  } | null;
  blocked: (DirectCard & { userId: string })[];
};

export type DirectLookup =
  | { result: "found"; userId: string; name: string; company: string; phoneE164: string; phoneDisplay: string; existingThreadId: string | null }
  | { result: "not_on_loopcom"; phoneDisplay: string }
  | { result: "self"; phoneDisplay: string }
  | { result: "invalid"; message: string };

/** (347) 555-0182 — how a person writes a number down. */
export function formatPhoneForDisplay(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 ?? "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 ?? "";
}

/** Digits as typed, so the field is usable while it is still incomplete. */
export function formatPhoneWhileTyping(raw: string): string {
  const digits = (raw ?? "").replace(/\D/g, "").slice(0, 11);
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length <= 3) return local;
  if (local.length <= 6) return `(${local.slice(0, 3)}) ${local.slice(3)}`;
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6, 10)}`;
}

/** Enough digits to be worth asking the server about. */
export function isSearchablePhone(raw: string): boolean {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
}

/**
 * Initials for the avatar. ⛔ Falls back to a neutral mark rather than a
 * letter from an email address — a Direct card is seen by someone at another
 * company.
 */
export function initialsFor(name: string): string {
  const parts = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter((p) => /[a-z]/i.test(p));
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** A stable colour per person, so the same face keeps the same colour. */
export function avatarClassFor(seed: string): string {
  if (!seed) return "unknown";
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `c${(h % 5) + 1}`;
}

/** "2:14 PM" for today, "Mon" this week, else a short date. */
export function shortTimestamp(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "Video call · 4 min" — the line a finished call leaves in the thread. */
export function callEventLabel(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return "Video call";
  if (seconds < 60) return `Video call · ${seconds} sec`;
  const mins = Math.round(seconds / 60);
  return `Video call · ${mins} min`;
}

/** The join code out of a stored call message, for rendering a link. */
export function meetingPathFor(code: string | null): string | null {
  return code ? `/meet/${code}` : null;
}

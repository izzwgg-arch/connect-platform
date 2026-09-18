/**
 * Pure messaging policy. Routes fetch rows and call these; nothing here talks
 * to the database directly (the one exception, isBlockedEitherWay/degree
 * lookups, stays in policy/graph.ts and is called by the service, not here).
 *
 * The rules (Izzy's brief):
 * - A DIRECT thread between A and B is unique by pairKey.
 * - The sender may start a thread with anyone not blocked.
 * - The recipient's participant state is ACTIVE when the two are 1st-degree
 *   connections, otherwise REQUESTED — unless the recipient's own
 *   `messageRequests` preference is false, in which case a stranger cannot
 *   start a thread at all (refused the same way as a block: no oracle).
 * - While the other side's participant state is REQUESTED or DECLINED, the
 *   sender is capped at ONE message in that thread, ever, refused with the
 *   same sentence both times — a sender can never tell DECLINED from
 *   "still pending" (no oracle).
 * - Read receipts are exposed to the other side only when BOTH participants
 *   have `readReceipts !== false`.
 * - Presence (online) is shown only when the person's `showOnline !== false`.
 */

export type ParticipantState = "ACTIVE" | "REQUESTED" | "DECLINED" | "LEFT";

export type MessagingPrefs = {
  messageRequests?: boolean;
  readReceipts?: boolean;
  showOnline?: boolean;
};

export const WAIT_FOR_ACCEPT_MESSAGE = "Wait for them to accept your request before sending more.";

/** Person.preferences is a loose JSON blob; every key defaults to "on". */
export function resolvePrefs(raw: unknown): Required<MessagingPrefs> {
  const p = (raw && typeof raw === "object" ? (raw as MessagingPrefs) : {}) ?? {};
  return {
    messageRequests: p.messageRequests !== false,
    readReceipts: p.readReceipts !== false,
    showOnline: p.showOnline !== false,
  };
}

export type StartOutcome = { allowed: true; recipientState: "ACTIVE" | "REQUESTED" } | { allowed: false };

/** Decides the recipient's initial participant state for a new DIRECT thread. Blocked and "requests off" refuse identically — the caller turns `allowed:false` into notFound(), never a different message. */
export function decideThreadStart(ctx: { blocked: boolean; connected: boolean; recipientAllowsRequests: boolean }): StartOutcome {
  if (ctx.blocked) return { allowed: false };
  if (ctx.connected) return { allowed: true, recipientState: "ACTIVE" };
  if (!ctx.recipientAllowsRequests) return { allowed: false };
  return { allowed: true, recipientState: "REQUESTED" };
}

/**
 * Can the sender post another message given the OTHER participant's current
 * state and how many messages the sender has already put in this thread?
 * ACTIVE (and, for a message sent while accepting, the transitional case) is
 * unlimited; REQUESTED/DECLINED cap the sender at one message ever; LEFT
 * (a group member who left) never receives new messages addressed via them.
 */
export function canSendGiven(otherState: ParticipantState, priorMessagesFromSender: number): boolean {
  if (otherState === "ACTIVE") return true;
  if (otherState === "LEFT") return false;
  // REQUESTED or DECLINED
  return priorMessagesFromSender < 1;
}

/** True when both sides of a pair allow read receipts to be shown to each other. */
export function readReceiptsVisible(a: MessagingPrefs | undefined, b: MessagingPrefs | undefined): boolean {
  return resolvePrefs(a).readReceipts && resolvePrefs(b).readReceipts;
}

/** True when this person is willing to show "online" to anyone at all. Recency is checked by the caller. */
export function presenceShareable(prefs: MessagingPrefs | undefined): boolean {
  return resolvePrefs(prefs).showOnline;
}

export const PRESENCE_WINDOW_MS = 3 * 60_000;

export function isOnline(lastSeenAt: Date | null | undefined, prefs: MessagingPrefs | undefined, now = new Date()): boolean {
  if (!lastSeenAt) return false;
  if (!presenceShareable(prefs)) return false;
  return now.getTime() - lastSeenAt.getTime() <= PRESENCE_WINDOW_MS;
}

/** Preview text for the thread list — never the full body, never for a deleted message. */
export function previewFor(kind: string, body: string | null | undefined): string {
  if (kind === "IMAGE") return "📷 Photo";
  if (kind === "VIDEO") return "🎬 Video";
  if (kind === "AUDIO") return "🎤 Voice message";
  if (kind === "FILE") return "📎 File";
  if (kind === "QUOTE_CARD") return "Sent a quote";
  const t = (body ?? "").replace(/\s+/g, " ").trim();
  return t.length > 140 ? `${t.slice(0, 139)}…` : t;
}

/** Strips control characters (never touches printable unicode, incl. Yiddish/Hebrew). */
export function sanitizeBody(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
}

/** A view of a thread is refused entirely once its viewer has declined or left it — same shape as absence. */
export function threadHiddenFor(state: ParticipantState): boolean {
  return state === "DECLINED" || state === "LEFT";
}

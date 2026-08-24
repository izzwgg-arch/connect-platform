/**
 * The Onboarding list, as a person reads it.
 *
 * The old admin list showed a raw status enum and a link. That was true and
 * useless: eleven of the twenty-three sign-ups sat at INVITE_SENT with no name
 * and no email, and nothing on screen distinguished "we invited them an hour
 * ago" from "this link has been dead since July".
 *
 * ⛔ The opened/returned facts are NOT new instrumentation — `recordLinkOpened`
 * has written them since the journey beacons shipped. They were simply never
 * read back. Everything here is derived from rows we already had.
 */

export type InvitationRowInput = {
  id: string;
  publicToken: string | null;
  companyName: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  mainEmail: string | null;
  status: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  submittedAt: Date | string | null;
  paidAt: Date | string | null;
  createdTenantId: string | null;
  extensionCount: number;
  /** From the event stream: first open, latest activity, current step. */
  openedAt: Date | string | null;
  lastActivityAt: Date | string | null;
  currentStepLabel: string | null;
  inviteSentAt: Date | string | null;
};

export type InvitationState =
  | "not_opened"
  | "in_progress"
  | "stalled"
  | "awaiting_payment"
  | "building"
  | "live"
  | "cancelled";

export type InvitationRow = {
  id: string;
  companyName: string;
  contactName: string;
  mainEmail: string;
  publicPath: string | null;
  status: string;
  state: InvitationState;
  /** The words on the pill, e.g. "Live", "Stopped halfway", "Not opened yet". */
  stateLabel: string;
  /** The plain-English "Sent 20 Aug · opened 2 minutes later" line. */
  storyLine: string;
  needsNudge: boolean;
  canResend: boolean;
  createdAt: string;
  openedAt: string | null;
  lastActivityAt: string | null;
  inviteSentAt: string | null;
  extensionCount: number;
  createdTenantId: string | null;
};

/** Anything quiet for this long, and not finished, is worth chasing. */
export const NUDGE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

function d(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const t = v instanceof Date ? v : new Date(v);
  return Number.isFinite(t.getTime()) ? t : null;
}

function iso(v: Date | string | null | undefined): string | null {
  const t = d(v);
  return t ? t.toISOString() : null;
}

/** "20 Aug" — short, because the row is scanned, not read. */
export function shortDate(v: Date | string, now: Date = new Date()): string {
  const t = d(v)!;
  const sameYear = t.getUTCFullYear() === now.getUTCFullYear();
  const month = t.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return sameYear ? `${t.getUTCDate()} ${month}` : `${t.getUTCDate()} ${month} ${t.getUTCFullYear()}`;
}

/** "2 minutes later", "4 days later" — the gap between two moments. */
export function gapWords(from: Date | string, to: Date | string): string {
  const a = d(from)!.getTime();
  const b = d(to)!.getTime();
  const secs = Math.max(0, Math.round((b - a) / 1000));
  if (secs < 90) return `${secs} second${secs === 1 ? "" : "s"} later`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} minute${mins === 1 ? "" : "s"} later`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"} later`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} later`;
}

/** "4 days ago" — how long something has been quiet. */
export function agoWords(v: Date | string, now: Date = new Date()): string {
  const secs = Math.max(0, Math.round((now.getTime() - d(v)!.getTime()) / 1000));
  if (secs < 90) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function decideState(row: InvitationRowInput, now: Date = new Date()): { state: InvitationState; label: string } {
  if (row.status === "CANCELED") return { state: "cancelled", label: "Cancelled" };
  if (row.status === "ACTIVE" || row.status === "COMPLETED") return { state: "live", label: "Live" };
  if (row.paidAt) return { state: "building", label: "Setting up their phones" };
  if (row.status === "SUBMITTED" || row.status === "AWAITING_PAYMENT") {
    return { state: "awaiting_payment", label: "Waiting on payment" };
  }
  // ⛔ A missing "opened" beacon does NOT mean nobody opened it. The beacon
  // arrived after some of these sign-ups, and one that an admin builds by
  // script has no wizard events at all — but autosaves and reached-steps are
  // proof somebody used the link. Claiming "not opened" over a row that
  // demonstrably has typing in it is the kind of wrong that makes a screen
  // untrustworthy.
  if (!row.openedAt && !row.lastActivityAt) return { state: "not_opened", label: "Not opened yet" };

  const quietSince = d(row.lastActivityAt) ?? d(row.openedAt)!;
  if (now.getTime() - quietSince.getTime() > NUDGE_AFTER_MS) {
    return { state: "stalled", label: "Stopped halfway" };
  }
  return { state: "in_progress", label: "Filling it in" };
}

/**
 * The one-line story under the name. Deliberately never says "INVITE_SENT" or
 * any other enum: what an admin needs is when it went out, whether they opened
 * it, and whether anything has happened since.
 */
export function buildStoryLine(row: InvitationRowInput, state: InvitationState, now: Date = new Date()): string {
  const parts: string[] = [];
  const sent = d(row.inviteSentAt);
  const created = d(row.createdAt)!;
  parts.push(sent ? `Sent ${shortDate(sent, now)}` : `Made ${shortDate(created, now)}`);

  const opened = d(row.openedAt);
  const activity = d(row.lastActivityAt);
  const done = d(row.paidAt) ?? d(row.submittedAt);

  if (opened) {
    parts.push(`opened ${gapWords(sent ?? created, opened)}`);
  } else if (activity) {
    // Used, but before the open beacon existed — say what we know, not what
    // we do not.
    parts.push("they filled it in");
  } else if (!done) {
    parts.push("nobody has ever opened it");
    return parts.join(" · ");
  } else {
    // Finished without ever touching the wizard: an admin built it by hand.
    parts.push("set up for them");
  }

  if (state === "live") {
    parts.push(done ? `finished ${shortDate(done, now)}` : "finished");
    return parts.join(" · ");
  }
  if (state === "cancelled") return parts.join(" · ");

  const last = d(row.lastActivityAt);
  if (row.currentStepLabel) {
    parts.push(`stopped at “${row.currentStepLabel}”`);
  }
  if (last) parts.push(`last seen ${agoWords(last, now)}`);
  return parts.join(" · ");
}

export function buildInvitationRow(row: InvitationRowInput, now: Date = new Date()): InvitationRow {
  const { state, label } = decideState(row, now);
  const contactName = [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ").trim();
  const email = String(row.mainEmail ?? "").trim();
  return {
    id: row.id,
    companyName: String(row.companyName ?? "").trim(),
    contactName,
    mainEmail: email,
    publicPath: row.publicToken ? `/onboarding/${encodeURIComponent(row.publicToken)}` : null,
    status: row.status,
    state,
    stateLabel: label,
    storyLine: buildStoryLine(row, state, now),
    needsNudge: state === "not_opened" || state === "stalled",
    canResend: Boolean(email) && state !== "live" && state !== "cancelled",
    createdAt: iso(row.createdAt)!,
    openedAt: iso(row.openedAt),
    lastActivityAt: iso(row.lastActivityAt),
    inviteSentAt: iso(row.inviteSentAt),
    extensionCount: row.extensionCount,
    createdTenantId: row.createdTenantId,
  };
}

/** Counts for the filter chips, in the order the screen shows them. */
export function countByFilter(rows: InvitationRow[]): { all: number; nudge: number; inProgress: number; finished: number } {
  return {
    all: rows.length,
    nudge: rows.filter((r) => r.needsNudge).length,
    inProgress: rows.filter((r) => r.state === "in_progress" || r.state === "awaiting_payment" || r.state === "building").length,
    finished: rows.filter((r) => r.state === "live").length,
  };
}

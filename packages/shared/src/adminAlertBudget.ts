/**
 * How many alert emails Connect is allowed to send itself.
 *
 * ⛔ Admin alerts ride the SAME mailbox as customer email — invoices, invites,
 * and the phone system's voicemail-to-email all send as
 * support@connectcomunications.com. Google caps that mailbox at a fixed number
 * of messages per day. On 2026-08-06 the alerts ate the entire allowance (451
 * in 24 hours, all to one inbox) and every customer email for the rest of the
 * day was refused: 20 voicemail notifications and one invoice payment link
 * never reached anyone. Monitoring starved the product.
 *
 * So the budget is not a nicety — it is the thing that keeps customer mail
 * deliverable. Two rules, and BOTH matter:
 *
 *  1. A per-alert cooldown that SURVIVES A RESTART. The old cooldown lived in
 *     an in-memory Map. The API restarted 56 times that day (deploys), and
 *     every restart wiped the Map and re-armed every alert — which is why a
 *     six-hour cooldown still produced one message every twenty-five minutes.
 *     The caller must therefore read the last-send time from the DATABASE and
 *     pass it in here. An in-memory map is a fast path, never the authority.
 *  2. A hard daily ceiling across ALL alerts, whatever the key. Rule 1 assumes
 *     alerts repeat under a stable identity; a new alert whose text carries a
 *     changing number ("3 records failed", then "4 records failed") slips
 *     through it every time. The ceiling is what makes the guarantee hold
 *     anyway — no matter what any future caller does, alerts can consume only
 *     a bounded slice of the mailbox's day.
 *
 * Suppressing an alert is not the same as losing it: callers log every
 * suppression, so the information is still on the server. Only the email
 * is dropped.
 */

/** Default gap between two sends of the same alert. */
export const ADMIN_ALERT_DEFAULT_COOLDOWN_MS = 6 * 3600_000;

/**
 * Most alert emails allowed in any rolling 24 hours, across every alert key.
 *
 * Deliberately far below the mailbox's daily allowance: alerts get a small
 * slice, customer mail keeps the rest. If real alerting ever needs more than
 * this in a day, the answer is fewer/quieter alerts, not a bigger number —
 * an inbox that gets forty messages a day is already an inbox nobody reads.
 */
export const ADMIN_ALERT_DAILY_CAP = 40;

export type AdminAlertDecision =
  | { send: true }
  | { send: false; reason: "cooldown" | "daily_cap" };

export function decideAdminAlert(input: {
  /** Now, in epoch ms. */
  now: number;
  /**
   * When this same alert last went out, from durable storage — null if it
   * never has. ⛔ Reading this from memory is what failed in production.
   */
  lastSentAtMs: number | null;
  /** Gap required for this alert; falls back to the default when unset. */
  cooldownMs?: number;
  /** Alert emails already queued in the last 24 hours, all keys. */
  sentLast24h: number;
  /** Ceiling override, for tests and env tuning. */
  dailyCap?: number;
}): AdminAlertDecision {
  const cap = Number.isFinite(input.dailyCap as number) && (input.dailyCap as number) >= 0
    ? (input.dailyCap as number)
    : ADMIN_ALERT_DAILY_CAP;
  if (input.sentLast24h >= cap) return { send: false, reason: "daily_cap" };

  const cooldownMs = Number.isFinite(input.cooldownMs as number) && (input.cooldownMs as number) >= 0
    ? (input.cooldownMs as number)
    : ADMIN_ALERT_DEFAULT_COOLDOWN_MS;
  // A last-send stamp in the future (clock skew between api and worker) must
  // suppress, never send — the two processes share one mailbox budget.
  if (input.lastSentAtMs != null && input.now - input.lastSentAtMs < cooldownMs) {
    return { send: false, reason: "cooldown" };
  }
  return { send: true };
}

/**
 * The window the caller should look back over for both inputs above.
 * Exported so api and worker cannot drift to different windows.
 */
export const ADMIN_ALERT_DAILY_WINDOW_MS = 24 * 3600_000;

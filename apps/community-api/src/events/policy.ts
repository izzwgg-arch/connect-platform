/**
 * Pure decisions for the events domain. Routes fetch rows and call these —
 * never re-derive an RSVP/visibility rule inline (CONVENTIONS §3).
 */

export type AttendeeListVisibility = "PUBLIC" | "ATTENDEES" | "HOST";
export type RsvpStatus = "GOING" | "INTERESTED" | "NOT_GOING" | "WAITLIST";

/** PUBLIC = anyone; ATTENDEES = anyone with any RSVP row; HOST = host only. The host can always see it. */
export function canSeeAttendeeList(vis: AttendeeListVisibility | string, ctx: { isHost: boolean; hasRsvp: boolean }): boolean {
  if (ctx.isHost) return true;
  switch (vis) {
    case "PUBLIC":
      return true;
    case "ATTENDEES":
      return ctx.hasRsvp;
    case "HOST":
      return false;
    default:
      return true;
  }
}

/** Whether a GOING rsvp should actually land as GOING or spill to the waitlist. capacity=null means unlimited. */
export function rsvpOutcome(status: RsvpStatus, capacity: number | null, currentGoing: number, alreadyGoing: boolean): RsvpStatus {
  if (status !== "GOING") return status;
  if (capacity == null) return "GOING";
  const effectiveGoing = alreadyGoing ? currentGoing - 1 : currentGoing;
  return effectiveGoing < capacity ? "GOING" : "WAITLIST";
}

export function spotsLeft(capacity: number | null, goingCount: number): number | null {
  if (capacity == null) return null;
  return Math.max(0, capacity - goingCount);
}

/** Reminder fires 24h before the event starts. */
export function reminderAtFor(startsAt: Date): Date {
  return new Date(startsAt.getTime() - 24 * 3600 * 1000);
}

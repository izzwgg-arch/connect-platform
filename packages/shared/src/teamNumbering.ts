// ── Ring group / queue numbering ─────────────────────────────────────────────
//
// Izzy's rule (2026-08-03): new ring groups live in the 800s, new queues in the
// 900s. Take the first free number in that series; when a series runs out, add
// a digit — 800…809 then 8000…8009 then 80000…, and the same for 9.
//
// The subtlety that makes this worth its own tested module: the two series are
// NOT independent. On A plus center, 900 is already a RING GROUP called
// "Intercom" and their queue sits at 600 — so a naive "first free 9xx" that
// only looked at queues would hand out 900 and collide. "Free" has to mean
// free across everything that occupies the tenant's dial plan: extensions,
// ring groups and queues together.
//
// Existing objects do not follow the rule and are not touched; it applies to
// newly created ones only.

export type TeamKind = "ring_group" | "queue";

/** Numbers already in use anywhere in the tenant's dial plan. */
export interface UsedNumbers {
  extensions: string[];
  ringGroups: string[];
  queues: string[];
}

export const TEAM_SERIES_DIGIT: Record<TeamKind, "8" | "9"> = {
  ring_group: "8",
  queue: "9",
};

/**
 * Candidate numbers for a series, in the order they should be offered:
 * 800..809, then 8000..8099, then 80000..80999 — widening only when a whole
 * band is exhausted, so numbers stay as short as possible.
 */
export function* candidateNumbers(kind: TeamKind, maxWidth = 6): Generator<string> {
  const lead = TEAM_SERIES_DIGIT[kind];
  // Width 3 = lead + "0" + one digit (800-809). Each extra width adds a digit.
  for (let width = 3; width <= maxWidth; width++) {
    const tailLength = width - 2; // digits after the leading "<lead>0"
    const count = 10 ** tailLength;
    for (let i = 0; i < count; i++) {
      yield `${lead}0${String(i).padStart(tailLength, "0")}`;
    }
  }
}

/**
 * The number to give a new team. Returns null only if every candidate up to
 * `maxWidth` digits is taken, which cannot happen in practice — the caller
 * should still handle it rather than assume.
 */
export function nextTeamNumber(kind: TeamKind, used: UsedNumbers, maxWidth = 6): string | null {
  const taken = new Set<string>([
    ...(used.extensions ?? []),
    ...(used.ringGroups ?? []),
    ...(used.queues ?? []),
  ].map((n) => String(n ?? "").trim()).filter(Boolean));

  for (const candidate of candidateNumbers(kind, maxWidth)) {
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** Plain-English note for the UI, so the number doesn't look arbitrary. */
// ── Forwarding numbers ───────────────────────────────────────────────────────
// A "forward to a phone number" menu key is really an internal number that a
// Custom Application answers on, which hands the call to a Custom Destination
// that dials outside. Izzy reserved 2000–2099 for these (2026-08-06) so they
// never collide with real extensions and are obvious in the PBX panel.

export const FORWARD_RANGE_START = 2000;
export const FORWARD_RANGE_END = 2099;

/**
 * First free number in the forwarding range.
 *
 * `used` must include everything that occupies the tenant's dial plan, and
 * `existingForwards` the numbers already answered by Custom Applications —
 * those live in their own table and are invisible to the extension/ring
 * group/queue lists, so leaving them out would hand back a number that is
 * already forwarding somewhere.
 *
 * Returns null when the range is full; callers must refuse rather than reach
 * outside the reserved band.
 */
export function nextForwardExtension(used: UsedNumbers, existingForwards: string[] = []): string | null {
  const taken = new Set<string>(
    [
      ...(used.extensions ?? []),
      ...(used.ringGroups ?? []),
      ...(used.queues ?? []),
      ...existingForwards,
    ]
      .map((n) => String(n ?? "").trim())
      .filter(Boolean),
  );
  for (let n = FORWARD_RANGE_START; n <= FORWARD_RANGE_END; n++) {
    const c = String(n);
    if (!taken.has(c)) return c;
  }
  return null;
}

export function explainChosenNumber(kind: TeamKind, chosen: string, used: UsedNumbers): string {
  const lead = TEAM_SERIES_DIGIT[kind];
  const first = `${lead}00`;
  const what = kind === "ring_group" ? "Ring groups" : "Queues";
  if (chosen === first) return `${what} start at ${first}, and it's free.`;
  const taken = new Set([...(used.extensions ?? []), ...(used.ringGroups ?? []), ...(used.queues ?? [])].map(String));
  return taken.has(first)
    ? `${what} use the ${lead}00s. ${first} is already taken, so this is the next one free.`
    : `${what} use the ${lead}00s — this is the next one free.`;
}

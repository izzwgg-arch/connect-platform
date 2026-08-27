/**
 * "The account IS the phone number" — and people say it badly.
 *
 * Izzy, 2026-08-27: *"Most numbers start with 845-783, 845-782, 845-774,
 * 845-238, 845-662, and 718 as well. Sometimes they don't speak too clearly,
 * so they'd say 'it's 783' and the system picks it up as 780. The system
 * searches for the closest match. Obviously, check the number they're calling
 * from as well."*
 *
 * Two sources of truth, in this order of trust:
 *  1. THE NUMBER THEY CALLED FROM. Hard evidence — the call physically
 *     originated there. A spoken number one digit off from the caller ID is
 *     almost certainly the same number misheard.
 *  2. NUMBERS WE HAVE SERVED BEFORE. Our own submitted-order history is a
 *     list of real customers of THIS store; a spoken number one digit off
 *     from exactly one of them is very likely that customer.
 *
 * ⛔⛔ THE SAFETY RULE THAT SHAPES EVERYTHING HERE: an account carries CARDS
 * ON FILE and a house balance. Binding an order to the WRONG account can
 * charge the wrong person. So a CORRECTED number is never treated as
 * certain — it is returned as a correction the rep confirms, and an
 * AMBIGUOUS one picks nothing at all and hands over the candidates. Only an
 * exact agreement is confident.
 *
 * ⛔ Distance 1 ONLY, and only for 10-digit numbers. At distance 2 the
 * candidate space explodes and "closest match" starts inventing customers.
 */

import { posPhoneDigits } from "./posWithLogic";

/**
 * Damerau-Levenshtein, bounded — one substitution, insertion, deletion, or
 * ADJACENT TRANSPOSITION. The transposition case is the point: "783" heard
 * as "738" is a single slip, and plain Levenshtein scores it 2.
 */
export function digitDistance(a: string, b: string, cap = 2): number {
  const s = String(a ?? "");
  const t = String(b ?? "");
  if (s === t) return 0;
  if (Math.abs(s.length - t.length) > cap) return cap + 1;
  const prev2: number[] = [];
  let prev: number[] = [];
  let cur: number[] = [];
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        v = Math.min(v, (prev2[j - 2] ?? Infinity) + 1);
      }
      cur[j] = v;
    }
    prev2.length = 0;
    prev2.push(...prev);
    prev = cur;
  }
  return Math.min(prev[t.length], cap + 1);
}

export type PhoneVerdict = {
  /** The 10 digits to use, or "" when nothing usable was found. */
  phone: string;
  /**
   * stated     — they said it and it agrees with the caller ID or our records
   * caller_id  — nothing usable was spoken; the number they called from
   * corrected  — what they said was one digit off; ⛔ REP MUST CONFIRM
   * ambiguous  — several equally-close customers; nothing picked
   * unknown    — usable digits, but new to us
   */
  confidence: "stated" | "caller_id" | "corrected" | "ambiguous" | "unknown";
  /** What the transcription actually produced, when it differs from `phone`. */
  heard?: string;
  /** For corrected/ambiguous: the candidates, best first. */
  candidates?: string[];
  /** Plain English for the rep — this is what the desk shows. */
  note?: string;
};

/** ⛔ A corrected or ambiguous verdict must never silently bind an account. */
export function needsRepConfirmation(v: PhoneVerdict): boolean {
  return v.confidence === "corrected" || v.confidence === "ambiguous";
}

const fmt = (p: string) => (p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p);

/**
 * Decide which phone number an order belongs to. Pure — the caller supplies
 * the numbers we have served before.
 */
export function resolveCustomerPhone(input: {
  spoken?: string | null;
  callerId?: string | null;
  known?: string[];
}): PhoneVerdict {
  const spoken = posPhoneDigits(String(input.spoken ?? "")) ?? "";
  const caller = posPhoneDigits(String(input.callerId ?? "")) ?? "";
  const known = [...new Set((input.known ?? []).map((k) => posPhoneDigits(String(k)) ?? "").filter((k) => k.length === 10))];

  // Nothing usable was spoken → the number they called from.
  if (!spoken) {
    if (caller) return { phone: caller, confidence: "caller_id" };
    return { phone: "", confidence: "unknown" };
  }

  // They said the number they are calling from. The strongest agreement there is.
  if (caller && spoken === caller) return { phone: spoken, confidence: "stated" };

  // One slip away from the number the call physically came from. The caller ID
  // is hard evidence, so it wins — but a rep still confirms, because the other
  // reading is that they deliberately gave someone else's account.
  if (caller && digitDistance(spoken, caller, 1) === 1) {
    return {
      phone: caller,
      confidence: "corrected",
      heard: spoken,
      candidates: [caller],
      note: `Heard ${fmt(spoken)}, but the call came from ${fmt(caller)} — one digit apart. Using the number they called from.`,
    };
  }

  // A customer we have served before, said exactly.
  if (known.includes(spoken)) return { phone: spoken, confidence: "stated" };

  // Closest customer we have served before.
  const near = known.filter((k) => digitDistance(spoken, k, 1) === 1);
  if (near.length === 1) {
    return {
      phone: near[0],
      confidence: "corrected",
      heard: spoken,
      candidates: near,
      note: `Heard ${fmt(spoken)}, which is not a customer — ${fmt(near[0])} is one digit away and has ordered before.`,
    };
  }
  if (near.length > 1) {
    // ⛔ pick NOTHING. Several real customers are equally close, and guessing
    // between them is how an order lands on the wrong account.
    return {
      phone: caller || spoken,
      confidence: "ambiguous",
      heard: spoken,
      candidates: near.slice(0, 5),
      note: `Heard ${fmt(spoken)}, which is not a customer. ${near.length} customers are one digit away — please confirm which.`,
    };
  }

  // Usable, just new to us. Keep what they said; offer the caller ID.
  return {
    phone: spoken,
    confidence: "unknown",
    ...(caller && caller !== spoken
      ? { candidates: [caller], note: `No order history for ${fmt(spoken)}. They are calling from ${fmt(caller)}.` }
      : {}),
  };
}

/**
 * The numbers this store has served before — from our OWN submitted orders.
 * ⛔ SUBMITTED only: a draft that was never put through may itself carry the
 * mis-heard number this function exists to correct, and feeding those back in
 * would teach the mistake.
 */
export async function knownCustomerPhones(db: any, tenantId: string, limit = 4000): Promise<string[]> {
  try {
    const rows = await db.supermarketOrderDraft.findMany({
      where: { tenantId, status: "SUBMITTED" },
      select: { customerPhone: true },
      orderBy: { submittedAt: "desc" },
      take: limit,
    });
    const out = new Set<string>();
    for (const r of Array.isArray(rows) ? rows : []) {
      const p = posPhoneDigits(String(r?.customerPhone ?? ""));
      if (p) out.add(p);
    }
    return [...out];
  } catch {
    // history is an upgrade, never a gate — no history just means no correction
    return [];
  }
}

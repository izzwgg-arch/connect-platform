/**
 * Minimal per-AOR contact registry — the ONLY new state introduced for the
 * Mode-B cold-answer fix (2026-06-29).
 *
 * Asterisk already streams `ContactStatus` AMI events (one per PJSIP contact
 * register / qualify / removal). Nothing persisted them, so there was no way to
 * answer the single question the Mode-B requeue needs:
 *
 *   "At `invite_accept` time, has a contact for this extension's AOR registered
 *    AFTER the (stale) extension leg was dialed, that is NOT one of the contacts
 *    the leg was actually dialed to?"
 *
 * Proven Mode-B failure (prod APK call 1782764578.146922, ext 110 / AOR
 * T2_110_1): the leg was forked to two pre-existing contacts; the swiped app
 * re-registered a brand-new contact ~13s after the dial; the requeue was blocked
 * by `extension_leg_already_live`; the fresh contact never got an INVITE. JsSIP
 * rotates the Contact URI on every register, and the stale blocking contact
 * stayed `Reachable` the whole time — so neither URI-equality nor qualify state
 * can discriminate. The reliable signal is "registered AFTER the dial AND not in
 * the dialed set", which is exactly what this registry answers.
 *
 * This is deliberately tiny: a bounded URI→firstSeen map per AOR, fed only by
 * the existing ContactStatus handler. It holds no call state and is not durable.
 */

/**
 * Normalize a SIP contact URI to a stable comparison key: drop everything from
 * the first `;` (transport/ob/x-ast-orig-host params reorder between the dial
 * string and the ContactStatus event) and l-case. Keeps `sip:user@host:port`.
 */
export function normalizeContactUri(uri: string | null | undefined): string {
  const raw = String(uri ?? "").trim();
  if (!raw) return "";
  const semi = raw.indexOf(";");
  const core = semi === -1 ? raw : raw.slice(0, semi);
  return core.trim().toLowerCase();
}

export class AorContactRegistry {
  /** aor → (normalizedContactUri → firstSeenAtMs). */
  private readonly byAor = new Map<string, Map<string, number>>();
  /** Defensive bound so a churning AOR can never grow unbounded. */
  private static readonly MAX_PER_AOR = 16;

  /**
   * Record a ContactStatus observation. `present` states set the first-seen
   * (registration) time once and never bump it on re-qualify, so a desk phone's
   * periodic re-qualify of an existing URI cannot masquerade as a fresh
   * registration. `gone` states remove the URI.
   */
  record(aor: string, uri: string, status: string, atMs: number): void {
    const a = String(aor ?? "").trim();
    const key = normalizeContactUri(uri);
    if (!a || !key) return;
    const s = String(status ?? "").trim().toLowerCase();
    const gone =
      s === "removed" || s === "deleted" || s === "unreachable" || s === "unregistered";
    if (gone) {
      const m = this.byAor.get(a);
      if (m) {
        m.delete(key);
        if (m.size === 0) this.byAor.delete(a);
      }
      return;
    }
    const present =
      s === "reachable" ||
      s === "nonqualified" ||
      s === "non-qualified" ||
      s === "created" ||
      s === "unknown" ||
      s === "available";
    if (!present) return;
    let m = this.byAor.get(a);
    if (!m) {
      m = new Map();
      this.byAor.set(a, m);
    }
    if (!m.has(key)) m.set(key, atMs);
    if (m.size > AorContactRegistry.MAX_PER_AOR) {
      let oldestKey: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [k, t] of m) {
        if (t < oldest) {
          oldest = t;
          oldestKey = k;
        }
      }
      if (oldestKey) m.delete(oldestKey);
    }
  }

  /**
   * Return the URI of a contact for `aor` that registered strictly AFTER
   * `sinceMs` and is NOT among `dialedUris` (the contacts the stale leg was
   * actually dialed to), or `null` if none. This is the Mode-B "fresh contact"
   * test (conditions 4 + 5).
   */
  freshContactNotDialed(
    aor: string,
    sinceMs: number,
    dialedUris: Iterable<string>,
  ): string | null {
    const m = this.byAor.get(String(aor ?? "").trim());
    if (!m) return null;
    const dialed = new Set<string>();
    for (const d of dialedUris) {
      const k = normalizeContactUri(d);
      if (k) dialed.add(k);
    }
    for (const [uri, at] of m) {
      if (at > sinceMs && !dialed.has(uri)) return uri;
    }
    return null;
  }

  /**
   * Read-only diagnostic snapshot of the currently-tracked contacts for an AOR
   * (normalized URI + first-seen/registration time). Used only for logging.
   */
  snapshot(aor: string): { uri: string; firstSeenAt: number }[] {
    const m = this.byAor.get(String(aor ?? "").trim());
    if (!m) return [];
    return Array.from(m, ([uri, firstSeenAt]) => ({ uri, firstSeenAt }));
  }
}

// ── Per-call message ordering for the /ws/telephony feed (2026-08-31) ───────
//
// The telephony server broadcasts `telephony.call.remove` synchronously at
// hangup, but `telephony.call.upsert` may be delivered LATE (it can ride an
// async CRM-enrichment round-trip server-side). Before this tracker existed, a
// stale upsert arriving after the remove re-inserted the dead call into the
// client map — and nothing corrected it until the server's next sweep, which is
// exactly the "somebody hung up and Active Calls / Team Directory kept showing
// On Call for up to a minute" complaint.
//
// The server stamps every call message with a per-call monotonic `seq`
// (assigned synchronously at emit time). This tracker remembers the highest
// seq applied per call — INCLUDING after a remove (the tombstone) — and
// refuses any upsert that is provably older than what was already applied.
//
// ⛔ A message with NO seq (an older server build) is always accepted — the
// tracker must never make the client stricter than the server it talks to.
// ⛔ Removes are always applied (they are sent synchronously server-side, so a
// remove can never be the stale message); their seq is only RECORDED so a
// later stale upsert is refused.
// ⛔ reset() must be called on every snapshot: a snapshot means a (re)connect,
// and a restarted server restarts its seq counters at 1 — stale high-water
// marks from the previous process would silently drop every new message.

export interface CallSeqTracker {
  /** True ⇒ apply the upsert; false ⇒ drop it (provably stale). */
  acceptUpsert(callId: string, seq: unknown): boolean;
  /** Record a remove's seq so later stale upserts for this call are refused. */
  noteRemove(callId: string, seq: unknown): void;
  /** Forget everything (call on every snapshot / reconnect). */
  reset(): void;
  /** Test-only visibility. */
  size(): number;
}

function asSeq(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createCallSeqTracker(cap = 2000): CallSeqTracker {
  const seqs = new Map<string, number>();

  const record = (callId: string, seq: number) => {
    if (!seqs.has(callId) && seqs.size >= cap) {
      // Map iterates in insertion order — drop the oldest tombstones first.
      const oldest = seqs.keys().next();
      if (!oldest.done) seqs.delete(oldest.value);
    }
    seqs.set(callId, seq);
  };

  return {
    acceptUpsert(callId: string, rawSeq: unknown): boolean {
      const seq = asSeq(rawSeq);
      if (seq === null) return true; // old server: no ordering information
      const last = seqs.get(callId);
      if (last !== undefined && seq <= last) return false;
      record(callId, seq);
      return true;
    },
    noteRemove(callId: string, rawSeq: unknown): void {
      const seq = asSeq(rawSeq);
      if (seq === null) return;
      const last = seqs.get(callId);
      if (last === undefined || seq > last) record(callId, seq);
    },
    reset(): void {
      seqs.clear();
    },
    size(): number {
      return seqs.size;
    },
  };
}

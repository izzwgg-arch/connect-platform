// Driver offline operation queue + sync reducer — PURE, dependency-free (no RN, no I/O).
// This is the correctness core of offline-first driver work: every mutating action
// (scan, status change, arrival, proof, exception) is queued with a client op id and
// synced idempotently. Conflicts surface to the driver rather than silently overwriting.
//
// Design ref: Gate 3 §06 (offline & conflicts), Phase 4 (sync engine).

export type OpKind = "scan" | "status" | "arrive" | "proof" | "exception";

export type OpState = "pending" | "syncing" | "synced" | "failed" | "conflict";

export interface QueuedOp {
  /** Client operation id — the idempotency anchor. Server dedupes on this. */
  opId: string;
  kind: OpKind;
  payload: Record<string, unknown>;
  createdAt: number; // ms epoch (caller supplies; keeps this module pure)
  state: OpState;
  attempts: number;
  error?: string;
}

export interface SyncResult {
  opId: string;
  ok: boolean;
  /** Server says this op conflicts with newer server state — needs driver attention. */
  conflict?: boolean;
  error?: string;
}

export const DEFAULT_MAX_ATTEMPTS = 5;

export function makeOp(kind: OpKind, payload: Record<string, unknown>, opId: string, now: number): QueuedOp {
  return { opId, kind, payload, createdAt: now, state: "pending", attempts: 0 };
}

/** Add an op, deduping by opId (idempotent — a repeat enqueue is a no-op). */
export function enqueue(queue: QueuedOp[], op: QueuedOp): QueuedOp[] {
  if (queue.some((q) => q.opId === op.opId)) return queue;
  return [...queue, op];
}

/** FIFO list of ops eligible to sync now: pending, or failed under the retry cap. */
export function syncableOps(queue: QueuedOp[], maxAttempts = DEFAULT_MAX_ATTEMPTS): QueuedOp[] {
  return queue
    .filter((q) => q.state === "pending" || (q.state === "failed" && q.attempts < maxAttempts))
    .sort((a, b) => (a.createdAt - b.createdAt) || a.opId.localeCompare(b.opId));
}

/** Mark ops as in-flight before sending. */
export function markSyncing(queue: QueuedOp[], opIds: string[]): QueuedOp[] {
  const set = new Set(opIds);
  return queue.map((q) => (set.has(q.opId) && q.state !== "synced" && q.state !== "conflict" ? { ...q, state: "syncing" } : q));
}

/** Apply one sync result. Idempotent and total: unknown opIds are ignored. */
export function applyResult(queue: QueuedOp[], result: SyncResult): QueuedOp[] {
  return queue.map((q) => {
    if (q.opId !== result.opId) return q;
    if (q.state === "synced") return q; // already done — never regress
    if (result.ok) return { ...q, state: "synced", error: undefined };
    if (result.conflict) return { ...q, state: "conflict", error: result.error || "conflict" };
    return { ...q, state: "failed", attempts: q.attempts + 1, error: result.error || "failed" };
  });
}

export function applyResults(queue: QueuedOp[], results: SyncResult[]): QueuedOp[] {
  return results.reduce(applyResult, queue);
}

/** Ops still needing to reach the server (anything not synced). */
export function unsyncedCount(queue: QueuedOp[]): number {
  return queue.filter((q) => q.state !== "synced").length;
}

/** Ops that need driver intervention (conflicts, or failed past the cap). */
export function blockedOps(queue: QueuedOp[], maxAttempts = DEFAULT_MAX_ATTEMPTS): QueuedOp[] {
  return queue.filter((q) => q.state === "conflict" || (q.state === "failed" && q.attempts >= maxAttempts));
}

/** Drop synced ops older than `keepMs`, keeping recent ones for UI confirmation. */
export function pruneSynced(queue: QueuedOp[], now: number, keepMs = 5 * 60_000): QueuedOp[] {
  return queue.filter((q) => q.state !== "synced" || now - q.createdAt < keepMs);
}

/** Reset a blocked op to pending after the driver acknowledges/resolves it. */
export function retryOp(queue: QueuedOp[], opId: string): QueuedOp[] {
  return queue.map((q) => (q.opId === opId && (q.state === "failed" || q.state === "conflict") ? { ...q, state: "pending", attempts: 0, error: undefined } : q));
}

export function serialize(queue: QueuedOp[]): string {
  return JSON.stringify(queue);
}

export function deserialize(raw: string | null | undefined): QueuedOp[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Reset any ops stuck "syncing" from a killed session back to pending.
    return parsed
      .filter((o) => o && typeof o.opId === "string" && typeof o.kind === "string")
      .map((o) => ({ ...o, state: o.state === "syncing" ? "pending" : o.state }));
  } catch {
    return [];
  }
}

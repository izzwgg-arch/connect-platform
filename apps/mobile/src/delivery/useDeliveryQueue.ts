// Offline queue controller hook. Binds the pure queue (offlineQueue.ts) to persistence
// (queueStorage.ts) and the network (deliveryClient.ts). Server remains authoritative.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  makeOp, enqueue, syncableOps, markSyncing, applyResult, unsyncedCount, blockedOps, retryOp, pruneSynced,
  type QueuedOp, type OpKind,
} from "./offlineQueue";
import { loadQueue, saveQueue } from "./queueStorage";
import { syncOp } from "./deliveryClient";

function genOpId(): string {
  return `op_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function useDeliveryQueue(authToken: string | null) {
  const [queue, setQueue] = useState<QueuedOp[]>([]);
  const [flushing, setFlushing] = useState(false);
  const queueRef = useRef<QueuedOp[]>([]);
  queueRef.current = queue;

  // Load persisted queue once.
  useEffect(() => {
    let alive = true;
    loadQueue().then((q) => {
      if (alive) setQueue(pruneSynced(q, Date.now()));
    });
    return () => {
      alive = false;
    };
  }, []);

  // Persist on change.
  useEffect(() => {
    saveQueue(queue);
  }, [queue]);

  const enqueueOp = useCallback((kind: OpKind, payload: Record<string, unknown>): string => {
    const opId = genOpId();
    setQueue((q) => enqueue(q, makeOp(kind, payload, opId, Date.now())));
    return opId;
  }, []);

  /** Convenience for the scan screen. Returns the clientOpId used. */
  const enqueueScan = useCallback(
    (labelToken: string, confirmReassign = false): string =>
      enqueueOp("scan", { token: labelToken, clientOpId: "", confirmReassign }),
    [enqueueOp],
  );

  const flush = useCallback(async () => {
    if (!authToken || flushing) return;
    const eligible = syncableOps(queueRef.current);
    if (eligible.length === 0) return;
    setFlushing(true);
    setQueue((q) => markSyncing(q, eligible.map((o) => o.opId)));
    try {
      for (const op of eligible) {
        // The clientOpId sent to the server IS the queue opId (idempotency anchor).
        const opWithId: QueuedOp = { ...op, payload: { ...op.payload, clientOpId: op.opId } };
        const result = await syncOp(authToken, opWithId);
        if (result) setQueue((q) => applyResult(q, result));
        else setQueue((q) => q.map((x) => (x.opId === op.opId ? { ...x, state: "pending" } : x))); // hold
      }
    } finally {
      setFlushing(false);
    }
  }, [authToken, flushing]);

  const retry = useCallback((opId: string) => setQueue((q) => retryOp(q, opId)), []);

  return {
    queue,
    flushing,
    enqueueOp,
    enqueueScan,
    flush,
    retry,
    unsyncedCount: unsyncedCount(queue),
    blocked: blockedOps(queue),
  };
}

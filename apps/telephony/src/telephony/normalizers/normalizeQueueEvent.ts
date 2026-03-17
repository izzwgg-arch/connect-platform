import type { NormalizedQueueState } from "../types";

export function normalizeQueueForClient(q: NormalizedQueueState): NormalizedQueueState {
  return { ...q, members: [...q.members] };
}

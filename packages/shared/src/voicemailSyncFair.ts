/**
 * Fair scheduling for PBX voicemail helper (spool) fallback when many tenant mailboxes
 * share a global per-cycle safety cap. Interleaves tenants round-robin style so one
 * heavy tenant cannot starve others; a rotating cursor ensures every mailbox is
 * reached within a bounded number of cycles.
 */

export type VoicemailHelperFairSlot = {
  tenantId: string;
  extNumber: string;
};

/** Round-robin interleave across tenants: T1e1, T2e1, T3e1, T1e2, T2e2, … */
export function interleaveVoicemailHelperSlots<T extends VoicemailHelperFairSlot>(byTenant: Map<string, T[]>): T[] {
  const tids = [...byTenant.keys()].sort((a, b) => a.localeCompare(b));
  const arrs = tids.map((t) => [...(byTenant.get(t) ?? [])]);
  for (const arr of arrs) {
    arr.sort((a, b) => a.extNumber.localeCompare(b.extNumber, undefined, { numeric: true }));
  }
  const out: T[] = [];
  let round = 0;
  for (;;) {
    let added = false;
    for (let i = 0; i < arrs.length; i++) {
      const arr = arrs[i]!;
      if (arr.length > round) {
        out.push(arr[round]!);
        added = true;
      }
    }
    if (!added) break;
    round++;
  }
  return out;
}

/**
 * Walk the interleaved ring from `startIndex`, taking up to `maxPicks` distinct mailboxes
 * (by keyFn). Never schedules the same mailbox twice in one cycle. `nextStartIndex` is
 * where the next cycle should resume so rotation continues across sync runs.
 */
export function selectDistinctFairHelperPicks<T>(
  interleaved: T[],
  maxPicks: number,
  startIndex: number,
  keyFn: (t: T) => string,
): { picks: T[]; nextStartIndex: number } {
  if (interleaved.length === 0 || maxPicks <= 0) {
    return { picks: [], nextStartIndex: 0 };
  }
  const len = interleaved.length;
  const picks: T[] = [];
  const seen = new Set<string>();
  let pos = ((startIndex % len) + len) % len;
  let guard = 0;
  const maxGuard = len * Math.max(maxPicks, 1) + len;

  while (picks.length < maxPicks && guard < maxGuard) {
    const item = interleaved[pos % len]!;
    const k = keyFn(item);
    pos++;
    guard++;
    if (seen.has(k)) continue;
    seen.add(k);
    picks.push(item);
  }

  return { picks, nextStartIndex: pos % len };
}

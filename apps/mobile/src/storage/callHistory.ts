/**
 * Local call history storage (AsyncStorage).
 *
 * The mobile app saves every outbound/inbound call here the moment it ends.
 * This gives instant, reliable call history that does not depend on server-side
 * CDR ingest timing.
 *
 * Records are prepended (newest first) and capped at MAX_RECORDS.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CallRecord } from "../types";

const HISTORY_KEY = "cc_mobile_call_history_v2";
const MAX_RECORDS = 150;

export async function loadLocalCallHistory(): Promise<CallRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CallRecord[]) : [];
  } catch {
    return [];
  }
}

export async function appendCallRecord(record: CallRecord): Promise<void> {
  try {
    const existing = await loadLocalCallHistory();
    // Deduplicate: skip if we already have a record with the same id
    if (existing.some((r) => r.id === record.id)) return;
    const updated = [record, ...existing].slice(0, MAX_RECORDS);
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {
    // Non-fatal — history loss acceptable
  }
}

export async function clearLocalCallHistory(): Promise<void> {
  await AsyncStorage.removeItem(HISTORY_KEY).catch(() => {});
}

/**
 * Merge remote (API) records with local (device) records.
 * Remote records are authoritative; local records that don't overlap
 * with any remote record (within 90s of the same call start time) are appended.
 */
export function mergeCallRecords(
  remote: CallRecord[],
  local: CallRecord[],
): CallRecord[] {
  // "Answered on another device" is a signal only THIS device knows (it saw
  // the call get answered away from it while ringing). The server's record
  // for the same call is usually "missed". When a local answered_elsewhere
  // record overlaps a remote record, promote the remote record's disposition
  // so Recent shows the accurate label instead of a red Missed.
  const merged = remote.map((r) => {
    const rt = new Date(r.startedAt).getTime();
    const overlap = local.find(
      (l) =>
        (l.disposition || '').toLowerCase() === 'answered_elsewhere' &&
        Math.abs(new Date(l.startedAt).getTime() - rt) < 90_000,
    );
    return overlap ? { ...r, disposition: 'answered_elsewhere' } : r;
  });

  const mergedMs = merged.map((r) => new Date(r.startedAt).getTime());

  const uniqueLocal = local.filter((l) => {
    const lt = new Date(l.startedAt).getTime();
    return !mergedMs.some((rt) => Math.abs(lt - rt) < 90_000);
  });

  return [...merged, ...uniqueLocal].sort(
    (a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}

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
    const rid = (r.linkedId || '').trim();
    // linkedId is exact; the ±90s window stays as the fallback for records that
    // predate linkedId or arrive without one. Matching on the id first also
    // makes the promotion work when the local record's startedAt is the
    // push-received time rather than the call's real start.
    const overlapping = local.filter((l) => {
      const lid = (l.linkedId || '').trim();
      if (rid && lid) return lid === rid;
      return Math.abs(new Date(l.startedAt).getTime() - rt) < 90_000;
    });
    const hasLocal = (disp: string) =>
      overlapping.some((l) => (l.disposition || '').toLowerCase() === disp);
    if (hasLocal('answered_elsewhere')) {
      return { ...r, disposition: 'answered_elsewhere' };
    }
    // HARDENED promotion (Izzy 2026-07-29): the live answered-elsewhere signal
    // races the PBX CANCEL and is often missed. The race-free variant: this
    // device logged that its ring ended WITHOUT it answering
    // ('ring_ended_unanswered', stamped by the SIP-cancel bridge), and the
    // SERVER — the authority — says the call was answered. Someone else must
    // have answered it. Never applies when this device answered (its own
    // answered record overlaps and wins), and never flips missed/voicemail
    // calls (server disposition isn't "answered" there).
    if (
      (r.disposition || '').toLowerCase() === 'answered' &&
      hasLocal('ring_ended_unanswered') &&
      !hasLocal('answered') &&
      !hasLocal('incoming')
    ) {
      return { ...r, disposition: 'answered_elsewhere' };
    }
    return r;
  });

  const mergedMs = merged.map((r) => new Date(r.startedAt).getTime());
  const mergedLinkedIds = new Set(
    merged.map((r) => (r.linkedId || '').trim()).filter((x) => x.length > 0),
  );

  const uniqueLocal = local.filter((l) => {
    // Match on linkedId FIRST — it is the PBX's exact call identifier and both
    // sides carry it. The old timestamp-only match (±90s) was the whole bug
    // behind the "Unknown" phantom row (Izzy 2026-07-31, screenshot):
    //
    //   A call rings the app AND a parallel/virtual extension on the real
    //   phone. The user answers on the phone, so this device writes a local
    //   `answered_elsewhere` record. That record's caller is BLANK, because the
    //   wake push is deliberately caller-less (INCOMING_CALL_WAKE carries no
    //   fromNumber) — and its startedAt is the push-received time, which can
    //   sit well outside 90s of the server's call start. No overlap was found,
    //   so the blank record was appended as a standalone row rendering as
    //   "Unknown" with no number and no name, while the SERVER record for the
    //   very same call (which has both) sat right next to it.
    const lid = (l.linkedId || '').trim();
    if (lid && mergedLinkedIds.has(lid)) return false;

    const lt = new Date(l.startedAt).getTime();
    if (mergedMs.some((rt) => Math.abs(lt - rt) < 90_000)) return false;

    // Signal-only records must never surface on their own. A local record with
    // no caller number AND no caller name carries nothing a human can act on —
    // it exists purely to colour a server record's disposition. If we get here
    // its server twin has not arrived yet (CDR ingest lags 20-60s); drop it and
    // let the next refresh show the real row rather than a phantom "Unknown".
    const hasCaller = Boolean((l.fromNumber || '').trim() || (l.fromName || '').trim());
    if (!hasCaller) return false;

    return true;
  });

  return [...merged, ...uniqueLocal].sort(
    (a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}

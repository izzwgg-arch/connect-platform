/**
 * Whether Connect may offer a call recording, and when it may conclude one does
 * not exist.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * ConnectCdr.recordingPath is captured from the AMI VarSet of __REC_FILENAME /
 * MIXMONITOR_FILENAME. VitalPBX sets that variable on calls it then does NOT
 * record — it is the name the file WOULD have carried — so a stored path proves
 * intent, never existence. Measured on Trust Bookkeeping 2026-08-11: 69 calls
 * advertised a recording that day and 38 files existed. A customer clicked four
 * dead buttons in eight minutes on 2026-08-04 and reported that recordings were
 * broken; he was right about the symptom and the cause was ours.
 *
 * The dangerous direction of this fix is the opposite one: wrongly concluding
 * "no recording" HIDES a recording the customer actually has. Both predicates
 * below therefore fail towards showing the recording, and both are unit-tested,
 * because the failure they guard against is silent — a hidden recording looks
 * exactly like a call that was never recorded.
 */

/** The minimum a caller must know about a CDR row to decide offerability. */
export interface RecordingRow {
  recordingPath?: string | null;
  recordingMissingAt?: Date | string | null;
}

/**
 * True when Connect should show a play/download control for this call.
 *
 * Requires BOTH a stored path AND no confirmed absence. Anything else — a row
 * we have never checked, a row whose check was inconclusive — still counts as
 * offerable, so we never hide audio on a guess.
 */
export function isRecordingOfferable(row: RecordingRow | null | undefined): boolean {
  if (!row) return false;
  const path = typeof row.recordingPath === "string" ? row.recordingPath.trim() : "";
  if (path.length === 0) return false;
  return !row.recordingMissingAt;
}

export interface MissingDecisionInput {
  /** HTTP status the PBX returned for the stored path. */
  pbxStatus: number;
  /** Did the VitalPBX-CDR recovery lookup find a working alternative file? */
  recovered: boolean;
}

/**
 * True only when the PBX has PROVEN the call has no audio: it 404'd the stored
 * path and its own CDR offered no other recfile that fetches.
 *
 * ⛔ A 5xx, a timeout, an auth failure or an unreachable PBX must never reach
 * here as `true`. Those mean "cannot tell", and hiding a customer's recordings
 * because the PBX had a bad minute is a far worse bug than the one being fixed.
 */
export function shouldMarkRecordingMissing(input: MissingDecisionInput): boolean {
  if (input.recovered) return false;
  return input.pbxStatus === 404;
}

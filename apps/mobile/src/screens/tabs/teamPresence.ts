import type { LiveTelephonyState } from '../../api/realtime';
import type { LiveCall, TeamDirectoryMember, TeamPresence } from '../../types';

/**
 * Does a live call involve this extension? Uses only the authoritative
 * `extensions[]` list the telephony service attaches to each call — NOT a
 * fuzzy from/to/connectedLine match, which previously flagged the wrong
 * person as "on a call" (e.g. when a DID or short code looked like an
 * extension number).
 */
export function callInvolvesExtension(call: LiveCall, extension: string, tenantId?: string | null): boolean {
  const belongsToTenant = !tenantId || !call.tenantId || call.tenantId === tenantId;
  if (!belongsToTenant) return false;
  return (call.extensions || []).includes(extension);
}

/**
 * Real-time presence for a team member.
 *
 * ⛔ LIVE CALLS ARE THE ONLY SOURCE OF "On Call" / "Ringing" (2026-08-31) —
 * the same rule the web Team Directory has always enforced
 * (apps/portal/services/liveCallState.ts presenceFromLiveCalls). This used to
 * OR in the raw Asterisk BLF hint (`inuse`/`busy`/`onhold`), and a hint that
 * went stale at hangup (missed/late AMI ExtensionStatus) kept the member
 * stuck at "On Call" until the telephony service's 3-MINUTE presence re-sync
 * sweep — the "they hung up and mobile showed On Call for minutes" complaint.
 * The hangup's `telephony.call.remove` arrives instantly on this same socket,
 * so the live-call map is exact; a busy-shaped hint with NO matching live
 * call is treated as stale and shown as Available. ⛔ Never OR the hint back
 * in as an independent on-call/ringing signal.
 *
 * The hint still decides available-vs-offline (registration), which live
 * calls cannot answer.
 */
export function livePresence(member: TeamDirectoryMember, live: LiveTelephonyState | null): TeamPresence {
  if (!live) return member.presence;

  let onCall = false;
  let ringing = false;
  for (const call of live.calls.values()) {
    if (!callInvolvesExtension(call, member.extension, member.tenantId)) continue;
    if (call.state === 'ringing' || call.state === 'dialing') ringing = true;
    else if (call.state === 'up' || call.state === 'held') onCall = true;
  }

  if (ringing) return 'ringing';
  if (onCall) return 'on_call';

  const direct = [...live.extensions.values()].find((ext) =>
    ext.extension === member.extension && (!member.tenantId || !ext.tenantId || ext.tenantId === member.tenantId),
  );
  const hint = String(direct?.status || '').trim().toLowerCase();

  // Registered / idle → Available. A busy/ringing-shaped hint with no live
  // call backing it is a stale lamp, not a call — show Available so mobile
  // agrees with Active Calls and the web Team Directory.
  if (hint === 'idle' || hint === 'inuse' || hint === 'busy' || hint === 'onhold' || hint === 'ringing') {
    return 'available';
  }
  return 'offline';
}

// Pure leg-classification helpers for CRM Voicemail Drop.
//
// Channel-naming evidence (docs/pbx-brain/, verified 2026-06-09):
//   • Agent / extension leg:  PJSIP/T<tenantId>_<ext>-<hex>   e.g. PJSIP/T3_302-00000a93
//   • Customer / PSTN trunk leg: PJSIP/<trunkDigits>_<name>-<hex>
//        e.g. PJSIP/344022_Vaddb-00000a93  (trunk endpoints are "<digits>_<name>")
//   • Local/Message channels are internal plumbing, never the drop target.
//
// Voicemail Drop must Redirect the CUSTOMER leg into [connect-vm-drop] and
// Hang up the AGENT leg. This module is pure (no I/O) so it is unit-testable
// and carries no behavior risk on its own.

const LOCAL_OR_MESSAGE = /^(Local|Message)\//i;
const AGENT_LEG = /^PJSIP\/T\d+_\d+/i;
const TRUNK_LEG = /^PJSIP\/\d+_/i;

export interface VoicemailDropLegs {
  /** Channel name of the customer/PSTN leg to redirect into [connect-vm-drop]. */
  customerLeg: string | null;
  /** Channel name of the agent leg to hang up after the redirect. */
  agentLeg: string | null;
}

function playable(channels: string[]): string[] {
  return channels.filter((c) => typeof c === "string" && c.length > 0 && !LOCAL_OR_MESSAGE.test(c));
}

/** True when the channel name looks like a tenant agent/extension endpoint. */
export function isAgentLeg(channel: string): boolean {
  return AGENT_LEG.test(channel);
}

/** True when the channel name looks like a PSTN/trunk endpoint. */
export function isTrunkLeg(channel: string): boolean {
  return TRUNK_LEG.test(channel) && !AGENT_LEG.test(channel);
}

/**
 * Classify the customer (PSTN) and agent legs of an active call.
 *
 * @param channels       All channel NAMES attached to the call (CallStateStore).
 * @param agentEndpoint  Optional hint for the initiating agent's endpoint, e.g.
 *                       "T3_302" or "PJSIP/T3_302-...". When supplied, the agent
 *                       leg matching it is preferred and is never chosen as the
 *                       customer leg (protects internal ext-to-ext calls).
 */
export function classifyVoicemailDropLegs(channels: string[], agentEndpoint?: string | null): VoicemailDropLegs {
  const list = playable(channels);
  if (list.length === 0) return { customerLeg: null, agentLeg: null };

  const hint = normalizeEndpointHint(agentEndpoint);
  const agentByHint = hint ? list.find((c) => channelMatchesEndpoint(c, hint)) ?? null : null;
  const agentLeg = agentByHint ?? list.find(isAgentLeg) ?? null;

  // Customer leg: a real trunk first; otherwise the first playable channel that
  // is not the agent leg (covers builds where the far end isn't a "<digits>_"
  // trunk, e.g. another PJSIP endpoint), never the agent leg itself.
  const trunk = list.find(isTrunkLeg) ?? null;
  const customerLeg = trunk ?? list.find((c) => c !== agentLeg) ?? null;

  return { customerLeg, agentLeg };
}

function normalizeEndpointHint(hint?: string | null): string | null {
  if (!hint) return null;
  const trimmed = hint.trim();
  if (!trimmed) return null;
  // Accept "PJSIP/T3_302-00000a93", "PJSIP/T3_302", or "T3_302" → "T3_302".
  const noScheme = trimmed.replace(/^PJSIP\//i, "");
  const noSuffix = noScheme.replace(/-[0-9a-f]+$/i, "");
  return noSuffix || null;
}

function channelMatchesEndpoint(channel: string, endpoint: string): boolean {
  const base = channel.replace(/^PJSIP\//i, "").replace(/-[0-9a-f]+$/i, "");
  return base.toLowerCase() === endpoint.toLowerCase();
}

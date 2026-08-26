/**
 * Parse the dialplan's `UserEvent(ConnectVoiceAgent, ...)` announcement.
 *
 * Why a UserEvent: the AudioSocket protocol carries ONLY a UUID, so the
 * dialplan tells telephony — over the AMI lane that already exists — which
 * tenant/DID/caller that UUID belongs to, moments before the TCP connection
 * arrives. Same non-blocking announcement pattern as ConnectWake: nothing on
 * the call path ever waits on HTTP.
 *
 * Asterisk renders `UserEvent(ConnectVoiceAgent,UUID: x,Tenant: y,...)` as a
 * frame with `Event: UserEvent`, `UserEvent: ConnectVoiceAgent`, and one
 * header per pair. Pure — unit-tested directly.
 */

export interface VoiceAgentAnnouncement {
  /** The AudioSocket session UUID (lowercased canonical form). */
  uuid: string;
  /** PBX tenant number (e.g. "102") — resolved to a Connect tenant by the api. */
  pbxTenant: string;
  /** DID the call arrived on, when the dialplan knows it. */
  did: string | null;
  /** Caller's number as the PBX saw it. */
  callerNumber: string | null;
}

export type AmiFrameLike = Record<string, string | undefined>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseVoiceAgentAnnouncement(frame: AmiFrameLike): VoiceAgentAnnouncement | null {
  if (frame["Event"] !== "UserEvent") return null;
  if (frame["UserEvent"] !== "ConnectVoiceAgent") return null;
  const uuid = (frame["UUID"] ?? "").trim().toLowerCase();
  const pbxTenant = (frame["Tenant"] ?? "").trim();
  if (!UUID_RE.test(uuid)) return null;
  if (!pbxTenant || !/^[0-9]{1,6}$/.test(pbxTenant)) return null;
  const did = (frame["Did"] ?? "").trim();
  const caller = (frame["CallerNum"] ?? "").trim();
  return {
    uuid,
    pbxTenant,
    did: did && /^[0-9+*#]{2,20}$/.test(did) ? did : null,
    callerNumber: caller && /^[0-9+*#]{2,20}$/.test(caller) ? caller : null,
  };
}

/**
 * Announcement registry: UUID → call metadata, with a short TTL.
 *
 * The AudioSocket TCP connection races the AMI event by design (both leave
 * the PBX in the same instant), so the server side WAITS briefly for the
 * announcement rather than refusing on the first miss. The TTL keeps a
 * announcement whose call never arrived from living forever.
 */
export class AnnouncementRegistry {
  private readonly entries = new Map<string, { ann: VoiceAgentAnnouncement; at: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  put(ann: VoiceAgentAnnouncement): void {
    this.sweep();
    this.entries.set(ann.uuid, { ann, at: this.now() });
  }

  /** Take (and consume) the announcement for a UUID, if fresh. */
  take(uuid: string): VoiceAgentAnnouncement | null {
    this.sweep();
    const hit = this.entries.get(uuid.toLowerCase());
    if (!hit) return null;
    this.entries.delete(uuid.toLowerCase());
    return hit.ann;
  }

  size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.entries) {
      if (v.at < cutoff) this.entries.delete(k);
    }
  }
}

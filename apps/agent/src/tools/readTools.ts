/**
 * Read tools v1 — ALL reads come from Connect's own Postgres mirrors
 * (PbxEndpointRegistration maintained by the worker's AMI feed, ConnectCdr from
 * CDR ingest). ZERO direct PBX contact in this layer — the gentlest possible
 * implementation of the LIVE PBX PROTOCOL (PLAN.md §3.8). Direct AMI reads can
 * be added later behind the rate-limited/circuit-broken path if mirror
 * freshness proves insufficient.
 * Every call is audit-logged and tenant-scoped by the caller (policy layer).
 */
export interface ExtensionStatusResult {
  extension: string;
  displayName?: string | null;
  registered: boolean;
  status: string; // REGISTERED | UNREACHABLE | UNREGISTERED | UNKNOWN | NO_DEVICE_SEEN
  contactUri?: string | null;
  userAgent?: string | null;
  lastEventAt?: Date | null;
  lastRegisteredAt?: Date | null;
  isWebrtcDevice?: boolean;
  roundtripUsec?: string | null;
}

export interface CdrSummary {
  totalCalls: number;
  answered: number;
  missed: number;
  failed: number;
  shortAnsweredCalls: number; // answered but talkSec < 15 — one-way-audio signature
  lastCallAt: Date | null;
  windowHours: number;
  recent: Array<{ direction: string; disposition: string; from: string | null; to: string | null; startedAt: Date; talkSec: number }>;
}

export interface VoicemailSummary {
  totalUnheard: number;
  totalInInbox: number;
  voicemails: Array<{
    from: string;
    receivedAt: Date;
    seconds: number;
    listened: boolean;
    /** Transcript text when auto-transcription produced one; null otherwise. */
    transcript: string | null;
  }>;
}

export class ReadTools {
  constructor(private prisma: any) {}

  /** Registration state for a tenant's extensions, from the DB mirror. */
  async extensionStatus(tenantId: string, extNumber?: string): Promise<ExtensionStatusResult[]> {
    const exts = await this.prisma.extension.findMany({
      where: { tenantId, ...(extNumber ? { extNumber } : {}) },
      select: { id: true, extNumber: true, displayName: true },
    });
    const regs = await this.prisma.pbxEndpointRegistration.findMany({
      where: { tenantId, ...(extNumber ? { extNumber } : {}) },
    });
    const byExt = new Map<string, any[]>();
    for (const r of regs) {
      const k = r.extNumber ?? "?";
      byExt.set(k, [...(byExt.get(k) ?? []), r]);
    }
    const out: ExtensionStatusResult[] = [];
    for (const e of exts) {
      const devs = byExt.get(e.extNumber) ?? [];
      if (devs.length === 0) {
        out.push({ extension: e.extNumber, displayName: e.displayName, registered: false, status: "NO_DEVICE_SEEN" });
        continue;
      }
      for (const d of devs) {
        out.push({
          extension: e.extNumber,
          displayName: e.displayName,
          registered: d.status === "REGISTERED",
          status: d.status,
          contactUri: d.contactUri,
          userAgent: d.userAgent,
          lastEventAt: d.lastEventAt,
          lastRegisteredAt: d.lastRegisteredAt,
          isWebrtcDevice: d.isWebrtcDevice,
          roundtripUsec: d.roundtripUsec,
        });
      }
    }
    return out;
  }

  /** The tenant's voicemail box, newest first, with transcripts where the
   *  transcriber has already produced one. Same DB mirror the Voicemail page
   *  reads — "cannot check voicemails / cannot summarize voicemails" was never
   *  a data problem, only a missing read path. Deleted messages excluded;
   *  transcripts are capped so one long message cannot flood the prompt. */
  async voicemailSummary(tenantId: string, extNumber?: string, limit = 15): Promise<VoicemailSummary> {
    const where: any = { tenantId, folder: "inbox", deletedAt: null, ...(extNumber ? { extension: extNumber } : {}) };
    const [totalUnheard, totalInInbox, rows] = await Promise.all([
      this.prisma.voicemail.count({ where: { ...where, listened: false } }),
      this.prisma.voicemail.count({ where }),
      this.prisma.voicemail.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        take: Math.min(Math.max(limit, 1), 25),
        select: { callerName: true, callerNumber: true, receivedAt: true, durationSec: true, listened: true, transcript: true },
      }),
    ]);
    return {
      totalUnheard,
      totalInInbox,
      voicemails: rows.map((v: any) => ({
        from: v.callerName || v.callerNumber || "Unknown caller",
        receivedAt: v.receivedAt,
        seconds: v.durationSec ?? 0,
        listened: !!v.listened,
        transcript: v.transcript ? String(v.transcript).slice(0, 400) : null,
      })),
    };
  }

  /** Call history summary for a tenant (optionally one extension) from ConnectCdr. */
  async cdrHistory(tenantId: string, extNumber?: string, windowHours = 48): Promise<CdrSummary> {
    const since = new Date(Date.now() - windowHours * 3600 * 1000);
    const where: any = { tenantId, startedAt: { gte: since } };
    if (extNumber) {
      where.OR = [{ toNumber: extNumber }, { fromNumber: extNumber }];
    }
    const rows = await this.prisma.connectCdr.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: 500,
      select: { direction: true, disposition: true, fromNumber: true, toNumber: true, startedAt: true, talkSec: true },
    });
    const answered = rows.filter((r: any) => r.disposition === "answered");
    return {
      totalCalls: rows.length,
      answered: answered.length,
      missed: rows.filter((r: any) => r.disposition === "missed").length,
      failed: rows.filter((r: any) => r.disposition === "failed" || r.disposition === "busy").length,
      shortAnsweredCalls: answered.filter((r: any) => r.talkSec > 0 && r.talkSec < 15).length,
      lastCallAt: rows[0]?.startedAt ?? null,
      windowHours,
      recent: rows.slice(0, 10).map((r: any) => ({
        direction: r.direction,
        disposition: r.disposition,
        from: r.fromNumber,
        to: r.toNumber,
        startedAt: r.startedAt,
        talkSec: r.talkSec,
      })),
    };
  }
}

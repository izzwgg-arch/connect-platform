import type { Prisma, PrismaClient } from "@prisma/client";

export const VM_SCENARIO = {
  NOTIFY_UPSERT_ZERO: "NOTIFY_UPSERT_ZERO",
  HELPER_ROUTE_MISSING: "HELPER_ROUTE_MISSING",
  HELPER_SECRET_MISMATCH: "HELPER_SECRET_MISMATCH",
  HELPER_UNREACHABLE: "HELPER_UNREACHABLE",
  REST_VS_SPOOL_DIVERGE: "REST_VS_SPOOL_DIVERGE",
  WORKER_SYNC_GLOBAL_ZERO: "WORKER_SYNC_GLOBAL_ZERO",
} as const;

export type VmScenario = (typeof VM_SCENARIO)[keyof typeof VM_SCENARIO];

export type HelperIncidentScenario =
  | typeof VM_SCENARIO.HELPER_ROUTE_MISSING
  | typeof VM_SCENARIO.HELPER_SECRET_MISMATCH
  | typeof VM_SCENARIO.HELPER_UNREACHABLE;

export const VM_STATUS = {
  OPEN: "OPEN",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  RESOLVED: "RESOLVED",
} as const;

const NOTIFY_WINDOW_MS = 15 * 60 * 1000;
const NOTIFY_THRESHOLD = 3;
const UNREACH_WINDOW_MS = 10 * 60 * 1000;
const UNREACH_THRESHOLD = 2;
const DIVERGE_ESCALATE_MS = 30 * 60 * 1000;

export function voicemailIngestIncidentsEnabled(): boolean {
  const v = String(process.env.VOICEMAIL_INGEST_INCIDENTS_ENABLED ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0";
}

/** Stable fingerprint; avoid secrets and raw URLs. */
export function buildFingerprint(scenario: VmScenario, parts: string[]): string {
  const safe = parts.map((p) => String(p || "").replace(/:/g, "_"));
  return `vmi:${scenario}:${safe.join(":")}`;
}

export function classifyHelperFailure(err: unknown): VmScenario | null {
  const e = err as { httpStatus?: number; name?: string; message?: string };
  const status = typeof e?.httpStatus === "number" ? e.httpStatus : null;
  if (status === 404) return VM_SCENARIO.HELPER_ROUTE_MISSING;
  if (status === 401) return VM_SCENARIO.HELPER_SECRET_MISMATCH;
  const name = String(e?.name || "");
  const msg = String(e?.message || err || "").toLowerCase();
  if (name === "AbortError") return VM_SCENARIO.HELPER_UNREACHABLE;
  if (
    msg.includes("timeout") ||
    msg.includes("fetch failed") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("networkerror")
  ) {
    return VM_SCENARIO.HELPER_UNREACHABLE;
  }
  return null;
}

export function helperBaseHostFromUrl(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    return u.host || null;
  } catch {
    return null;
  }
}

function sanitizeMeta(meta: Record<string, unknown>): Prisma.InputJsonValue {
  const allow = new Set([
    "mailbox",
    "context",
    "pbxInstanceId",
    "source",
    "httpStatus",
    "helperBaseHost",
    "fallback_reason",
    "recentEventAt",
    "lastDivergeAt",
    "suppressed",
  ]);
  const out: Record<string, unknown> = {};
  for (const k of allow) {
    if (meta[k] !== undefined && meta[k] !== null) out[k] = meta[k];
  }
  return out as Prisma.InputJsonValue;
}

function pruneIsoWindow(isoList: string[], nowMs: number, windowMs: number): string[] {
  const cutoff = nowMs - windowMs;
  return isoList
    .map((s) => {
      const t = new Date(s).getTime();
      return Number.isFinite(t) ? { s, t } : null;
    })
    .filter((x): x is { s: string; t: number } => x !== null && x.t >= cutoff)
    .map((x) => x.s);
}

async function findOpen(prisma: PrismaClient, fingerprint: string) {
  return prisma.voicemailIngestIncident.findFirst({
    where: { fingerprint, status: { in: [VM_STATUS.OPEN, VM_STATUS.ACKNOWLEDGED] } },
    orderBy: { firstSeenAt: "desc" },
  });
}

async function resolveOpensByFingerprint(prisma: PrismaClient, fingerprint: string, now: Date) {
  await prisma.voicemailIngestIncident.updateMany({
    where: { fingerprint, status: { in: [VM_STATUS.OPEN, VM_STATUS.ACKNOWLEDGED] } },
    data: { status: VM_STATUS.RESOLVED, resolvedAt: now },
  });
}

async function resolveHelperOpensForPbx(prisma: PrismaClient, pbxInstanceId: string, now: Date) {
  for (const scenario of [
    VM_SCENARIO.HELPER_ROUTE_MISSING,
    VM_SCENARIO.HELPER_SECRET_MISMATCH,
    VM_SCENARIO.HELPER_UNREACHABLE,
  ] as const) {
    const fp = buildFingerprint(scenario, [pbxInstanceId]);
    await resolveOpensByFingerprint(prisma, fp, now);
  }
}

const TITLES: Record<VmScenario, string> = {
  [VM_SCENARIO.NOTIFY_UPSERT_ZERO]: "Voicemail notify: MWI newCount>0 but no rows upserted",
  [VM_SCENARIO.HELPER_ROUTE_MISSING]: "PBX helper missing voicemail spool route (404)",
  [VM_SCENARIO.HELPER_SECRET_MISMATCH]: "PBX helper auth failed (401)",
  [VM_SCENARIO.HELPER_UNREACHABLE]: "PBX helper unreachable or timed out",
  [VM_SCENARIO.REST_VS_SPOOL_DIVERGE]: "VitalPBX REST empty but spool lists messages — ingest gap",
  [VM_SCENARIO.WORKER_SYNC_GLOBAL_ZERO]: "Worker voicemail sync saw zero records across all linked tenants",
};

const ACTIONS: Record<VmScenario, string> = {
  [VM_SCENARIO.NOTIFY_UPSERT_ZERO]:
    "Check extension mapping, REST vs spool, and DEBUGGING.md voicemail section. If helper-related, follow DEPLOYMENT.md Phase 1 operator transcript.",
  [VM_SCENARIO.HELPER_ROUTE_MISSING]:
    "Upgrade PBX helper to VERSION 2026.05.08.1+ (install pin). See DEPLOYMENT.md Phase 1 — operator handoff.",
  [VM_SCENARIO.HELPER_SECRET_MISMATCH]:
    "Align CONNECT_PBX_HELPER_SECRET on PBX with PBX_ROUTE_HELPER_SECRET for api/worker; restart helper and queue-deploy api+worker.",
  [VM_SCENARIO.HELPER_UNREACHABLE]:
    "Verify PBX_ROUTE_HELPER_BASE_URL, firewall, and helper systemd on the PBX. See DEBUGGING.md voicemail helper smoke.",
  [VM_SCENARIO.REST_VS_SPOOL_DIVERGE]:
    "Inspect msg*.txt / origtime mapping and dedupe keys; compare REST tenant header vs mailbox context (TELEPHONY.md).",
  [VM_SCENARIO.WORKER_SYNC_GLOBAL_ZERO]:
    "Confirm TenantPbxLink + extensions; check VitalPBX REST and worker logs for voicemail-sync-cycle JSON.",
};

async function upsertOpenIncident(
  prisma: PrismaClient,
  input: {
    fingerprint: string;
    tenantId: string | null;
    scenario: VmScenario;
    severity: string;
    metadata: Record<string, unknown>;
    now: Date;
    bumpOccurrence?: boolean;
  },
) {
  const existing = await findOpen(prisma, input.fingerprint);
  const meta = sanitizeMeta(input.metadata);
  if (!existing) {
    await prisma.voicemailIngestIncident.create({
      data: {
        fingerprint: input.fingerprint,
        tenantId: input.tenantId,
        scenario: input.scenario,
        severity: input.severity,
        status: VM_STATUS.OPEN,
        lastEventAt: input.now,
        occurrenceCount: 1,
        title: TITLES[input.scenario],
        actionText: ACTIONS[input.scenario],
        metadata: meta,
      },
    });
    return;
  }
  const nextOcc = (input.bumpOccurrence === false ? existing.occurrenceCount : existing.occurrenceCount + 1) || 1;
  await prisma.voicemailIngestIncident.update({
    where: { id: existing.id },
    data: {
      lastEventAt: input.now,
      occurrenceCount: nextOcc,
      severity: input.severity,
      metadata: meta,
    },
  });
}

/** newCount>0 && upserted===0 — opens after 3 events in 15 minutes (rolling). */
export async function recordNotifyUpsertZero(
  prisma: PrismaClient,
  input: { tenantId: string; mailbox: string; context: string; now?: Date },
): Promise<void> {
  if (!voicemailIngestIncidentsEnabled()) return;
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const fingerprint = buildFingerprint(VM_SCENARIO.NOTIFY_UPSERT_ZERO, [input.tenantId, input.mailbox, input.context || "default"]);
  const open = await findOpen(prisma, fingerprint);
  const prevMeta = (open?.metadata as Record<string, unknown>) || {};
  const prevRecent = Array.isArray(prevMeta.recentEventAt) ? (prevMeta.recentEventAt as string[]) : [];
  const recent = pruneIsoWindow([...prevRecent, now.toISOString()], nowMs, NOTIFY_WINDOW_MS);

  if (recent.length < NOTIFY_THRESHOLD) {
    if (open) {
      await prisma.voicemailIngestIncident.update({
        where: { id: open.id },
        data: {
          lastEventAt: now,
          metadata: sanitizeMeta({
            ...prevMeta,
            mailbox: input.mailbox,
            context: input.context,
            recentEventAt: recent,
          }),
        },
      });
    } else {
      await prisma.voicemailIngestIncident.create({
        data: {
          fingerprint,
          tenantId: input.tenantId,
          scenario: VM_SCENARIO.NOTIFY_UPSERT_ZERO,
          severity: "INFO",
          status: VM_STATUS.OPEN,
          firstSeenAt: now,
          lastEventAt: now,
          occurrenceCount: 0,
          title: TITLES[VM_SCENARIO.NOTIFY_UPSERT_ZERO],
          actionText: ACTIONS[VM_SCENARIO.NOTIFY_UPSERT_ZERO],
          metadata: sanitizeMeta({
            mailbox: input.mailbox,
            context: input.context,
            recentEventAt: recent,
            suppressed: true,
          }),
        },
      });
    }
    return;
  }

  await upsertOpenIncident(prisma, {
    fingerprint,
    tenantId: input.tenantId,
    scenario: VM_SCENARIO.NOTIFY_UPSERT_ZERO,
    severity: "HIGH",
    metadata: { mailbox: input.mailbox, context: input.context, recentEventAt: recent },
    now,
  });
}

export async function resolveNotifyUpsertZeroIfRecovered(
  prisma: PrismaClient,
  input: { tenantId: string; mailbox: string; context: string; now?: Date },
): Promise<void> {
  if (!voicemailIngestIncidentsEnabled()) return;
  const now = input.now ?? new Date();
  const fingerprint = buildFingerprint(VM_SCENARIO.NOTIFY_UPSERT_ZERO, [input.tenantId, input.mailbox, input.context || "default"]);
  await resolveOpensByFingerprint(prisma, fingerprint, now);
}

/** REST 0, helper>0, upserted 0 — warning first, HIGH if repeated within 30m. */
export async function recordRestVsSpoolDiverge(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    mailbox: string;
    source: "voicemail_notify" | "worker_sync";
    now?: Date;
  },
): Promise<void> {
  if (!voicemailIngestIncidentsEnabled()) return;
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const fingerprint = buildFingerprint(VM_SCENARIO.REST_VS_SPOOL_DIVERGE, [input.tenantId, input.mailbox, input.source]);
  const open = await findOpen(prisma, fingerprint);
  const prev = (open?.metadata as Record<string, unknown>) || {};
  const lastIso = typeof prev.lastDivergeAt === "string" ? prev.lastDivergeAt : null;
  let severity = "WARNING";
  if (lastIso) {
    const delta = nowMs - new Date(lastIso).getTime();
    if (delta > 0 && delta < DIVERGE_ESCALATE_MS) severity = "HIGH";
  }
  await upsertOpenIncident(prisma, {
    fingerprint,
    tenantId: input.tenantId,
    scenario: VM_SCENARIO.REST_VS_SPOOL_DIVERGE,
    severity,
    metadata: {
      mailbox: input.mailbox,
      source: input.source,
      lastDivergeAt: now.toISOString(),
    },
    now,
  });
}

export async function resolveRestVsSpoolDiverge(
  prisma: PrismaClient,
  input: { tenantId: string; mailbox: string; source: "voicemail_notify" | "worker_sync"; now?: Date },
): Promise<void> {
  if (!voicemailIngestIncidentsEnabled()) return;
  const fingerprint = buildFingerprint(VM_SCENARIO.REST_VS_SPOOL_DIVERGE, [input.tenantId, input.mailbox, input.source]);
  await resolveOpensByFingerprint(prisma, fingerprint, input.now ?? new Date());
}

export async function recordHelperIncident(
  prisma: PrismaClient,
  input: {
    scenario: HelperIncidentScenario;
    pbxInstanceId: string;
    tenantId?: string | null;
    metadata?: Record<string, unknown>;
    now?: Date;
  },
): Promise<void> {
  if (!voicemailIngestIncidentsEnabled()) return;
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const fingerprint = buildFingerprint(input.scenario, [input.pbxInstanceId]);
  const severity =
    input.scenario === VM_SCENARIO.HELPER_ROUTE_MISSING || input.scenario === VM_SCENARIO.HELPER_SECRET_MISMATCH
      ? "HIGH"
      : "HIGH";

  if (input.scenario === VM_SCENARIO.HELPER_UNREACHABLE) {
    const open = await findOpen(prisma, fingerprint);
    const prevMeta = (open?.metadata as Record<string, unknown>) || {};
    const prevRecent = Array.isArray(prevMeta.recentEventAt) ? (prevMeta.recentEventAt as string[]) : [];
    const recent = pruneIsoWindow([...prevRecent, now.toISOString()], nowMs, UNREACH_WINDOW_MS);
    if (recent.length < UNREACH_THRESHOLD) {
      if (open) {
        await prisma.voicemailIngestIncident.update({
          where: { id: open.id },
          data: {
            lastEventAt: now,
            metadata: sanitizeMeta({
              ...prevMeta,
              ...input.metadata,
              pbxInstanceId: input.pbxInstanceId,
              recentEventAt: recent,
            }),
          },
        });
      } else {
        await prisma.voicemailIngestIncident.create({
          data: {
            fingerprint,
            tenantId: input.tenantId ?? null,
            scenario: input.scenario,
            severity: "INFO",
            status: VM_STATUS.OPEN,
            firstSeenAt: now,
            lastEventAt: now,
            occurrenceCount: 0,
            title: TITLES[input.scenario],
            actionText: ACTIONS[input.scenario],
            metadata: sanitizeMeta({
              ...input.metadata,
              pbxInstanceId: input.pbxInstanceId,
              recentEventAt: recent,
              suppressed: true,
            }),
          },
        });
      }
      return;
    }
    await upsertOpenIncident(prisma, {
      fingerprint,
      tenantId: input.tenantId ?? null,
      scenario: input.scenario,
      severity,
      metadata: { ...input.metadata, pbxInstanceId: input.pbxInstanceId, recentEventAt: recent },
      now,
    });
    return;
  }

  await upsertOpenIncident(prisma, {
    fingerprint,
    tenantId: input.tenantId ?? null,
    scenario: input.scenario,
    severity,
    metadata: { ...input.metadata, pbxInstanceId: input.pbxInstanceId },
    now,
  });
}

export async function resolveHelperIncidentsForPbx(
  prisma: PrismaClient,
  pbxInstanceId: string,
  now?: Date,
): Promise<void> {
  if (!voicemailIngestIncidentsEnabled()) return;
  await resolveHelperOpensForPbx(prisma, pbxInstanceId, now ?? new Date());
}

export async function recordWorkerSyncGlobalZero(prisma: PrismaClient, now?: Date): Promise<void> {
  if (!voicemailIngestIncidentsEnabled()) return;
  const t = now ?? new Date();
  const fingerprint = buildFingerprint(VM_SCENARIO.WORKER_SYNC_GLOBAL_ZERO, ["global"]);
  await upsertOpenIncident(prisma, {
    fingerprint,
    tenantId: null,
    scenario: VM_SCENARIO.WORKER_SYNC_GLOBAL_ZERO,
    severity: "WARNING",
    metadata: {},
    now: t,
  });
}

export async function resolveWorkerSyncGlobalZero(prisma: PrismaClient, now?: Date): Promise<void> {
  if (!voicemailIngestIncidentsEnabled()) return;
  const fingerprint = buildFingerprint(VM_SCENARIO.WORKER_SYNC_GLOBAL_ZERO, ["global"]);
  await resolveOpensByFingerprint(prisma, fingerprint, now ?? new Date());
}

/** Hide staging rows (threshold not yet met) from admin lists. */
export function isVoicemailIncidentSurfaceable(row: { scenario: string; severity: string }): boolean {
  if (row.scenario === VM_SCENARIO.NOTIFY_UPSERT_ZERO && row.severity === "INFO") return false;
  if (row.scenario === VM_SCENARIO.HELPER_UNREACHABLE && row.severity === "INFO") return false;
  return true;
}

export async function listVoicemailIngestIncidents(
  prisma: PrismaClient,
  q: {
    status?: string;
    scenario?: string;
    tenantId?: string;
    since?: Date;
    limit: number;
    cursor?: string | null;
  },
) {
  const and: Prisma.VoicemailIngestIncidentWhereInput[] = [
    {
      NOT: {
        AND: [{ scenario: VM_SCENARIO.NOTIFY_UPSERT_ZERO }, { severity: "INFO" }],
      },
    },
    {
      NOT: {
        AND: [{ scenario: VM_SCENARIO.HELPER_UNREACHABLE }, { severity: "INFO" }],
      },
    },
  ];
  if (q.status) and.push({ status: q.status });
  if (q.scenario) and.push({ scenario: q.scenario });
  if (q.tenantId) and.push({ tenantId: q.tenantId });
  if (q.since) and.push({ lastEventAt: { gte: q.since } });

  const rows = await prisma.voicemailIngestIncident.findMany({
    where: { AND: and },
    orderBy: [{ lastEventAt: "desc" }, { createdAt: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  return rows;
}

export async function getVoicemailIngestIncident(prisma: PrismaClient, id: string) {
  return prisma.voicemailIngestIncident.findUnique({ where: { id } });
}

export async function acknowledgeVoicemailIngestIncident(
  prisma: PrismaClient,
  id: string,
  userId: string,
): Promise<{ ok: boolean }> {
  const row = await prisma.voicemailIngestIncident.findUnique({ where: { id } });
  if (!row) return { ok: false };
  if (row.status === VM_STATUS.RESOLVED) return { ok: true };
  await prisma.voicemailIngestIncident.update({
    where: { id },
    data: {
      status: VM_STATUS.ACKNOWLEDGED,
      acknowledgedAt: new Date(),
      acknowledgedByUserId: userId,
    },
  });
  return { ok: true };
}

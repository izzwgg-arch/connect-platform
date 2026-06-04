import type { Prisma, PrismaClient } from "@prisma/client";
import {
  buildWebrtcIncidentFingerprint,
  evaluateWebrtcIncidentTriggers,
  WEBRTC_INCIDENT_DISMISS_COOLDOWN_MS,
  webrtcIncidentDrillDownPath,
  webrtcIncidentSuggestedAction,
  webrtcIncidentTitle,
  type WebrtcDiagEventRow,
  type WebrtcIncidentTrigger,
} from "@connect/shared/webrtcIncidentAlerts";

export const WEBRTC_INCIDENT_STATUS = {
  OPEN: "OPEN",
  RESOLVED: "RESOLVED",
} as const;

export function webrtcCallingIncidentsEnabled(): boolean {
  const v = String(process.env.WEBRTC_CALLING_INCIDENTS_ENABLED ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0";
}

function sanitizeMeta(trigger: WebrtcIncidentTrigger, lastEventId?: string | null): Prisma.InputJsonValue {
  return {
    direction: trigger.direction,
    diagnosisSummary: trigger.diagnosisSummary,
    affectedUserIds: trigger.affectedUserIds.slice(0, 20),
    affectedExtensions: trigger.affectedExtensions.slice(0, 20),
    sampleEventIds: trigger.sampleEventIds.slice(0, 10),
    lastEventId: lastEventId ?? null,
    drillDownPath: webrtcIncidentDrillDownPath(trigger.failureType),
  } as Prisma.InputJsonValue;
}

async function findOpenByFingerprint(prisma: PrismaClient, fingerprint: string) {
  return prisma.webrtcCallingIncident.findFirst({
    where: { fingerprint, status: WEBRTC_INCIDENT_STATUS.OPEN },
    orderBy: { firstSeenAt: "desc" },
  });
}

export async function upsertWebrtcCallingIncident(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    trigger: WebrtcIncidentTrigger;
    now: Date;
    lastEventId?: string | null;
  },
): Promise<{ id: string; created: boolean }> {
  const fingerprint = buildWebrtcIncidentFingerprint(
    input.tenantId,
    input.trigger.failureType,
    input.now.getTime(),
  );
  const existing = await findOpenByFingerprint(prisma, fingerprint);
  const meta = sanitizeMeta(input.trigger, input.lastEventId);
  if (!existing) {
    const row = await prisma.webrtcCallingIncident.create({
      data: {
        fingerprint,
        tenantId: input.tenantId,
        failureType: input.trigger.failureType,
        severity: input.trigger.severity,
        status: WEBRTC_INCIDENT_STATUS.OPEN,
        direction: input.trigger.direction,
        firstSeenAt: input.trigger.firstSeenAt,
        lastSeenAt: input.trigger.lastSeenAt,
        occurrenceCount: input.trigger.count,
        title: webrtcIncidentTitle(input.trigger.failureType),
        actionText: webrtcIncidentSuggestedAction(input.trigger.failureType),
        latestSipCode: input.trigger.latestSipCode,
        latestSipReason: input.trigger.latestSipReason,
        metadata: meta,
      },
    });
    return { id: row.id, created: true };
  }
  await prisma.webrtcCallingIncident.update({
    where: { id: existing.id },
    data: {
      lastSeenAt: input.trigger.lastSeenAt,
      occurrenceCount: Math.max(existing.occurrenceCount + 1, input.trigger.count),
      severity: input.trigger.severity,
      latestSipCode: input.trigger.latestSipCode,
      latestSipReason: input.trigger.latestSipReason,
      metadata: meta,
    },
  });
  return { id: existing.id, created: false };
}

export async function fetchRecentWebrtcDiagRows(
  prisma: PrismaClient,
  tenantId: string,
  windowMs = 30 * 60 * 1000,
): Promise<WebrtcDiagEventRow[]> {
  const since = new Date(Date.now() - windowMs);
  const events = await prisma.voiceDiagEvent.findMany({
    where: {
      tenantId,
      createdAt: { gte: since },
      type: "CALL_QUALITY_REPORT",
    },
    select: { id: true, tenantId: true, userId: true, createdAt: true, payload: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return events
    .filter((e) => {
      const p = e.payload as Record<string, unknown>;
      const kind = String(p.kind ?? "");
      if (kind === "WEBRTC_CALL_DEBUG") return true;
      const endReason = String(p.endReason ?? "");
      return endReason.toLowerCase().includes("incompatible sdp");
    })
    .map((e) => ({
      id: e.id,
      tenantId: e.tenantId,
      userId: e.userId,
      createdAt: e.createdAt,
      payload: e.payload as Record<string, unknown>,
    }));
}

export async function evaluateWebrtcCallingIncidentsForTenant(
  prisma: PrismaClient,
  tenantId: string,
  lastEventId?: string | null,
): Promise<string[]> {
  if (!webrtcCallingIncidentsEnabled()) return [];
  const rows = await fetchRecentWebrtcDiagRows(prisma, tenantId);
  const triggers = evaluateWebrtcIncidentTriggers(rows);
  const now = new Date();
  const ids: string[] = [];
  for (const trigger of triggers) {
    const { id } = await upsertWebrtcCallingIncident(prisma, {
      tenantId,
      trigger,
      now,
      lastEventId,
    });
    ids.push(id);
  }
  return ids;
}

export async function recordWebrtcDiagIngestFailure(
  prisma: PrismaClient,
  input: { tenantId: string; reason: string; now?: Date },
): Promise<void> {
  if (!webrtcCallingIncidentsEnabled()) return;
  const now = input.now ?? new Date();
  const fingerprint = buildWebrtcIncidentFingerprint(input.tenantId, "diag_ingest_failure", now.getTime(), 60);
  const existing = await findOpenByFingerprint(prisma, fingerprint);
  if (!existing) {
    await prisma.webrtcCallingIncident.create({
      data: {
        fingerprint,
        tenantId: input.tenantId,
        failureType: "diag_ingest_failure",
        severity: "warning",
        status: WEBRTC_INCIDENT_STATUS.OPEN,
        direction: "both",
        lastSeenAt: now,
        occurrenceCount: 1,
        title: "WebRTC diagnostic ingest failures",
        actionText: "Check API logs for webrtc_call_debug_invalid_payload / persist errors.",
        metadata: { reason: input.reason.slice(0, 200) },
      },
    });
    return;
  }
  await prisma.webrtcCallingIncident.update({
    where: { id: existing.id },
    data: {
      lastSeenAt: now,
      occurrenceCount: existing.occurrenceCount + 1,
    },
  });
}

export type AdminWebrtcIncidentView = {
  id: string;
  severity: "critical" | "warning";
  failureType: string;
  direction: string;
  title: string;
  description: string;
  affectedTenantId: string;
  affectedTenantName: string | null;
  affectedExtensions: string[];
  affectedUserCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  latestSipCode: number | null;
  latestSipReason: string | null;
  suggestedAction: string;
  drillDownPath: string;
  sampleEventIds: string[];
};

function isDismissedForUser(
  dismissals: { dismissedAt: Date }[],
  lastSeenAt: Date,
  nowMs: number,
): boolean {
  if (dismissals.length === 0) return false;
  const dismissedAt = dismissals[0]!.dismissedAt.getTime();
  if (lastSeenAt.getTime() > dismissedAt + WEBRTC_INCIDENT_DISMISS_COOLDOWN_MS) {
    return false;
  }
  return dismissedAt <= nowMs;
}

export async function listActiveWebrtcIncidentsForAdmin(
  prisma: PrismaClient,
  input: { adminUserId: string; adminTenantId: string; isSuperAdmin: boolean },
): Promise<AdminWebrtcIncidentView[]> {
  if (!webrtcCallingIncidentsEnabled()) return [];
  const nowMs = Date.now();
  const rows = await prisma.webrtcCallingIncident.findMany({
    where: {
      status: WEBRTC_INCIDENT_STATUS.OPEN,
      ...(input.isSuperAdmin ? {} : { tenantId: input.adminTenantId }),
    },
    include: {
      tenant: { select: { name: true } },
      dismissals: {
        where: { userId: input.adminUserId },
        select: { dismissedAt: true },
        take: 1,
      },
    },
    orderBy: [{ severity: "desc" }, { lastSeenAt: "desc" }],
    take: 25,
  });

  const out: AdminWebrtcIncidentView[] = [];
  for (const row of rows) {
    if (isDismissedForUser(row.dismissals, row.lastSeenAt, nowMs)) continue;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const extensions = Array.isArray(meta.affectedExtensions)
      ? (meta.affectedExtensions as string[])
      : [];
    const userIds = Array.isArray(meta.affectedUserIds) ? (meta.affectedUserIds as string[]) : [];
    const sampleEventIds = Array.isArray(meta.sampleEventIds) ? (meta.sampleEventIds as string[]) : [];
    out.push({
      id: row.id,
      severity: row.severity === "critical" ? "critical" : "warning",
      failureType: row.failureType,
      direction: row.direction,
      title: row.title,
      description: String(meta.diagnosisSummary ?? row.title),
      affectedTenantId: row.tenantId,
      affectedTenantName: row.tenant?.name ?? null,
      affectedExtensions: extensions,
      affectedUserCount: userIds.length,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      occurrenceCount: row.occurrenceCount,
      latestSipCode: row.latestSipCode,
      latestSipReason: row.latestSipReason,
      suggestedAction: row.actionText,
      drillDownPath: String(meta.drillDownPath ?? "/admin/call-timeline"),
      sampleEventIds,
    });
  }
  return out;
}

export async function dismissWebrtcCallingIncident(
  prisma: PrismaClient,
  input: { incidentId: string; userId: string; adminTenantId: string; isSuperAdmin: boolean },
): Promise<{ ok: boolean; reason?: string }> {
  const row = await prisma.webrtcCallingIncident.findUnique({
    where: { id: input.incidentId },
    select: { id: true, tenantId: true },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (!input.isSuperAdmin && row.tenantId !== input.adminTenantId) {
    return { ok: false, reason: "tenant_isolation" };
  }
  await prisma.webrtcCallingIncidentDismissal.upsert({
    where: { incidentId_userId: { incidentId: input.incidentId, userId: input.userId } },
    create: { incidentId: input.incidentId, userId: input.userId },
    update: { dismissedAt: new Date() },
  });
  return { ok: true };
}

export async function loadOpenWebrtcIncidentsForOps(
  prisma: PrismaClient,
  take = 15,
) {
  return prisma.webrtcCallingIncident.findMany({
    where: { status: WEBRTC_INCIDENT_STATUS.OPEN },
    include: { tenant: { select: { name: true } } },
    orderBy: [{ severity: "desc" }, { lastSeenAt: "desc" }],
    take,
  });
}

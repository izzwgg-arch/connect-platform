import type { Prisma, PrismaClient } from "@prisma/client";
import {
  buildGlobalOutageFingerprint,
  computeWebrtcPlatformHealth,
  evaluateGlobalWebrtcOutage,
  GLOBAL_OUTAGE_DISMISS_COOLDOWN_MS,
  GLOBAL_WEBRTC_OUTAGE_TYPE,
  type GlobalWebrtcOutageSnapshot,
} from "@connect/shared/webrtcGlobalOutageAlerts";
import type { WebrtcDiagEventRow } from "@connect/shared/webrtcIncidentAlerts";
import { webrtcCallingIncidentsEnabled, WEBRTC_INCIDENT_STATUS } from "./webrtcCallingIncidentService";

export const PLATFORM_OUTAGE_STATUS = {
  OPEN: "OPEN",
  RESOLVED: "RESOLVED",
} as const;

const GLOBAL_TITLE = "Potential platform-wide WebRTC outage detected";
const GLOBAL_ACTION =
  "Review Incident Center, Call Flight, and WEBRTC_CALL_DEBUG logs. Check PBX/WSS transport before customer reports. See WEBRTC_DIAGNOSTICS.md § Platform-wide WebRTC outage detection.";

function isDismissedForUser(
  dismissals: { dismissedAt: Date }[],
  lastSeenAt: Date,
  nowMs: number,
): boolean {
  if (dismissals.length === 0) return false;
  const dismissedAt = dismissals[0]!.dismissedAt.getTime();
  if (lastSeenAt.getTime() > dismissedAt + GLOBAL_OUTAGE_DISMISS_COOLDOWN_MS) {
    return false;
  }
  return dismissedAt <= nowMs;
}

/** Exported for unit tests — per-admin dismiss with cooldown reopen. */
export function platformOutageHiddenForAdmin(
  dismissedAt: Date | null,
  lastSeenAt: Date,
  nowMs: number,
): boolean {
  if (!dismissedAt) return false;
  return isDismissedForUser([{ dismissedAt }], lastSeenAt, nowMs);
}

function metaFromSnapshot(snap: GlobalWebrtcOutageSnapshot): Prisma.InputJsonValue {
  return {
    reasons: snap.reasons,
    affectedTenantIds: snap.affectedTenantIds,
    affectedUserIds: snap.affectedUserIds.slice(0, 50),
    activeIncidentCount: snap.activeIncidentCount,
    outboundFailureCount: snap.outboundFailureCount,
    inboundFailureCount: snap.inboundFailureCount,
    sdpFailureCount: snap.sdpFailureCount,
    successRate: snap.successRate,
    successAttempts: snap.successAttempts,
    successCount: snap.successCount,
    sampleDiagEventIds: snap.sampleDiagEventIds,
    sampleFlightIds: [],
  } as Prisma.InputJsonValue;
}

export async function fetchRecentWebrtcDiagRowsGlobal(
  prisma: PrismaClient,
  windowMs = 15 * 60 * 1000,
): Promise<WebrtcDiagEventRow[]> {
  const since = new Date(Date.now() - windowMs);
  const events = await prisma.voiceDiagEvent.findMany({
    where: {
      createdAt: { gte: since },
      type: "CALL_QUALITY_REPORT",
    },
    select: { id: true, tenantId: true, userId: true, createdAt: true, payload: true },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  return events
    .filter((e) => {
      const p = e.payload as Record<string, unknown>;
      const kind = String(p.kind ?? "");
      if (kind === "WEBRTC_CALL_DEBUG") return true;
      if (kind === "WEBRTC_SDP_DEBUG") return true;
      const dk = String(p.debugKind ?? "");
      if (dk.startsWith("WEBRTC_")) return true;
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

async function openIncidentTenantSummary(prisma: PrismaClient) {
  const rows = await prisma.webrtcCallingIncident.findMany({
    where: { status: WEBRTC_INCIDENT_STATUS.OPEN },
    select: { tenantId: true },
    distinct: ["tenantId"],
  });
  const count = await prisma.webrtcCallingIncident.count({
    where: { status: WEBRTC_INCIDENT_STATUS.OPEN },
  });
  return { tenantIds: rows.map((r) => r.tenantId), count };
}

async function findOpenPlatformOutage(prisma: PrismaClient, fingerprint: string) {
  return prisma.webrtcPlatformOutage.findFirst({
    where: { fingerprint, status: PLATFORM_OUTAGE_STATUS.OPEN },
    orderBy: { firstSeenAt: "desc" },
  });
}

export async function evaluateWebrtcPlatformOutage(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<{ id: string | null; created: boolean; active: boolean }> {
  if (!webrtcCallingIncidentsEnabled()) {
    return { id: null, created: false, active: false };
  }

  const diagRows = await fetchRecentWebrtcDiagRowsGlobal(prisma);
  const { tenantIds, count } = await openIncidentTenantSummary(prisma);
  const snap = evaluateGlobalWebrtcOutage({
    diagRows,
    openIncidentTenantIds: tenantIds,
    activeOpenIncidentCount: count,
    nowMs: now.getTime(),
  });

  if (!snap) {
    return { id: null, created: false, active: false };
  }

  const fingerprint = buildGlobalOutageFingerprint(now.getTime());
  const existing = await findOpenPlatformOutage(prisma, fingerprint);
  const meta = metaFromSnapshot(snap);

  if (!existing) {
    const row = await prisma.webrtcPlatformOutage.create({
      data: {
        fingerprint,
        failureType: GLOBAL_WEBRTC_OUTAGE_TYPE,
        severity: snap.severity,
        status: PLATFORM_OUTAGE_STATUS.OPEN,
        firstSeenAt: snap.firstSeenAt,
        lastSeenAt: snap.lastSeenAt,
        occurrenceCount: 1,
        title: GLOBAL_TITLE,
        actionText: GLOBAL_ACTION,
        diagnosisSummary: snap.diagnosisSummary,
        latestDiagnosisCategory: snap.latestDiagnosisCategory,
        latestSipCode: snap.latestSipCode,
        latestSipReason: snap.latestSipReason,
        metadata: meta,
      },
    });
    return { id: row.id, created: true, active: true };
  }

  await prisma.webrtcPlatformOutage.update({
    where: { id: existing.id },
    data: {
      lastSeenAt: snap.lastSeenAt,
      occurrenceCount: existing.occurrenceCount + 1,
      severity: snap.severity,
      diagnosisSummary: snap.diagnosisSummary,
      latestDiagnosisCategory: snap.latestDiagnosisCategory,
      latestSipCode: snap.latestSipCode,
      latestSipReason: snap.latestSipReason,
      metadata: meta,
    },
  });
  return { id: existing.id, created: false, active: true };
}

export type AdminGlobalWebrtcOutageView = {
  id: string;
  severity: "critical" | "warning";
  failureType: string;
  title: string;
  diagnosisSummary: string;
  firstSeenAt: string;
  lastSeenAt: string;
  affectedTenantCount: number;
  affectedUserCount: number;
  activeIncidentCount: number;
  outboundFailureCount: number;
  inboundFailureCount: number;
  sdpFailureCount: number;
  successRate: number | null;
  successAttempts: number;
  latestDiagnosisCategory: string | null;
  latestSipCode: number | null;
  latestSipReason: string | null;
  sampleDiagEventIds: string[];
  sampleFlightIds: string[];
  suggestedAction: string;
  reasons: string[];
};

export async function listActiveGlobalWebrtcOutageForAdmin(
  prisma: PrismaClient,
  adminUserId: string,
): Promise<AdminGlobalWebrtcOutageView | null> {
  if (!webrtcCallingIncidentsEnabled()) return null;
  const nowMs = Date.now();
  const row = await prisma.webrtcPlatformOutage.findFirst({
    where: { status: PLATFORM_OUTAGE_STATUS.OPEN },
    include: {
      dismissals: {
        where: { userId: adminUserId },
        select: { dismissedAt: true },
        take: 1,
      },
    },
    orderBy: [{ severity: "desc" }, { lastSeenAt: "desc" }],
  });
  if (!row) return null;
  if (isDismissedForUser(row.dismissals, row.lastSeenAt, nowMs)) return null;

  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const tenantIds = Array.isArray(meta.affectedTenantIds) ? (meta.affectedTenantIds as string[]) : [];
  const userIds = Array.isArray(meta.affectedUserIds) ? (meta.affectedUserIds as string[]) : [];
  const sampleDiagEventIds = Array.isArray(meta.sampleDiagEventIds)
    ? (meta.sampleDiagEventIds as string[])
    : [];
  const sampleFlightIds = Array.isArray(meta.sampleFlightIds) ? (meta.sampleFlightIds as string[]) : [];
  const reasons = Array.isArray(meta.reasons) ? (meta.reasons as string[]) : [];

  return {
    id: row.id,
    severity: row.severity === "critical" ? "critical" : "warning",
    failureType: row.failureType,
    title: row.title,
    diagnosisSummary: row.diagnosisSummary ?? "",
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    affectedTenantCount: tenantIds.length,
    affectedUserCount: userIds.length,
    activeIncidentCount: typeof meta.activeIncidentCount === "number" ? meta.activeIncidentCount : 0,
    outboundFailureCount: typeof meta.outboundFailureCount === "number" ? meta.outboundFailureCount : 0,
    inboundFailureCount: typeof meta.inboundFailureCount === "number" ? meta.inboundFailureCount : 0,
    sdpFailureCount: typeof meta.sdpFailureCount === "number" ? meta.sdpFailureCount : 0,
    successRate: typeof meta.successRate === "number" ? meta.successRate : null,
    successAttempts: typeof meta.successAttempts === "number" ? meta.successAttempts : 0,
    latestDiagnosisCategory: row.latestDiagnosisCategory,
    latestSipCode: row.latestSipCode,
    latestSipReason: row.latestSipReason,
    sampleDiagEventIds,
    sampleFlightIds,
    suggestedAction: row.actionText,
    reasons,
  };
}

export async function dismissWebrtcPlatformOutage(
  prisma: PrismaClient,
  input: { outageId: string; userId: string },
): Promise<{ ok: boolean; reason?: string }> {
  const row = await prisma.webrtcPlatformOutage.findUnique({
    where: { id: input.outageId },
    select: { id: true },
  });
  if (!row) return { ok: false, reason: "not_found" };
  await prisma.webrtcPlatformOutageDismissal.upsert({
    where: { outageId_userId: { outageId: input.outageId, userId: input.userId } },
    create: { outageId: input.outageId, userId: input.userId },
    update: { dismissedAt: new Date() },
  });
  return { ok: true };
}

export async function getWebrtcPlatformHealthSnapshot(prisma: PrismaClient) {
  if (!webrtcCallingIncidentsEnabled()) {
    return {
      status: "healthy" as const,
      lastSuccessfulInbound: null,
      lastSuccessfulOutbound: null,
      activeIncidents: 0,
      successRate: null,
      successAttempts: 0,
      affectedTenants: 0,
      outboundFailureCount15m: 0,
      inboundFailureCount15m: 0,
      globalOutageActive: false,
    };
  }

  const diagRows = await fetchRecentWebrtcDiagRowsGlobal(prisma);
  const { count } = await openIncidentTenantSummary(prisma);
  const activeOutage = await prisma.webrtcPlatformOutage.findFirst({
    where: { status: PLATFORM_OUTAGE_STATUS.OPEN },
    select: { id: true },
  });
  const health = computeWebrtcPlatformHealth({
    diagRows,
    activeOpenIncidentCount: count,
    activeGlobalOutage: !!activeOutage,
  });
  return { ...health, globalOutageActive: !!activeOutage };
}

export async function loadOpenWebrtcPlatformOutageForOps(prisma: PrismaClient, take = 5) {
  return prisma.webrtcPlatformOutage.findMany({
    where: { status: PLATFORM_OUTAGE_STATUS.OPEN },
    orderBy: [{ severity: "desc" }, { lastSeenAt: "desc" }],
    take,
  });
}

import { db } from "@connect/db";
import { generateVitalPbxCsv } from "./vitalpbxTemplate";

export function toPublicUrl(token: string | null | undefined): string | null {
  const t = (token || "").trim();
  return t ? `/onboarding/${encodeURIComponent(t)}` : null;
}

export async function listAdminSubmissions(limit = 300) {
  const rows = await (db as any).onboardingSubmission.findMany({
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: {
      _count: { select: { requestedExtensions: true, uploadedFiles: true } },
    },
  } as any);
  return rows.map((r: any) => ({
    id: r.id,
    publicToken: r.publicToken,
    publicUrl: toPublicUrl(r.publicToken),
    companyName: r.companyName || "",
    contactName: [r.contactFirstName, r.contactLastName].filter(Boolean).join(" "),
    mainEmail: r.mainEmail || "",
    billingEmail: r.billingEmail || "",
    status: r.status,
    smsEnabled: !!r.smsEnabled,
    createdTenantId: r.createdTenantId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    submittedAt: r.submittedAt,
    requestedExtensionCount: (r as any)._count?.requestedExtensions || 0,
    uploadedFileCount: (r as any)._count?.uploadedFiles || 0,
    hasCardOnFile: Boolean((r as any).cardTokenPreview),
    csvAvailable: ((r as any)._count?.requestedExtensions || 0) > 0,
  }));
}

export async function readAdminSubmissionDetail(id: string) {
  const row = await (db as any).onboardingSubmission.findUnique({
    where: { id },
    include: {
      requestedExtensions: true,
      uploadedFiles: true,
      events: { orderBy: { createdAt: "asc" } },
    },
  } as any);
  if (!row) return null;
  return {
    ...row,
    publicUrl: toPublicUrl(row.publicToken),
  };
}

export function isValidStatusTransition(from: any, to: any): boolean {
  if (from === to) return true;
  const ord: Record<string, number> = {
    INVITE_SENT: 0,
    IN_PROGRESS: 1,
    SUBMITTED: 2,
    AWAITING_PBX_SETUP: 3,
    AWAITING_PORT: 4,
    AWAITING_PAYMENT: 5,
    READY_TO_SYNC: 6,
    ACTIVE: 7,
    COMPLETED: 8,
    CANCELED: 9,
  } as any;
  // Disallow moving backward from terminal states
  const terminal = new Set<string>(["COMPLETED", "CANCELED"]);
  if (terminal.has(from)) return false;
  // Allow monotonic forward moves or cancel at any time before completed
  if (to === "CANCELED") return true;
  return (ord[to] ?? 0) >= (ord[from] ?? 0);
}

export async function buildVitalPbxCsvForSubmission(id: string) {
  const row = await (db as any).onboardingSubmission.findUnique({
    where: { id },
    include: { requestedExtensions: true },
  } as any);
  if (!row) return null;
  const rows = (row.requestedExtensions || []).map((e: any) => ({
    extNumber: e.extNumber,
    name: e.displayName || undefined,
    email: e.email || undefined,
    vmPassword: e.vmPassword || undefined,
  }));
  return generateVitalPbxCsv(rows);
}

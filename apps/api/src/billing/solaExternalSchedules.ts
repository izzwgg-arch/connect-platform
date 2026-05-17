/**
 * Read-only Sola recurring schedule import + operator mapping (Phase B).
 * No charges, no PaymentMethod creation, no token storage.
 */

import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import {
  redactSolaRecurringPayload,
  SolaRecurringClient,
  type SolaRecurringClientConfig,
  type SolaRecurringPaymentMethodRow,
  type SolaRecurringScheduleRow,
} from "@connect/integrations";
import { logBillingEvent } from "./invoiceEngine";

export type SolaScheduleMappingStatus = "UNMAPPED" | "MAPPED" | "IGNORED" | "CONFLICT";

export type TenantMatchCandidate = {
  tenantId: string;
  tenantName: string;
  confidence: "exact_email" | "company_name" | "fuzzy_name" | "none";
  reason: string;
};

export type ParsedSolaSchedule = {
  solaScheduleId: string;
  solaCustomerId: string;
  solaPaymentMethodId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  companyName: string | null;
  maskedCard: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: string | null;
  expYear: string | null;
  amountCents: number | null;
  intervalType: string | null;
  intervalCount: number | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastTransactionStatus: string | null;
  isActive: boolean;
  rawSafeJson: Record<string, unknown>;
};

export type SyncSolaSchedulesResult = {
  scanned: number;
  created: number;
  updated: number;
  unmapped: number;
  mapped: number;
  ignored: number;
  conflicts: number;
  errors: Array<{ solaScheduleId?: string; message: string }>;
};

type AnyDb = typeof db;

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}

function parseAmountCents(amount: unknown): number | null {
  if (amount === undefined || amount === null || amount === "") return null;
  const n = typeof amount === "number" ? amount : Number(String(amount).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(n) && n > 1000) return n;
  return Math.round(n * 100);
}

/** MMYY from Sola Exp field. */
export function parseSolaCardExpiry(exp: unknown): { expMonth: string | null; expYear: string | null } {
  const raw = str(exp);
  if (!raw || raw.length < 4) return { expMonth: null, expYear: null };
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return { expMonth: null, expYear: null };
  return { expMonth: digits.slice(0, 2), expYear: digits.slice(-2) };
}

export function last4FromMaskedCard(masked: unknown): string | null {
  const digits = String(masked || "").replace(/\D/g, "");
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

export function normalizeCompanyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function customerDisplayName(row: SolaRecurringScheduleRow): string | null {
  const company = str(row.BillCompany);
  if (company) return company;
  const first = str(row.BillFirstName);
  const last = str(row.BillLastName);
  const full = [first, last].filter(Boolean).join(" ").trim();
  return full || null;
}

export function parseSolaScheduleRow(
  row: SolaRecurringScheduleRow,
  maskedPm?: SolaRecurringPaymentMethodRow | null,
): ParsedSolaSchedule {
  const maskedCard = str(maskedPm?.MaskedCardNumber) || null;
  const { expMonth, expYear } = parseSolaCardExpiry(maskedPm?.Exp);
  const scheduleId = str(row.ScheduleId);
  const customerId = str(row.CustomerId);
  if (!scheduleId || !customerId) {
    throw new Error("SOLA_SCHEDULE_MISSING_IDS");
  }

  return {
    solaScheduleId: scheduleId,
    solaCustomerId: customerId,
    solaPaymentMethodId: str(row.PaymentMethodId),
    customerName: customerDisplayName(row),
    customerEmail: str(row.Email)?.toLowerCase() ?? null,
    companyName: str(row.BillCompany),
    maskedCard,
    brand: str(maskedPm?.Issuer) || null,
    last4: last4FromMaskedCard(maskedCard),
    expMonth,
    expYear,
    amountCents: parseAmountCents(row.Amount),
    intervalType: str(row.IntervalType)?.toLowerCase() ?? null,
    intervalCount: row.IntervalCount !== undefined && row.IntervalCount !== null ? Number(row.IntervalCount) : null,
    nextRunAt: parseSolaDateTime(row.NextScheduledRunTime),
    lastRunAt: parseSolaDateTime(row.LastRunTime),
    lastTransactionStatus: str(row.LastTransactionStatus),
    isActive: row.IsActive === true || String(row.IsActive).toLowerCase() === "true",
    rawSafeJson: redactSolaRecurringPayload({
      ...(row as Record<string, unknown>),
      ...(maskedPm
        ? {
            paymentMethod: redactSolaRecurringPayload({
              Issuer: maskedPm.Issuer,
              MaskedCardNumber: maskedPm.MaskedCardNumber,
              Exp: maskedPm.Exp,
              TokenType: maskedPm.TokenType,
              Token: maskedPm.Token,
            }),
          }
        : {}),
    }),
  };
}

export function parseSolaDateTime(value: unknown): Date | null {
  const raw = str(value);
  if (!raw) return null;
  const d = new Date(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function mapSolaScheduleActiveStatus(row: SolaRecurringScheduleRow): boolean {
  if (row.IsActive === true) return true;
  if (row.IsActive === false) return false;
  const s = String(row.IsActive ?? "").toLowerCase();
  return s === "true" || s === "1";
}

function configFromBillingSolaRow(row: {
  credentialsEncrypted: string;
  simulate: boolean;
}): SolaRecurringClientConfig | null {
  const secrets = decryptJson<{ apiKey?: string }>(row.credentialsEncrypted);
  const apiKey = secrets.apiKey?.trim();
  if (!apiKey) return null;
  return { apiKey, simulate: !!row.simulate };
}

export async function resolveSolaRecurringClientConfig(
  tenantId?: string | null,
  dbClient: AnyDb = db as AnyDb,
): Promise<SolaRecurringClientConfig> {
  if (tenantId) {
    const row = await dbClient.billingSolaConfig.findUnique({ where: { tenantId } });
    if (row) {
      if (!row.isEnabled) {
        const err: Error & { code?: string } = new Error("SOLA_NOT_ENABLED");
        err.code = "SOLA_NOT_ENABLED";
        throw err;
      }
      const cfg = configFromBillingSolaRow(row);
      if (cfg) return cfg;
    }
  }

  const envKey = process.env.SOLA_CARDKNOX_API_KEY?.trim();
  if (envKey) {
    return {
      apiKey: envKey,
      simulate: process.env.SOLA_CARDKNOX_SIMULATE === "1",
    };
  }

  const fallback = await dbClient.billingSolaConfig.findFirst({
    where: { isEnabled: true },
    orderBy: [{ mode: "desc" }, { updatedAt: "desc" }],
  });
  if (fallback) {
    const cfg = configFromBillingSolaRow(fallback);
    if (cfg) return cfg;
  }

  const err: Error & { code?: string } = new Error("SOLA_NOT_CONFIGURED");
  err.code = "SOLA_NOT_CONFIGURED";
  throw err;
}

export function suggestTenantMatch(
  parsed: Pick<ParsedSolaSchedule, "customerEmail" | "customerName" | "companyName">,
  tenants: Array<{ id: string; name: string; billingEmail: string | null }>,
): TenantMatchCandidate {
  const email = parsed.customerEmail?.toLowerCase();
  if (email) {
    const exact = tenants.filter((t) => t.billingEmail?.toLowerCase() === email);
    if (exact.length === 1) {
      return {
        tenantId: exact[0].id,
        tenantName: exact[0].name,
        confidence: "exact_email",
        reason: `Billing email matches ${email}`,
      };
    }
    if (exact.length > 1) {
      return {
        tenantId: exact[0].id,
        tenantName: exact[0].name,
        confidence: "none",
        reason: `Multiple tenants share billing email ${email}`,
      };
    }
  }

  const companyNorm = parsed.companyName ? normalizeCompanyName(parsed.companyName) : "";
  if (companyNorm.length >= 3) {
    const companyHits = tenants.filter((t) => normalizeCompanyName(t.name) === companyNorm);
    if (companyHits.length === 1) {
      return {
        tenantId: companyHits[0].id,
        tenantName: companyHits[0].name,
        confidence: "company_name",
        reason: `Company name matches tenant "${companyHits[0].name}"`,
      };
    }
  }

  const nameNorm = parsed.customerName ? normalizeCompanyName(parsed.customerName) : "";
  if (nameNorm.length >= 4) {
    const fuzzy = tenants.filter((t) => {
      const tn = normalizeCompanyName(t.name);
      return tn.includes(nameNorm) || nameNorm.includes(tn);
    });
    if (fuzzy.length === 1) {
      return {
        tenantId: fuzzy[0].id,
        tenantName: fuzzy[0].name,
        confidence: "fuzzy_name",
        reason: `Name similar to tenant "${fuzzy[0].name}"`,
      };
    }
  }

  return { tenantId: "", tenantName: "", confidence: "none", reason: "No confident tenant match" };
}

export type SolaExternalScheduleDeps = {
  db: AnyDb;
  getRecurringClient: (tenantId?: string | null) => Promise<SolaRecurringClient>;
  loadTenants: () => Promise<Array<{ id: string; name: string; billingEmail: string | null }>>;
  logPlatformEvent: (input: { operatorId: string; type: string; metadata: Record<string, unknown> }) => Promise<void>;
  logTenantEvent?: (input: {
    tenantId: string;
    type: string;
    message?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  now?: () => Date;
};

async function logSolaImportPlatformEvent(
  database: AnyDb,
  input: { operatorId: string; type: string; metadata: Record<string, unknown> },
): Promise<void> {
  const probe = await (database as AnyDb).tenant.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
  if (!probe) return;
  await logBillingEvent({
    tenantId: probe.id,
    type: input.type,
    message: "Sola external schedule import.",
    metadata: { catalogScope: "sola_external_import", operatorId: input.operatorId, ...input.metadata },
  });
}

export function defaultSolaExternalScheduleDeps(): SolaExternalScheduleDeps {
  return {
    db: db as AnyDb,
    getRecurringClient: async (tenantId) => new SolaRecurringClient(await resolveSolaRecurringClientConfig(tenantId)),
    loadTenants: async () => {
      const rows = await (db as AnyDb).tenant.findMany({
        select: {
          id: true,
          name: true,
          billingSettings: { select: { billingEmail: true } },
        },
      });
      return rows.map((t: { id: string; name: string; billingSettings: { billingEmail: string | null } | null }) => ({
        id: t.id,
        name: t.name,
        billingEmail: t.billingSettings?.billingEmail ?? null,
      }));
    },
    logPlatformEvent: (input) => logSolaImportPlatformEvent(db as AnyDb, input),
    logTenantEvent: async (input) => {
      await logBillingEvent({
        tenantId: input.tenantId,
        type: input.type,
        message: input.message,
        metadata: input.metadata,
      });
    },
    now: () => new Date(),
  };
}

export async function syncSolaExternalSchedules(input: {
  operatorId: string;
  tenantId?: string | null;
  deps?: SolaExternalScheduleDeps;
}): Promise<SyncSolaSchedulesResult> {
  const deps = input.deps ?? defaultSolaExternalScheduleDeps();
  const client = await deps.getRecurringClient(input.tenantId);
  const tenants = await deps.loadTenants();
  const now = deps.now?.() ?? new Date();

  const result: SyncSolaSchedulesResult = {
    scanned: 0,
    created: 0,
    updated: 0,
    unmapped: 0,
    mapped: 0,
    ignored: 0,
    conflicts: 0,
    errors: [],
  };

  let nextToken: string | undefined;
  do {
    const page = await client.listSchedules({ pageSize: 100, nextToken, filters: { IsDeleted: false } });
    for (const row of page.items) {
      result.scanned += 1;
      try {
        const scheduleId = str(row.ScheduleId);
        if (!scheduleId) {
          result.errors.push({ message: "Schedule missing ScheduleId" });
          continue;
        }

        let detail = row;
        if (!str(row.PaymentMethodId)) {
          try {
            detail = await client.getSchedule(scheduleId);
          } catch {
            /* keep list row */
          }
        }

        let maskedPm: SolaRecurringPaymentMethodRow | null = null;
        const pmId = str(detail.PaymentMethodId);
        if (pmId) {
          try {
            maskedPm = await client.getPaymentMethodMasked(pmId);
          } catch {
            /* card metadata optional */
          }
        }

        const parsed = parseSolaScheduleRow(detail, maskedPm);
        const existing = await (deps.db as AnyDb).billingSolaExternalScheduleLink.findUnique({
          where: { solaScheduleId: parsed.solaScheduleId },
        });

        const match = suggestTenantMatch(parsed, tenants);
        const conflictSuggestion = match.confidence === "none" && match.reason.includes("Multiple tenants");
        const preserveMapping =
          existing && (existing.mappingStatus === "MAPPED" || existing.mappingStatus === "IGNORED");

        const metadataFields = {
          solaCustomerId: parsed.solaCustomerId,
          solaPaymentMethodId: parsed.solaPaymentMethodId,
          customerName: parsed.customerName,
          customerEmail: parsed.customerEmail,
          companyName: parsed.companyName,
          maskedCard: parsed.maskedCard,
          brand: parsed.brand,
          last4: parsed.last4,
          expMonth: parsed.expMonth,
          expYear: parsed.expYear,
          amountCents: parsed.amountCents,
          intervalType: parsed.intervalType,
          intervalCount: parsed.intervalCount,
          nextRunAt: parsed.nextRunAt,
          lastRunAt: parsed.lastRunAt,
          lastTransactionStatus: parsed.lastTransactionStatus,
          isActive: parsed.isActive,
          rawSafeJson: parsed.rawSafeJson as object,
          lastSyncedAt: now,
        };

        if (existing) {
          await (deps.db as AnyDb).billingSolaExternalScheduleLink.update({
            where: { id: existing.id },
            data: preserveMapping
              ? metadataFields
              : {
                  ...metadataFields,
                  suggestedTenantId: match.tenantId || null,
                  matchConfidence: match.confidence,
                  matchReason: match.reason,
                  mappingStatus: conflictSuggestion ? "CONFLICT" : existing.mappingStatus,
                },
          });
          result.updated += 1;
        } else {
          await (deps.db as AnyDb).billingSolaExternalScheduleLink.create({
            data: {
              ...metadataFields,
              solaScheduleId: parsed.solaScheduleId,
              mappingStatus: conflictSuggestion ? "CONFLICT" : "UNMAPPED",
              suggestedTenantId: match.tenantId || null,
              matchConfidence: match.confidence,
              matchReason: match.reason,
            },
          });
          result.created += 1;
        }
      } catch (e: unknown) {
        result.errors.push({
          solaScheduleId: str(row.ScheduleId) || undefined,
          message: e instanceof Error ? e.message : "sync_row_failed",
        });
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);

  const counts = await (deps.db as AnyDb).billingSolaExternalScheduleLink.groupBy({
    by: ["mappingStatus"],
    _count: { _all: true },
  });
  for (const row of counts) {
    const status = row.mappingStatus as SolaScheduleMappingStatus;
    const n = row._count._all;
    if (status === "UNMAPPED") result.unmapped = n;
    if (status === "MAPPED") result.mapped = n;
    if (status === "IGNORED") result.ignored = n;
    if (status === "CONFLICT") result.conflicts = n;
  }

  await deps.logPlatformEvent({
    operatorId: input.operatorId,
    type: "billing.sola_import_sync",
    metadata: { ...result, sourceTenantId: input.tenantId || null },
  });

  return result;
}

export async function mapSolaExternalSchedule(input: {
  linkId: string;
  tenantId: string;
  operatorId: string;
  deps?: SolaExternalScheduleDeps;
}): Promise<{ ok: true; link: unknown } | { ok: false; code: number; error: string }> {
  const deps = input.deps ?? defaultSolaExternalScheduleDeps();
  const link = await (deps.db as AnyDb).billingSolaExternalScheduleLink.findUnique({ where: { id: input.linkId } });
  if (!link) return { ok: false, code: 404, error: "schedule_link_not_found" };

  const tenant = await (deps.db as AnyDb).tenant.findUnique({ where: { id: input.tenantId }, select: { id: true } });
  if (!tenant) return { ok: false, code: 404, error: "tenant_not_found" };

  const now = deps.now?.() ?? new Date();
  const updated = await (deps.db as AnyDb).billingSolaExternalScheduleLink.update({
    where: { id: input.linkId },
    data: {
      tenantId: input.tenantId,
      suggestedTenantId: input.tenantId,
      mappingStatus: "MAPPED",
      mappedByUserId: input.operatorId,
      mappedAt: now,
    },
  });

  const logTenant = deps.logTenantEvent ?? defaultSolaExternalScheduleDeps().logTenantEvent!;
  await logTenant({
    tenantId: input.tenantId,
    type: "billing.sola_external_schedule_mapped",
    message: "Sola recurring schedule linked to Connect tenant (no charge)",
    metadata: {
      linkId: input.linkId,
      solaScheduleId: link.solaScheduleId,
      solaCustomerId: link.solaCustomerId,
      operatorId: input.operatorId,
    },
  });

  return { ok: true, link: updated };
}

export async function ignoreSolaExternalSchedule(input: {
  linkId: string;
  operatorId: string;
  deps?: SolaExternalScheduleDeps;
}): Promise<{ ok: true } | { ok: false; code: number; error: string }> {
  const deps = input.deps ?? defaultSolaExternalScheduleDeps();
  const link = await (deps.db as AnyDb).billingSolaExternalScheduleLink.findUnique({ where: { id: input.linkId } });
  if (!link) return { ok: false, code: 404, error: "schedule_link_not_found" };

  await (deps.db as AnyDb).billingSolaExternalScheduleLink.update({
    where: { id: input.linkId },
    data: { mappingStatus: "IGNORED", mappedByUserId: input.operatorId, mappedAt: deps.now?.() ?? new Date() },
  });

  const logTenant = deps.logTenantEvent ?? defaultSolaExternalScheduleDeps().logTenantEvent!;
  const logTenantId = link.tenantId || link.suggestedTenantId;
  if (logTenantId) {
    await logTenant({
      tenantId: logTenantId,
      type: "billing.sola_external_schedule_ignored",
      metadata: { linkId: input.linkId, solaScheduleId: link.solaScheduleId, operatorId: input.operatorId },
    });
  } else {
    await deps.logPlatformEvent({
      operatorId: input.operatorId,
      type: "billing.sola_external_schedule_ignored",
      metadata: { linkId: input.linkId, solaScheduleId: link.solaScheduleId },
    });
  }

  return { ok: true };
}

export async function unmapSolaExternalSchedule(input: {
  linkId: string;
  operatorId: string;
  deps?: SolaExternalScheduleDeps;
}): Promise<{ ok: true } | { ok: false; code: number; error: string }> {
  const deps = input.deps ?? defaultSolaExternalScheduleDeps();
  const link = await (deps.db as AnyDb).billingSolaExternalScheduleLink.findUnique({ where: { id: input.linkId } });
  if (!link) return { ok: false, code: 404, error: "schedule_link_not_found" };
  if (link.mappingStatus !== "MAPPED") return { ok: false, code: 400, error: "not_mapped" };

  await (deps.db as AnyDb).billingSolaExternalScheduleLink.update({
    where: { id: input.linkId },
    data: {
      tenantId: null,
      mappingStatus: "UNMAPPED",
      mappedByUserId: null,
      mappedAt: null,
    },
  });

  return { ok: true };
}

import type { PrismaClient } from "@connect/db";
import type { VitalPbxClient } from "@connect/integrations";

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/** Digits-only key for DID matching (consistent with CDR-style normalization). */
export function normalizeInboundDidDigits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = digitsOnly(raw);
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length < 3) return null;
  return d;
}

function extractPbxInboundId(entry: Record<string, unknown>): string | null {
  for (const k of ["id", "inbound_number_id", "inboundNumberId", "did_id", "didId"]) {
    const v = entry[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return null;
}

function extractNumberString(entry: unknown): string | null {
  if (typeof entry === "string" && entry.trim()) return entry.trim();
  if (!entry || typeof entry !== "object") return null;
  const o = entry as Record<string, unknown>;
  for (const k of [
    "number",
    "phone",
    "did",
    "callerid",
    "caller_id",
    "phone_number",
    "phoneNumber",
    "destination",
    "extension",
  ]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/**
 * Fetch VitalPBX inbound numbers per tenant and persist to PbxTenantInboundDid.
 * Call only from admin refresh / explicit sync — sequential PBX calls (1 list + N tenant DID lists per run).
 */
export async function syncPbxTenantInboundDids(
  db: PrismaClient,
  pbxInstanceId: string,
  client: VitalPbxClient,
  tenants: unknown[],
): Promise<{ tenantsProcessed: number; numbersUpserted: number; errors: string[] }> {
  const errors: string[] = [];
  const syncStartedAt = new Date(Date.now() - 2000);

  const [dirRows, links] = await Promise.all([
    db.pbxTenantDirectory.findMany({ where: { pbxInstanceId } }),
    db.tenantPbxLink.findMany({ where: { pbxInstanceId, status: "LINKED" } }),
  ]);
  const dirByVital = new Map(dirRows.map((r) => [r.vitalTenantId.trim(), r]));
  const connectByVital = new Map<string, string>();
  for (const l of links) {
    const v = (l.pbxTenantId || "").trim();
    if (v) connectByVital.set(v.toLowerCase(), l.tenantId);
    const code = (l.pbxTenantCode || "").trim().toUpperCase();
    if (code) {
      const hit = dirRows.find((r) => r.tenantCode.toUpperCase() === code);
      if (hit) connectByVital.set(hit.vitalTenantId.trim().toLowerCase(), l.tenantId);
    }
  }

  let tenantsProcessed = 0;
  let numbersUpserted = 0;

  for (const rawTenant of tenants) {
    const t = rawTenant as { tenant_id?: unknown; id?: unknown; name?: unknown };
    const vitalTenantId = String(t.tenant_id ?? t.id ?? "").trim();
    if (!vitalTenantId) continue;

    const dir = dirByVital.get(vitalTenantId) ?? null;
    const slug = (dir?.tenantSlug || String(t.name ?? "").trim()) || null;
    const code = dir?.tenantCode ?? null;
    const connectTenantId = connectByVital.get(vitalTenantId.toLowerCase()) ?? null;

    let inboundRows: unknown[] = [];
    try {
      inboundRows = await client.listTenantInboundNumbers(vitalTenantId);
    } catch (e: any) {
      errors.push(`${vitalTenantId}: ${e?.message || String(e)}`);
      continue;
    }
    tenantsProcessed++;

    for (const entry of inboundRows) {
      if (!entry || typeof entry !== "object") continue;
      const o = entry as Record<string, unknown>;
      const rawNum = extractNumberString(entry);
      const e164 = normalizeInboundDidDigits(rawNum);
      if (!e164) continue;
      const pbxInboundId = extractPbxInboundId(o);
      await db.pbxTenantInboundDid.upsert({
        where: {
          pbxInstanceId_e164: { pbxInstanceId, e164 },
        },
        create: {
          pbxInstanceId,
          vitalTenantId,
          e164,
          pbxInboundId,
          rawNumber: rawNum,
          pbxTenantSlug: slug,
          pbxTenantCode: code,
          connectTenantId,
          active: true,
          lastSeenAt: new Date(),
        },
        update: {
          vitalTenantId,
          pbxInboundId: pbxInboundId ?? undefined,
          rawNumber: rawNum ?? undefined,
          pbxTenantSlug: slug ?? undefined,
          pbxTenantCode: code ?? undefined,
          connectTenantId,
          active: true,
          lastSeenAt: new Date(),
        },
      });
      numbersUpserted++;
    }
  }

  await db.pbxTenantInboundDid.updateMany({
    where: {
      pbxInstanceId,
      active: true,
      lastSeenAt: { lt: syncStartedAt },
    },
    data: { active: false },
  });

  return { tenantsProcessed, numbersUpserted, errors };
}

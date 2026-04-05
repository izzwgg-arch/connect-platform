import type { PrismaClient } from "@connect/db";
import { decryptJson } from "@connect/security";
import { normalizeInboundDidDigits } from "@connect/integrations";

type OmbuRow = {
  did: string | Buffer | null;
  tenant_id: number | string | null;
  destination_id: number | string | null;
  tenant_name: string | null;
  tenant_prefix: string | null;
};

/**
 * Read-only sync from VitalPBX Ombutel MySQL: inbound DID → tenant_id.
 *
 * Source query (authoritative for inbound routing in multi-tenant VitalPBX):
 * ```sql
 * SELECT TRIM(CAST(r.did AS CHAR)) AS did,
 *        r.tenant_id AS tenant_id,
 *        r.destination_id AS destination_id,
 *        t.name AS tenant_name,
 *        t.prefix AS tenant_prefix
 * FROM ombutel.ombu_inbound_routes r
 * INNER JOIN ombutel.ombu_tenants t ON t.tenant_id = r.tenant_id
 * WHERE r.did IS NOT NULL AND TRIM(CAST(r.did AS CHAR)) <> ''
 * ```
 */
const OMBU_INBOUND_DID_SQL = `
SELECT TRIM(CAST(r.did AS CHAR)) AS did,
       r.tenant_id AS tenant_id,
       r.destination_id AS destination_id,
       t.name AS tenant_name,
       t.prefix AS tenant_prefix
FROM ombutel.ombu_inbound_routes r
INNER JOIN ombutel.ombu_tenants t ON t.tenant_id = r.tenant_id
WHERE r.did IS NOT NULL AND TRIM(CAST(r.did AS CHAR)) <> ''
`.trim();

function asString(v: string | Buffer | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return String(v);
}

function tenantCodeFromPrefix(prefix: string | null | undefined): string | null {
  const p = (prefix || "").trim();
  if (!p) return null;
  const stripped = p.endsWith("_") ? p.slice(0, -1) : p;
  return stripped.toUpperCase() || null;
}

function slugFromTenantName(name: string | null | undefined): string | null {
  const n = (name || "").trim();
  if (!n) return null;
  return n
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export type OmbutelInboundDidSyncResult = {
  source: "ombutel_mysql";
  rowsRead: number;
  tenantsProcessed: number;
  numbersUpserted: number;
  errors: string[];
};

export type OmbutelInboundDidSyncSkip = {
  source: "skipped";
  skipReason: string;
  tenantsProcessed: 0;
  numbersUpserted: 0;
  errors: string[];
};

/**
 * Upserts PbxTenantInboundDid from ombutel.ombu_inbound_routes (+ tenant names/prefixes).
 * `ombuMysqlUrlEncrypted` must be set on the PbxInstance (encryptJson({ mysqlUrl: "mysql://..." }) recommended).
 */
export async function syncInboundDidsFromOmbutelMysql(
  db: PrismaClient,
  pbxInstanceId: string,
  ombuMysqlUrlEncrypted: string | null | undefined,
): Promise<OmbutelInboundDidSyncResult | OmbutelInboundDidSyncSkip> {
  if (!ombuMysqlUrlEncrypted?.trim()) {
    return {
      source: "skipped",
      skipReason: "ombuMysqlUrlEncrypted not configured on PbxInstance",
      tenantsProcessed: 0,
      numbersUpserted: 0,
      errors: [],
    };
  }

  let mysqlUrl: string;
  try {
    const parsed = decryptJson<{ mysqlUrl?: string; url?: string }>(ombuMysqlUrlEncrypted.trim());
    mysqlUrl = String(parsed.mysqlUrl || parsed.url || "").trim();
  } catch {
    return {
      source: "skipped",
      skipReason: "ombuMysqlUrlEncrypted could not be decrypted (use encryptJson({ mysqlUrl }) )",
      tenantsProcessed: 0,
      numbersUpserted: 0,
      errors: [],
    };
  }
  if (!mysqlUrl) {
    return {
      source: "skipped",
      skipReason: "decrypted payload missing mysqlUrl",
      tenantsProcessed: 0,
      numbersUpserted: 0,
      errors: [],
    };
  }

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

  let mysql: typeof import("mysql2/promise");
  try {
    mysql = await import("mysql2/promise");
  } catch (e: any) {
    return {
      source: "skipped",
      skipReason: `mysql2 package not available: ${e?.message || String(e)}`,
      tenantsProcessed: 0,
      numbersUpserted: 0,
      errors: [],
    };
  }

  let conn: import("mysql2/promise").Connection;
  try {
    conn = await mysql.createConnection(mysqlUrl);
  } catch (e: any) {
    errors.push(`MySQL connect: ${e?.message || String(e)}`);
    return { source: "ombutel_mysql", rowsRead: 0, tenantsProcessed: 0, numbersUpserted: 0, errors };
  }

  let rows: OmbuRow[];
  try {
    const [r2] = await conn.query(OMBU_INBOUND_DID_SQL);
    rows = r2 as OmbuRow[];
  } catch (e: any) {
    errors.push(`MySQL query: ${e?.message || String(e)}`);
    await conn.end().catch(() => {});
    return { source: "ombutel_mysql", rowsRead: 0, tenantsProcessed: 0, numbersUpserted: 0, errors };
  } finally {
    await conn.end().catch(() => {});
  }

  const tenantIdsSeen = new Set<string>();
  let numbersUpserted = 0;

  for (const raw of rows) {
    const didRaw = asString(raw.did);
    const e164 = normalizeInboundDidDigits(didRaw);
    if (!e164) continue;
    const vitalTenantId = String(raw.tenant_id ?? "").trim();
    if (!vitalTenantId) continue;
    tenantIdsSeen.add(vitalTenantId);

    const dir = dirByVital.get(vitalTenantId) ?? null;
    const codeFromDb = tenantCodeFromPrefix(asString(raw.tenant_prefix));
    const code = (dir?.tenantCode ?? codeFromDb ?? "").trim().toUpperCase() || null;
    const slug = dir?.tenantSlug ?? slugFromTenantName(asString(raw.tenant_name)) ?? null;
    const connectTenantId = connectByVital.get(vitalTenantId.toLowerCase()) ?? null;
    const dest = raw.destination_id;
    const pbxInboundId =
      dest !== null && dest !== undefined && String(dest).trim() !== "" ? String(dest).trim() : null;

    await db.pbxTenantInboundDid.upsert({
      where: { pbxInstanceId_e164: { pbxInstanceId, e164 } },
      create: {
        pbxInstanceId,
        vitalTenantId,
        e164,
        pbxInboundId,
        rawNumber: didRaw.trim() || null,
        pbxTenantSlug: slug,
        pbxTenantCode: code,
        connectTenantId,
        active: true,
        lastSeenAt: new Date(),
      },
      update: {
        vitalTenantId,
        pbxInboundId: pbxInboundId ?? undefined,
        rawNumber: didRaw.trim() || null,
        pbxTenantSlug: slug ?? undefined,
        pbxTenantCode: code ?? undefined,
        connectTenantId,
        active: true,
        lastSeenAt: new Date(),
      },
    });
    numbersUpserted++;
  }

  await db.pbxTenantInboundDid.updateMany({
    where: {
      pbxInstanceId,
      active: true,
      lastSeenAt: { lt: syncStartedAt },
    },
    data: { active: false },
  });

  return {
    source: "ombutel_mysql",
    rowsRead: rows.length,
    tenantsProcessed: tenantIdsSeen.size,
    numbersUpserted,
    errors,
  };
}

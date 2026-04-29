import type { PrismaClient } from "@connect/db";
import { decryptJson } from "@connect/security";

/**
 * Read-only sync of VitalPBX Music-On-Hold *classes* (groups) into Connect's
 * PbxMohClass catalog. Source: `ombutel.ombu_music_groups` over the same
 * read-only MariaDB connection already used by the DID + prompt syncs.
 *
 * Hard limits (to keep the PBX calm):
 *   - One indexed SELECT on `ombu_music_groups` (LIMIT 2000).
 *   - One indexed aggregate SELECT on `ombu_music_files` (grouped by
 *     music_group_id, LIMIT 2000).
 *   - One lookup on `ombu_tenants` / `tenants` for tenant_id → slug.
 * Nothing else touches the PBX. No filesystem scan. No shell. No polling loop.
 *
 * Tenant mapping: same channel as prompt sync — `db.tenantPbxLink.pbxTenantId`
 * (numeric, string-compared) resolves VitalPBX tenant_id → Connect tenantId.
 * If no mapping exists we store the row with `tenantId = null` so a super-admin
 * can still see it in the "all tenants" view.
 */

export type MohClassSyncResult =
  | {
      source: "ombutel_mysql";
      table: string;
      rowsRead: number;
      created: number;
      updated: number;
      deactivated: number;
      unassigned: number;
      perTenant: Array<{ tenantId: string | null; tenantSlug: string | null; count: number }>;
      sample: Array<{ pbxGroupId: number; displayName: string; runtimeClass: string; rawTenant: string | null; resolvedTenantId: string | null }>;
      errors: string[];
    }
  | {
      source: "skipped";
      skipReason: string;
      errors: string[];
    };

type DbRow = Record<string, unknown>;

function slugify(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function syncMohClassesFromOmbutelMysql(
  db: PrismaClient,
  pbxInstanceId: string,
  ombuMysqlUrlEncrypted: string | null | undefined,
  options: { deactivateMissing?: boolean } = {},
): Promise<MohClassSyncResult> {
  if (!ombuMysqlUrlEncrypted?.trim()) {
    return {
      source: "skipped",
      skipReason: "ombuMysqlUrlEncrypted not configured on PbxInstance",
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
      skipReason: "ombuMysqlUrlEncrypted could not be decrypted",
      errors: [],
    };
  }
  if (!mysqlUrl) {
    return { source: "skipped", skipReason: "decrypted payload missing mysqlUrl", errors: [] };
  }

  let mysql: typeof import("mysql2/promise");
  try {
    mysql = await import("mysql2/promise");
  } catch (e: any) {
    return {
      source: "skipped",
      skipReason: `mysql2 package not available: ${e?.message || String(e)}`,
      errors: [],
    };
  }

  const errors: string[] = [];
  let conn: import("mysql2/promise").Connection | null = null;
  try {
    conn = await mysql.createConnection(mysqlUrl);
  } catch (e: any) {
    return {
      source: "ombutel_mysql",
      table: "(none)",
      rowsRead: 0, created: 0, updated: 0, deactivated: 0, unassigned: 0,
      perTenant: [], sample: [],
      errors: [`MySQL connect: ${e?.message || String(e)}`],
    };
  }

  try {
    // Discover schema + confirm table exists.
    const [[dbRow]] = (await conn.query("SELECT DATABASE() AS db")) as [DbRow[], unknown];
    const schema = String((dbRow as any)?.db || "").trim();
    if (!schema) {
      return {
        source: "ombutel_mysql",
        table: "(none)", rowsRead: 0, created: 0, updated: 0, deactivated: 0, unassigned: 0,
        perTenant: [], sample: [], errors: ["MySQL URL has no database selected"],
      };
    }

    const [tRows] = (await conn.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME IN ('ombu_music_groups','music_groups','musiconhold_classes')`,
      [schema],
    )) as [DbRow[], unknown];
    const table = (tRows[0] as any)?.TABLE_NAME ? String((tRows[0] as any).TABLE_NAME) : null;
    if (!table) {
      return {
        source: "ombutel_mysql",
        table: "(none)", rowsRead: 0, created: 0, updated: 0, deactivated: 0, unassigned: 0,
        perTenant: [], sample: [],
        errors: [`No MOH-groups table found in schema "${schema}". Looked for ombu_music_groups / music_groups / musiconhold_classes.`],
      };
    }

    // Load the tenant mapping (same sources as prompt sync).
    const [pbxLinks, dirRows, ombuTenantsRaw] = await Promise.all([
      db.tenantPbxLink.findMany({
        where: {
          pbxInstanceId,
          OR: [{ status: "LINKED" }, { status: "ERROR", pbxTenantId: { not: null } }],
        },
      }),
      db.pbxTenantDirectory.findMany({ where: { pbxInstanceId } }),
      conn.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('ombu_tenants','tenants')`,
        [schema],
      ) as Promise<[DbRow[], unknown]>,
    ]);
    const tenantsTableRows = ombuTenantsRaw[0] as DbRow[];
    const tenantsTable = tenantsTableRows.find((r) => String((r as any).TABLE_NAME) === "ombu_tenants")
      ? "ombu_tenants"
      : tenantsTableRows.find((r) => String((r as any).TABLE_NAME) === "tenants")
        ? "tenants"
        : null;

    const vitalToConnect = new Map<string, string>();
    for (const l of pbxLinks) {
      const v = (l.pbxTenantId || "").trim();
      if (v) vitalToConnect.set(v.toLowerCase(), l.tenantId);
    }
    const dirByVital = new Map(dirRows.map((r) => [r.vitalTenantId.trim().toLowerCase(), r]));

    // Optional: pull human tenant names / prefixes for the response summary.
    const tenantNameByVital = new Map<string, string>();
    if (tenantsTable) {
      try {
        const [tr] = (await conn.query(
          `SELECT tenant_id AS id, name FROM \`${schema}\`.\`${tenantsTable}\` LIMIT 5000`,
        )) as [DbRow[], unknown];
        for (const r of tr) {
          const id = String((r as any).id ?? "").trim();
          const name = String((r as any).name ?? "").trim();
          if (id) tenantNameByVital.set(id, name);
        }
      } catch (e: any) {
        errors.push(`ombu_tenants query: ${e?.message || String(e)}`);
      }
    }

    // 1. Load all groups.
    const [gRows] = (await conn.query(
      `SELECT music_group_id, name, type, application, streaming_url, streaming_format,
              \`default\` AS is_default, tenant_id
         FROM \`${schema}\`.\`${table}\`
        LIMIT 2000`,
    )) as [DbRow[], unknown];
    const groups = gRows as Array<{
      music_group_id: number | string;
      name: string | Buffer | null;
      type: string | null;
      application: string | null;
      streaming_url: string | null;
      streaming_format: string | null;
      is_default: string | null;
      tenant_id: number | string | null;
    }>;

    // 2. Rollup of file counts per group — one aggregate query. If the files
    //    table is missing (older builds) we silently fall back to 0.
    const fileCountByGroup = new Map<number, number>();
    try {
      const [fcRows] = (await conn.query(
        `SELECT music_group_id, COUNT(*) AS n
           FROM \`${schema}\`.\`ombu_music_files\`
          GROUP BY music_group_id
          LIMIT 2000`,
      )) as [DbRow[], unknown];
      for (const r of fcRows) {
        const id = Number((r as any).music_group_id);
        const n = Number((r as any).n);
        if (Number.isFinite(id) && Number.isFinite(n)) fileCountByGroup.set(id, n);
      }
    } catch { /* table missing — fine */ }

    // 3. Upsert each group.
    const now = new Date();
    let created = 0;
    let updated = 0;
    let unassigned = 0;
    const seenGroupIds: number[] = [];
    const perTenantCounts = new Map<string, { tenantId: string | null; tenantSlug: string | null; count: number }>();
    const sample: Array<{ pbxGroupId: number; displayName: string; runtimeClass: string; rawTenant: string | null; resolvedTenantId: string | null }> = [];

    for (const g of groups) {
      const pbxGroupId = Number(g.music_group_id);
      if (!Number.isFinite(pbxGroupId)) continue;
      const name = Buffer.isBuffer(g.name) ? g.name.toString("utf8") : String(g.name ?? "").trim();
      if (!name) continue;
      seenGroupIds.push(pbxGroupId);

      const rawTenant = g.tenant_id == null ? "" : String(g.tenant_id).trim();
      const connectTenantId = rawTenant ? (vitalToConnect.get(rawTenant.toLowerCase()) ?? null) : null;
      const tenantSlug = rawTenant ? (dirByVital.get(rawTenant.toLowerCase())?.tenantSlug ?? null)
                                   : null;
      if (!connectTenantId) unassigned += 1;

      const bucketKey = connectTenantId ?? "__unassigned__";
      const bucket = perTenantCounts.get(bucketKey);
      if (bucket) bucket.count += 1;
      else perTenantCounts.set(bucketKey, { tenantId: connectTenantId, tenantSlug, count: 1 });

      // VitalPBX stores the human label in `name` but exposes the runtime
      // Asterisk class as `moh<group_id>` in musiconhold.conf.
      const mohClassName = `moh${pbxGroupId}`;
      if (sample.length < 8) {
        sample.push({ pbxGroupId, displayName: name, runtimeClass: mohClassName, rawTenant: rawTenant || null, resolvedTenantId: connectTenantId });
      }
      const classType = (g.type || "").toString().trim().toLowerCase() || null;
      const isDefault = String(g.is_default || "").toLowerCase() === "yes";

      const existing = await (db as any).pbxMohClass.findUnique({
        where: { pbxInstanceId_pbxGroupId: { pbxInstanceId, pbxGroupId } },
      });
      if (existing) {
        await (db as any).pbxMohClass.update({
          where: { id: existing.id },
          data: {
            tenantId: connectTenantId,
            tenantSlug,
            pbxTenantId: rawTenant || null,
            name,
            mohClassName,
            classType,
            streamingUrl: g.streaming_url || null,
            streamingFormat: g.streaming_format || null,
            isDefault,
            fileCount: fileCountByGroup.get(pbxGroupId) ?? 0,
            isActive: true,
            lastSeenAt: now,
          },
        });
        updated += 1;
      } else {
        await (db as any).pbxMohClass.create({
          data: {
            pbxInstanceId,
            tenantId: connectTenantId,
            tenantSlug,
            pbxGroupId,
            pbxTenantId: rawTenant || null,
            name,
            mohClassName,
            classType,
            streamingUrl: g.streaming_url || null,
            streamingFormat: g.streaming_format || null,
            isDefault,
            fileCount: fileCountByGroup.get(pbxGroupId) ?? 0,
            isActive: true,
            firstSeenAt: now,
            lastSeenAt: now,
          },
        });
        created += 1;
      }
    }

    // 4. Optional — deactivate rows whose group_id is no longer in VitalPBX.
    let deactivated = 0;
    if (options.deactivateMissing) {
      const res = await (db as any).pbxMohClass.updateMany({
        where: {
          pbxInstanceId,
          isActive: true,
          pbxGroupId: { notIn: seenGroupIds.length ? seenGroupIds : [-1] },
        },
        data: { isActive: false, lastSeenAt: now },
      });
      deactivated = res.count ?? 0;
    }

    const perTenant = Array.from(perTenantCounts.values()).sort((a, b) => b.count - a.count);

    // Touch unused var to avoid TS unused warnings in some builds.
    void tenantNameByVital;

    return {
      source: "ombutel_mysql",
      table,
      rowsRead: groups.length,
      created,
      updated,
      deactivated,
      unassigned,
      perTenant,
      sample,
      errors,
    };
  } catch (e: any) {
    return {
      source: "ombutel_mysql",
      table: "(none)",
      rowsRead: 0, created: 0, updated: 0, deactivated: 0, unassigned: 0,
      perTenant: [], sample: [],
      errors: [`sync error: ${e?.message || String(e)}`, ...errors],
    };
  } finally {
    try { await conn?.end(); } catch { /* ignore */ }
  }
}

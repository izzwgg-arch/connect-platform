import { decryptJson } from "@connect/security";

/**
 * Read-only, on-demand listing of VitalPBX Ring Groups for a given VitalPBX
 * tenant_id, pulled directly from the Ombutel MariaDB. No sync step — every
 * call hits the live DB, because the dropdown is only needed while an admin
 * is editing an IVR option and the result set is tiny (<100 rows per tenant).
 *
 * Why not the VitalPBX REST API? The public REST collection doesn't expose
 * ring-groups in VitalPBX 4 (the `VitalPbxClient.listRingGroups` shim throws
 * `NOT_SUPPORTED`). Ombutel MariaDB is the authoritative source anyway.
 *
 * Schema discovery: VitalPBX has shifted table names between versions. We
 * discover the ring-group table at runtime by checking INFORMATION_SCHEMA
 * for any of the known candidates and picking the first one that exists,
 * with its tenant column auto-detected (tenant_id / tenantid).
 *
 * Returns `{ rows: [] }` when:
 *   - ombuMysqlUrlEncrypted is not configured or can't be decrypted
 *   - mysql2 package isn't installed (shouldn't happen in prod — same dep
 *     as the existing sync helpers)
 *   - No ring-group table is present in the Ombutel schema
 * so the caller UI can fall back to a free-text input without blowing up.
 */

export type RingGroupRow = {
  id: string | null;
  number: string;         // extension / group number — the only field the CEP needs
  name: string | null;    // display label shown in the dropdown (may duplicate number)
  strategy: string | null;
  tenantId: string | null; // VitalPBX tenant_id (string-compared)
};

export type RingGroupListResult =
  | {
      source: "ombutel_mysql";
      table: string;
      rows: RingGroupRow[];
      error: null;
    }
  | {
      source: "skipped";
      skipReason: string;
      rows: [];
      error: string | null;
    };

type DbRow = Record<string, unknown>;

// Candidates are tried in priority order. `tenantCols` lists known tenant-scope
// column names per candidate — first one present in the table is used.
const CANDIDATES: Array<{ table: string; tenantCols: string[]; numberCols: string[]; nameCols: string[]; strategyCols: string[]; idCols: string[] }> = [
  {
    table: "ombu_ring_groups",
    tenantCols: ["tenant_id", "tenantid"],
    numberCols: ["group_number", "ring_group_number", "extension", "number"],
    nameCols:   ["description", "name", "group_name"],
    strategyCols: ["strategy", "ring_strategy"],
    idCols: ["ring_group_id", "id"],
  },
  {
    table: "ring_groups",
    tenantCols: ["tenant_id", "tenantid"],
    numberCols: ["extension", "number", "grpnum"],
    nameCols:   ["description", "name"],
    strategyCols: ["strategy"],
    idCols: ["id", "grpnum"],
  },
];

export async function listRingGroupsFromOmbutel(
  vitalTenantId: string | null,
  ombuMysqlUrlEncrypted: string | null | undefined,
): Promise<RingGroupListResult> {
  if (!ombuMysqlUrlEncrypted?.trim()) {
    return { source: "skipped", skipReason: "ombuMysqlUrlEncrypted not configured on PbxInstance", rows: [], error: null };
  }

  let mysqlUrl: string;
  try {
    const parsed = decryptJson<{ mysqlUrl?: string; url?: string }>(ombuMysqlUrlEncrypted.trim());
    mysqlUrl = String(parsed.mysqlUrl || parsed.url || "").trim();
  } catch {
    return { source: "skipped", skipReason: "ombuMysqlUrlEncrypted could not be decrypted", rows: [], error: null };
  }
  if (!mysqlUrl) {
    return { source: "skipped", skipReason: "decrypted payload missing mysqlUrl", rows: [], error: null };
  }

  let mysql: typeof import("mysql2/promise");
  try {
    mysql = await import("mysql2/promise");
  } catch (e: any) {
    return { source: "skipped", skipReason: `mysql2 unavailable: ${e?.message || String(e)}`, rows: [], error: null };
  }

  let conn: import("mysql2/promise").Connection | null = null;
  try {
    conn = await mysql.createConnection(mysqlUrl);
  } catch (e: any) {
    return { source: "skipped", skipReason: `mysql connect: ${e?.message || String(e)}`, rows: [], error: e?.message || String(e) };
  }

  try {
    const [[dbRow]] = (await conn.query("SELECT DATABASE() AS db")) as [DbRow[], unknown];
    const schema = String((dbRow as any)?.db || "").trim();
    if (!schema) {
      return { source: "skipped", skipReason: "MySQL URL has no database selected", rows: [], error: null };
    }

    // Find which candidate table actually exists in this schema. Single
    // INFORMATION_SCHEMA round-trip — cheap.
    const candidateNames = CANDIDATES.map((c) => c.table);
    const placeholders = candidateNames.map(() => "?").join(",");
    const [tRows] = (await conn.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
      [schema, ...candidateNames],
    )) as [DbRow[], unknown];
    const presentTables = new Set((tRows as DbRow[]).map((r) => String((r as any).TABLE_NAME)));

    const chosen = CANDIDATES.find((c) => presentTables.has(c.table));
    if (!chosen) {
      return { source: "skipped", skipReason: `no known ring-group table in schema "${schema}"`, rows: [], error: null };
    }

    // Inspect the chosen table's columns so we can build a query that won't
    // 1054 on a missing column when VitalPBX versions vary.
    const [cRows] = (await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, chosen.table],
    )) as [DbRow[], unknown];
    const columns = new Set((cRows as DbRow[]).map((r) => String((r as any).COLUMN_NAME)));

    const pick = (candidates: string[]): string | null => candidates.find((c) => columns.has(c)) ?? null;
    const numberCol   = pick(chosen.numberCols);
    const nameCol     = pick(chosen.nameCols);
    const strategyCol = pick(chosen.strategyCols);
    const tenantCol   = pick(chosen.tenantCols);
    const idCol       = pick(chosen.idCols);
    if (!numberCol) {
      return { source: "skipped", skipReason: `table "${chosen.table}" has no known number column (tried ${chosen.numberCols.join("/")})`, rows: [], error: null };
    }

    const selectParts: string[] = [
      `${numberCol} AS \`_number\``,
      `${idCol ? `${idCol} AS \`_id\`` : "NULL AS `_id`"}`,
      `${nameCol ? `${nameCol} AS \`_name\`` : "NULL AS `_name`"}`,
      `${strategyCol ? `${strategyCol} AS \`_strategy\`` : "NULL AS `_strategy`"}`,
      `${tenantCol ? `${tenantCol} AS \`_tenant\`` : "NULL AS `_tenant`"}`,
    ];

    let where = "";
    const params: any[] = [];
    if (tenantCol && vitalTenantId) {
      where = `WHERE \`${tenantCol}\` = ?`;
      params.push(vitalTenantId);
    }

    const sql = `SELECT ${selectParts.join(", ")} FROM ${chosen.table} ${where} ORDER BY ${numberCol} ASC LIMIT 200`;
    const [rRows] = (await conn.query(sql, params)) as [DbRow[], unknown];

    const out: RingGroupRow[] = (rRows as DbRow[]).map((r) => ({
      id: r["_id"] != null ? String(r["_id"]) : null,
      number: String(r["_number"] ?? "").trim(),
      name: r["_name"] != null ? String(r["_name"]) : null,
      strategy: r["_strategy"] != null ? String(r["_strategy"]) : null,
      tenantId: r["_tenant"] != null ? String(r["_tenant"]) : null,
    })).filter((r) => r.number);

    return { source: "ombutel_mysql", table: chosen.table, rows: out, error: null };
  } catch (e: any) {
    return { source: "skipped", skipReason: `mysql query: ${e?.message || String(e)}`, rows: [], error: e?.message || String(e) };
  } finally {
    await conn.end().catch(() => {});
  }
}

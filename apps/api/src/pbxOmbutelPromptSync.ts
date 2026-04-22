import type { PrismaClient } from "@connect/db";
import { decryptJson } from "@connect/security";

/**
 * Read-only sync of VitalPBX System Recordings into Connect's TenantPbxPrompt
 * catalog. Source: the VitalPBX `ombutel` MariaDB, same read-only connection
 * already used by `pbxOmbutelInboundDidSync.ts`. No SSH. No filesystem scan.
 * Exactly two indexed SELECTs per run; no PBX load beyond that.
 *
 * VitalPBX's recordings schema isn't formally published, so we DISCOVER the
 * right table + columns from INFORMATION_SCHEMA rather than hard-coding names.
 * That keeps us robust across VitalPBX 4.x point releases and Ombutel builds.
 */

export type PromptAutoSyncResult =
  | {
      source: "ombutel_mysql";
      table: string;
      tenantColumn: string | null;
      tenantColumnType: "numeric" | "string" | "none";
      ombuTenantsSeen: number;
      rowsRead: number;
      created: number;
      updated: number;
      unassigned: number;
      deactivated: number;
      /** Per-Connect-tenant breakdown so admins can see where rows landed. */
      perTenant: Array<{ tenantId: string | null; tenantSlug: string | null; count: number }>;
      /** First few sample rows for debugging (filename + resolved tenant). */
      sample: Array<{ ref: string; rawTenant: string | null; resolvedConnectTenantId: string | null; method: string }>;
      errors: string[];
    }
  | {
      source: "skipped";
      skipReason: string;
      errors: string[];
    };

type DbRow = Record<string, unknown>;

/** Promptish column-name guesses, in priority order. */
const COLS_FILENAME = ["filename", "file_name", "file", "recording", "audio_file", "name"];
const COLS_DISPLAY = ["description", "display_name", "label", "name", "title"];
// Prefer the numeric FK; fall back to the string-prefix column (older builds / Ombutel).
const COLS_TENANT = ["tenant_id", "tenantid", "tenant"];
const COLS_ID = ["id", "recording_id", "system_recording_id"];

/** Numeric MySQL types we treat as "tenant_id is a numeric FK". */
const NUMERIC_TYPES = new Set([
  "tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric",
]);

function stripTrailingSep(s: string): string {
  return s.replace(/[_\-]+$/, "");
}

function slugify(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Return the first column from `candidates` that exists in `actual` (case-insensitive). */
function pickColumn(candidates: string[], actual: Set<string>): string | null {
  const lower = new Map(Array.from(actual).map((c) => [c.toLowerCase(), c]));
  for (const c of candidates) {
    const hit = lower.get(c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Strip common Asterisk audio extensions and normalise path. */
function stripExt(s: string): string {
  return s.replace(/\.(wav|gsm|ulaw|alaw|sln\d*|g722|g729|mp3|wav49)$/i, "");
}

/** Build `custom/<base>` if the raw value is a bare filename; otherwise return as-is. */
function canonicaliseRef(raw: string): string {
  let ref = stripExt(String(raw || "").trim());
  if (!ref) return "";
  // Drop a leading sounds-dir prefix we don't want in the ref.
  ref = ref.replace(/^\/?var\/lib\/asterisk\/sounds\//, "");
  // Drop leading/trailing slashes.
  ref = ref.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!ref.includes("/")) ref = `custom/${ref}`;
  return ref;
}

/** Same format guard the rest of the IVR code enforces. */
const IVR_PROMPT_REF_REGEX = /^[A-Za-z0-9_\-./]{1,160}$/;

export async function syncPromptsFromOmbutelMysql(
  db: PrismaClient,
  pbxInstanceId: string,
  ombuMysqlUrlEncrypted: string | null | undefined,
  options: { deactivateMissing?: boolean } = {},
): Promise<PromptAutoSyncResult> {
  if (!ombuMysqlUrlEncrypted?.trim()) {
    return {
      source: "skipped",
      skipReason: "ombuMysqlUrlEncrypted not configured on PbxInstance — open Admin → PBX Instances and set the read-only MySQL URL",
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
      skipReason: "ombuMysqlUrlEncrypted could not be decrypted (use encryptJson({ mysqlUrl: 'mysql://user:pass@host:3306/ombutel' }))",
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
    return makeEmptyResult("(none)", null, "none", [`MySQL connect: ${e?.message || String(e)}`]);
  }

  try {
    // 1. Resolve which DB schema we're connected to (the URL includes it).
    //    `SELECT DATABASE()` is O(1) and avoids relying on URL parsing.
    const [[dbRow]] = (await conn.query("SELECT DATABASE() AS db")) as [DbRow[], unknown];
    const schema = String((dbRow as any)?.db || "").trim();
    if (!schema) {
      return makeEmptyResult("(none)", null, "none", ["MySQL URL has no database selected"]);
    }

    // 2. Discover the recordings table. VitalPBX 4 uses ombu_system_recordings
    //    but older Ombutel builds use different names, so we search.
    const candidateTables = [
      "ombu_system_recordings",
      "ombu_recordings",
      "system_recordings",
      "recordings",
    ];
    const [tRows] = (await conn.query(
      `SELECT TABLE_NAME
         FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME IN (?)`,
      [schema, candidateTables],
    )) as [DbRow[], unknown];

    let table: string | null = null;
    const found = new Set(tRows.map((r) => String((r as any).TABLE_NAME)));
    for (const c of candidateTables) if (found.has(c)) { table = c; break; }

    if (!table) {
      // Fallback: fuzzy match anything that looks like a recordings table.
      const [fuzzy] = (await conn.query(
        `SELECT TABLE_NAME
           FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = ?
            AND (TABLE_NAME LIKE '%recording%' OR TABLE_NAME LIKE '%announcement%')
          ORDER BY TABLE_NAME
          LIMIT 1`,
        [schema],
      )) as [DbRow[], unknown];
      table = fuzzy[0] ? String((fuzzy[0] as any).TABLE_NAME) : null;
    }

    if (!table) {
      return makeEmptyResult("(none)", null, "none", [
        `No system-recordings table found in schema "${schema}". Looked for: ${candidateTables.join(", ")} and anything *recording*/*announcement*. Confirm the ombu MySQL user can see this schema.`,
      ]);
    }

    // 3. Introspect columns so we pick the right ones without guessing.
    //    Keep DATA_TYPE too so we can tell numeric tenant_id apart from a
    //    string-prefix `tenant` column (older Ombutel builds use the latter).
    const [cRows] = (await conn.query(
      `SELECT COLUMN_NAME, DATA_TYPE
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, table],
    )) as [DbRow[], unknown];
    const cols = new Set(cRows.map((r) => String((r as any).COLUMN_NAME)));
    const typeByCol = new Map<string, string>(
      cRows.map((r) => [String((r as any).COLUMN_NAME).toLowerCase(), String((r as any).DATA_TYPE || "").toLowerCase()]),
    );
    const colFile = pickColumn(COLS_FILENAME, cols);
    const colDisplay = pickColumn(COLS_DISPLAY, cols);
    const colTenant = pickColumn(COLS_TENANT, cols);
    const colId = pickColumn(COLS_ID, cols);

    const tenantColumnType: "numeric" | "string" | "none" = !colTenant
      ? "none"
      : NUMERIC_TYPES.has(typeByCol.get(colTenant.toLowerCase()) || "")
        ? "numeric"
        : "string";

    if (!colFile) {
      return {
        source: "ombutel_mysql",
        table,
        tenantColumn: colTenant,
        tenantColumnType,
        ombuTenantsSeen: 0,
        rowsRead: 0,
        created: 0,
        updated: 0,
        unassigned: 0,
        deactivated: 0,
        perTenant: [],
        sample: [],
        errors: [
          `Table "${schema}.${table}" has no recognisable filename column. Columns seen: ${Array.from(cols).join(", ")}`,
        ],
      };
    }

    // 4. Build the tenant-map once. Same source of truth as the DID sync,
    //    PLUS a prefix → vitalTenantId map (for tables that store the tenant
    //    as a string prefix like "acme_" rather than the numeric FK).
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
    // Lookup the tenants table (ombu_tenants in VitalPBX 4, sometimes just tenants).
    const tenantsTableRows = ombuTenantsRaw[0];
    const tenantsTable = tenantsTableRows.find((r) => String((r as any).TABLE_NAME) === "ombu_tenants")
      ? "ombu_tenants"
      : tenantsTableRows.find((r) => String((r as any).TABLE_NAME) === "tenants")
        ? "tenants"
        : null;

    type OmbuTenant = { id: string; name: string; prefix: string };
    const ombuTenants: OmbuTenant[] = [];
    if (tenantsTable) {
      try {
        const [tr] = (await conn.query(
          `SELECT tenant_id AS id, name, prefix FROM \`${schema}\`.\`${tenantsTable}\` LIMIT 5000`,
        )) as [DbRow[], unknown];
        for (const r of tr) {
          const id = String((r as any).id ?? "").trim();
          if (!id) continue;
          ombuTenants.push({
            id,
            name: String((r as any).name ?? "").trim(),
            prefix: String((r as any).prefix ?? "").trim(),
          });
        }
      } catch (e: any) {
        errors.push(`ombu_tenants query: ${e?.message || String(e)}`);
      }
    }

    const vitalToConnect = new Map<string, string>();
    for (const l of pbxLinks) {
      const v = (l.pbxTenantId || "").trim();
      if (v) vitalToConnect.set(v.toLowerCase(), l.tenantId);
    }
    const dirByVital = new Map(dirRows.map((r) => [r.vitalTenantId.trim().toLowerCase(), r]));

    // prefix → vitalTenantId. Accept the raw prefix ("acme_") AND its stripped
    // form ("acme") so recordings stored either way resolve correctly.
    const prefixToVital = new Map<string, string>();
    // slug → vitalTenantId, for filename-based fallback resolution.
    const slugToVital = new Map<string, string>();
    for (const t of ombuTenants) {
      const rawPrefix = t.prefix.toLowerCase();
      const bare = stripTrailingSep(rawPrefix);
      if (rawPrefix) prefixToVital.set(rawPrefix, t.id);
      if (bare) prefixToVital.set(bare, t.id);
      const nameSlug = slugify(t.name);
      if (nameSlug) slugToVital.set(nameSlug, t.id);
      if (bare) slugToVital.set(bare, t.id);
    }

    // 5. Pull rows. Only the columns we'll actually use.
    const selectCols = [
      colId ? `\`${colId}\` AS id` : `NULL AS id`,
      `\`${colFile}\` AS filename`,
      colDisplay && colDisplay !== colFile ? `\`${colDisplay}\` AS display_name` : `NULL AS display_name`,
      colTenant ? `\`${colTenant}\` AS tenant_col` : `NULL AS tenant_col`,
    ].join(", ");
    const sql = `SELECT ${selectCols} FROM \`${schema}\`.\`${table}\` LIMIT 5000`;
    const [rRows] = (await conn.query(sql)) as [DbRow[], unknown];
    const rows = rRows as Array<{ id: unknown; filename: unknown; display_name: unknown; tenant_col: unknown }>;

    // 6. Upsert each recording into TenantPbxPrompt.
    const now = new Date();
    let created = 0;
    let updated = 0;
    let unassigned = 0;
    const seenRefs: string[] = [];
    const perTenantCounts = new Map<string, { tenantId: string | null; tenantSlug: string | null; count: number }>();
    const sample: Array<{ ref: string; rawTenant: string | null; resolvedConnectTenantId: string | null; method: string }> = [];

    // Sorted tenant slug list for filename-prefix fallback (longest first).
    const sortedSlugs = Array.from(slugToVital.keys()).sort((a, b) => b.length - a.length);

    for (const raw of rows) {
      const rawName = Buffer.isBuffer(raw.filename)
        ? (raw.filename as Buffer).toString("utf8")
        : String(raw.filename ?? "");
      const ref = canonicaliseRef(rawName);
      if (!ref) continue;
      if (!IVR_PROMPT_REF_REGEX.test(ref)) continue;
      seenRefs.push(ref);

      const displayRaw = Buffer.isBuffer(raw.display_name)
        ? (raw.display_name as Buffer).toString("utf8")
        : (raw.display_name == null ? null : String(raw.display_name));
      const displayName = (displayRaw && displayRaw.trim()) || ref.split("/").pop() || ref;

      // ── Resolve the tenant, layered best → worst ────────────────────────
      const rawTenant = raw.tenant_col == null ? "" : String(raw.tenant_col).trim().toLowerCase();
      let vitalTenantId: string | null = null;
      let method = "none";
      if (rawTenant) {
        if (tenantColumnType === "numeric" && vitalToConnect.has(rawTenant)) {
          vitalTenantId = rawTenant;
          method = "tenant_id";
        } else if (tenantColumnType === "string") {
          const hit = prefixToVital.get(rawTenant) ?? prefixToVital.get(stripTrailingSep(rawTenant));
          if (hit) { vitalTenantId = hit; method = "tenant_prefix"; }
        } else if (vitalToConnect.has(rawTenant)) {
          // numeric-typed fallback even if DATA_TYPE said otherwise
          vitalTenantId = rawTenant;
          method = "tenant_id";
        }
      }
      // Last-chance: filename prefix matches a tenant slug → use that tenant.
      if (!vitalTenantId) {
        const base = (ref.split("/").pop() ?? ref).toLowerCase();
        for (const slug of sortedSlugs) {
          if (base === slug || base.startsWith(slug + "_") || base.startsWith(slug + "-")) {
            const hit = slugToVital.get(slug);
            if (hit) { vitalTenantId = hit; method = "filename_prefix"; break; }
          }
        }
      }

      const connectTenantId = vitalTenantId ? (vitalToConnect.get(vitalTenantId) ?? null) : null;
      const tenantSlug = vitalTenantId ? (dirByVital.get(vitalTenantId)?.tenantSlug ?? null) : null;
      if (!connectTenantId) { unassigned += 1; method = method === "none" ? "unassigned" : `${method}_but_no_connect_link`; }

      // Per-tenant counter for the response.
      const bucketKey = connectTenantId ?? "__unassigned__";
      const bucket = perTenantCounts.get(bucketKey);
      if (bucket) bucket.count += 1;
      else perTenantCounts.set(bucketKey, { tenantId: connectTenantId, tenantSlug, count: 1 });

      if (sample.length < 8) {
        sample.push({ ref, rawTenant: rawTenant || null, resolvedConnectTenantId: connectTenantId, method });
      }

      const fileBase = (ref.split("/").pop() ?? ref).toLowerCase();
      const category = inferCategory(fileBase);

      const existing = await (db as any).tenantPbxPrompt.findUnique({ where: { promptRef: ref } });
      if (existing) {
        await (db as any).tenantPbxPrompt.update({
          where: { promptRef: ref },
          data: {
            tenantId: connectTenantId,
            tenantSlug,
            lastSeenAt: now,
            // Preserve an admin's manual displayName/category edits.
            displayName: existing.source === "manual" ? existing.displayName : displayName,
            category: existing.source === "manual" ? existing.category : category,
            source: existing.source === "manual" ? "manual" : "pbx_sync",
            isActive: true,
          },
        });
        updated += 1;
      } else {
        await (db as any).tenantPbxPrompt.create({
          data: {
            tenantId: connectTenantId,
            tenantSlug,
            promptRef: ref,
            fileBaseName: fileBase,
            relativePath: ref,
            displayName,
            category,
            source: "pbx_sync",
            isActive: true,
          },
        });
        created += 1;
      }
    }

    // 7. Optionally deactivate rows that disappeared from the PBX.
    let deactivated = 0;
    if (options.deactivateMissing && seenRefs.length > 0) {
      const res = await (db as any).tenantPbxPrompt.updateMany({
        where: { promptRef: { notIn: seenRefs }, isActive: true, source: { not: "manual" } },
        data: { isActive: false },
      });
      deactivated = res.count ?? 0;
    }

    return {
      source: "ombutel_mysql",
      table: `${schema}.${table}`,
      tenantColumn: colTenant,
      tenantColumnType,
      ombuTenantsSeen: ombuTenants.length,
      rowsRead: rows.length,
      created,
      updated,
      unassigned,
      deactivated,
      perTenant: Array.from(perTenantCounts.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 50),
      sample,
      errors,
    };
  } catch (e: any) {
    errors.push(`MySQL query: ${e?.message || String(e)}`);
    return makeEmptyResult("(unknown)", null, "none", errors);
  } finally {
    await conn.end().catch(() => {});
  }
}

function makeEmptyResult(
  table: string,
  tenantColumn: string | null,
  tenantColumnType: "numeric" | "string" | "none",
  errors: string[],
): PromptAutoSyncResult {
  return {
    source: "ombutel_mysql",
    table,
    tenantColumn,
    tenantColumnType,
    ombuTenantsSeen: 0,
    rowsRead: 0,
    created: 0,
    updated: 0,
    unassigned: 0,
    deactivated: 0,
    perTenant: [],
    sample: [],
    errors,
  };
}

function inferCategory(base: string): string {
  const b = base.toLowerCase();
  if (/(invalid|wrong|bad)/.test(b)) return "invalid";
  if (/(timeout|no[-_]?input|nodigit)/.test(b)) return "timeout";
  if (/(greet|main|normal|welcome|business|closed|after[-_]?hours|holiday|emergency)/.test(b)) return "greeting";
  return "general";
}

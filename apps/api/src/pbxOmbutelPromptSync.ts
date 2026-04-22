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
      rowsRead: number;
      created: number;
      updated: number;
      unassigned: number;
      deactivated: number;
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
const COLS_TENANT = ["tenant_id", "tenant", "tenantid"];
const COLS_ID = ["id", "recording_id", "system_recording_id"];

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
    return {
      source: "ombutel_mysql" as const,
      table: "(none)",
      rowsRead: 0,
      created: 0,
      updated: 0,
      unassigned: 0,
      deactivated: 0,
      errors: [`MySQL connect: ${e?.message || String(e)}`],
    };
  }

  try {
    // 1. Resolve which DB schema we're connected to (the URL includes it).
    //    `SELECT DATABASE()` is O(1) and avoids relying on URL parsing.
    const [[dbRow]] = (await conn.query("SELECT DATABASE() AS db")) as [DbRow[], unknown];
    const schema = String((dbRow as any)?.db || "").trim();
    if (!schema) {
      return {
        source: "ombutel_mysql",
        table: "(none)",
        rowsRead: 0,
        created: 0,
        updated: 0,
        unassigned: 0,
        deactivated: 0,
        errors: ["MySQL URL has no database selected"],
      };
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
      return {
        source: "ombutel_mysql",
        table: "(none)",
        rowsRead: 0,
        created: 0,
        updated: 0,
        unassigned: 0,
        deactivated: 0,
        errors: [
          `No system-recordings table found in schema "${schema}". Looked for: ${candidateTables.join(", ")} and anything *recording*/*announcement*. Confirm the ombu MySQL user can see this schema.`,
        ],
      };
    }

    // 3. Introspect columns so we pick the right ones without guessing.
    const [cRows] = (await conn.query(
      `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, table],
    )) as [DbRow[], unknown];
    const cols = new Set(cRows.map((r) => String((r as any).COLUMN_NAME)));
    const colFile = pickColumn(COLS_FILENAME, cols);
    const colDisplay = pickColumn(COLS_DISPLAY, cols);
    const colTenant = pickColumn(COLS_TENANT, cols);
    const colId = pickColumn(COLS_ID, cols);

    if (!colFile) {
      return {
        source: "ombutel_mysql",
        table,
        rowsRead: 0,
        created: 0,
        updated: 0,
        unassigned: 0,
        deactivated: 0,
        errors: [
          `Table "${schema}.${table}" has no recognisable filename column. Columns seen: ${Array.from(cols).join(", ")}`,
        ],
      };
    }

    // 4. Build the tenant-map once. Same source of truth as the DID sync.
    const [pbxLinks, dirRows] = await Promise.all([
      db.tenantPbxLink.findMany({
        where: {
          pbxInstanceId,
          OR: [{ status: "LINKED" }, { status: "ERROR", pbxTenantId: { not: null } }],
        },
      }),
      db.pbxTenantDirectory.findMany({ where: { pbxInstanceId } }),
    ]);
    const vitalToConnect = new Map<string, string>();
    for (const l of pbxLinks) {
      const v = (l.pbxTenantId || "").trim();
      if (v) vitalToConnect.set(v.toLowerCase(), l.tenantId);
    }
    const dirByVital = new Map(dirRows.map((r) => [r.vitalTenantId.trim().toLowerCase(), r]));

    // 5. Pull rows. Only the columns we'll actually use.
    const selectCols = [
      colId ? `\`${colId}\` AS id` : `NULL AS id`,
      `\`${colFile}\` AS filename`,
      colDisplay && colDisplay !== colFile ? `\`${colDisplay}\` AS display_name` : `NULL AS display_name`,
      colTenant ? `\`${colTenant}\` AS tenant_id` : `NULL AS tenant_id`,
    ].join(", ");
    const sql = `SELECT ${selectCols} FROM \`${schema}\`.\`${table}\` LIMIT 5000`;
    const [rRows] = (await conn.query(sql)) as [DbRow[], unknown];
    const rows = rRows as Array<{ id: unknown; filename: unknown; display_name: unknown; tenant_id: unknown }>;

    // 6. Upsert each recording into TenantPbxPrompt.
    const now = new Date();
    let created = 0;
    let updated = 0;
    let unassigned = 0;
    const seenRefs: string[] = [];

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

      const vitalTenantId = raw.tenant_id == null ? "" : String(raw.tenant_id).trim().toLowerCase();
      const connectTenantId = vitalTenantId ? (vitalToConnect.get(vitalTenantId) ?? null) : null;
      const tenantSlug = vitalTenantId ? (dirByVital.get(vitalTenantId)?.tenantSlug ?? null) : null;
      if (!connectTenantId) unassigned += 1;

      const base = (ref.split("/").pop() ?? ref).toLowerCase();
      const category = inferCategory(base);

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
            fileBaseName: base,
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
      rowsRead: rows.length,
      created,
      updated,
      unassigned,
      deactivated,
      errors,
    };
  } catch (e: any) {
    errors.push(`MySQL query: ${e?.message || String(e)}`);
    return {
      source: "ombutel_mysql",
      table: "(unknown)",
      rowsRead: 0,
      created: 0,
      updated: 0,
      unassigned: 0,
      deactivated: 0,
      errors,
    };
  } finally {
    await conn.end().catch(() => {});
  }
}

function inferCategory(base: string): string {
  const b = base.toLowerCase();
  if (/(invalid|wrong|bad)/.test(b)) return "invalid";
  if (/(timeout|no[-_]?input|nodigit)/.test(b)) return "timeout";
  if (/(greet|main|normal|welcome|business|closed|after[-_]?hours|holiday|emergency)/.test(b)) return "greeting";
  return "general";
}

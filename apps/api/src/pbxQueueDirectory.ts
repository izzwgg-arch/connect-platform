import { decryptJson } from "@connect/security";

/**
 * Read-only listing of VitalPBX queues *and their members* for one VitalPBX
 * tenant, straight from the Ombutel MariaDB.
 *
 * Why here and not the REST API: same reason as `pbxOmbutelRingGroupList.ts` —
 * VitalPBX 4's REST collection is not a usable source for this, and Ombutel is
 * authoritative anyway. This module is the *config* half of the queue feature;
 * the history half lives in `pbxQueueStats.ts` and reads a different schema.
 *
 * ⛔ THE ONE THING THIS MODULE EXISTS TO GET RIGHT: `logName`.
 * A queue is called `750` in Ombutel and `T8_Q750` in `asterisk.queues_log`.
 * Querying the log by the bare extension returns zero rows and reads exactly
 * like "this queue has no history" — a silent wrong answer. So the mapping is
 * derived HERE, once, and every reports query takes the name from this row
 * rather than rebuilding it. Never hand-assemble `T{n}_Q{ext}` at a call site.
 *
 * Returns `{ rows: [] }` with a soft `skipReason` (never throws) when the PBX
 * connection isn't configured, mysql2 is missing, or the schema doesn't carry
 * the tables — so a queue screen degrades to "no queues" instead of a 500.
 */

export type QueueMemberRow = {
  /** SIP extension number, e.g. "102". */
  extension: string;
  /** Display name from ombu_extensions.name, e.g. "Customer Service". */
  name: string | null;
  /** Lower penalty rings first in `linear`/`rrmemory`; 0 for most. */
  penalty: number;
  /** "static" (configured) or "dynamic" (logged in at runtime). */
  type: string;
};

export type QueueConfigRow = {
  id: string;
  /** Queue's own extension number, e.g. "750". */
  extension: string;
  /** Human name, e.g. "Phone Orders". */
  name: string;
  /** Caller-ID prefix so agents see which line rang. */
  prefix: string | null;
  /** ringall | linear | leastrecent | fewestcalls | random | rrmemory | … */
  strategy: string | null;
  /** Seconds a member's phone rings before moving on. */
  timeoutSec: number | null;
  /** Seconds to wait before retrying the member list. */
  retrySec: number | null;
  /** Seconds an agent is held unavailable after a call. */
  wrapupSec: number | null;
  /** Max callers allowed to wait; 0 = unlimited. */
  maxLen: number | null;
  /**
   * The queue's own service-level target in seconds, if the admin set one.
   * ⛔ NULL on all three of Gesheft's queues — VitalPBX leaves it unset by
   * default. The reports layer must therefore supply its own target and say
   * so, not silently present a made-up SLA as the customer's own.
   */
  serviceLevelSec: number | null;
  announcePosition: boolean;
  joinEmpty: string | null;
  leaveWhenEmpty: string | null;
  recorded: boolean;
  members: QueueMemberRow[];
  /**
   * How this queue is named in `asterisk.queues_log` — `T<tenant>_Q<ext>`.
   * Derived once, here. See the module header.
   */
  logName: string;
};

export type QueueDirectoryResult =
  | { source: "ombutel_mysql"; rows: QueueConfigRow[]; skipReason: null }
  | { source: "skipped"; rows: []; skipReason: string };

type DbRow = Record<string, unknown>;

const skip = (skipReason: string): QueueDirectoryResult => ({ source: "skipped", rows: [], skipReason });

/** Build the `queues_log` name for a queue. The ONLY place this is assembled. */
export function queueLogName(vitalTenantId: string | number, queueExtension: string): string {
  return `T${String(vitalTenantId).trim()}_Q${String(queueExtension).trim()}`;
}

/**
 * Open a connection to the Ombutel MariaDB from a PbxInstance's encrypted URL.
 * Exported because `pbxQueueStats.ts` needs the same connection (the queue log
 * lives on the same server, in a different schema) and duplicating the decrypt
 * + import dance is how the two drift apart.
 */
export async function connectOmbutelMysql(
  ombuMysqlUrlEncrypted: string | null | undefined,
): Promise<
  | { ok: true; conn: import("mysql2/promise").Connection; schema: string }
  | { ok: false; skipReason: string }
> {
  if (!ombuMysqlUrlEncrypted?.trim()) {
    return { ok: false, skipReason: "ombuMysqlUrlEncrypted not configured on PbxInstance" };
  }

  let mysqlUrl: string;
  try {
    const parsed = decryptJson<{ mysqlUrl?: string; url?: string }>(ombuMysqlUrlEncrypted.trim());
    mysqlUrl = String(parsed.mysqlUrl || parsed.url || "").trim();
  } catch {
    return { ok: false, skipReason: "ombuMysqlUrlEncrypted could not be decrypted" };
  }
  if (!mysqlUrl) return { ok: false, skipReason: "decrypted payload missing mysqlUrl" };

  let mysql: typeof import("mysql2/promise");
  try {
    mysql = await import("mysql2/promise");
  } catch (e: any) {
    return { ok: false, skipReason: `mysql2 unavailable: ${e?.message || String(e)}` };
  }

  let conn: import("mysql2/promise").Connection;
  try {
    conn = await mysql.createConnection(mysqlUrl);
  } catch (e: any) {
    return { ok: false, skipReason: `mysql connect: ${e?.message || String(e)}` };
  }

  try {
    const [[dbRow]] = (await conn.query("SELECT DATABASE() AS db")) as [DbRow[], unknown];
    const schema = String((dbRow as any)?.db || "").trim();
    if (!schema) {
      await conn.end().catch(() => {});
      return { ok: false, skipReason: "MySQL URL has no database selected" };
    }
    return { ok: true, conn, schema };
  } catch (e: any) {
    await conn.end().catch(() => {});
    return { ok: false, skipReason: `mysql select database: ${e?.message || String(e)}` };
  }
}

/** Which of `names` exist as columns on `table`. One INFORMATION_SCHEMA hit. */
async function columnsOf(
  conn: import("mysql2/promise").Connection,
  schema: string,
  table: string,
): Promise<Set<string>> {
  const [rows] = (await conn.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, table],
  )) as [DbRow[], unknown];
  return new Set((rows as DbRow[]).map((r) => String((r as any).COLUMN_NAME)));
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const yes = (v: unknown): boolean => String(v ?? "").trim().toLowerCase() === "yes";

/**
 * Every extension on the tenant, for the "who's in this queue?" picker.
 *
 * Returned alongside the queues by `GET /voice/queues` rather than from its own
 * endpoint: it is the same tenant scope and the same connection, and a second
 * round-trip to the PBX for a list this small is not worth a second door.
 */
export async function listTenantExtensions(
  vitalTenantId: string,
  ombuMysqlUrlEncrypted: string | null | undefined,
): Promise<Array<{ extension: string; name: string | null }>> {
  const tenant = String(vitalTenantId || "").trim();
  if (!tenant) return [];
  const c = await connectOmbutelMysql(ombuMysqlUrlEncrypted);
  if (!c.ok) return [];
  const { conn, schema } = c;
  try {
    const cols = await columnsOf(conn, schema, "ombu_extensions");
    if (!cols.has("extension")) return [];
    const tenantCol = cols.has("tenant_id") ? "tenant_id" : cols.has("tenantid") ? "tenantid" : null;
    if (!tenantCol) return [];
    // ⛔ `name`, not `description` — ombu_extensions has no description column.
    const nameCol = cols.has("name") ? "`name`" : "NULL";
    const [rows] = (await conn.query(
      `SELECT \`extension\` AS \`_ext\`, ${nameCol} AS \`_name\`
         FROM \`ombu_extensions\`
        WHERE \`${tenantCol}\` = ?
        ORDER BY \`extension\` ASC
        LIMIT 500`,
      [tenant],
    )) as [DbRow[], unknown];
    return (rows as DbRow[])
      .map((r) => ({
        extension: String(r["_ext"] ?? "").trim(),
        name: r["_name"] != null ? String(r["_name"]).trim() || null : null,
      }))
      .filter((e) => e.extension);
  } catch {
    return []; // the picker degrades to "no extensions", never a 500
  } finally {
    await conn.end().catch(() => {});
  }
}

export async function listQueuesFromOmbutel(
  vitalTenantId: string,
  ombuMysqlUrlEncrypted: string | null | undefined,
): Promise<QueueDirectoryResult> {
  const tenant = String(vitalTenantId || "").trim();
  if (!tenant) return skip("no vitalTenantId");

  const c = await connectOmbutelMysql(ombuMysqlUrlEncrypted);
  if (!c.ok) return skip(c.skipReason);
  const { conn, schema } = c;

  try {
    const qCols = await columnsOf(conn, schema, "ombu_queues");
    if (qCols.size === 0) return skip(`no ombu_queues table in schema "${schema}"`);

    // ⛔ ombu_queues is keyed `queue_id`, NOT `id` — selecting `id` is a hard
    // 1054 that reads like the table being absent. Same family: ombu_extensions
    // has `name`, not `description`. Both cost a wrong answer during the audit,
    // so every column below is probed rather than assumed.
    const has = (col: string) => qCols.has(col);
    const col = (candidates: string[], alias: string): string => {
      const found = candidates.find((x) => qCols.has(x));
      return found ? `q.\`${found}\` AS \`${alias}\`` : `NULL AS \`${alias}\``;
    };
    if (!has("extension")) return skip(`ombu_queues has no "extension" column in schema "${schema}"`);
    const idCol = has("queue_id") ? "queue_id" : has("id") ? "id" : null;
    if (!idCol) return skip(`ombu_queues has no id column in schema "${schema}"`);
    const tenantCol = has("tenant_id") ? "tenant_id" : has("tenantid") ? "tenantid" : null;
    if (!tenantCol) return skip(`ombu_queues has no tenant column in schema "${schema}"`);

    const sql = `
      SELECT
        q.\`${idCol}\` AS \`_id\`,
        q.\`extension\` AS \`_ext\`,
        ${col(["description", "name", "queue_name"], "_name")},
        ${col(["prefix"], "_prefix")},
        ${col(["strategy", "ring_strategy"], "_strategy")},
        ${col(["timeout"], "_timeout")},
        ${col(["retry"], "_retry")},
        ${col(["wrapuptime"], "_wrapup")},
        ${col(["maxlen"], "_maxlen")},
        ${col(["servicelevel"], "_sla")},
        ${col(["announce_position"], "_announcepos")},
        ${col(["joinempty"], "_joinempty")},
        ${col(["leavewhenempty"], "_leavewhenempty")},
        ${col(["record"], "_record")}
      FROM \`ombu_queues\` q
      WHERE q.\`${tenantCol}\` = ?
      ORDER BY q.\`extension\` ASC
      LIMIT 200`;
    const [qRows] = (await conn.query(sql, [tenant])) as [DbRow[], unknown];

    const queues: QueueConfigRow[] = (qRows as DbRow[])
      .map((r) => {
        const extension = String(r["_ext"] ?? "").trim();
        return {
          id: String(r["_id"] ?? ""),
          extension,
          name: String(r["_name"] ?? "").trim() || extension,
          prefix: r["_prefix"] != null ? String(r["_prefix"]) : null,
          strategy: r["_strategy"] != null ? String(r["_strategy"]) : null,
          timeoutSec: num(r["_timeout"]),
          retrySec: num(r["_retry"]),
          wrapupSec: num(r["_wrapup"]),
          maxLen: num(r["_maxlen"]),
          serviceLevelSec: num(r["_sla"]),
          announcePosition: yes(r["_announcepos"]),
          joinEmpty: r["_joinempty"] != null ? String(r["_joinempty"]) : null,
          leaveWhenEmpty: r["_leavewhenempty"] != null ? String(r["_leavewhenempty"]) : null,
          recorded: yes(r["_record"]),
          members: [],
          logName: queueLogName(tenant, extension),
        };
      })
      .filter((q) => q.extension);

    if (queues.length === 0) {
      return { source: "ombutel_mysql", rows: [], skipReason: null };
    }

    // Members, in one round-trip for every queue this tenant owns. The join is
    // ombu_queue_members.extension_id → ombu_extensions.extension_id.
    const mCols = await columnsOf(conn, schema, "ombu_queue_members");
    const eCols = await columnsOf(conn, schema, "ombu_extensions");
    if (mCols.has("queue_id") && mCols.has("extension_id") && eCols.has("extension_id")) {
      // ⛔ ombu_extensions carries `name`; there is NO `description` column on
      // it. Probe rather than assume — this exact guess 1054'd during the audit.
      const nameCol = eCols.has("name") ? "e.`name`" : eCols.has("description") ? "e.`description`" : "NULL";
      const ids = queues.map((q) => q.id);
      const [mRows] = (await conn.query(
        `SELECT m.\`queue_id\` AS \`_qid\`,
                e.\`extension\` AS \`_ext\`,
                ${nameCol} AS \`_name\`,
                ${mCols.has("penalty") ? "m.`penalty`" : "0"} AS \`_penalty\`,
                ${mCols.has("type") ? "m.`type`" : "'static'"} AS \`_type\`
           FROM \`ombu_queue_members\` m
           LEFT JOIN \`ombu_extensions\` e ON e.\`extension_id\` = m.\`extension_id\`
          WHERE m.\`queue_id\` IN (${ids.map(() => "?").join(",")})
          ORDER BY m.\`penalty\` ASC, e.\`extension\` ASC
          LIMIT 2000`,
        ids,
      )) as [DbRow[], unknown];

      const byQueue = new Map<string, QueueMemberRow[]>();
      for (const r of mRows as DbRow[]) {
        const ext = String(r["_ext"] ?? "").trim();
        if (!ext) continue; // member row whose extension was deleted
        const list = byQueue.get(String(r["_qid"])) ?? [];
        list.push({
          extension: ext,
          name: r["_name"] != null ? String(r["_name"]).trim() || null : null,
          penalty: num(r["_penalty"]) ?? 0,
          type: String(r["_type"] ?? "static"),
        });
        byQueue.set(String(r["_qid"]), list);
      }
      for (const q of queues) q.members = byQueue.get(q.id) ?? [];
    }

    return { source: "ombutel_mysql", rows: queues, skipReason: null };
  } catch (e: any) {
    return skip(`mysql query: ${e?.message || String(e)}`);
  } finally {
    await conn.end().catch(() => {});
  }
}

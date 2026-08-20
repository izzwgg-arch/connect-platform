/**
 * Read-only listing of VitalPBX conference rooms for one VitalPBX tenant,
 * straight from the Ombutel MariaDB (`ombu_conferences`).
 *
 * Same shape and same reasons as `pbxQueueDirectory.ts`: VitalPBX's REST
 * collection only offers a thin read and its caches go stale (the tenant list
 * was measured 40+ minutes behind), while Ombutel is authoritative — it is
 * what the panel writes and what the dialplan is rendered from. The MySQL
 * connection helper is IMPORTED from pbxQueueDirectory rather than re-built,
 * per that module's own instruction.
 *
 * Column facts, read from the live PBX on 2026-08-20 (all 25 columns of
 * `ombu_conferences` described over read-only SSH): keyed `conference_id`,
 * the room number is `extension`, the name is `description`, PINs are
 * `userpin`/`adminpin`, and the option toggles are enum('yes','no') columns
 * (`record_conference`, `startmuted`, `quiet`, `announce_user_count`,
 * `announce_join_leave`, `music_on_hold_when_empty`, `wait_marked`,
 * `end_marked`). Every column below is still PROBED before it is selected —
 * the `queue_id`-vs-`id` and `name`-vs-`description` traps both cost a wrong
 * answer once, and a VitalPBX upgrade could rename any of these.
 *
 * Returns `{ rows: [] }` with a soft `skipReason` (never throws) when the PBX
 * connection isn't configured, mysql2 is missing, or the schema doesn't carry
 * the table — the Conference page degrades to "no rooms" instead of a 500.
 */
import { connectOmbutelMysql } from "./pbxQueueDirectory";

export type ConferenceConfigRow = {
  /** Panel row id (`conference_id`) — what edit/delete replays target. */
  id: string;
  /** The room's dial-in number inside the tenant, e.g. "700". */
  extension: string;
  /** Human name, e.g. "Sales stand-up". */
  name: string;
  /** PIN ordinary participants enter, or null when the room is open. */
  userPin: string | null;
  /** PIN that marks the caller as the room's admin/host. */
  adminPin: string | null;
  /** 0/null = unlimited. */
  maxMembers: number | null;
  recordConference: boolean;
  startMuted: boolean;
  /** Quiet mode — no enter/leave prompts at all. */
  quiet: boolean;
  announceUserCount: boolean;
  announceJoinLeave: boolean;
  musicOnHoldWhenEmpty: boolean;
  /** Participants wait on hold until an admin (marked user) arrives. */
  waitForAdmin: boolean;
  /** The room ends for everyone when the last admin leaves. */
  endWhenAdminLeaves: boolean;
  language: string | null;
  videoMode: string | null;
};

export type ConferenceDirectoryResult =
  | { source: "ombutel_mysql"; rows: ConferenceConfigRow[]; skipReason: null }
  | { source: "skipped"; rows: []; skipReason: string };

type DbRow = Record<string, unknown>;

const skip = (skipReason: string): ConferenceDirectoryResult => ({ source: "skipped", rows: [], skipReason });

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const yes = (v: unknown): boolean => String(v ?? "").trim().toLowerCase() === "yes";
const strOrNull = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

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

export async function listConferencesFromOmbutel(
  vitalTenantId: string,
  ombuMysqlUrlEncrypted: string | null | undefined,
): Promise<ConferenceDirectoryResult> {
  const tenant = String(vitalTenantId || "").trim();
  if (!tenant) return skip("no vitalTenantId");

  const c = await connectOmbutelMysql(ombuMysqlUrlEncrypted);
  if (!c.ok) return skip(c.skipReason);
  const { conn, schema } = c;

  try {
    const cols = await columnsOf(conn, schema, "ombu_conferences");
    if (cols.size === 0) return skip(`no ombu_conferences table in schema "${schema}"`);

    const has = (col: string) => cols.has(col);
    const col = (candidates: string[], alias: string): string => {
      const found = candidates.find((x) => cols.has(x));
      return found ? `c.\`${found}\` AS \`${alias}\`` : `NULL AS \`${alias}\``;
    };
    if (!has("extension")) return skip(`ombu_conferences has no "extension" column in schema "${schema}"`);
    const idCol = has("conference_id") ? "conference_id" : has("id") ? "id" : null;
    if (!idCol) return skip(`ombu_conferences has no id column in schema "${schema}"`);
    const tenantCol = has("tenant_id") ? "tenant_id" : has("tenantid") ? "tenantid" : null;
    if (!tenantCol) return skip(`ombu_conferences has no tenant column in schema "${schema}"`);

    const sql = `
      SELECT
        c.\`${idCol}\` AS \`_id\`,
        c.\`extension\` AS \`_ext\`,
        ${col(["description", "name"], "_name")},
        ${col(["userpin"], "_userpin")},
        ${col(["adminpin"], "_adminpin")},
        ${col(["max_members"], "_maxmembers")},
        ${col(["record_conference"], "_record")},
        ${col(["startmuted"], "_startmuted")},
        ${col(["quiet"], "_quiet")},
        ${col(["announce_user_count"], "_announcecount")},
        ${col(["announce_join_leave"], "_announcejoin")},
        ${col(["music_on_hold_when_empty"], "_mohempty")},
        ${col(["wait_marked"], "_waitmarked")},
        ${col(["end_marked"], "_endmarked")},
        ${col(["language"], "_language")},
        ${col(["video_mode"], "_videomode")}
      FROM \`ombu_conferences\` c
      WHERE c.\`${tenantCol}\` = ?
      ORDER BY c.\`extension\` ASC
      LIMIT 200`;
    const [rows] = (await conn.query(sql, [tenant])) as [DbRow[], unknown];

    const conferences: ConferenceConfigRow[] = (rows as DbRow[])
      .map((r) => {
        const extension = String(r["_ext"] ?? "").trim();
        return {
          id: String(r["_id"] ?? ""),
          extension,
          name: String(r["_name"] ?? "").trim() || extension,
          userPin: strOrNull(r["_userpin"]),
          adminPin: strOrNull(r["_adminpin"]),
          maxMembers: num(r["_maxmembers"]),
          recordConference: yes(r["_record"]),
          startMuted: yes(r["_startmuted"]),
          quiet: yes(r["_quiet"]),
          announceUserCount: yes(r["_announcecount"]),
          announceJoinLeave: yes(r["_announcejoin"]),
          musicOnHoldWhenEmpty: yes(r["_mohempty"]),
          waitForAdmin: yes(r["_waitmarked"]),
          endWhenAdminLeaves: yes(r["_endmarked"]),
          language: strOrNull(r["_language"]),
          videoMode: strOrNull(r["_videomode"]),
        };
      })
      .filter((row) => row.extension);

    return { source: "ombutel_mysql", rows: conferences, skipReason: null };
  } catch (e: any) {
    return skip(`mysql query: ${e?.message || String(e)}`);
  } finally {
    await conn.end().catch(() => {});
  }
}

/**
 * Resolve a US state abbreviation to `ombutel.states.id`, which is what the
 * VitalPBX emergency-location form wants (`state_id`). New York is 3956.
 *
 * ⛔ Read from the PBX database, never guessed. A wrong state id puts a wrong
 * address in front of a 911 dispatcher. Returns null when it cannot be sure,
 * and the build then logs a loud "emergency calling skipped" line rather than
 * registering half an address.
 */

import { db } from "@connect/db";
import { decryptJson } from "@connect/security";

/** `states.country_id` for the United States. */
export const OMBUTEL_COUNTRY_US = 231;

const cache = new Map<string, string | null>();

export async function resolveOmbutelStateId(abbreviation: string | null | undefined): Promise<string | null> {
  const abbr = String(abbreviation || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(abbr)) return null;
  if (cache.has(abbr)) return cache.get(abbr)!;

  try {
    const inst: any = await (db as any).pbxInstance.findFirst({ where: { isEnabled: true } });
    if (!inst?.ombuMysqlUrlEncrypted) return null;
    const parsed: any = decryptJson(String(inst.ombuMysqlUrlEncrypted).trim());
    const url = String(parsed.mysqlUrl || parsed.url || "").trim();
    if (!url) return null;
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection(url);
    try {
      const [rows]: any = await conn.query(
        "SELECT id FROM ombutel.states WHERE country_id = ? AND abbreviation = ? LIMIT 1",
        [OMBUTEL_COUNTRY_US, abbr],
      );
      const id = rows?.[0]?.id != null ? String(rows[0].id) : null;
      cache.set(abbr, id);
      return id;
    } finally {
      await conn.end().catch(() => {});
    }
  } catch {
    return null;
  }
}

import type { Db } from "../db.js";
import { Prisma } from "../db.js";

/** Joins the searchable fields of an object into one lowercase document. */
export function buildSearchText(parts: Array<string | string[] | null | undefined>): string {
  return parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join(" \n ")
    .toLowerCase()
    .slice(0, 20_000);
}

/** websearch_to_tsquery-compatible: quotes, OR, -negation all work; empty → null. */
export function toTsQuery(q: string): string | null {
  const s = q.trim().replace(/\s+/g, " ");
  return s ? s : null;
}

export type FtsRow = { id: string; rank: number };

/**
 * Full-text + trigram search over one table's searchText. Returns ids ranked.
 * Trigram similarity rescues typos ("embroidry") that tsquery misses; the `%`
 * operator is GIN-indexed, with the cut-off set per database (migration
 * 20260918160000_trgm_threshold).
 */
export async function ftsIds(db: Db, table: string, idColumn: string, q: string, limit = 50, extraWhere: Prisma.Sql = Prisma.empty): Promise<FtsRow[]> {
  const tsq = toTsQuery(q);
  if (!tsq) return [];
  const t = Prisma.raw(`"${table}"`);
  const idc = Prisma.raw(`"${idColumn}"`);
  const rows = await db.$queryRaw<FtsRow[]>(Prisma.sql`
    SELECT ${idc} AS id,
           (ts_rank_cd("searchTsv", websearch_to_tsquery('simple', ${tsq})) * 2 + similarity(coalesce("searchText",''), ${q.toLowerCase()})) AS rank
    FROM ${t}
    WHERE ("searchTsv" @@ websearch_to_tsquery('simple', ${tsq}) OR "searchText" % ${q.toLowerCase()})
      ${extraWhere}
    ORDER BY rank DESC
    LIMIT ${limit}
  `);
  return rows;
}

/** Prefix autocomplete over a name column. */
export async function prefixIds(db: Db, table: string, idColumn: string, column: string, prefix: string, limit = 8): Promise<string[]> {
  const p = prefix.trim().toLowerCase();
  if (!p) return [];
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT ${Prisma.raw(`"${idColumn}"`)} AS id FROM ${Prisma.raw(`"${table}"`)}
    WHERE lower(${Prisma.raw(`"${column}"`)}) LIKE ${p + "%"}
    LIMIT ${limit}
  `);
  return rows.map((r) => r.id);
}

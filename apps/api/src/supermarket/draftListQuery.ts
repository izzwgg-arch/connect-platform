// Query-string parsing for GET /supermarket/drafts (the Orders Desk list).
//
// Pure — no Fastify, no Prisma — so it is unit-tested directly. The route
// hands `req.query` in and gets clamped, typed values out.
//
// Contract (2026-09-08, Orders Desk filters + paging):
//   status     one of DRAFT_STATUSES; anything else = all statuses
//   source     one of DRAFT_SOURCES (call | voicemail | text); else = all
//   from / to  ISO-8601 instants, inclusive on createdAt (the portal sends the
//              browser's local day boundaries as full ISO strings); an inverted
//              pair is swapped, an unparsable value is ignored
//   q          free text, trimmed, ≤ 80 chars — see draftSearchWhere()
//   page       1-based, default 1
//   pageSize   default 50, clamped to 1..200

export const DRAFT_STATUSES = ["NEEDS_REVIEW", "APPROVED", "SUBMITTED", "SUBMIT_FAILED", "DISMISSED", "SUBMITTING"] as const;
export const DRAFT_SOURCES = ["call", "voicemail", "text"] as const;
export const DRAFTS_DEFAULT_PAGE_SIZE = 50;
export const DRAFTS_MAX_PAGE_SIZE = 200;
export const DRAFTS_MAX_PAGE = 100_000;
export const DRAFTS_MAX_QUERY_CHARS = 80;

export interface DraftListQuery {
  status?: (typeof DRAFT_STATUSES)[number];
  sourceType?: (typeof DRAFT_SOURCES)[number];
  from?: Date;
  to?: Date;
  q?: string;
  page: number;
  pageSize: number;
}

function optString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function optDate(v: unknown): Date | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function parseDraftListQuery(q: Record<string, unknown> | null | undefined): DraftListQuery {
  const src = q ?? {};
  const status = optString(src.status);
  const source = optString(src.source)?.toLowerCase();
  let from = optDate(src.from);
  let to = optDate(src.to);
  if (from && to && from.getTime() > to.getTime()) [from, to] = [to, from];
  const text = optString(src.q);
  return {
    status: status && (DRAFT_STATUSES as readonly string[]).includes(status) ? (status as DraftListQuery["status"]) : undefined,
    sourceType: source && (DRAFT_SOURCES as readonly string[]).includes(source) ? (source as DraftListQuery["sourceType"]) : undefined,
    from,
    to,
    q: text ? text.slice(0, DRAFTS_MAX_QUERY_CHARS) : undefined,
    page: clampInt(src.page, 1, 1, DRAFTS_MAX_PAGE),
    pageSize: clampInt(src.pageSize, DRAFTS_DEFAULT_PAGE_SIZE, 1, DRAFTS_MAX_PAGE_SIZE),
  };
}

/**
 * Prisma `where` fragment for the search box. Searches customer name, phone
 * and POS order number:
 *   • letters present, or fewer than 3 digits → name (case-insensitive contains)
 *   • 3+ digits → phone by its digits (so "845 555" and "(845) 555" both hit
 *     a stored "8455550142"), plus the raw text in case the phone is stored
 *     formatted
 *   • the raw text is always tried against posOrderId
 * Returns null for an empty query so the caller can skip it.
 */
export function draftSearchWhere(q: string | undefined): { OR: Record<string, unknown>[] } | null {
  const text = (q ?? "").trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  const hasLetters = /[^\d\s().+\-]/.test(text);
  const OR: Record<string, unknown>[] = [];
  if (hasLetters || digits.length < 3) OR.push({ customerName: { contains: text, mode: "insensitive" } });
  if (digits.length >= 3) {
    OR.push({ customerPhone: { contains: digits } });
    if (digits !== text) OR.push({ customerPhone: { contains: text } });
  }
  OR.push({ posOrderId: { contains: text } });
  return { OR };
}

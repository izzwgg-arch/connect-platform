// Query-string parsing for GET /delivery/orders (dispatcher orders list).
//
// Pure and side-effect free so it can be unit-tested without Fastify or Prisma.
// The route hands `req.query` in; the service gets typed, clamped values out.
//
// Contract (2026-09-08, orders page date-range filter + paging):
//   status    optional; validated against the status table by the service
//   storeId   optional DeliveryStore id
//   from / to optional ISO-8601 instants (the portal sends local day boundaries
//             as full ISO strings so the tenant's browser timezone wins); an
//             inverted pair is swapped, an unparsable value is ignored
//   page      1-based, default 1
//   pageSize  default 50, clamped to 1..200 (the old hard cap of the unpaged list)

export const ORDERS_DEFAULT_PAGE_SIZE = 50;
export const ORDERS_MAX_PAGE_SIZE = 200;
export const ORDERS_MAX_PAGE = 100_000;

export interface OrdersQuery {
  status?: string;
  storeId?: string;
  from?: Date;
  to?: Date;
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

export function parseOrdersQuery(q: Record<string, unknown> | null | undefined): OrdersQuery {
  const src = q ?? {};
  let from = optDate(src.from);
  let to = optDate(src.to);
  if (from && to && from.getTime() > to.getTime()) [from, to] = [to, from];
  return {
    status: optString(src.status),
    storeId: optString(src.storeId),
    from,
    to,
    page: clampInt(src.page, 1, 1, ORDERS_MAX_PAGE),
    pageSize: clampInt(src.pageSize, ORDERS_DEFAULT_PAGE_SIZE, 1, ORDERS_MAX_PAGE_SIZE),
  };
}

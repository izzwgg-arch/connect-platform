"use client";

// Tracking → Orders. Filters live in the URL (?range=30d&status=…&store=…&page=2&size=50)
// so a lookup can be bookmarked, shared and survives Back. The API pages server-side
// (GET /delivery/orders → { items, total, page, pageSize }); the search box narrows the
// loaded page client-side, as before. See CLAUDE.md handoff "Orders page date-range
// filter + paging (2026-09-08)".

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Package, Search, X } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { deliveryApi, type DeliveryOrderRow, type DeliveryStoreRow } from "../../../../services/deliveryApi";

const STATUS_TONES: Record<string, string> = {
  DELIVERED: "border-crm-success/40 bg-crm-success/10 text-crm-success",
  PARTIALLY_DELIVERED: "border-crm-success/40 bg-crm-success/10 text-crm-success",
  CANCELED: "border-crm-border bg-crm-surface-2 text-crm-muted",
  DELIVERY_FAILED: "border-crm-danger/40 bg-crm-danger/10 text-crm-danger",
  REFUSED: "border-crm-danger/40 bg-crm-danger/10 text-crm-danger",
  EXCEPTION: "border-crm-danger/40 bg-crm-danger/10 text-crm-danger",
  OUT_FOR_DELIVERY: "border-crm-accent/40 bg-crm-accent/10 text-crm-accent",
  EN_ROUTE: "border-crm-accent/40 bg-crm-accent/10 text-crm-accent",
  APPROACHING: "border-crm-accent/40 bg-crm-accent/10 text-crm-accent",
  ARRIVED: "border-crm-accent/40 bg-crm-accent/10 text-crm-accent",
};
function statusClass(s: string) {
  return STATUS_TONES[s] || "border-crm-border bg-crm-surface-2 text-crm-muted";
}

const STATUS_FILTERS = ["", "READY", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED"];

type RangeKey = "today" | "7d" | "30d" | "90d" | "all" | "custom";
const RANGE_PRESETS: { key: RangeKey; label: string; daysBack: number | null }[] = [
  { key: "today", label: "Today", daysBack: 0 },
  { key: "7d", label: "Last 7 days", daysBack: 6 },
  { key: "30d", label: "Last 30 days", daysBack: 29 },
  { key: "90d", label: "Last 90 days", daysBack: 89 },
  { key: "all", label: "All time", daysBack: null },
];
const DEFAULT_RANGE: RangeKey = "30d";
const PAGE_SIZES = [25, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 50;

function isRangeKey(v: string | null): v is RangeKey {
  return v === "custom" || RANGE_PRESETS.some((p) => p.key === v);
}
function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
/** "2026-06-01" (an <input type="date"> value) → local midnight, or null. */
function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function toYmd(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Local-day boundaries for the chosen range, as instants the API compares createdAt against. */
function rangeBounds(range: RangeKey, from: string, to: string, now = new Date()): { from?: Date; to?: Date } {
  if (range === "all") return {};
  if (range === "custom") {
    const f = from ? parseYmd(from) : null;
    const t = to ? parseYmd(to) : null;
    return { from: f ? startOfDay(f) : undefined, to: t ? endOfDay(t) : undefined };
  }
  const preset = RANGE_PRESETS.find((p) => p.key === range);
  const back = preset?.daysBack ?? 29;
  const f = startOfDay(now);
  f.setDate(f.getDate() - back);
  return { from: f };
}
function describeRange(range: RangeKey, bounds: { from?: Date; to?: Date }, now = new Date()) {
  if (range === "all") return "All time";
  const from = bounds.from;
  const to = bounds.to ?? now;
  if (!from) return to ? `Up to ${fmtDay(to, true)}` : "All time";
  const sameYear = from.getFullYear() === to.getFullYear();
  const sameMonth = sameYear && from.getMonth() === to.getMonth();
  if (sameMonth && from.getDate() === to.getDate()) return fmtDay(from, true);
  if (sameMonth) return `${from.getDate()} – ${fmtDay(to, true)}`;
  return `${fmtDay(from, !sameYear)} – ${fmtDay(to, true)}`;
}
function fmtDay(d: Date, withYear: boolean) {
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
}
function fmtReceived(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: "—", time: "" };
  const day = d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return { day, time };
}
function pageNumbers(page: number, pages: number): (number | "…")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out: (number | "…")[] = [1];
  if (page > 3) out.push("…");
  for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) out.push(i);
  if (page < pages - 2) out.push("…");
  out.push(pages);
  return out;
}

export default function DeliveryOrdersPage() {
  // useSearchParams needs a Suspense boundary under the app router.
  return (
    <Suspense fallback={<CRMPageShell innerClassName={crm.pageInnerWide}><p className="p-4 text-sm text-crm-muted">Loading…</p></CRMPageShell>}>
      <DeliveryOrdersInner />
    </Suspense>
  );
}

function DeliveryOrdersInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // ── URL-backed filter state ────────────────────────────────────────────────
  const rangeParam = sp.get("range");
  const range: RangeKey = isRangeKey(rangeParam) ? rangeParam : DEFAULT_RANGE;
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";
  const status = sp.get("status") ?? "";
  const storeId = sp.get("store") ?? "";
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const sizeParam = Number.parseInt(sp.get("size") ?? "", 10);
  const pageSize = PAGE_SIZES.includes(sizeParam) ? sizeParam : DEFAULT_PAGE_SIZE;

  const setParams = useCallback(
    (patch: Record<string, string | null>, opts: { keepPage?: boolean } = {}) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      if (!opts.keepPage) next.delete("page");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [sp, router, pathname],
  );

  // ── Custom range draft (only committed on Apply) ───────────────────────────
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  useEffect(() => {
    setDraftFrom(from);
    setDraftTo(to);
  }, [from, to]);
  const draftValid = Boolean(draftFrom || draftTo) && (!draftFrom || !draftTo || draftFrom <= draftTo);
  const draftDirty = draftFrom !== from || draftTo !== to;

  // ── Data ───────────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<DeliveryOrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [stores, setStores] = useState<DeliveryStoreRow[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const bounds = useMemo(() => rangeBounds(range, from, to), [range, from, to]);
  const rangeText = useMemo(() => describeRange(range, bounds), [range, bounds]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    deliveryApi
      .orders({
        status: status || undefined,
        storeId: storeId || undefined,
        from: bounds.from?.toISOString(),
        to: bounds.to?.toISOString(),
        page,
        pageSize,
      })
      .then((res) => {
        if (cancelled) return;
        setRows(res.items);
        setTotal(res.total);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load orders.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, storeId, bounds, page, pageSize]);

  useEffect(() => {
    deliveryApi.stores().then(setStores).catch(() => setStores([]));
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((o) =>
      [o.sourceId, o.customerName, o.addrLine1, o.driverName].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)),
    );
  }, [rows, q]);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const firstIdx = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastIdx = Math.min(page * pageSize, total);
  const showing = total === 0 ? "No orders" : `Showing ${firstIdx.toLocaleString()}–${lastIdx.toLocaleString()} of ${total.toLocaleString()}`;
  const filtersActive = range !== DEFAULT_RANGE || Boolean(status) || Boolean(storeId) || pageSize !== DEFAULT_PAGE_SIZE || Boolean(q);
  const todayYmd = toYmd(new Date());

  const storeOptions = useMemo(
    () => [{ value: "", label: "All stores" }, ...stores.map((s) => ({ value: s.id, label: s.name }))],
    [stores],
  );

  const pagerBtn = cn(crm.btnSecondary, "h-8 w-8 rounded-lg p-0");

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<Package size={20} />}
        title="Orders"
        subtitle="Search and manage delivery orders. Open one for its full audit timeline."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-crm-muted" />
              <input
                className={cn(crm.input, crm.inputWithIcon, "h-9 w-52")}
                placeholder="Search order, name, driver…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            {stores.length > 1 ? (
              <ConnectSelect
                size="sm"
                className="w-44"
                value={storeId}
                onChange={(v) => setParams({ store: v })}
                ariaLabel="Store"
                options={storeOptions}
              />
            ) : null}
          </div>
        }
      />

      {/* Filter bar */}
      <CRMCard padding="md" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="min-w-[64px] text-[11px] font-semibold uppercase tracking-wide text-crm-muted">Status</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f || "all"}
                type="button"
                className={status === f ? crm.filterPillActive : crm.filterPill}
                onClick={() => setParams({ status: f })}
              >
                {f ? f.replace(/_/g, " ").toLowerCase() : "all"}
              </button>
            ))}
          </div>
        </div>
        <div className="border-t border-crm-border" />
        <div className="flex flex-wrap items-center gap-3">
          <span className="min-w-[64px] text-[11px] font-semibold uppercase tracking-wide text-crm-muted">Received</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={range === p.key ? crm.filterPillActive : crm.filterPill}
                onClick={() => setParams({ range: p.key === DEFAULT_RANGE ? null : p.key, from: null, to: null })}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className={range === "custom" ? crm.filterPillActive : crm.filterPill}
              onClick={() => {
                if (range === "custom") return;
                // Seed the draft with the range currently shown so Apply is one click away.
                const seedFrom = bounds.from ? toYmd(bounds.from) : "";
                setDraftFrom(seedFrom);
                setDraftTo(todayYmd);
                setParams({ range: "custom", from: seedFrom || null, to: todayYmd });
              }}
            >
              {range === "custom" ? "Custom" : "Custom…"}
            </button>
          </div>
          {range === "custom" ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!draftValid) return;
                setParams({ range: "custom", from: draftFrom || null, to: draftTo || null });
              }}
            >
              <input
                type="date"
                aria-label="From date"
                className={cn(crm.selectCompact, "tracking-orders-date h-9 w-[150px]")}
                value={draftFrom}
                max={draftTo || todayYmd}
                onChange={(e) => setDraftFrom(e.target.value)}
              />
              <span className="text-[13px] text-crm-muted">to</span>
              <input
                type="date"
                aria-label="To date"
                className={cn(crm.selectCompact, "tracking-orders-date h-9 w-[150px]")}
                value={draftTo}
                min={draftFrom || undefined}
                max={todayYmd}
                onChange={(e) => setDraftTo(e.target.value)}
              />
              <button type="submit" className={cn(crm.btnPrimary, "h-9")} disabled={!draftValid || !draftDirty}>
                Apply
              </button>
            </form>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <span className="whitespace-nowrap text-[13px] text-crm-muted">{rangeText}</span>
            {filtersActive ? (
              <button
                type="button"
                className={crm.btnGhost}
                onClick={() => {
                  setQ("");
                  setParams({ range: null, from: null, to: null, status: null, store: null, size: null });
                }}
              >
                <X size={14} /> Clear filters
              </button>
            ) : null}
          </div>
        </div>
      </CRMCard>

      {/* Results */}
      <CRMCard padding="none">
        <div className="flex items-center justify-between gap-3 border-b border-crm-border px-4 py-3">
          <span className="text-[13px] text-crm-muted">
            <span className="font-semibold text-crm-text">{total.toLocaleString()}</span> {total === 1 ? "order matches" : "orders match"} · newest first
          </span>
          <span className="text-[13px] text-crm-muted">{showing}</span>
        </div>
        {error ? (
          <p className="p-4 text-sm text-crm-muted">{error}</p>
        ) : loading && rows.length === 0 ? (
          <p className="p-4 text-sm text-crm-muted">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="p-4 text-sm text-crm-muted">
            {rows.length === 0
              ? range === "all"
                ? "No orders match this filter."
                : "No orders received in this range. Try a wider range or All time."
              : "No orders on this page match your search."}
          </p>
        ) : (
          <div className={cn("overflow-x-auto transition-opacity", loading && "opacity-60")}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-crm-border text-left text-[11px] uppercase tracking-wide text-crm-muted">
                  <th className="px-4 py-2 font-semibold">Order</th>
                  <th className="px-4 py-2 font-semibold">Received</th>
                  <th className="px-4 py-2 font-semibold">Customer / address</th>
                  <th className="px-4 py-2 font-semibold">Run · driver</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Notify</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => {
                  const r = fmtReceived(o.createdAt);
                  return (
                    <tr key={o.id} className="border-b border-crm-border hover:bg-crm-surface-2">
                      <td className="px-4 py-2.5 font-mono text-xs text-crm-text">{o.sourceId}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-crm-text">
                        {r.day}
                        {r.time ? <span className="text-crm-muted"> · {r.time}</span> : null}
                      </td>
                      <td className="px-4 py-2.5 text-crm-text">
                        {o.customerName || "—"} <span className="text-crm-muted">· {o.addrLine1}{o.addrUnit ? ` ${o.addrUnit}` : ""}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        {o.driverName ? (
                          <span className="text-crm-text">{o.driverName}{o.runId ? <span className="text-crm-muted"> · run {o.runId.slice(0, 6)}</span> : null}</span>
                        ) : (
                          <span className="text-crm-muted">unassigned</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusClass(o.status)}`}>
                          {o.status.replace(/_/g, " ").toLowerCase()}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        {o.notifyConsent ? (
                          <span className="inline-flex items-center gap-1 text-xs text-crm-success">● on</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-crm-muted">○ off</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link href={`/tracking/orders/${o.id}`} className={crm.btnGhost}>Open</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!error && total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-crm-border px-4 py-3">
            <span className="text-[13px] text-crm-muted">{showing}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={pagerBtn}
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => setParams({ page: page - 1 <= 1 ? null : String(page - 1) }, { keepPage: true })}
              >
                <ChevronLeft size={14} />
              </button>
              {pageNumbers(page, pages).map((n, i) =>
                n === "…" ? (
                  <span key={`gap-${i}`} className="inline-flex h-8 min-w-[32px] items-center justify-center px-2 text-[13px] text-crm-muted">…</span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    aria-current={n === page ? "page" : undefined}
                    className={cn(
                      "inline-flex h-8 min-w-[32px] items-center justify-center rounded-lg border px-2 text-[13px] font-medium transition-colors",
                      n === page
                        ? "border-crm-accent/50 bg-crm-accent/15 text-crm-accent"
                        : "border-transparent text-crm-muted hover:bg-crm-surface-2 hover:text-crm-text",
                    )}
                    onClick={() => setParams({ page: n === 1 ? null : String(n) }, { keepPage: true })}
                  >
                    {n}
                  </button>
                ),
              )}
              <button
                type="button"
                className={pagerBtn}
                aria-label="Next page"
                disabled={page >= pages}
                onClick={() => setParams({ page: String(page + 1) }, { keepPage: true })}
              >
                <ChevronRight size={14} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-crm-muted">Rows per page</span>
              <ConnectSelect
                size="sm"
                className="w-[88px]"
                value={String(pageSize)}
                onChange={(v) => setParams({ size: Number(v) === DEFAULT_PAGE_SIZE ? null : v })}
                ariaLabel="Rows per page"
                options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
              />
            </div>
          </div>
        ) : null}
      </CRMCard>
    </CRMPageShell>
  );
}

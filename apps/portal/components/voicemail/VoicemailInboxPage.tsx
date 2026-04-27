"use client";

import { MoreHorizontal, Phone, Play, Search, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../EmptyState";
import { ErrorState } from "../ErrorState";
import { LoadingSkeleton } from "../LoadingSkeleton";
import { PageHeader } from "../PageHeader";
import { useAppContext } from "../../hooks/useAppContext";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useSipPhone } from "../../hooks/useSipPhone";
import { apiDelete, apiGet, apiPatch } from "../../services/apiClient";
import { VoicemailDetailDrawer } from "./VoicemailDetailDrawer";
import { VoicemailKpiStrip } from "./VoicemailKpiStrip";
import { dayGroupFor, dayGroupLabel, fmtDuration, fmtListTime, previewText, callerInitials, callerKind } from "./formatting";
import type { DayGroup } from "./formatting";
import type { VoicemailFolder, VoicemailListResponse, VoicemailRow, VoicemailTab } from "./types";

const PAGE_SIZE_HINT = 100;

function useWideInboxLayout(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const fn = () => setWide(mq.matches);
    fn();
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return wide;
}

function buildListParams(args: {
  tab: VoicemailTab;
  page: number;
  tenantParam: string;
  extension: string;
  dateFrom: string;
  dateTo: string;
  search: string;
}): string {
  const p = new URLSearchParams();
  p.set("page", String(args.page));
  p.set("tenantId", args.tenantParam);
  if (args.extension.trim()) p.set("extension", args.extension.trim());
  if (args.dateFrom) p.set("dateFrom", args.dateFrom);
  if (args.dateTo) p.set("dateTo", args.dateTo);
  if (args.search.trim()) p.set("search", args.search.trim());
  if (args.tab === "inbox") p.set("folder", "inbox");
  if (args.tab === "urgent") p.set("folder", "urgent");
  if (args.tab === "old") p.set("folder", "old");
  if (args.tab === "new") p.set("listened", "false");
  return p.toString();
}

function buildStatsParams(tenantParam: string, extra: Record<string, string>): string {
  const p = new URLSearchParams();
  p.set("page", "1");
  p.set("tenantId", tenantParam);
  Object.entries(extra).forEach(([k, v]) => p.set(k, v));
  return p.toString();
}

export function VoicemailInboxPage() {
  const router = useRouter();
  const phone = useSipPhone();
  const { adminScope, tenantId: contextTenantId } = useAppContext();
  const wide = useWideInboxLayout();

  const [tab, setTab] = useState<VoicemailTab>("inbox");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 280);
  const [extensionFilter, setExtensionFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<VoicemailRow[]>([]);
  const [total, setTotal] = useState(0);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selected, setSelected] = useState<VoicemailRow | null>(null);
  const [drawerAutoPlay, setDrawerAutoPlay] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);

  const [stats, setStats] = useState({ total: 0, newCount: 0, urgentCount: 0, staleCount: 0 });
  const [statsLoading, setStatsLoading] = useState(true);

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const tenantParam = useMemo(() => {
    if (contextTenantId) return contextTenantId;
    if (adminScope === "GLOBAL") return "global";
    return contextTenantId || "global";
  }, [adminScope, contextTenantId]);

  const showTenant = !contextTenantId && adminScope === "GLOBAL";

  const notesKey = useMemo(() => `cc-vm-notes-v1:${tenantParam}`, [tenantParam]);
  const [noteDraft, setNoteDraft] = useState("");

  useEffect(() => {
    if (!selected) {
      setNoteDraft("");
      return;
    }
    try {
      const raw = localStorage.getItem(notesKey);
      const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      setNoteDraft(map[selected.id] ?? "");
    } catch {
      setNoteDraft("");
    }
  }, [selected, notesKey]);

  const persistNote = useCallback(
    (vmId: string, text: string) => {
      try {
        const raw = localStorage.getItem(notesKey);
        const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
        if (text.trim()) map[vmId] = text;
        else delete map[vmId];
        localStorage.setItem(notesKey, JSON.stringify(map));
      } catch {
        /* ignore */
      }
    },
    [notesKey],
  );

  const onNotesChange = useCallback(
    (text: string) => {
      setNoteDraft(text);
      if (selected) persistNote(selected.id, text);
    },
    [persistNote, selected],
  );

  useEffect(() => {
    setPage(1);
  }, [tab, debouncedSearch, extensionFilter, dateFrom, dateTo, tenantParam]);

  const reloadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const [inb, urg, oldVm, unread, stale] = await Promise.all([
        apiGet<VoicemailListResponse>(`/voice/voicemail?${buildStatsParams(tenantParam, { folder: "inbox" })}`),
        apiGet<VoicemailListResponse>(`/voice/voicemail?${buildStatsParams(tenantParam, { folder: "urgent" })}`),
        apiGet<VoicemailListResponse>(`/voice/voicemail?${buildStatsParams(tenantParam, { folder: "old" })}`),
        apiGet<VoicemailListResponse>(`/voice/voicemail?${buildStatsParams(tenantParam, { listened: "false" })}`),
        apiGet<VoicemailListResponse>(`/voice/voicemail?${buildStatsParams(tenantParam, { olderThanDays: "7" })}`),
      ]);
      const totalVm = (inb.total ?? 0) + (urg.total ?? 0) + (oldVm.total ?? 0);
      setStats({
        total: totalVm,
        newCount: unread.total ?? 0,
        urgentCount: urg.total ?? 0,
        staleCount: stale.total ?? 0,
      });
    } catch {
      setStats({ total: 0, newCount: 0, urgentCount: 0, staleCount: 0 });
    } finally {
      setStatsLoading(false);
    }
  }, [tenantParam]);

  useEffect(() => {
    void reloadStats();
  }, [reloadStats]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (page === 1) setLoadingInitial(true);
      else setLoadingMore(true);
      setListError(null);
      try {
        const qs = buildListParams({
          tab,
          page,
          tenantParam,
          extension: extensionFilter,
          dateFrom,
          dateTo,
          search: debouncedSearch,
        });
        const data = await apiGet<VoicemailListResponse>(`/voice/voicemail?${qs}`);
        if (cancelled) return;
        setTotal(data.total ?? 0);
        const chunk = data.voicemails ?? [];
        setRows((prev) => {
          if (page === 1) return chunk;
          const seen = new Set(prev.map((r) => r.id));
          const merged = [...prev];
          for (const r of chunk) {
            if (!seen.has(r.id)) merged.push(r);
          }
          return merged;
        });
      } catch (e: unknown) {
        if (!cancelled) setListError(e instanceof Error ? e.message : "Failed to load voicemails");
      } finally {
        if (!cancelled) {
          setLoadingInitial(false);
          setLoadingMore(false);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [tab, page, tenantParam, extensionFilter, dateFrom, dateTo, debouncedSearch]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((e) => e.isIntersecting);
        if (!hit || loadingMore || loadingInitial) return;
        if (rows.length >= total) return;
        setPage((p) => p + 1);
      },
      { root: null, rootMargin: "120px", threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadingMore, loadingInitial, rows.length, total]);

  useEffect(() => {
    if (!rowMenuId) return;
    function close(e: MouseEvent) {
      const el = e.target as HTMLElement;
      if (el.closest("[data-vm-row-menu]") || el.closest("[data-vm-more-btn]")) return;
      setRowMenuId(null);
    }
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [rowMenuId]);

  const grouped = useMemo(() => {
    const order: DayGroup[] = ["today", "yesterday", "earlier"];
    const buckets: Record<DayGroup, VoicemailRow[]> = { today: [], yesterday: [], earlier: [] };
    for (const r of rows) {
      buckets[dayGroupFor(r.receivedAt)].push(r);
    }
    return order.filter((k) => buckets[k].length > 0).map((k) => ({ key: k, label: dayGroupLabel(k), items: buckets[k] }));
  }, [rows]);

  const mergeRow = useCallback((id: string, patch: Partial<VoicemailRow>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setSelected((s) => (s?.id === id ? { ...s, ...patch } : s));
  }, []);

  const handlePatch = useCallback(
    async (id: string, body: { listened?: boolean; folder?: VoicemailFolder }) => {
      await apiPatch(`/voice/voicemail/${id}`, body);
      if (body.listened !== undefined) mergeRow(id, { listened: body.listened, readAt: body.listened ? new Date().toISOString() : null });
      if (body.folder !== undefined) mergeRow(id, { folder: body.folder });

      const leavesTab =
        (tab === "inbox" && body.folder != null && body.folder !== "inbox") ||
        (tab === "urgent" && body.folder != null && body.folder !== "urgent") ||
        (tab === "old" && body.folder != null && body.folder !== "old") ||
        (tab === "new" && body.listened === true);
      if (leavesTab) {
        setRows((rs) => rs.filter((r) => r.id !== id));
        setSelected((s) => (s?.id === id ? null : s));
      }
      void reloadStats();
    },
    [mergeRow, reloadStats, tab],
  );

  const handleDelete = useCallback(async (id: string) => {
    setDeleteId(id);
    try {
      await apiDelete(`/voice/voicemail/${id}`);
      setRows((rs) => rs.filter((r) => r.id !== id));
      setSelected((s) => (s?.id === id ? null : s));
      void reloadStats();
    } finally {
      setDeleteId(null);
    }
  }, [reloadStats]);

  const handleCall = useCallback(
    (num: string) => {
      phone.setDialpadInput(num);
      phone.dial(num);
    },
    [phone],
  );

  const handleMessage = useCallback(
    (_num: string) => {
      router.push("/sms");
    },
    [router],
  );

  const handleCopy = useCallback(async (num: string) => {
    try {
      await navigator.clipboard.writeText(num);
    } catch {
      /* ignore */
    }
  }, []);

  const refresh = useCallback(() => {
    setPage(1);
    setRows([]);
    setLoadingInitial(true);
    void reloadStats();
  }, [reloadStats]);

  const emptyTitle =
    debouncedSearch.trim() || extensionFilter.trim() || dateFrom || dateTo
      ? "No voicemails match your filters"
      : tab === "new"
        ? "No new messages"
        : "No voicemails yet";

  const emptyMessage =
    debouncedSearch.trim() || extensionFilter.trim() || dateFrom || dateTo
      ? "Try clearing search or widening the date range."
      : "When callers leave a message, it will show up here as a conversation thread.";

  const tabs: { key: VoicemailTab; label: string }[] = [
    { key: "inbox", label: "Inbox" },
    { key: "new", label: "New" },
    { key: "urgent", label: "Urgent" },
    { key: "old", label: "Old" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 54px)", overflow: "hidden", background: "var(--bg-soft)" }}>
      <div style={{ flexShrink: 0, padding: "16px 20px 12px", borderBottom: "1px solid var(--border)", background: "var(--panel)" }}>
        <div style={{ marginBottom: 14 }}>
          <PageHeader
            title="Voicemail"
            subtitle="Messages from people, not audio files."
            actions={
              <button type="button" className="btn ghost" onClick={refresh} style={{ fontSize: 13 }}>
                Refresh
              </button>
            }
          />
        </div>
        <VoicemailKpiStrip
          loading={statsLoading}
          total={stats.total}
          newCount={stats.newCount}
          urgentCount={stats.urgentCount}
          staleCount={stats.staleCount}
        />
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            borderRight: wide && selected ? "1px solid var(--border)" : undefined,
          }}
        >
          <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)", background: "var(--panel)" }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  style={{
                    padding: "8px 16px",
                    borderRadius: 99,
                    border: tab === t.key ? "1px solid rgba(34,168,255,0.45)" : "1px solid var(--border)",
                    background: tab === t.key ? "rgba(34,168,255,0.12)" : "var(--panel-2)",
                    color: tab === t.key ? "var(--accent)" : "var(--text-dim)",
                    fontWeight: tab === t.key ? 650 : 500,
                    fontSize: 13,
                    cursor: "pointer",
                    transition: "background 0.15s, border-color 0.15s, color 0.15s",
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              <div style={{ position: "relative", flex: "1 1 220px", minWidth: 0, maxWidth: 420 }}>
                <Search
                  size={16}
                  style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)" }}
                />
                <input
                  className="input"
                  placeholder="Search name, number, or extension…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ paddingLeft: 38, fontSize: 13, width: "100%" }}
                />
              </div>
              <input
                className="input"
                placeholder="Extension filter"
                value={extensionFilter}
                onChange={(e) => setExtensionFilter(e.target.value)}
                style={{ width: 130, fontSize: 13 }}
              />
              <input className="input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ width: 150, fontSize: 13 }} />
              <input className="input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ width: 150, fontSize: 13 }} />
              {(extensionFilter || dateFrom || dateTo || search) && (
                <button
                  type="button"
                  className="btn ghost"
                  style={{ fontSize: 12 }}
                  onClick={() => {
                    setExtensionFilter("");
                    setDateFrom("");
                    setDateTo("");
                    setSearch("");
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", background: "var(--bg)" }}>
            {loadingInitial && rows.length === 0 ? <LoadingSkeleton rows={6} /> : null}
            {listError && rows.length === 0 ? <ErrorState message={listError} /> : null}
            {!loadingInitial && !listError && rows.length === 0 ? <EmptyState title={emptyTitle} message={emptyMessage} /> : null}

            {grouped.map((g) => (
              <div key={g.key}>
                <div
                  style={{
                    position: "sticky",
                    top: 0,
                    zIndex: 2,
                    padding: "10px 20px",
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    color: "var(--text-dim)",
                    background: "color-mix(in srgb, var(--panel) 94%, transparent)",
                    backdropFilter: "blur(8px)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  {g.label}
                </div>
                {g.items.map((vm) => {
                  const selectedRow = selected?.id === vm.id;
                  const unread = !vm.listened;
                  const urgent = vm.folder === "urgent";
                  const old = vm.folder === "old";
                  const preview = previewText(vm);
                  const kind = callerKind(vm);

                  return (
                    <div
                      key={vm.id}
                      onClick={() => {
                        setSelected(vm);
                        setDrawerAutoPlay(false);
                        setRowMenuId(null);
                      }}
                      style={{
                        margin: "0 12px 10px",
                        borderRadius: 16,
                        border: `1px solid ${selectedRow ? "rgba(34,168,255,0.45)" : "var(--border)"}`,
                        background: selectedRow ? "rgba(34,168,255,0.07)" : unread ? "rgba(34,168,255,0.04)" : "var(--panel)",
                        boxShadow: selectedRow ? "0 8px 28px rgba(34,168,255,0.12)" : "0 4px 16px rgba(0,0,0,0.04)",
                        padding: "14px 16px",
                        cursor: "pointer",
                        display: "grid",
                        gridTemplateColumns: "minmax(0,1fr) auto",
                        gap: 12,
                        transition: "transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease, background 0.15s ease",
                      }}
                      className="vm-feed-card"
                    >
                      <style>{`
                        .vm-feed-card:hover {
                          transform: translateY(-1px);
                          box-shadow: 0 10px 28px rgba(0,0,0,0.08);
                        }
                      `}</style>
                      <div style={{ display: "flex", gap: 14, minWidth: 0 }}>
                        <div
                          style={{
                            width: 46,
                            height: 46,
                            borderRadius: "50%",
                            background: "linear-gradient(145deg, var(--panel-2), var(--panel))",
                            border: "1px solid var(--border)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontWeight: 800,
                            fontSize: 14,
                            color: "var(--accent)",
                            flexShrink: 0,
                          }}
                        >
                          {callerInitials(vm)}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontWeight: unread ? 750 : 600, fontSize: 15, letterSpacing: "-0.02em" }}>
                              {vm.callerName || vm.callerId}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                padding: "2px 8px",
                                borderRadius: 99,
                                background: "var(--panel-2)",
                                border: "1px solid var(--border)",
                                color: "var(--text-dim)",
                              }}
                            >
                              Ext {vm.extension}
                            </span>
                            {showTenant && vm.tenantName ? (
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 500,
                                  padding: "2px 8px",
                                  borderRadius: 99,
                                  background: "var(--panel-2)",
                                  color: "var(--text-dim)",
                                  border: "1px solid var(--border)",
                                  maxWidth: 160,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={vm.tenantName}
                              >
                                {vm.tenantName}
                              </span>
                            ) : null}
                            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{kind === "internal" ? "Internal" : "External"}</span>
                          </div>
                          <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.45 }}>
                            {preview ?? "Voicemail received"}
                          </div>
                          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                            {unread ? (
                              <span style={{ fontSize: 11, fontWeight: 650, padding: "2px 8px", borderRadius: 99, background: "rgba(34,168,255,0.15)", color: "var(--accent)" }}>
                                New
                              </span>
                            ) : null}
                            {urgent ? (
                              <span style={{ fontSize: 11, fontWeight: 650, padding: "2px 8px", borderRadius: 99, background: "rgba(234,96,104,0.15)", color: "var(--danger)" }}>
                                Urgent
                              </span>
                            ) : null}
                            {old ? (
                              <span style={{ fontSize: 11, fontWeight: 650, padding: "2px 8px", borderRadius: 99, background: "rgba(142,160,178,0.12)", color: "var(--text-dim)" }}>
                                Old
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10, minWidth: 120 }}>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 500 }}>{fmtListTime(vm.receivedAt)}</div>
                          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>{fmtDuration(vm.durationSec)}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }} onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="icon-btn"
                            title="Play"
                            style={{
                              width: 42,
                              height: 42,
                              borderRadius: "50%",
                              background: "var(--accent)",
                              color: "#fff",
                              border: "none",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              cursor: "pointer",
                              boxShadow: "0 4px 14px rgba(34,168,255,0.35)",
                            }}
                            onClick={() => {
                              setSelected(vm);
                              setDrawerAutoPlay(true);
                            }}
                          >
                            <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />
                          </button>
                          <button type="button" className="icon-btn" title="Call back" onClick={() => handleCall(vm.callerId)}>
                            <Phone size={17} />
                          </button>
                          <button type="button" className="icon-btn" title="Messages" onClick={() => handleMessage(vm.callerId)}>
                            <Send size={17} />
                          </button>
                          <div style={{ position: "relative" }}>
                            <button
                              type="button"
                              className="icon-btn"
                              title="More"
                              data-vm-more-btn
                              onClick={() => setRowMenuId((id) => (id === vm.id ? null : vm.id))}
                            >
                              <MoreHorizontal size={18} />
                            </button>
                            {rowMenuId === vm.id ? (
                              <div
                                data-vm-row-menu
                                style={{
                                  position: "absolute",
                                  right: 0,
                                  top: "100%",
                                  marginTop: 6,
                                  minWidth: 200,
                                  padding: 6,
                                  borderRadius: 12,
                                  border: "1px solid var(--border)",
                                  background: "var(--panel)",
                                  boxShadow: "var(--shadow)",
                                  zIndex: 5,
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 2,
                                }}
                              >
                                <button
                                  type="button"
                                  className="btn ghost"
                                  style={{ justifyContent: "flex-start", fontSize: 13 }}
                                  onClick={() => {
                                    void handleCopy(vm.callerId);
                                    setRowMenuId(null);
                                  }}
                                >
                                  Copy number
                                </button>
                                <button
                                  type="button"
                                  className="btn ghost"
                                  style={{ justifyContent: "flex-start", fontSize: 13 }}
                                  onClick={() => {
                                    void handlePatch(vm.id, { listened: !vm.listened });
                                    setRowMenuId(null);
                                  }}
                                >
                                  Mark {vm.listened ? "unread" : "read"}
                                </button>
                                {vm.folder !== "urgent" ? (
                                  <button
                                    type="button"
                                    className="btn ghost"
                                    style={{ justifyContent: "flex-start", fontSize: 13, color: "var(--danger)" }}
                                    onClick={() => {
                                      void handlePatch(vm.id, { folder: "urgent" });
                                      setRowMenuId(null);
                                    }}
                                  >
                                    Mark urgent
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="btn ghost"
                                    style={{ justifyContent: "flex-start", fontSize: 13 }}
                                    onClick={() => {
                                      void handlePatch(vm.id, { folder: "inbox" });
                                      setRowMenuId(null);
                                    }}
                                  >
                                    Move to inbox
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn ghost"
                                  style={{ justifyContent: "flex-start", fontSize: 13, color: "var(--danger)" }}
                                  disabled={deleteId === vm.id}
                                  onClick={() => {
                                    void handleDelete(vm.id);
                                    setRowMenuId(null);
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}

            <div ref={sentinelRef} style={{ height: 24 }} />
            {loadingMore ? (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Loading more…</div>
            ) : null}
            {rows.length > 0 && rows.length >= total ? (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
                End of list · {total.toLocaleString()} message{total === 1 ? "" : "s"} · up to {PAGE_SIZE_HINT} per request
              </div>
            ) : null}
          </div>
        </div>

        {selected && wide ? (
          <VoicemailDetailDrawer
            vm={selected}
            open
            autoPlayAudio={drawerAutoPlay}
            showTenant={showTenant}
            notes={noteDraft}
            onNotesChange={onNotesChange}
            onClose={() => setSelected(null)}
            onCall={handleCall}
            onMessage={handleMessage}
            onCopyNumber={handleCopy}
            onDelete={handleDelete}
            onToggleListened={async (id, listened) => {
              await handlePatch(id, { listened });
            }}
            onSetFolder={async (id, folder) => {
              await handlePatch(id, { folder });
            }}
            deleting={deleteId === selected.id}
            layout="side"
          />
        ) : null}
      </div>

      {selected && !wide ? (
        <VoicemailDetailDrawer
          vm={selected}
          open
          autoPlayAudio={drawerAutoPlay}
          showTenant={showTenant}
          notes={noteDraft}
          onNotesChange={onNotesChange}
          onClose={() => setSelected(null)}
          onCall={handleCall}
          onMessage={handleMessage}
          onCopyNumber={handleCopy}
          onDelete={handleDelete}
          onToggleListened={async (id, listened) => {
            await handlePatch(id, { listened });
          }}
          onSetFolder={async (id, folder) => {
            await handlePatch(id, { folder });
          }}
          deleting={deleteId === selected.id}
          layout="overlay"
        />
      ) : null}
    </div>
  );
}

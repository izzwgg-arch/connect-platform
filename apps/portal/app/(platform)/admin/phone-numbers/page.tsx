"use client";

import { useCallback, useMemo, useState } from "react";
import { Hash, RefreshCw, Search, Star } from "lucide-react";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { ErrorState } from "../../../../components/ErrorState";
import { apiGet, apiPut } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";
import { useTenantOptions } from "../../../../hooks/useTenantOptions";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";

// ── Types ──────────────────────────────────────────────────────────────────────

type PbxDidRow = {
  id: string;
  pbxInstanceId: string;
  vitalTenantId: string;
  e164: string;
  rawNumber: string | null;
  pbxTenantSlug: string | null;
  pbxTenantCode: string | null;
  connectTenantId: string | null;
  active: boolean;
  lastSeenAt: string;
  createdAt: string;
};

type ConnectPhoneNumber = {
  id: string;
  tenantId: string;
  tenantName: string | null;
  provider: string;
  phoneNumber: string;
  friendlyName: string | null;
  region: string | null;
  areaCode: string | null;
  monthlyCostCents: number;
  status: string;
  purchasedAt: string | null;
  createdAt: string;
  tenant?: { name: string } | null;
};

type PbxDidsResponse = { instanceId: string; count: number; rows: PbxDidRow[] };

type TenantBillingSettings = {
  invoiceSupportPhone?: string | null;
};

type UnifiedRow = {
  id: string;
  phoneNumber: string;
  tenantId: string | null;
  tenantName: string | null;
  source: "pbx_did" | "connect";
  status: string;
  monthlyCostCents: number | null;
  region: string | null;
  lastUpdated: string;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatE164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    const n = digits.slice(1);
    return `+1 (${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

function formatCents(cents: number | null): string {
  if (cents === null) return "—";
  if (cents === 0) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function isSameNumber(a: string, b: string) {
  return a.replace(/\D/g, "") === b.replace(/\D/g, "");
}

function statusBadge(source: "pbx_did" | "connect", status: string) {
  if (source === "pbx_did") {
    return status === "active"
      ? <span className="badge success">Active</span>
      : <span className="badge neutral">Inactive</span>;
  }
  const map: Record<string, string> = { ACTIVE: "success", RELEASING: "warning", RELEASED: "neutral", SUSPENDED: "error" };
  return <span className={`badge ${map[status] || "neutral"}`}>{status.charAt(0) + status.slice(1).toLowerCase()}</span>;
}

function sourceBadge(source: "pbx_did" | "connect") {
  return source === "pbx_did"
    ? <span className="badge info">PBX DID</span>
    : <span className="badge neutral">Connect</span>;
}

// ── Page ───────────────────────────────────────────────────────────────────────

const SOURCE_OPTIONS = [
  { value: "", label: "All sources" },
  { value: "pbx_did", label: "PBX DIDs" },
  { value: "connect", label: "Connect numbers" },
];

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive / Released" },
];

export default function AdminPhoneNumbersPage() {
  const { role } = useAppContext();
  const isSuper = role === "SUPER_ADMIN";

  const [tenantFilter, setTenantFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [settingMain, setSettingMain] = useState<string | null>(null);
  const [mainNumberOverride, setMainNumberOverride] = useState<string | null>(null);

  const { options: tenantOptions } = useTenantOptions({ connectOnly: false });

  // Fetch PBX DIDs
  const pbxParams = tenantFilter ? `?connectTenantId=${encodeURIComponent(tenantFilter)}` : "";
  const pbxDids = useAsyncResource(
    () => apiGet<PbxDidsResponse>(`/admin/pbx/tenant-inbound-dids${pbxParams}`),
    [tenantFilter, reloadKey],
    { keepPreviousData: true },
  );

  // Fetch Connect PhoneNumbers
  const cnParams = tenantFilter ? `?tenantId=${encodeURIComponent(tenantFilter)}` : "";
  const connectNumbers = useAsyncResource(
    () => apiGet<ConnectPhoneNumber[]>(`/admin/numbers${cnParams}`),
    [tenantFilter, reloadKey],
    { keepPreviousData: true },
  );

  // Fetch billing settings for selected tenant (to show current main number)
  const billingSettings = useAsyncResource(
    () =>
      tenantFilter
        ? apiGet<{ billingSettings?: TenantBillingSettings }>(`/admin/billing/platform/tenants/${encodeURIComponent(tenantFilter)}`)
        : Promise.resolve(null),
    [tenantFilter, reloadKey],
    { keepPreviousData: false },
  );

  const currentMainNumber: string =
    mainNumberOverride ??
    (billingSettings.status === "success" && billingSettings.data
      ? (billingSettings.data.billingSettings?.invoiceSupportPhone ?? "")
      : "");

  const setMainNumber = useCallback(
    async (tenantId: string, phoneNumber: string) => {
      setSettingMain(phoneNumber);
      try {
        await apiPut(`/admin/billing/tenants/${encodeURIComponent(tenantId)}/settings`, {
          invoiceSupportPhone: phoneNumber,
        });
        setMainNumberOverride(phoneNumber);
      } catch (e) {
        alert(`Failed to set main number: ${e instanceof Error ? e.message : "Unknown error"}`);
      } finally {
        setSettingMain(null);
      }
    },
    [],
  );

  // Build tenant lookup
  const tenantNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const opt of tenantOptions) m.set(opt.id, opt.name);
    return m;
  }, [tenantOptions]);

  // Reset main number override when tenant filter changes
  const handleTenantChange = (v: string) => {
    setTenantFilter(v);
    setMainNumberOverride(null);
  };

  // Merge rows
  const allRows = useMemo<UnifiedRow[]>(() => {
    const rows: UnifiedRow[] = [];
    if (pbxDids.status === "success") {
      for (const d of pbxDids.data.rows) {
        const tenantName = d.connectTenantId
          ? (tenantNameById.get(d.connectTenantId) ?? null)
          : (d.pbxTenantSlug ?? d.pbxTenantCode ?? null);
        rows.push({
          id: `pbx-${d.id}`,
          phoneNumber: d.e164,
          tenantId: d.connectTenantId,
          tenantName,
          source: "pbx_did",
          status: d.active ? "active" : "inactive",
          monthlyCostCents: null,
          region: null,
          lastUpdated: d.lastSeenAt,
        });
      }
    }
    if (connectNumbers.status === "success") {
      for (const n of connectNumbers.data) {
        rows.push({
          id: `cn-${n.id}`,
          phoneNumber: n.phoneNumber,
          tenantId: n.tenantId,
          tenantName: n.tenant?.name ?? n.tenantName ?? tenantNameById.get(n.tenantId) ?? null,
          source: "connect",
          status: n.status,
          monthlyCostCents: n.monthlyCostCents ?? null,
          region: n.region ?? null,
          lastUpdated: n.purchasedAt ?? n.createdAt,
        });
      }
    }
    // Sort: main number first, then by phone number
    rows.sort((a, b) => {
      const aMain = currentMainNumber ? isSameNumber(a.phoneNumber, currentMainNumber) : false;
      const bMain = currentMainNumber ? isSameNumber(b.phoneNumber, currentMainNumber) : false;
      if (aMain && !bMain) return -1;
      if (!aMain && bMain) return 1;
      return a.phoneNumber.localeCompare(b.phoneNumber);
    });
    return rows;
  }, [pbxDids.status, pbxDids.data, connectNumbers.status, connectNumbers.data, tenantNameById, currentMainNumber]);

  // Client-side filtering
  const filteredRows = useMemo(() => {
    let r = allRows;
    if (sourceFilter) r = r.filter((row) => row.source === sourceFilter);
    if (statusFilter === "active") r = r.filter((row) => row.status === "active" || row.status === "ACTIVE");
    if (statusFilter === "inactive") r = r.filter((row) => row.status !== "active" && row.status !== "ACTIVE");
    if (search.trim()) {
      const q = search.trim().replace(/\D/g, "");
      const ql = search.trim().toLowerCase();
      r = r.filter((row) => row.phoneNumber.replace(/\D/g, "").includes(q) || (row.tenantName ?? "").toLowerCase().includes(ql));
    }
    return r;
  }, [allRows, sourceFilter, statusFilter, search]);

  const pbxTotal = pbxDids.status === "success" ? pbxDids.data.rows.length : 0;
  const cnTotal = connectNumbers.status === "success" ? connectNumbers.data.length : 0;
  const activeCount = allRows.filter((r) => r.status === "active" || r.status === "ACTIVE").length;
  const isLoading = (pbxDids.status === "loading" && !pbxDids.data) || (connectNumbers.status === "loading" && !connectNumbers.data);
  const isRefreshing = pbxDids.status === "success" && pbxDids.refreshing;
  const hasError = pbxDids.status === "error" || connectNumbers.status === "error";
  const showMainFeature = isSuper && !!tenantFilter;

  return (
    <PermissionGate permission="can_view_admin_phone_numbers" fallback={<div className="state-box">You do not have access to this page.</div>}>
      <div className="stack" style={{ gap: 18 }}>
        <PageHeader
          title="Phone Numbers"
          subtitle="All PBX inbound DIDs and Connect phone numbers across tenants."
          actions={
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setReloadKey((k) => k + 1)}
              disabled={isLoading || isRefreshing}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <RefreshCw size={14} className={isRefreshing ? "spin" : ""} />
              Refresh
            </button>
          }
        />

        {/* Stats */}
        <section className="grid four">
          <div className="stat-card">
            <div className="stat-label">Total Numbers</div>
            <div className="stat-value">{isLoading ? "—" : pbxTotal + cnTotal}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">PBX DIDs</div>
            <div className="stat-value">{isLoading ? "—" : pbxTotal}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Connect Numbers</div>
            <div className="stat-value">{isLoading ? "—" : cnTotal}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Active</div>
            <div className="stat-value">{isLoading ? "—" : activeCount}</div>
          </div>
        </section>

        {/* Filters */}
        <section className="panel" style={{ padding: 12 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            {isSuper && (
              <ConnectSelect
                value={tenantFilter}
                onChange={(v) => handleTenantChange(v as string)}
                options={[{ value: "", label: "All tenants" }, ...tenantOptions.map((t) => ({ value: t.id, label: t.name }))]}
                placeholder="All tenants"
                style={{ minWidth: 200 }}
              />
            )}
            <ConnectSelect
              value={sourceFilter}
              onChange={(v) => setSourceFilter(v as string)}
              options={SOURCE_OPTIONS}
              placeholder="All sources"
              style={{ minWidth: 160 }}
            />
            <ConnectSelect
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as string)}
              options={STATUS_OPTIONS}
              placeholder="All statuses"
              style={{ minWidth: 160 }}
            />
            <div style={{ position: "relative", flex: "1 1 200px", minWidth: 200 }}>
              <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
              <input
                type="text"
                className="input"
                placeholder="Search number or tenant…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ paddingLeft: 32 }}
              />
            </div>
            {(tenantFilter || sourceFilter || statusFilter || search) && (
              <button className="btn btn-sm btn-ghost" onClick={() => { handleTenantChange(""); setSourceFilter(""); setStatusFilter(""); setSearch(""); }}>
                Clear filters
              </button>
            )}
          </div>
          {showMainFeature && currentMainNumber && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
              <Star size={12} style={{ color: "#f59e0b" }} />
              Main number for this tenant: <strong style={{ color: "var(--text-secondary)" }}>{formatE164(currentMainNumber)}</strong>
              <span style={{ opacity: 0.6 }}>— appears in invoice header</span>
            </div>
          )}
        </section>

        {/* Table */}
        <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
          {isLoading ? (
            <div style={{ padding: 16 }}><LoadingSkeleton rows={8} /></div>
          ) : hasError ? (
            <div style={{ padding: 16 }}>
              <ErrorState message={pbxDids.status === "error" ? (pbxDids as any).error : (connectNumbers as any).error} />
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Phone Number</th>
                    {!tenantFilter && <th>Tenant</th>}
                    <th>Source</th>
                    <th>Status</th>
                    <th>Monthly Rate</th>
                    <th>Region</th>
                    <th>Last Updated</th>
                    {showMainFeature && <th style={{ width: 120 }}>Invoice</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={showMainFeature ? 8 : 7} style={{ textAlign: "center", padding: "32px 16px", color: "var(--text-muted)" }}>
                        <Hash size={20} style={{ marginBottom: 6, opacity: 0.4 }} />
                        <div>No phone numbers found{search || tenantFilter || sourceFilter || statusFilter ? " matching filters" : ""}.</div>
                        {!tenantFilter && (
                          <div style={{ marginTop: 6, fontSize: 12 }}>
                            Select a tenant or click <strong>Refresh</strong> after running "Refresh PBX tenants."
                          </div>
                        )}
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((row) => {
                      const isMain = !!currentMainNumber && isSameNumber(row.phoneNumber, currentMainNumber);
                      const isSetting = settingMain === row.phoneNumber;
                      return (
                        <tr key={row.id} style={isMain ? { background: "var(--bg-accent-subtle, #fafaf7)" } : undefined}>
                          <td style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 500 }}>
                            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              {isMain && <Star size={13} style={{ color: "#f59e0b", flexShrink: 0 }} />}
                              {formatE164(row.phoneNumber)}
                            </span>
                          </td>
                          {!tenantFilter && (
                            <td>
                              {row.tenantName ? (
                                <span title={row.tenantId ?? undefined}>{row.tenantName}</span>
                              ) : row.tenantId ? (
                                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{row.tenantId.slice(0, 12)}…</span>
                              ) : (
                                <span style={{ color: "var(--text-muted)" }}>Unlinked</span>
                              )}
                            </td>
                          )}
                          <td>{sourceBadge(row.source)}</td>
                          <td>{statusBadge(row.source, row.status)}</td>
                          <td style={{ color: "var(--text-secondary)", fontSize: 13 }}>{formatCents(row.monthlyCostCents)}</td>
                          <td style={{ color: "var(--text-muted)", fontSize: 13 }}>{row.region ?? "—"}</td>
                          <td style={{ color: "var(--text-muted)", fontSize: 13 }}>{fmtDate(row.lastUpdated)}</td>
                          {showMainFeature && (
                            <td>
                              {isMain ? (
                                <span className="badge warning" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                  <Star size={11} /> Main
                                </span>
                              ) : row.tenantId ? (
                                <button
                                  className="btn btn-xs btn-ghost"
                                  disabled={!!settingMain}
                                  onClick={() => void setMainNumber(row.tenantId!, row.phoneNumber)}
                                  title="Set as main number for this tenant (appears in invoice header)"
                                >
                                  {isSetting ? "Saving…" : "Set as Main"}
                                </button>
                              ) : null}
                            </td>
                          )}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
          {!isLoading && !hasError && (
            <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", fontSize: 12, color: "var(--text-muted)", display: "flex", gap: 16 }}>
              <span>Showing <strong>{filteredRows.length}</strong> of <strong>{allRows.length}</strong> numbers</span>
              {showMainFeature && (
                <span style={{ opacity: 0.7 }}>Select a tenant to set the main invoice number.</span>
              )}
              {isRefreshing && <span style={{ color: "var(--text-accent)" }}>Refreshing…</span>}
            </div>
          )}
        </section>
      </div>
    </PermissionGate>
  );
}

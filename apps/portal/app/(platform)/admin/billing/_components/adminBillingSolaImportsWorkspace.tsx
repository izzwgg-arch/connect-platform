"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost } from "../../../../../services/apiClient";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { ErrorState } from "../../../../../components/ErrorState";
import { BillingEmptyState } from "../../../../../components/billing/BillingEmptyState";
import { BillingTableSkeleton } from "../../../../../components/billing/BillingTableSkeleton";
import { dollars, formatDate } from "../../../../../lib/billingUi";
import { useAdminBillingTenant } from "./useAdminBillingTenant";
import "../sola-imports/billingSolaImports.css";

type ScheduleRow = {
  id: string;
  tenantId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  companyName: string | null;
  brand: string | null;
  last4: string | null;
  amountCents: number | null;
  intervalType: string | null;
  intervalCount: number | null;
  nextRunAt: string | null;
  isActive: boolean;
  mappingStatus: string;
  matchConfidence: string | null;
  tenantName: string | null;
  suggestedTenantId: string | null;
  suggestedTenantName: string | null;
  cutoverStatus: string | null;
  linkedPaymentMethodId: string | null;
};

type ListResult = { schedules: ScheduleRow[]; total: number; page: number; pages: number };
type TenantOption = { id: string; name: string };

const STATUS_FILTERS = ["ALL", "UNMAPPED", "MAPPED", "IGNORED", "CONFLICT"] as const;

function statusChipClass(status: string) {
  const s = status.toUpperCase();
  if (s === "MAPPED") return "billing-sola-chip--mapped";
  if (s === "IGNORED") return "billing-sola-chip--ignored";
  if (s === "CONFLICT") return "billing-sola-chip--conflict";
  return "billing-sola-chip--unmapped";
}

type CutoverConfirmState = {
  row: ScheduleRow;
  step: "warning" | "confirming";
};

function cutoverStatusLabel(status: string | null): string {
  if (!status) return "Mapped";
  if (status === "TOKEN_LINKED") return "Token linked";
  if (status === "READY_FOR_CUTOVER") return "Ready for cutover";
  if (status === "CUTOVER_COMPLETE") return "Cutover complete";
  if (status === "CUTOVER_FAILED") return "Cutover failed";
  return status;
}

function cutoverStatusClass(status: string | null): string {
  if (status === "CUTOVER_COMPLETE") return "billing-sola-chip--mapped";
  if (status === "TOKEN_LINKED") return "billing-sola-chip--token-linked";
  if (status === "CUTOVER_FAILED") return "billing-sola-chip--conflict";
  return "billing-sola-chip--unmapped";
}

export function SolaImportsWorkspace() {
  const { effectiveTenantId, displayName } = useAdminBillingTenant();
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("UNMAPPED");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [listRev, setListRev] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [mapTarget, setMapTarget] = useState<{ row: ScheduleRow; tenantId: string } | null>(null);
  const [linkingToken, setLinkingToken] = useState<string | null>(null);
  const [cutoverTarget, setCutoverTarget] = useState<CutoverConfirmState | null>(null);
  const [cutoverWorking, setCutoverWorking] = useState(false);

  const tenantsRes = useAsyncResource<TenantOption[]>(() => apiGet("/admin/billing/platform/tenants"), []);
  const listUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (statusFilter !== "ALL") p.set("status", statusFilter);
    if (activeFilter === "active") p.set("active", "true");
    if (activeFilter === "inactive") p.set("active", "false");
    if (search.trim()) p.set("search", search.trim());
    p.set("page", String(page));
    p.set("limit", "50");
    return `/admin/billing/platform/sola-import/schedules?${p}`;
  }, [statusFilter, activeFilter, search, page, listRev]);

  const listRes = useAsyncResource<ListResult>(() => apiGet(listUrl), [listUrl]);
  const bumpList = useCallback(() => setListRev((n) => n + 1), []);
  const tenants = tenantsRes.status === "success" ? tenantsRes.data : [];

  return (
    <div className="billing-ws-section billing-p8-scope billing-sola-imports-scope" data-testid="billing-sola-imports">
      <div className="billing-ws-head">
        <div>
          <h2 className="billing-ws-title">Sola imported schedules</h2>
          <p className="muted billing-ws-sub">Read-only import — no charges, no schedule changes.</p>
        </div>
        <Link href="/admin/billing/payments" className="btn ghost">Payments</Link>
      </div>
      <div className="billing-sola-trust" role="note">
        <span>This does not charge customers.</span>
        <span>This does not disable existing Sola schedules.</span>
        <span>Mapping only links schedules to Connect tenants.</span>
      </div>
      {effectiveTenantId ? (
        <p className="muted billing-sola-scope-hint">
          Sync uses SOLA credentials for <strong>{displayName || "this workspace"}</strong>.
        </p>
      ) : (
        <p className="muted billing-sola-scope-hint">
          Sync uses the platform SOLA env key, or the newest enabled company SOLA config.
        </p>
      )}
      <div className="billing-sola-toolbar">
        <button type="button" className="btn primary" disabled={syncing} onClick={() => void (async () => {
          setSyncing(true);
          setActionError("");
          try {
            const r = await apiPost<{ scanned: number; created: number; updated: number }>(
              "/admin/billing/platform/sola-import/sync",
              effectiveTenantId ? { tenantId: effectiveTenantId } : {},
              undefined,
              { timeoutMs: 180_000 },
            );
            setSyncResult(`Synced ${r.scanned}: ${r.created} new, ${r.updated} updated.`);
            bumpList();
          } catch (e: unknown) { setActionError(e instanceof Error ? e.message : "Sync failed"); }
          finally { setSyncing(false); }
        })()}>{syncing ? "Syncing… (may take up to a minute)" : "Sync from Sola"}</button>
        <input className="input" placeholder="Search…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <select className="input" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as typeof statusFilter); setPage(1); }}>
          {STATUS_FILTERS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {syncResult && <p className="muted">{syncResult}</p>}
      {actionError && <ErrorState message={actionError} />}
      {listRes.status === "loading" && <BillingTableSkeleton rows={6} />}
      {listRes.status === "error" && <ErrorState message={listRes.error} />}
      {listRes.status === "success" && listRes.data.schedules.length === 0 && (
        <BillingEmptyState title="No schedules" message='Click "Sync from Sola" to import.' />
      )}
      {listRes.status === "success" && listRes.data.schedules.length > 0 && (
        <div className="billing-sola-table-scroll">
          <table className="billing-sola-table">
            <thead>
              <tr>
                <th>Customer</th><th>Card</th><th>Amount</th><th>Next run</th>
                <th>Map status</th><th>Cutover</th><th>Tenant</th><th />
              </tr>
            </thead>
            <tbody>
              {listRes.data.schedules.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.customerName || row.companyName || "—"}
                    <br /><span className="muted">{row.customerEmail}</span>
                  </td>
                  <td>{row.brand || "Card"} ···{row.last4 || "----"}</td>
                  <td>{row.amountCents != null ? dollars(row.amountCents) : "—"}</td>
                  <td>
                    {row.nextRunAt ? formatDate(row.nextRunAt) : "—"}
                    {row.isActive && row.mappingStatus === "MAPPED" && row.cutoverStatus !== "CUTOVER_COMPLETE" && (
                      <span className="billing-sola-active-warn" title="Old Sola schedule still active">⚠ Active</span>
                    )}
                  </td>
                  <td><span className={`billing-sola-chip ${statusChipClass(row.mappingStatus)}`}>{row.mappingStatus}</span></td>
                  <td>
                    {row.mappingStatus === "MAPPED" && (
                      <span className={`billing-sola-chip ${cutoverStatusClass(row.cutoverStatus)}`}>
                        {cutoverStatusLabel(row.cutoverStatus)}
                      </span>
                    )}
                  </td>
                  <td>{row.tenantName || row.suggestedTenantName || "—"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {row.mappingStatus !== "MAPPED" && row.mappingStatus !== "IGNORED" && (
                        <button type="button" className="btn ghost" onClick={() => setMapTarget({ row, tenantId: row.suggestedTenantId || tenants[0]?.id || "" })}>Map</button>
                      )}
                      {row.mappingStatus === "MAPPED" && row.cutoverStatus !== "CUTOVER_COMPLETE" && !row.linkedPaymentMethodId && (
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={linkingToken === row.id}
                          title="Store vault token in Connect. Does not charge or disable old schedule."
                          onClick={() => void (async () => {
                            setLinkingToken(row.id);
                            setActionError("");
                            try {
                              await apiPost(`/admin/billing/platform/sola-import/schedules/${row.id}/link-token`, {});
                              bumpList();
                            } catch (e: unknown) {
                              setActionError(e instanceof Error ? e.message : "Token link failed");
                            } finally {
                              setLinkingToken(null);
                            }
                          })()}
                        >
                          {linkingToken === row.id ? "Linking…" : "Link card token"}
                        </button>
                      )}
                      {row.mappingStatus === "MAPPED" && row.linkedPaymentMethodId && row.cutoverStatus !== "CUTOVER_COMPLETE" && (
                        <button
                          type="button"
                          className="btn primary"
                          title="Disable old Sola schedule and enable Connect autopay."
                          onClick={() => setCutoverTarget({ row, step: "warning" })}
                        >
                          Take over billing
                        </button>
                      )}
                      {row.mappingStatus === "MAPPED" && row.cutoverStatus === "CUTOVER_FAILED" && (
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={linkingToken === row.id}
                          onClick={() => void (async () => {
                            setLinkingToken(row.id);
                            setActionError("");
                            try {
                              await apiPost(`/admin/billing/platform/sola-import/schedules/${row.id}/link-token`, {});
                              bumpList();
                            } catch (e: unknown) {
                              setActionError(e instanceof Error ? e.message : "Retry failed");
                            } finally {
                              setLinkingToken(null);
                            }
                          })()}
                        >
                          Retry token link
                        </button>
                      )}
                      {row.mappingStatus === "MAPPED" && row.cutoverStatus !== "CUTOVER_COMPLETE" && (
                        <button type="button" className="btn ghost" onClick={() => void apiPost(`/admin/billing/platform/sola-import/schedules/${row.id}/unmap`, {}).then(bumpList)}>Unmap</button>
                      )}
                      {row.mappingStatus !== "IGNORED" && row.cutoverStatus !== "CUTOVER_COMPLETE" && (
                        <button type="button" className="btn ghost" onClick={() => void apiPost(`/admin/billing/platform/sola-import/schedules/${row.id}/ignore`, {}).then(bumpList)}>Ignore</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Map to tenant drawer */}
      {mapTarget && (
        <div className="billing-p8-overlay" onClick={() => setMapTarget(null)}>
          <div className="billing-p8-drawer" onClick={(e) => e.stopPropagation()}>
            <h3>Map to tenant</h3>
            <select className="input" value={mapTarget.tenantId} onChange={(e) => setMapTarget({ ...mapTarget, tenantId: e.target.value })}>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button type="button" className="btn primary" onClick={() => void apiPost(`/admin/billing/platform/sola-import/schedules/${mapTarget.row.id}/map`, { tenantId: mapTarget.tenantId }).then(() => { setMapTarget(null); bumpList(); })}>Confirm</button>
          </div>
        </div>
      )}

      {/* Take Over Billing confirmation drawer */}
      {cutoverTarget && (
        <div className="billing-p8-overlay" onClick={() => !cutoverWorking && setCutoverTarget(null)}>
          <div className="billing-p8-drawer billing-sola-cutover-drawer" onClick={(e) => e.stopPropagation()}>
            {cutoverTarget.step === "warning" && (
              <>
                <h3>Take over billing in Connect</h3>
                <div className="billing-sola-cutover-warnings">
                  <p className="billing-sola-cutover-warn-item">⚠ The old Sola recurring schedule will be <strong>permanently disabled</strong>.</p>
                  <p className="billing-sola-cutover-warn-item">⚠ Connect autopay will be <strong>enabled</strong> for this tenant.</p>
                  <p className="billing-sola-cutover-warn-item">✓ <strong>No charge will happen now.</strong> The next charge runs on the tenant&apos;s next billing day.</p>
                  <p className="billing-sola-cutover-warn-item">⚠ Never run both old Sola schedule and Connect autopay at the same time.</p>
                </div>
                <p style={{ fontSize: 13, color: "#6b7280", marginTop: 8 }}>
                  Customer: <strong>{cutoverTarget.row.customerName || cutoverTarget.row.companyName || "—"}</strong>
                  {" · "}Card: {cutoverTarget.row.brand} ···{cutoverTarget.row.last4}
                </p>
                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button type="button" className="btn primary" onClick={() => setCutoverTarget({ ...cutoverTarget, step: "confirming" })}>
                    I understand — proceed
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setCutoverTarget(null)}>Cancel</button>
                </div>
              </>
            )}
            {cutoverTarget.step === "confirming" && (
              <>
                <h3>Final confirmation</h3>
                <p style={{ fontSize: 14 }}>This action is <strong>irreversible</strong>. The Sola schedule will be disabled immediately.</p>
                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={cutoverWorking}
                    onClick={() => void (async () => {
                      setCutoverWorking(true);
                      setActionError("");
                      try {
                        await apiPost(
                          `/admin/billing/platform/tenants/${cutoverTarget.row.tenantId}/billing-cutover/take-over`,
                          {
                            solaScheduleLinkId: cutoverTarget.row.id,
                            linkedPaymentMethodId: cutoverTarget.row.linkedPaymentMethodId,
                            confirmDisableSolaSchedule: true,
                            confirmEnableConnectAutopay: true,
                            confirmNoImmediateCharge: true,
                          },
                        );
                        setCutoverTarget(null);
                        bumpList();
                      } catch (e: unknown) {
                        setActionError(e instanceof Error ? e.message : "Cutover failed");
                      } finally {
                        setCutoverWorking(false);
                      }
                    })()}
                  >
                    {cutoverWorking ? "Taking over…" : "Confirm — disable Sola and enable Connect billing"}
                  </button>
                  <button type="button" className="btn ghost" disabled={cutoverWorking} onClick={() => setCutoverTarget(null)}>Cancel</button>
                </div>
                {actionError && <ErrorState message={actionError} />}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

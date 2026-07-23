"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CRMPageShell, CRMPageHeader, CRMCard, crm } from "../../../../../components/crm";
import { deliveryApi } from "../../../../../services/deliveryApi";

export default function DeliveryOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id || "");
  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    deliveryApi
      .order(id)
      .then(setOrder)
      .catch(() => setError("Couldn't load this order."))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <CRMPageShell><CRMCard><p className="text-sm text-crm-muted">Loading…</p></CRMCard></CRMPageShell>;
  if (error || !order) return <CRMPageShell><CRMCard><p className="text-sm text-crm-muted">{error || "Not found."}</p></CRMCard></CRMPageShell>;

  const events: any[] = order.statusEvents || [];

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        title={`Order ${order.sourceId}`}
        subtitle={`${order.addrLine1}${order.addrUnit ? ` · ${order.addrUnit}` : ""}`}
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Audit timeline */}
        <CRMCard className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-crm-text">Delivery timeline</h2>
          {events.length === 0 ? (
            <p className="text-sm text-crm-muted">No events yet.</p>
          ) : (
            <ol className="relative ml-2 border-l border-crm-border pl-4">
              {events.map((e, i) => (
                <li key={e.id || i} className="mb-3">
                  <div className="text-sm text-crm-text">
                    {e.fromStatus ? `${e.fromStatus} → ` : ""}<b>{e.toStatus}</b>
                    <span className="ml-2 rounded border border-crm-border px-1.5 py-0.5 text-[10px] uppercase text-crm-muted">{e.actor}</span>
                  </div>
                  <div className="text-xs text-crm-muted">
                    {new Date(e.createdAt).toLocaleString()}{e.reason ? ` · ${e.reason}` : ""}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CRMCard>

        {/* Status mapping + meta */}
        <div className="flex flex-col gap-3">
          <CRMCard>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-crm-muted">Status mapping</h2>
            <div className="flex items-center justify-between text-sm">
              <span className="text-crm-muted">Connect (normalized)</span>
              <span className="rounded-full border border-crm-accent/40 bg-crm-accent/10 px-2 py-0.5 text-xs font-semibold text-crm-accent">{order.status}</span>
            </div>
            <div className="my-2 h-px bg-crm-border" />
            <div className="flex items-center justify-between text-sm">
              <span className="text-crm-muted">Source system (raw)</span>
              <span className="font-mono text-xs text-crm-text">{order.rawSourceStatus}</span>
            </div>
          </CRMCard>

          <CRMCard>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-crm-muted">Packages</h2>
            {(order.packages || []).length === 0 ? (
              <p className="text-sm text-crm-muted">No packages recorded.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm text-crm-text">
                {order.packages.map((p: any) => (
                  <li key={p.id} className="flex items-center justify-between">
                    <span>{p.label || "package"}</span>
                    {p.tempSensitive ? <span className="text-xs text-crm-warning">chilled</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </CRMCard>
        </div>
      </div>
    </CRMPageShell>
  );
}

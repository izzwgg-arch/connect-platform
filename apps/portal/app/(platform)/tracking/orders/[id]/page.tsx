"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Link2, UserCog, StickyNote, ShieldOff, Copy, Check } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../../components/crm";
import { deliveryApi } from "../../../../../services/deliveryApi";

function maskPhone(p?: string | null): string {
  if (!p) return "—";
  const d = p.replace(/\D/g, "");
  if (d.length < 4) return "•••";
  return `(•••) •••-${d.slice(-4)}`;
}
function statusTone(s: string): string {
  if (s === "DELIVERED" || s === "PARTIALLY_DELIVERED") return "border-crm-success/40 bg-crm-success/10 text-crm-success";
  if (s === "DELIVERY_FAILED" || s === "REFUSED" || s === "EXCEPTION" || s === "ADDRESS_ISSUE") return "border-crm-danger/40 bg-crm-danger/10 text-crm-danger";
  if (["OUT_FOR_DELIVERY", "EN_ROUTE", "APPROACHING", "ARRIVED"].includes(s)) return "border-crm-accent/40 bg-crm-accent/10 text-crm-accent";
  return "border-crm-border bg-crm-surface-2 text-crm-muted";
}

export default function DeliveryOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id || "");
  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [drivers, setDrivers] = useState<any[]>([]);
  const [note, setNote] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);
  const [linkPath, setLinkPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setOrder(await deliveryApi.order(id));
    } catch {
      setError("Couldn't load this order.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!id) return;
    load();
    deliveryApi.drivers().then(setDrivers).catch(() => {});
  }, [id]);

  async function resendLink() {
    setBusy("link");
    try {
      const r = await deliveryApi.resendTrackingLink(id);
      const base = typeof window !== "undefined" ? window.location.origin : "";
      setLinkPath(`${base}${r.path}`);
    } finally { setBusy(null); }
  }
  async function revokeLink() {
    setBusy("revoke");
    try { await deliveryApi.revokeTrackingLink(id); setLinkPath(null); } finally { setBusy(null); }
  }
  async function reassign(driverId: string) {
    if (!driverId) return;
    setBusy("reassign");
    try { await deliveryApi.reassign(id, driverId); await load(); } finally { setBusy(null); }
  }
  async function saveNote() {
    if (!note.trim()) return;
    setBusy("note");
    try { await deliveryApi.addNote(id, note.trim()); setNote(""); setNoteSaved(true); setTimeout(() => setNoteSaved(false), 2500); } finally { setBusy(null); }
  }

  if (loading) return <CRMPageShell><CRMCard><p className="text-sm text-crm-muted">Loading…</p></CRMCard></CRMPageShell>;
  if (error || !order) return <CRMPageShell><CRMCard><p className="text-sm text-crm-muted">{error || "Not found."}</p></CRMCard></CRMPageShell>;

  const events: any[] = order.statusEvents || [];

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        title={`Order ${order.sourceId}`}
        subtitle={`${order.addrLine1}${order.addrUnit ? ` · ${order.addrUnit}` : ""}`}
        actions={
          <span className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold", statusTone(order.status))}>
            {String(order.status).replace(/_/g, " ").toLowerCase()}
          </span>
        }
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Timeline */}
        <CRMCard className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-crm-text">Delivery timeline</h2>
          {events.length === 0 ? (
            <p className="text-sm text-crm-muted">No events yet.</p>
          ) : (
            <ol className="relative ml-2 border-l border-crm-border pl-4">
              {events.map((e, i) => (
                <li key={e.id || i} className="mb-3">
                  <div className="flex items-center gap-2 text-sm text-crm-text">
                    {e.fromStatus ? <span className="text-crm-muted">{e.fromStatus} → </span> : null}<b>{e.toStatus}</b>
                    <span className="rounded border border-crm-border px-1.5 py-0.5 text-[10px] uppercase text-crm-muted">{e.actor}</span>
                    {e.source ? <span className="rounded border border-crm-border px-1.5 py-0.5 text-[10px] uppercase text-crm-muted">source: {e.source}</span> : null}
                  </div>
                  <div className="text-xs text-crm-muted">
                    {new Date(e.createdAt).toLocaleString()}{e.reason ? ` · ${e.reason}` : ""}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CRMCard>

        {/* Right rail */}
        <div className="flex flex-col gap-3">
          {/* Customer contact */}
          <CRMCard>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-crm-muted">Customer</h2>
            <div className="text-sm text-crm-text">{order.customerName || "—"}</div>
            <div className="mt-0.5 font-mono text-sm text-crm-text">{maskPhone(order.customerPhone)}</div>
            <p className="mt-1 text-[11px] text-crm-muted">Number is masked; full contact stays with the store per consent.</p>
            <div className="mt-3 flex flex-col gap-1.5">
              <button className={crm.btnSecondary} disabled={!!busy} onClick={resendLink}>
                <Link2 size={14} /> {busy === "link" ? "…" : "Resend tracking link"}
              </button>
              {linkPath && (
                <div className="flex items-center gap-1.5 rounded-crm border border-crm-border bg-crm-surface-2 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-crm-muted">{linkPath}</span>
                  <button className="text-crm-muted hover:text-crm-text" onClick={() => { navigator.clipboard?.writeText(linkPath); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
              )}
              {linkPath && (
                <button className={crm.btnGhost} disabled={!!busy} onClick={revokeLink}><ShieldOff size={13} /> Revoke link</button>
              )}
            </div>
          </CRMCard>

          {/* Reassign */}
          <CRMCard>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-crm-muted"><UserCog size={12} className="mr-1 inline" />Reassign</h2>
            <select
              className={crm.select}
              defaultValue={order.assignment?.driverId || ""}
              disabled={busy === "reassign"}
              onChange={(e) => reassign(e.target.value)}
            >
              <option value="">Choose a driver…</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>{d.userId?.slice(0, 12) || d.id.slice(0, 8)}{d.status ? ` · ${d.status.toLowerCase()}` : ""}</option>
              ))}
            </select>
          </CRMCard>

          {/* Internal note */}
          <CRMCard>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-crm-muted"><StickyNote size={12} className="mr-1 inline" />Add internal note</h2>
            <textarea
              className={cn(crm.input, "min-h-[64px] resize-y")}
              placeholder="Context for the next dispatcher…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button className={cn(crm.btnSecondary, "mt-2 w-full")} disabled={!note.trim() || busy === "note"} onClick={saveNote}>
              {busy === "note" ? "Saving…" : noteSaved ? "Saved ✓" : "Save note"}
            </button>
          </CRMCard>

          {/* Status mapping */}
          <CRMCard>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-crm-muted">Status mapping</h2>
            <div className="flex items-center justify-between text-sm">
              <span className="text-crm-muted">Loopcom (normalized)</span>
              <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", statusTone(order.status))}>{order.status}</span>
            </div>
            <div className="my-2 h-px bg-crm-border" />
            <div className="flex items-center justify-between text-sm">
              <span className="text-crm-muted">Source system (raw)</span>
              <span className="font-mono text-xs text-crm-text">{order.rawSourceStatus || "—"}</span>
            </div>
          </CRMCard>

          {/* Packages */}
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

"use client";

import { useEffect, useState } from "react";
import { Plug, Database, MapPin, Webhook, Phone } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { deliveryApi } from "../../../../services/deliveryApi";

function Status({ tone, children }: { tone: "ok" | "info" | "warn"; children: React.ReactNode }) {
  const cls = tone === "ok" ? "border-crm-success/40 bg-crm-success/10 text-crm-success"
    : tone === "warn" ? "border-crm-warning/40 bg-crm-warning/10 text-crm-warning"
    : "border-crm-border bg-crm-surface-2 text-crm-muted";
  return <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", cls)}>{children}</span>;
}

export default function TrackingIntegrationsPage() {
  const [cfg, setCfg] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    deliveryApi.config().then(setCfg).catch((e) => setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load integrations."));
  }, []);

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader icon={<Plug size={20} />} title="Integrations" subtitle="Order source, geocoding, webhooks, and telephony wiring for delivery tracking." />
      {error && <CRMCard><p className="text-sm text-crm-muted">{error}</p></CRMCard>}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <CRMCard>
          <div className="mb-2 flex items-center gap-2"><Database size={16} className="text-crm-accent" /><h2 className="text-sm font-semibold text-crm-text">Order source</h2><span className="ml-auto"><Status tone="warn">mock adapter</Status></span></div>
          <p className="text-sm text-crm-muted">Orders currently arrive through the built-in mock adapter. The live supermarket Order API integration lands in a later phase — no invented fields until its spec is provided.</p>
          <div className="mt-3 rounded-crm border border-crm-border bg-crm-surface-2 px-3 py-2 font-mono text-[11px] text-crm-muted">POST /internal/delivery/orders <span className="text-crm-text">· secret-gated</span></div>
        </CRMCard>

        <CRMCard>
          <div className="mb-2 flex items-center gap-2"><MapPin size={16} className="text-crm-accent" /><h2 className="text-sm font-semibold text-crm-text">Geocoding</h2><span className="ml-auto"><Status tone="info">server-configured</Status></span></div>
          <p className="text-sm text-crm-muted">Address→coordinate geocoding runs server-side (Nominatim / Mapbox / Google), enabled only when the operator sets <code className="text-crm-text">DELIVERY_GEOCODER_URL</code>. Off by default; addresses still track without it.</p>
        </CRMCard>

        <CRMCard>
          <div className="mb-2 flex items-center gap-2"><Webhook size={16} className="text-crm-accent" /><h2 className="text-sm font-semibold text-crm-text">Outbound webhooks</h2><span className="ml-auto"><Status tone="info">none</Status></span></div>
          <p className="text-sm text-crm-muted">No outbound delivery webhooks are configured. Status changes are recorded in the audit log and surfaced in the dashboard and notification center.</p>
        </CRMCard>

        <CRMCard>
          <div className="mb-2 flex items-center gap-2"><Phone size={16} className="text-crm-accent" /><h2 className="text-sm font-semibold text-crm-text">Telephony &amp; SMS</h2><span className="ml-auto"><Status tone="ok">reused</Status></span></div>
          <p className="text-sm text-crm-muted">Delivery reuses Connect's existing SMS and PBX/voice — no parallel stack. SMS sends stay in <b>test mode</b> and voice/IVR is <b>read-only</b> (no VitalPBX writes) until carrier/compliance sign-off.</p>
          <div className="mt-3 flex items-center justify-between text-xs">
            <span className="text-crm-muted">Voice mode</span>
            <span className="font-mono text-crm-text">{cfg?.voiceMode || "PRERECORDED_NUMBER_PLAYBACK"}</span>
          </div>
        </CRMCard>
      </div>
    </CRMPageShell>
  );
}

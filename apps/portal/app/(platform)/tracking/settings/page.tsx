"use client";

import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm } from "../../../../components/crm";
import { deliveryApi } from "../../../../services/deliveryApi";

const ROWS: { key: string; label: string }[] = [
  { key: "enabled", label: "Delivery tracking enabled" },
  { key: "mapReveal", label: "Customer map policy" },
  { key: "exactPinStopsAway", label: "Exact pin when (stops away)" },
  { key: "verifyTier", label: "Verification tier" },
  { key: "voiceMode", label: "Voice ETA mode" },
  { key: "retentionDays", label: "Location retention (days)" },
  { key: "notifyOutForDelivery", label: "Notify: out for delivery" },
  { key: "notifyDelayed", label: "Notify: delayed" },
  { key: "notifyDelivered", label: "Notify: delivered" },
  { key: "notifyApproaching", label: "Notify: approaching" },
];

export default function TrackingSettingsPage() {
  const [cfg, setCfg] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    deliveryApi.config().then(setCfg)
      .catch((e) => setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load settings."))
      .finally(() => setLoading(false));
  }, []);
  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader icon={<Settings2 size={20} />} title="Tracking settings" subtitle="Tenant configuration for delivery tracking." />
      {error ? <CRMCard><p className="text-sm text-crm-muted">{error}</p></CRMCard>
        : loading ? <CRMCard><p className="text-sm text-crm-muted">Loading…</p></CRMCard>
        : cfg ? (
          <CRMCard padding="none">
            <ul className="divide-y divide-crm-border">
              {ROWS.map((r) => (
                <li key={r.key} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="text-crm-muted">{r.label}</span>
                  <span className="font-medium text-crm-text">{String(cfg[r.key] ?? "—")}</span>
                </li>
              ))}
            </ul>
          </CRMCard>
        ) : null}
      <p className="text-xs text-crm-muted">Editing requires the <span className="font-mono">can_manage_tracking_settings</span> permission (Phase 3 setup wizard adds the edit form). Values here reflect the live tenant config.</p>
    </CRMPageShell>
  );
}

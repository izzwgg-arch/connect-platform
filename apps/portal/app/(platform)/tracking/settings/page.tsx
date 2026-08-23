"use client";

import { useEffect, useMemo, useState } from "react";
import { Settings, ShieldCheck, Bell, CheckCircle2 } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm } from "../../../../components/crm";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { deliveryApi } from "../../../../services/deliveryApi";

// ── Config shape (loose; server is source of truth) ──────────────────────────
interface DeliveryConfig {
  enabled: boolean;
  mapReveal: "PROGRESSIVE" | "FULL" | "NONE";
  exactPinStopsAway: number;
  verifyTier: "TIERED" | "STRICT" | "LIGHT";
  retentionDays: number;
  notifyOutForDelivery: boolean;
  notifyDelayed: boolean;
  notifyDelivered: boolean;
  notifyApproaching: boolean;
  voiceMode: "PRERECORDED_NUMBER_PLAYBACK" | "TTS" | "COARSE";
}

const MAP_REVEAL_OPTS: { value: DeliveryConfig["mapReveal"]; label: string }[] = [
  { value: "PROGRESSIVE", label: "Progressive reveal (recommended)" },
  { value: "FULL", label: "Full map" },
  { value: "NONE", label: "No map" },
];

const VERIFY_TIER_OPTS: { value: DeliveryConfig["verifyTier"]; label: string }[] = [
  { value: "TIERED", label: "Tiered (by order type)" },
  { value: "STRICT", label: "Strict (always high)" },
  { value: "LIGHT", label: "Light (minimal)" },
];

const VOICE_MODE_OPTS: { value: DeliveryConfig["voiceMode"]; label: string }[] = [
  { value: "PRERECORDED_NUMBER_PLAYBACK", label: "Prerecorded + number playback" },
  { value: "TTS", label: "Text-to-speech" },
  { value: "COARSE", label: "Coarse (range only)" },
];

// ── Inline primitives (token-styled, no external libs) ───────────────────────
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-crm-accent/30 ${
        checked ? "border-crm-accent bg-crm-accent" : "border-crm-border bg-crm-surface-2"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3.5 w-3.5 rounded-full shadow-sm transition-transform ${
          checked ? "translate-x-[18px] bg-crm-surface" : "translate-x-0.5 bg-crm-muted"
        }`}
      />
    </button>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-2.5">
      <span className="min-w-0">
        <span className="block text-sm text-crm-text">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-crm-muted">{hint}</span> : null}
      </span>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-2.5">
      <label className={`mb-1.5 block ${crm.label}`}>{label}</label>
      {children}
    </div>
  );
}

export default function TrackingSettingsPage() {
  const [original, setOriginal] = useState<DeliveryConfig | null>(null);
  const [draft, setDraft] = useState<DeliveryConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    deliveryApi
      .config()
      .then((cfg) => {
        setOriginal(cfg as DeliveryConfig);
        setDraft(cfg as DeliveryConfig);
      })
      .catch((e) =>
        setError(
          e?.message === "delivery_not_enabled"
            ? "Delivery isn't enabled for this tenant yet."
            : "Couldn't load settings.",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  // Only the keys the user actually changed.
  const patch = useMemo(() => {
    if (!original || !draft) return {} as Partial<DeliveryConfig>;
    const out: Record<string, unknown> = {};
    (Object.keys(draft) as (keyof DeliveryConfig)[]).forEach((k) => {
      if (draft[k] !== original[k]) out[k as string] = draft[k];
    });
    return out;
  }, [original, draft]);

  const dirty = Object.keys(patch).length > 0;

  function set<K extends keyof DeliveryConfig>(key: K, value: DeliveryConfig[K]) {
    setSaved(false);
    setSaveError(null);
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function onSave() {
    if (!dirty) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const next = await deliveryApi.saveConfig(patch);
      const merged = { ...(draft as DeliveryConfig), ...(next || {}) } as DeliveryConfig;
      setOriginal(merged);
      setDraft(merged);
      setSaved(true);
    } catch (e: any) {
      setSaveError(
        e?.message === "delivery_not_enabled"
          ? "Delivery isn't enabled for this tenant yet."
          : "Couldn't save changes. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<Settings size={20} />}
        title="Configuration"
        subtitle="Tenant tracking, privacy, notifications, voice, and proof-of-delivery policy."
        actions={
          <div className="flex items-center gap-3">
            {saveError ? (
              <span className="text-xs font-medium text-crm-danger">{saveError}</span>
            ) : saved ? (
              <span className="text-xs font-medium text-crm-success">Saved</span>
            ) : dirty ? (
              <span className="text-xs text-crm-muted">Unsaved changes</span>
            ) : null}
            <button
              type="button"
              className={crm.btnPrimary}
              disabled={!dirty || saving || loading}
              onClick={onSave}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        }
      />

      {error ? (
        <CRMCard>
          <p className="text-sm text-crm-muted">{error}</p>
        </CRMCard>
      ) : loading || !draft ? (
        <CRMCard>
          <p className="text-sm text-crm-muted">Loading…</p>
        </CRMCard>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {/* 1 — Tracking & privacy */}
          <CRMCard>
            <div className="mb-3 flex items-center gap-2">
              <ShieldCheck size={16} className="text-crm-accent" />
              <h2 className="text-sm font-semibold text-crm-text">Tracking &amp; privacy</h2>
            </div>
            <div className="divide-y divide-crm-border/60">
              <ToggleRow
                label="Delivery tracking enabled"
                hint="Master switch for customer-facing live tracking."
                checked={draft.enabled}
                onChange={(v) => set("enabled", v)}
              />
              <Field label="Customer map policy">
                <ConnectSelect
                  style={{ width: "100%" }}
                  value={draft.mapReveal}
                  onChange={(v) => set("mapReveal", v as DeliveryConfig["mapReveal"])}
                  options={MAP_REVEAL_OPTS}
                />
              </Field>
              <Field label="Show exact pin when (stops away)">
                <input
                  type="number"
                  min={0}
                  max={10}
                  className={crm.input}
                  value={draft.exactPinStopsAway}
                  onChange={(e) =>
                    set(
                      "exactPinStopsAway",
                      Math.max(0, Math.min(10, Number(e.target.value) || 0)),
                    )
                  }
                />
              </Field>
              <Field label="Verification tier">
                <ConnectSelect
                  style={{ width: "100%" }}
                  value={draft.verifyTier}
                  onChange={(v) => set("verifyTier", v as DeliveryConfig["verifyTier"])}
                  options={VERIFY_TIER_OPTS}
                />
              </Field>
              <Field label="Location retention (days)">
                <input
                  type="number"
                  min={0}
                  className={crm.input}
                  value={draft.retentionDays}
                  onChange={(e) => set("retentionDays", Math.max(0, Number(e.target.value) || 0))}
                />
              </Field>
            </div>
          </CRMCard>

          {/* 2 — Notifications & voice */}
          <CRMCard>
            <div className="mb-3 flex items-center gap-2">
              <Bell size={16} className="text-crm-accent" />
              <h2 className="text-sm font-semibold text-crm-text">Notifications &amp; voice</h2>
            </div>
            <div className="divide-y divide-crm-border/60">
              <ToggleRow
                label="“Out for delivery” notification"
                checked={draft.notifyOutForDelivery}
                onChange={(v) => set("notifyOutForDelivery", v)}
              />
              <ToggleRow
                label="“Delayed” notification"
                checked={draft.notifyDelayed}
                onChange={(v) => set("notifyDelayed", v)}
              />
              <ToggleRow
                label="“Delivered” notification"
                checked={draft.notifyDelivered}
                onChange={(v) => set("notifyDelivered", v)}
              />
              <ToggleRow
                label="“Approaching” notification (opt-in)"
                checked={draft.notifyApproaching}
                onChange={(v) => set("notifyApproaching", v)}
              />
              <Field label="Voice ETA mode">
                <ConnectSelect
                  style={{ width: "100%" }}
                  value={draft.voiceMode}
                  onChange={(v) => set("voiceMode", v as DeliveryConfig["voiceMode"])}
                  options={VOICE_MODE_OPTS}
                />
              </Field>
            </div>
          </CRMCard>

          {/* 3 — Proof of delivery (read-only policy) */}
          <CRMCard className="lg:col-span-2">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={16} className="text-crm-accent" />
                <h2 className="text-sm font-semibold text-crm-text">Proof of delivery</h2>
              </div>
              <span className={`${crm.chip} ${crm.chipActive}`}>Governed server-side</span>
            </div>
            <p className="mb-3 text-sm text-crm-muted">
              Photo, signature, and PIN requirements are set per order type by the server-side
              policy and can&apos;t be edited here. Current requirements:
            </p>
            <div className="flex flex-wrap gap-2">
              <span className={crm.chip}>Standard: photo or tap</span>
              <span className={crm.chip}>Signature-required: signature</span>
              <span className={crm.chip}>Age-restricted: PIN + photo</span>
            </div>
          </CRMCard>
        </div>
      )}
    </CRMPageShell>
  );
}

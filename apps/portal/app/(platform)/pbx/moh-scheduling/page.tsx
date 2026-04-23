"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPost, apiPatch, apiDelete } from "../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

type HoldType = "default" | "business_hours" | "after_hours" | "holiday" | "campaign" | "emergency" | "custom";
type RuleType = "weekly" | "holiday" | "one_time";

interface HoldProfile {
  id: string;
  tenantId: string;
  name: string;
  type: HoldType;
  vitalPbxMohClassName: string;
  holdAnnouncementEnabled: boolean;
  holdAnnouncementRef: string | null;
  holdAnnouncementIntervalSec: number;
  introAnnouncementRef: string | null;
  isActive: boolean;
  createdAt: string;
}

interface ScheduleRule {
  id: string;
  scheduleId: string;
  profileId: string;
  ruleType: RuleType;
  weekday: number | null;
  startTime: string | null;
  endTime: string | null;
  startAt: string | null;
  endAt: string | null;
  priority: number;
  isActive: boolean;
}

interface ScheduleConfig {
  id: string;
  tenantId: string;
  timezone: string;
  defaultProfileId: string | null;
  afterHoursProfileId: string | null;
  holidayProfileId: string | null;
  isActive: boolean;
  rules: ScheduleRule[];
}

interface OverrideState {
  id: string;
  tenantId: string;
  isActive: boolean;
  profileId: string | null;
  reason: string | null;
  expiresAt: string | null;
  activatedAt: string | null;
  profile?: { name?: string; vitalPbxMohClassName?: string } | null;
}

interface PublishRecord {
  id: string;
  tenantId: string;
  publishedBy: string;
  publishedAt: string;
  source: string;
  previousMohClass: string | null;
  newMohClass: string;
  status: string;
  error: string | null;
  isRollback: boolean;
  keysWritten?: Array<{ key: string; value: string }>;
  previousKeysSnapshot?: Array<{ key: string; value: string }>;
}

interface PreviewResult {
  profile: HoldProfile | null;
  mode: string;
  mohClass: string | null;
  at: string;
  lastPublished: { mohClass: string; holdMode: string; publishedAt: string } | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<HoldType, string> = {
  default:        "Default",
  business_hours: "Business Hours",
  after_hours:    "After Hours",
  holiday:        "Holiday",
  campaign:       "Campaign",
  emergency:      "Emergency",
  custom:         "Custom",
};

const TYPE_COLORS: Record<HoldType, string> = {
  default:        "#6366f1",
  business_hours: "#22c55e",
  after_hours:    "#f59e0b",
  holiday:        "#8b5cf6",
  campaign:       "#06b6d4",
  emergency:      "#ef4444",
  custom:         "#64748b",
};

const RULE_LABELS: Record<RuleType, string> = {
  weekly:   "Weekly (day/time)",
  holiday:  "Holiday (date)",
  one_time: "One-Time Override",
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const ALL_TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Phoenix", "America/Anchorage", "Pacific/Honolulu",
  "Europe/London", "Europe/Paris", "Europe/Berlin",
  "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata", "Australia/Sydney", "UTC",
];

const SOURCE_LABELS: Record<string, string> = {
  schedule:        "Schedule",
  manual:          "Manual",
  override:        "Override",
  rollback:        "Rollback",
  admin:           "Admin",
  reconciliation:  "Reconcile",
};

const TABS = ["Hold Profiles", "Assets", "Schedule", "Override", "Publish"] as const;
type Tab = typeof TABS[number];

// ── MOH Assets (uploaded music tracks) ───────────────────────────────────────
// Each upload becomes a MohAsset row on Connect and a MOH class on the PBX
// once the sync helper pulls the manifest and reloads Asterisk. Connect is the
// source of truth — the PBX only caches the bytes locally.
interface MohAsset {
  id: string;
  tenantId: string;
  name: string;
  mohClassName: string;
  sourceFilename: string;
  sizeBytes: number;
  mimeType: string;
  contentHash: string;
  status: string;
  createdAt: string;
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function HoldSchedulingPage() {
  const { tenantId, can, role } = useAppContext();
  const isSuperAdmin = role === "SUPER_ADMIN";
  const [activeTab, setActiveTab] = useState<Tab>("Hold Profiles");
  const [error, setError] = useState<string | null>(null);

  const [profiles, setProfiles] = useState<HoldProfile[]>([]);
  const [schedule, setSchedule] = useState<ScheduleConfig | null>(null);
  const [override, setOverride] = useState<OverrideState | null>(null);
  const [history, setHistory] = useState<PublishRecord[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);

  const canManage = can("can_manage_moh");

  const reload = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = `?tenantId=${encodeURIComponent(tenantId)}`;
      const [p, s, o, h, pv] = await Promise.allSettled([
        apiGet<{ profiles: HoldProfile[] }>(`/voice/moh/profiles${qs}`),
        apiGet<{ schedule: ScheduleConfig | null }>(`/voice/moh/schedule${qs}`),
        apiGet<{ override: OverrideState | null }>(`/voice/moh/override${qs}`),
        apiGet<{ records: PublishRecord[] }>(`/voice/moh/publish-history${qs}&limit=20`),
        apiGet<PreviewResult>(`/voice/moh/preview${qs}`),
      ]);
      if (p.status === "fulfilled") setProfiles(p.value.profiles);
      if (s.status === "fulfilled") setSchedule(s.value.schedule);
      if (o.status === "fulfilled") setOverride(o.value.override);
      if (h.status === "fulfilled") setHistory(h.value.records);
      if (pv.status === "fulfilled") setPreview(pv.value);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load hold profile data");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div style={{ padding: "24px 32px", minHeight: "100vh", color: "var(--text-primary, #f1f5f9)" }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: -0.5 }}>Hold Profile Scheduling</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted, #94a3b8)" }}>
          Schedule Music-On-Hold classes and hold announcements per tenant. Connect controls scheduling — VitalPBX handles all media playback.
        </p>

        {/* Live status badges */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          {preview?.mohClass && (
            <StatusBadge color="#22c55e" label="Active MOH" value={preview.mohClass} />
          )}
          {preview?.mode && preview.mode !== "none" && (
            <StatusBadge color="#6366f1" label="Mode" value={preview.mode} />
          )}
          {preview?.profile?.holdAnnouncementEnabled && (
            <StatusBadge color="#06b6d4" label="Announcement" value={preview.profile.holdAnnouncementRef ?? "enabled"} />
          )}
          {preview?.lastPublished && (
            <StatusBadge color="#475569" label="Last pushed" value={new Date(preview.lastPublished.publishedAt).toLocaleString()} />
          )}
        </div>
      </div>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444", borderRadius: 8, padding: "10px 16px", marginBottom: 20, fontSize: 13, color: "#fca5a5" }}>
          {error}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid rgba(255,255,255,0.08)", marginBottom: 28 }}>
        {TABS.map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            padding: "10px 18px", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
            borderRadius: "6px 6px 0 0", transition: "all 0.15s",
            background: activeTab === tab ? "rgba(99,102,241,0.15)" : "transparent",
            color: activeTab === tab ? "#a5b4fc" : "var(--text-muted, #94a3b8)",
            borderBottom: activeTab === tab ? "2px solid #6366f1" : "2px solid transparent",
          }}>
            {tab}
          </button>
        ))}
      </div>

      {loading && <div style={{ fontSize: 13, color: "#64748b" }}>Loading…</div>}

      {!loading && activeTab === "Hold Profiles" && (
        <ProfilesTab profiles={profiles} tenantId={tenantId} canManage={canManage} onRefresh={reload} isSuperAdmin={isSuperAdmin} />
      )}
      {!loading && activeTab === "Assets" && (
        <AssetsTab tenantId={tenantId} canUpload={can("can_upload_moh")} />
      )}
      {!loading && activeTab === "Schedule" && (
        <ScheduleTab schedule={schedule} profiles={profiles} tenantId={tenantId} canManage={canManage} onRefresh={reload} />
      )}
      {!loading && activeTab === "Override" && (
        <OverrideTab override={override} profiles={profiles} tenantId={tenantId} canManage={canManage} onRefresh={reload} />
      )}
      {!loading && activeTab === "Publish" && (
        <PublishTab history={history} preview={preview} tenantId={tenantId} canManage={canManage} onRefresh={reload} />
      )}
    </div>
  );
}

// ── Badges ────────────────────────────────────────────────────────────────────

function StatusBadge({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(0,0,0,0.3)", border: `1px solid ${color}40`, borderRadius: 7, padding: "4px 10px", fontSize: 12 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span style={{ color: "#64748b" }}>{label}:</span>
      <strong style={{ color: "#e2e8f0" }}>{value}</strong>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Hold Profiles
// ═══════════════════════════════════════════════════════════════════════════════

interface PromptCatalogRow {
  id: string;
  tenantId: string | null;
  tenantSlug: string | null;
  promptRef: string;
  displayName: string;
  category: string;
  source: string;
  isActive: boolean;
}

interface PbxMohClassRow {
  id: string;
  tenantId: string | null;
  tenantSlug: string | null;
  pbxGroupId: number;
  name: string;
  mohClassName: string;
  classType: string | null;
  isDefault: boolean;
  fileCount: number;
  isActive: boolean;
}

// ── MOH class picker ─────────────────────────────────────────────────────────
// Dropdown-first picker for the "VitalPBX MOH Class" field on Hold Profiles.
// Merges two sources so the admin never has to guess the right class name:
//   1. Classes synced from ombu_music_groups (existing VitalPBX classes).
//   2. Classes materialised from uploaded MOH assets (each asset's
//      deterministic mohClassName).
// Legacy-safe: if the saved value isn't in either list we still render it at
// the top of the options as "(legacy)" so saving the profile doesn't wipe it.
// Manual-entry escape hatch is kept for brand-new classes that aren't on the
// PBX yet.
function MohClassPicker({
  value, onChange, pbxClasses, assets, loading, placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  pbxClasses: PbxMohClassRow[];
  assets: MohAsset[];
  loading: boolean;
  placeholder?: string;
}) {
  type Opt = { value: string; label: string; source: "pbx" | "upload" | "legacy" };
  const options: Opt[] = [];
  const seen = new Set<string>();
  for (const c of pbxClasses) {
    if (!c.isActive) continue;
    const v = c.mohClassName;
    if (seen.has(v)) continue;
    seen.add(v);
    options.push({ value: v, label: `${v}${c.fileCount ? ` · ${c.fileCount} file${c.fileCount === 1 ? "" : "s"}` : ""}${c.isDefault ? " · default" : ""}`, source: "pbx" });
  }
  for (const a of assets) {
    const v = a.mohClassName;
    if (seen.has(v)) continue;
    seen.add(v);
    options.push({ value: v, label: `${v} · uploaded "${a.name}"`, source: "upload" });
  }
  const hasCurrent = !!value && seen.has(value);
  if (value && !hasCurrent) {
    options.unshift({ value, label: `${value} (legacy — not in catalog)`, source: "legacy" });
    seen.add(value);
  }

  const [manual, setManual] = useState(() => options.length === 0 && !value);
  const effectiveManual = manual || (options.length === 0 && !value);

  if (effectiveManual) {
    const empty = options.length === 0 && !loading;
    return (
      <div>
        <input style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? "e.g. default or holiday_jazz"} />
        <div style={{ fontSize: 11, color: empty ? "#fbbf24" : "#64748b", marginTop: 4, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {empty ? (
            <span>No MOH classes indexed for this tenant yet. Click <strong>Sync PBX MOH classes</strong> above, upload a MOH asset on the <strong>Assets</strong> tab, or type an existing class name.</span>
          ) : (
            <span>Manual entry — VitalPBX MOH class name.</span>
          )}
          {options.length > 0 && (
            <button type="button" onClick={() => setManual(false)} style={{ background: "transparent", border: "none", color: "#818cf8", cursor: "pointer", fontSize: 11, padding: 0 }}>
              Use dropdown
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <select style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— Select MOH class —</option>
        {options.map((o) => (
          <option key={`${o.source}:${o.value}`} value={o.value}>{o.label}</option>
        ))}
      </select>
      <div style={{ fontSize: 11, color: "#64748b", marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <span>{pbxClasses.filter((c) => c.isActive).length} PBX · {assets.length} uploaded</span>
        <button type="button" onClick={() => setManual(true)} style={{ background: "transparent", border: "none", color: "#818cf8", cursor: "pointer", fontSize: 11, padding: 0 }}>
          Type custom
        </button>
      </div>
    </div>
  );
}

function ProfilesTab({ profiles, tenantId, canManage, onRefresh, isSuperAdmin }: {
  profiles: HoldProfile[]; tenantId: string; canManage: boolean; onRefresh: () => void;
  isSuperAdmin?: boolean;
}) {
  const [prompts, setPrompts] = useState<PromptCatalogRow[]>([]);
  const [mohClasses, setMohClasses] = useState<PbxMohClassRow[]>([]);
  const [mohAssetsLite, setMohAssetsLite] = useState<MohAsset[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const reloadCatalog = useCallback(async () => {
    if (!tenantId) { setPrompts([]); setMohClasses([]); setMohAssetsLite([]); return; }
    setCatalogLoading(true);
    try {
      const qs = `?tenantId=${encodeURIComponent(tenantId)}`;
      const [pR, cR, aR] = await Promise.allSettled([
        apiGet<{ prompts: PromptCatalogRow[] }>(`/voice/ivr/prompts${qs}`),
        apiGet<{ classes: PbxMohClassRow[] }>(`/voice/moh/pbx-classes${qs}`),
        apiGet<{ assets: MohAsset[] }>(`/voice/moh/assets${qs}`),
      ]);
      setPrompts(pR.status === "fulfilled" ? (pR.value.prompts ?? []).filter((p) => p.isActive) : []);
      setMohClasses(cR.status === "fulfilled" ? (cR.value.classes ?? []) : []);
      setMohAssetsLite(aR.status === "fulfilled" ? (aR.value.assets ?? []) : []);
    } finally { setCatalogLoading(false); }
  }, [tenantId]);

  useEffect(() => { reloadCatalog(); }, [reloadCatalog]);

  const autoSyncMohClasses = useCallback(async () => {
    if (!confirm("Sync existing MOH classes from VitalPBX into Connect? Reads from the PBX's ombutel MySQL (same read-only channel as DID/prompt sync).")) return;
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await apiPost<{ ok: boolean; skipReason?: string; result?: { rowsRead: number; created: number; updated: number; unassigned: number } }>(
        "/voice/moh/pbx-classes/auto-sync",
        {},
      );
      if (r.ok && r.result) {
        setSyncMsg(`Synced ${r.result.rowsRead} MOH class(es): +${r.result.created} new, ${r.result.updated} updated, ${r.result.unassigned} unassigned.`);
      } else {
        setSyncMsg(`Sync skipped: ${r.skipReason ?? "unknown reason"}`);
      }
      await reloadCatalog();
    } catch (e: any) {
      setSyncMsg(e?.message ?? "Sync failed");
    } finally { setSyncing(false); }
  }, [reloadCatalog]);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<{
    name: string; type: HoldType; vitalPbxMohClassName: string;
    holdAnnouncementEnabled: boolean; holdAnnouncementRef: string;
    holdAnnouncementIntervalSec: number; introAnnouncementRef: string;
  }>({ name: "", type: "default", vitalPbxMohClassName: "", holdAnnouncementEnabled: false, holdAnnouncementRef: "", holdAnnouncementIntervalSec: 30, introAnnouncementRef: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const openCreate = () => {
    setEditId(null);
    setForm({ name: "", type: "default", vitalPbxMohClassName: "", holdAnnouncementEnabled: false, holdAnnouncementRef: "", holdAnnouncementIntervalSec: 30, introAnnouncementRef: "" });
    setShowForm(true);
  };
  const openEdit = (p: HoldProfile) => {
    setEditId(p.id);
    setForm({ name: p.name, type: p.type, vitalPbxMohClassName: p.vitalPbxMohClassName, holdAnnouncementEnabled: p.holdAnnouncementEnabled, holdAnnouncementRef: p.holdAnnouncementRef ?? "", holdAnnouncementIntervalSec: p.holdAnnouncementIntervalSec ?? 30, introAnnouncementRef: p.introAnnouncementRef ?? "" });
    setShowForm(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.vitalPbxMohClassName.trim()) { setErr("Name and MOH class are required."); return; }
    setSaving(true); setErr(null);
    const payload = { ...form, holdAnnouncementRef: form.holdAnnouncementRef || null, introAnnouncementRef: form.introAnnouncementRef || null };
    try {
      if (editId) {
        await apiPatch(`/voice/moh/profiles/${editId}`, payload);
      } else {
        await apiPost("/voice/moh/profiles", { tenantId, ...payload });
      }
      setShowForm(false);
      onRefresh();
    } catch (e: any) { setErr(e?.message ?? "Save failed"); }
    finally { setSaving(false); }
  };

  const deactivate = async (id: string) => {
    if (!confirm("Remove this profile?")) return;
    try { await apiDelete(`/voice/moh/profiles/${id}`); onRefresh(); }
    catch (e: any) { alert(e?.message ?? "Failed"); }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Hold Profiles</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "#475569" }}>
            Each profile maps to an existing VitalPBX MOH class and optionally enables hold announcements.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {isSuperAdmin && (
            <button
              onClick={autoSyncMohClasses}
              disabled={syncing}
              style={btnSmall("#334155")}
              title="Index existing VitalPBX MOH classes into Connect so the MOH-class dropdown has options"
            >
              {syncing ? "Syncing…" : "Sync PBX MOH classes"}
            </button>
          )}
          {canManage && <button onClick={openCreate} style={btnStyle("#6366f1")}>+ Add Profile</button>}
        </div>
      </div>

      {syncMsg && (
        <div style={{ margin: "0 0 14px", padding: "8px 12px", borderRadius: 6, fontSize: 12, background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.3)", color: "#c7d2fe" }}>
          {syncMsg}
        </div>
      )}

      {profiles.length === 0 && <div style={emptyBox}>No Hold Profiles yet. Create one for each hold scenario you want to schedule.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {profiles.map((p) => (
          <div key={p.id} style={cardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: TYPE_COLORS[p.type] ?? "#64748b", flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{TYPE_LABELS[p.type]}</div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-end" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: "#64748b" }}>MOH:</span>
                <code style={{ fontSize: 11, background: "rgba(0,0,0,0.3)", padding: "2px 7px", borderRadius: 4, color: "#94a3b8" }}>{p.vitalPbxMohClassName}</code>
              </div>
              {p.holdAnnouncementEnabled && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 10, background: "rgba(6,182,212,0.15)", border: "1px solid rgba(6,182,212,0.3)", color: "#67e8f9", borderRadius: 4, padding: "1px 6px" }}>
                    📢 {p.holdAnnouncementRef ?? "announcement"} every {p.holdAnnouncementIntervalSec}s
                  </span>
                </div>
              )}
              {p.introAnnouncementRef && (
                <div style={{ fontSize: 10, color: "#64748b" }}>intro: <code style={{ color: "#94a3b8" }}>{p.introAnnouncementRef}</code></div>
              )}
            </div>
            {canManage && (
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => openEdit(p)} style={btnSmall("#334155")}>Edit</button>
                <button onClick={() => deactivate(p.id)} style={btnSmall("#7f1d1d")}>Remove</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {showForm && (
        <div style={modalOverlay}>
          <div style={modalBox}>
            <h3 style={{ margin: "0 0 18px", fontSize: 15, fontWeight: 700 }}>{editId ? "Edit" : "Add"} Hold Profile</h3>
            {err && <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 10 }}>{err}</div>}

            <label style={labelStyle}>Name</label>
            <input style={inputStyle} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Holiday Jazz" />

            <label style={labelStyle}>Type</label>
            <select style={inputStyle} value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as HoldType }))}>
              {(Object.entries(TYPE_LABELS) as [HoldType, string][]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>

            <label style={labelStyle}>VitalPBX MOH Class <span style={{ color: "#64748b", fontWeight: 400 }}>(pick from your PBX or uploaded assets)</span></label>
            <MohClassPicker
              value={form.vitalPbxMohClassName}
              onChange={(v) => setForm((f) => ({ ...f, vitalPbxMohClassName: v }))}
              pbxClasses={mohClasses}
              assets={mohAssetsLite}
              loading={catalogLoading}
            />

            <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0 14px" }} />
            <SectionLabel>Hold Announcement (optional)</SectionLabel>

            <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <input type="checkbox" checked={form.holdAnnouncementEnabled} onChange={(e) => setForm((f) => ({ ...f, holdAnnouncementEnabled: e.target.checked }))} style={{ accentColor: "#06b6d4" }} />
              Enable periodic hold announcement
            </label>

            {form.holdAnnouncementEnabled && (
              <>
                <label style={labelStyle}>Announcement Prompt <span style={{ color: "#64748b", fontWeight: 400 }}>(tenant recording)</span></label>
                <select
                  style={inputStyle}
                  value={form.holdAnnouncementRef}
                  onChange={(e) => setForm((f) => ({ ...f, holdAnnouncementRef: e.target.value }))}
                >
                  <option value="">— Select a prompt —</option>
                  {prompts.map((p) => (
                    <option key={p.id} value={p.promptRef}>{p.displayName || p.promptRef} ({p.promptRef})</option>
                  ))}
                </select>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: -8, marginBottom: 12 }}>
                  Played on a loop while the caller is on hold via <code>[connect-hold-announce]</code>. Uses AstDB keys <code>hold_announce</code> + <code>hold_repeat</code>.
                </div>

                <label style={labelStyle}>Repeat Interval (seconds)</label>
                <input type="number" style={inputStyle} value={form.holdAnnouncementIntervalSec} onChange={(e) => setForm((f) => ({ ...f, holdAnnouncementIntervalSec: parseInt(e.target.value) || 30 }))} min={10} max={3600} />
              </>
            )}

            <label style={labelStyle}>Intro Prompt <span style={{ color: "#64748b", fontWeight: 400 }}>(optional — played once on hold entry)</span></label>
            <select
              style={inputStyle}
              value={form.introAnnouncementRef}
              onChange={(e) => setForm((f) => ({ ...f, introAnnouncementRef: e.target.value }))}
            >
              <option value="">— None —</option>
              {prompts.map((p) => (
                <option key={p.id} value={p.promptRef}>{p.displayName || p.promptRef} ({p.promptRef})</option>
              ))}
            </select>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <button onClick={() => setShowForm(false)} style={btnSmall("#334155")}>Cancel</button>
              <button onClick={save} disabled={saving} style={btnStyle("#6366f1")}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Schedule
// ═══════════════════════════════════════════════════════════════════════════════

function ScheduleTab({ schedule, profiles, tenantId, canManage, onRefresh }: {
  schedule: ScheduleConfig | null; profiles: HoldProfile[]; tenantId: string; canManage: boolean; onRefresh: () => void;
}) {
  const [tz, setTz] = useState(schedule?.timezone ?? "America/New_York");
  const [defId, setDefId] = useState(schedule?.defaultProfileId ?? "");
  const [ahId, setAhId] = useState(schedule?.afterHoursProfileId ?? "");
  const [holId, setHolId] = useState(schedule?.holidayProfileId ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleForm, setRuleForm] = useState({ ruleType: "weekly" as RuleType, profileId: "", weekday: 1, startTime: "09:00", endTime: "17:00", holidayDate: "", startAt: "", endAt: "", priority: 0 });
  const [savingRule, setSavingRule] = useState(false);
  const [ruleErr, setRuleErr] = useState<string | null>(null);

  useEffect(() => { setTz(schedule?.timezone ?? "America/New_York"); setDefId(schedule?.defaultProfileId ?? ""); setAhId(schedule?.afterHoursProfileId ?? ""); setHolId(schedule?.holidayProfileId ?? ""); }, [schedule]);

  const saveConfig = async () => {
    setSaving(true); setErr(null); setSaved(false);
    try {
      const token = typeof window !== "undefined" ? (localStorage.getItem("token") || localStorage.getItem("cc-token") || "") : "";
      const apiBase = typeof window !== "undefined" ? `${window.location.origin}/api` : (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001");
      const resp = await fetch(`${apiBase}/voice/moh/schedule`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ tenantId, timezone: tz, defaultProfileId: defId || null, afterHoursProfileId: ahId || null, holidayProfileId: holId || null, isActive: true }),
      });
      if (!resp.ok) { const b = await resp.json().catch(() => ({})); throw new Error((b as any)?.error ?? "Save failed"); }
      setSaved(true); onRefresh();
    } catch (e: any) { setErr(e?.message ?? "Save failed"); }
    finally { setSaving(false); }
  };

  const saveRule = async () => {
    if (!schedule) { setRuleErr("Save the schedule first."); return; }
    if (!ruleForm.profileId) { setRuleErr("Select a profile."); return; }
    setSavingRule(true); setRuleErr(null);
    try {
      const payload: Record<string, unknown> = { tenantId, scheduleId: schedule.id, profileId: ruleForm.profileId, ruleType: ruleForm.ruleType, priority: ruleForm.priority };
      if (ruleForm.ruleType === "weekly") { payload.weekday = ruleForm.weekday; payload.startTime = ruleForm.startTime; payload.endTime = ruleForm.endTime; }
      else if (ruleForm.ruleType === "holiday") { payload.startTime = ruleForm.holidayDate; }
      else { payload.startAt = ruleForm.startAt ? new Date(ruleForm.startAt).toISOString() : null; payload.endAt = ruleForm.endAt ? new Date(ruleForm.endAt).toISOString() : null; }
      await apiPost("/voice/moh/schedule/rules", payload);
      setShowRuleForm(false); onRefresh();
    } catch (e: any) { setRuleErr(e?.message ?? "Failed"); }
    finally { setSavingRule(false); }
  };

  const deleteRule = async (id: string) => {
    if (!confirm("Remove this rule?")) return;
    try { await apiDelete(`/voice/moh/schedule/rules/${id}`); onRefresh(); }
    catch (e: any) { alert(e?.message ?? "Failed"); }
  };

  const profs = profiles.filter((p) => p.isActive);
  const rules = schedule?.rules ?? [];

  return (
    <div style={{ maxWidth: 760 }}>
      <h2 style={{ margin: "0 0 18px", fontSize: 16, fontWeight: 600 }}>Schedule Configuration</h2>
      {err && <div style={{ color: "#fca5a5", fontSize: 13, marginBottom: 10 }}>{err}</div>}
      {saved && <div style={{ color: "#86efac", fontSize: 13, marginBottom: 10 }}>Schedule saved.</div>}

      <SectionLabel>Timezone</SectionLabel>
      <select style={{ ...inputStyle, maxWidth: 320 }} value={tz} onChange={(e) => setTz(e.target.value)} disabled={!canManage}>
        {ALL_TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}
      </select>

      <SectionLabel>Default Profile Slots</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
        {([["Default / Business Hours", defId, setDefId], ["After Hours Fallback", ahId, setAhId], ["Holiday Fallback", holId, setHolId]] as const).map(([label, val, setter]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 200, fontSize: 13, color: "#94a3b8", flexShrink: 0 }}>{label}</span>
            <select style={{ ...inputStyle, flex: 1 }} value={val} onChange={(e) => (setter as any)(e.target.value)} disabled={!canManage}>
              <option value="">— Not set —</option>
              {profs.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.vitalPbxMohClassName})</option>)}
            </select>
          </div>
        ))}
      </div>

      {canManage && <button onClick={saveConfig} disabled={saving} style={btnStyle("#6366f1")}>{saving ? "Saving…" : "Save Configuration"}</button>}

      <div style={{ marginTop: 32, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionLabelInline>Rules</SectionLabelInline>
        {canManage && schedule && (
          <button onClick={() => { setRuleForm({ ruleType: "weekly", profileId: "", weekday: 1, startTime: "09:00", endTime: "17:00", holidayDate: "", startAt: "", endAt: "", priority: 0 }); setRuleErr(null); setShowRuleForm(true); }} style={btnSmall("#334155")}>+ Add Rule</button>
        )}
      </div>
      {!schedule && <div style={{ fontSize: 12, color: "#475569" }}>Save configuration above first to enable rules.</div>}
      {rules.length === 0 && schedule && <div style={emptyBox}>No rules. Rules override the default profile slots at specific times.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rules.map((r) => {
          const prof = profs.find((p) => p.id === r.profileId);
          return (
            <div key={r.id} style={{ ...cardStyle, fontSize: 13 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{RULE_LABELS[r.ruleType]}</div>
                <div style={{ color: "#64748b", marginTop: 2 }}>
                  {r.ruleType === "weekly" && `${DAY_NAMES[r.weekday ?? 0]} ${r.startTime}–${r.endTime}`}
                  {r.ruleType === "holiday" && `Date: ${r.startTime}`}
                  {r.ruleType === "one_time" && `${r.startAt ? new Date(r.startAt).toLocaleString() : "?"} → ${r.endAt ? new Date(r.endAt).toLocaleString() : "?"}`}
                  {r.priority > 0 && <span style={{ marginLeft: 8, color: "#6366f1" }}>priority {r.priority}</span>}
                </div>
              </div>
              {prof && <code style={{ fontSize: 11, background: "rgba(0,0,0,0.3)", padding: "2px 7px", borderRadius: 4, color: "#94a3b8" }}>{prof.vitalPbxMohClassName}</code>}
              {canManage && <button onClick={() => deleteRule(r.id)} style={btnSmall("#7f1d1d")}>Remove</button>}
            </div>
          );
        })}
      </div>

      {showRuleForm && (
        <div style={modalOverlay}>
          <div style={modalBox}>
            <h3 style={{ margin: "0 0 18px", fontSize: 15, fontWeight: 700 }}>Add Schedule Rule</h3>
            {ruleErr && <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 10 }}>{ruleErr}</div>}
            <label style={labelStyle}>Rule Type</label>
            <select style={inputStyle} value={ruleForm.ruleType} onChange={(e) => setRuleForm((f) => ({ ...f, ruleType: e.target.value as RuleType }))}>
              {(Object.entries(RULE_LABELS) as [RuleType, string][]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label style={labelStyle}>Hold Profile</label>
            <select style={inputStyle} value={ruleForm.profileId} onChange={(e) => setRuleForm((f) => ({ ...f, profileId: e.target.value }))}>
              <option value="">— Select —</option>
              {profs.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.vitalPbxMohClassName})</option>)}
            </select>
            {ruleForm.ruleType === "weekly" && (
              <>
                <label style={labelStyle}>Day</label>
                <select style={inputStyle} value={ruleForm.weekday} onChange={(e) => setRuleForm((f) => ({ ...f, weekday: parseInt(e.target.value) }))}>
                  {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ flex: 1 }}><label style={labelStyle}>Start</label><input type="time" style={{ ...timeInput, width: "100%" }} value={ruleForm.startTime} onChange={(e) => setRuleForm((f) => ({ ...f, startTime: e.target.value }))} /></div>
                  <div style={{ flex: 1 }}><label style={labelStyle}>End</label><input type="time" style={{ ...timeInput, width: "100%" }} value={ruleForm.endTime} onChange={(e) => setRuleForm((f) => ({ ...f, endTime: e.target.value }))} /></div>
                </div>
              </>
            )}
            {ruleForm.ruleType === "holiday" && (
              <><label style={labelStyle}>Date (YYYY-MM-DD)</label><input style={inputStyle} value={ruleForm.holidayDate} onChange={(e) => setRuleForm((f) => ({ ...f, holidayDate: e.target.value }))} placeholder="2026-12-25" /></>
            )}
            {ruleForm.ruleType === "one_time" && (
              <><label style={labelStyle}>Start</label><input type="datetime-local" style={inputStyle} value={ruleForm.startAt} onChange={(e) => setRuleForm((f) => ({ ...f, startAt: e.target.value }))} /><label style={labelStyle}>End</label><input type="datetime-local" style={inputStyle} value={ruleForm.endAt} onChange={(e) => setRuleForm((f) => ({ ...f, endAt: e.target.value }))} /></>
            )}
            <label style={labelStyle}>Priority <span style={{ color: "#64748b", fontWeight: 400 }}>(higher = wins on overlap)</span></label>
            <input type="number" style={inputStyle} value={ruleForm.priority} onChange={(e) => setRuleForm((f) => ({ ...f, priority: parseInt(e.target.value) || 0 }))} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowRuleForm(false)} style={btnSmall("#334155")}>Cancel</button>
              <button onClick={saveRule} disabled={savingRule} style={btnStyle("#6366f1")}>{savingRule ? "Saving…" : "Add Rule"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Override
// ═══════════════════════════════════════════════════════════════════════════════

function OverrideTab({ override, profiles, tenantId, canManage, onRefresh }: {
  override: OverrideState | null; profiles: HoldProfile[]; tenantId: string; canManage: boolean; onRefresh: () => void;
}) {
  const [profileId, setProfileId] = useState(override?.profileId ?? "");
  const [reason, setReason] = useState(override?.reason ?? "");
  const [expiresAt, setExpiresAt] = useState(override?.expiresAt ? override.expiresAt.slice(0, 16) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const isActive = override?.isActive ?? false;

  const activate = async () => {
    if (!profileId) { setErr("Select a hold profile."); return; }
    setSaving(true); setErr(null); setMsg(null);
    try {
      const r: any = await apiPost("/voice/moh/override/activate", { tenantId, profileId, reason: reason || undefined, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null });
      setMsg(r?.publishResult ? `Override activated and published immediately: ${r.publishResult.mohClass}` : "Override activated. Will publish within 60s.");
      onRefresh();
    } catch (e: any) { setErr(e?.message ?? "Failed"); }
    finally { setSaving(false); }
  };

  const deactivate = async () => {
    setSaving(true); setErr(null); setMsg(null);
    try {
      const r: any = await apiPost("/voice/moh/override/deactivate", { tenantId });
      setMsg(r?.publishResult ? `Override cleared. Restored to: ${r.publishResult.mohClass} (${r.publishResult.mode})` : "Override cleared. Will reconcile within 60s.");
      onRefresh();
    } catch (e: any) { setErr(e?.message ?? "Failed"); }
    finally { setSaving(false); }
  };

  const selProf = profiles.find((p) => p.id === (override?.profileId ?? ""));

  return (
    <div style={{ maxWidth: 520 }}>
      <h2 style={{ margin: "0 0 18px", fontSize: 16, fontWeight: 600 }}>Manual Override</h2>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 18 }}>
        Activating an override publishes immediately — no waiting for the next reconciliation cycle.
      </p>

      <div style={{ ...cardStyle, marginBottom: 20, borderColor: isActive ? "#ef4444" : "rgba(255,255,255,0.08)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
          <span style={{ width: 12, height: 12, borderRadius: "50%", background: isActive ? "#ef4444" : "#22c55e", flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{isActive ? "Override ACTIVE" : "Override inactive"}</div>
            {isActive && selProf && (
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
                <code style={{ color: "#e2e8f0" }}>{selProf.vitalPbxMohClassName}</code>
                {selProf.holdAnnouncementEnabled && <span style={{ marginLeft: 6, color: "#67e8f9" }}>+ announcement</span>}
                {override?.reason ? ` — ${override.reason}` : ""}
                {override?.expiresAt ? ` (expires ${new Date(override.expiresAt).toLocaleString()})` : " (manual)"}
              </div>
            )}
          </div>
        </div>
        {isActive && canManage && <button onClick={deactivate} disabled={saving} style={{ ...btnSmall("#7f1d1d"), padding: "6px 14px" }}>Deactivate</button>}
      </div>

      {err && <div style={{ color: "#fca5a5", fontSize: 13, marginBottom: 10 }}>{err}</div>}
      {msg && <div style={{ color: "#86efac", fontSize: 13, marginBottom: 10 }}>{msg}</div>}

      {canManage && !isActive && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={labelStyle}>Hold Profile to activate</label>
            <select style={inputStyle} value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">— Select profile —</option>
              {profiles.filter((p) => p.isActive).map((p) => (
                <option key={p.id} value={p.id}>{p.name} → {p.vitalPbxMohClassName}{p.holdAnnouncementEnabled ? " + 📢" : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Reason (optional)</label>
            <input style={inputStyle} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Holiday campaign" />
          </div>
          <div>
            <label style={labelStyle}>Auto-expire at (optional)</label>
            <input type="datetime-local" style={inputStyle} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>Leave blank for manual deactivation only.</div>
          </div>
          <button onClick={activate} disabled={saving} style={btnStyle("#ef4444")}>{saving ? "Activating…" : "Activate Override"}</button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Publish
// ═══════════════════════════════════════════════════════════════════════════════

function PublishTab({ history, preview, tenantId, canManage, onRefresh }: {
  history: PublishRecord[]; preview: PreviewResult | null; tenantId: string; canManage: boolean; onRefresh: () => void;
}) {
  const [publishing, setPublishing] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const publish = async () => {
    if (!confirm("Publish current Hold Profile to the PBX now?")) return;
    setPublishing(true); setMsg(null);
    try {
      const r: any = await apiPost("/voice/moh/publish", { tenantId });
      setMsg({ ok: true, text: `Published: ${r?.mohClass} (${r?.mode})${r?.profile?.holdAnnouncementEnabled ? " + announcement" : ""}` });
      onRefresh();
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? "Publish failed" }); }
    finally { setPublishing(false); }
  };

  const rollback = async (id: string) => {
    if (!confirm("Roll back to the state before this publish?")) return;
    setRollingBack(id); setMsg(null);
    try {
      const r: any = await apiPost(`/voice/moh/rollback/${id}`, {});
      setMsg({ ok: true, text: `Rolled back to: ${r?.restoredMohClass}` });
      onRefresh();
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? "Rollback failed" }); }
    finally { setRollingBack(null); }
  };

  return (
    <div>
      {/* Current state card */}
      <div style={{ ...cardStyle, marginBottom: 24, alignItems: "flex-start", flexDirection: "column", gap: 14, padding: 20 }}>
        <div style={{ width: "100%" }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Publish Hold Profile to PBX</div>
          <p style={{ fontSize: 13, color: "#94a3b8", margin: "0 0 12px" }}>
            Writes the current effective Hold Profile as AstDB keys to VitalPBX/Asterisk via AMI.
            VitalPBX reads these at hold/queue time — Connect never handles media.
          </p>

          {/* Current runtime state table */}
          {preview?.profile && (
            <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "#64748b", textTransform: "uppercase", marginBottom: 8 }}>Current Effective State</div>
              {[
                ["active_moh_class", preview.profile.vitalPbxMohClassName],
                ["hold_mode", preview.mode],
                ["hold_announcement_enabled", preview.profile.holdAnnouncementEnabled ? "1" : "0"],
                ["hold_announcement_ref", preview.profile.holdAnnouncementRef ?? ""],
                ["hold_announcement_interval", String(preview.profile.holdAnnouncementIntervalSec ?? 30)],
                ["intro_announcement_ref", preview.profile.introAnnouncementRef ?? ""],
                ["hold_announce", preview.profile.holdAnnouncementEnabled ? (preview.profile.holdAnnouncementRef ?? "") : ""],
                ["hold_repeat", String(preview.profile.holdAnnouncementIntervalSec ?? 30)],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 12, fontSize: 12, padding: "2px 0" }}>
                  <code style={{ color: "#94a3b8", minWidth: 220 }}>{k}</code>
                  <span style={{ color: v ? "#e2e8f0" : "#475569" }}>{v || "—"}</span>
                </div>
              ))}
            </div>
          )}
          {preview?.lastPublished && (
            <div style={{ fontSize: 12, color: "#64748b" }}>
              Last pushed: <strong style={{ color: "#94a3b8" }}>{preview.lastPublished.mohClass}</strong> ({preview.lastPublished.holdMode}) at {new Date(preview.lastPublished.publishedAt).toLocaleString()}
            </div>
          )}
        </div>
        {msg && <div style={{ fontSize: 13, color: msg.ok ? "#86efac" : "#fca5a5" }}>{msg.text}</div>}
        {canManage && <button onClick={publish} disabled={publishing} style={btnStyle("#6366f1")}>{publishing ? "Publishing…" : "Publish Now"}</button>}
      </div>

      {/* History */}
      <h3 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 600 }}>Publish History</h3>
      {history.length === 0 && <div style={emptyBox}>No publish records yet.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {history.map((r) => (
          <div key={r.id} style={{ ...cardStyle, fontSize: 13 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: r.status === "success" ? "#22c55e" : r.status === "failed" ? "#ef4444" : "#f59e0b" }} />
                <code style={{ color: "#e2e8f0" }}>{r.newMohClass}</code>
                {r.isRollback && <span style={{ fontSize: 10, background: "rgba(99,102,241,0.2)", color: "#a5b4fc", borderRadius: 4, padding: "1px 6px" }}>rollback</span>}
                <span style={{ fontSize: 11, color: "#64748b" }}>{SOURCE_LABELS[r.source] ?? r.source}</span>
                <span style={{ color: "#475569" }}>{new Date(r.publishedAt).toLocaleString()}</span>
              </div>
              <div style={{ marginTop: 3, color: "#64748b" }}>
                by {r.publishedBy}
                {r.previousMohClass && <span style={{ marginLeft: 8 }}>← was: <code>{r.previousMohClass}</code></span>}
                {r.status === "failed" && r.error && <span style={{ color: "#fca5a5", marginLeft: 8 }}>{r.error}</span>}
              </div>
            </div>
            {canManage && r.status === "success" && !r.isRollback && (
              <button onClick={() => rollback(r.id)} disabled={rollingBack === r.id} style={btnSmall("#334155")}>
                {rollingBack === r.id ? "…" : "Rollback"}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Micro components / styles ─────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "#64748b", textTransform: "uppercase", marginBottom: 8, marginTop: 18 }}>{children}</div>;
}
function SectionLabelInline({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "#64748b", textTransform: "uppercase" }}>{children}</span>;
}

const cardStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 14, background: "rgba(15,23,42,0.6)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px 16px" };
const emptyBox: React.CSSProperties = { background: "rgba(15,23,42,0.4)", border: "1px dashed rgba(255,255,255,0.08)", borderRadius: 8, padding: "20px 16px", color: "#475569", fontSize: 13, textAlign: "center" };
const inputStyle: React.CSSProperties = { width: "100%", background: "rgba(15,23,42,0.8)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 7, padding: "8px 12px", color: "#e2e8f0", fontSize: 13, outline: "none", marginBottom: 12, boxSizing: "border-box" };
const timeInput: React.CSSProperties = { background: "rgba(15,23,42,0.8)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 7, padding: "5px 8px", color: "#e2e8f0", fontSize: 12, outline: "none", marginBottom: 12 };
const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 4 };
const modalOverlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 };
const modalBox: React.CSSProperties = { background: "#0f172a", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, padding: 28, minWidth: 420, maxWidth: 560, width: "100%", maxHeight: "90vh", overflowY: "auto" };
function btnStyle(bg: string): React.CSSProperties { return { background: bg, color: "#fff", border: "none", borderRadius: 7, padding: "9px 18px", cursor: "pointer", fontSize: 13, fontWeight: 600 }; }
function btnSmall(bg: string): React.CSSProperties { return { background: bg, color: "#e2e8f0", border: "none", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap" }; }

// ── Assets tab ────────────────────────────────────────────────────────────────
// Tenants upload MOH audio here. Files land on Connect; the PBX-host
// connect-media-sync helper pulls them on a cron (see docs/pbx/connect-media-sync.sh).
function AssetsTab({ tenantId, canUpload }: { tenantId: string; canUpload: boolean }) {
  const [assets, setAssets] = useState<MohAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = `?tenantId=${encodeURIComponent(tenantId)}`;
      const r = await apiGet<{ assets: MohAsset[] }>(`/voice/moh/assets${qs}`);
      setAssets(r.assets ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load assets");
    } finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => { reload(); }, [reload]);

  const upload = useCallback(async () => {
    if (!file) { setError("Choose a file first"); return; }
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true);
    setError(null);
    try {
      // Direct multipart upload — not JSON — so we bypass the apiClient helper.
      // Same session token as normal API calls; the server validates it.
      const baseUrl = (process.env.NEXT_PUBLIC_API_URL || (typeof window !== "undefined" ? `${window.location.origin}/api` : "")).replace(/\/+$/, "");
      const token =
        (typeof window !== "undefined" &&
          (localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken"))) || "";
      const fd = new FormData();
      fd.append("meta", JSON.stringify({ tenantId, name: name.trim() }));
      fd.append("file", file);
      const res = await fetch(`${baseUrl}/voice/moh/assets`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        throw new Error(msg || `Upload failed (${res.status})`);
      }
      setName("");
      setFile(null);
      await reload();
    } catch (e: any) {
      setError(e?.message ?? "Upload failed");
    } finally { setBusy(false); }
  }, [file, name, tenantId, reload]);

  const remove = useCallback(async (id: string) => {
    if (!confirm("Archive this MOH asset? The PBX helper will remove it on the next sync.")) return;
    try {
      await apiDelete(`/voice/moh/assets/${id}`);
      await reload();
    } catch (e: any) { setError(e?.message ?? "Delete failed"); }
  }, [reload]);

  return (
    <div>
      {canUpload && (
        <div style={{ ...cardStyle, flexDirection: "column", alignItems: "stretch", gap: 12, padding: 20, marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Upload music on hold</div>
          <p style={{ fontSize: 12, color: "#94a3b8", margin: 0 }}>
            MP3 / WAV / AAC up to 50 MB. A new VitalPBX MOH class is created on the next PBX sync run.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <input
              type="text"
              placeholder="Asset name (e.g. Holiday Jazz)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ ...inputStyle, width: 260, marginBottom: 0 }}
            />
            <input
              type="file"
              accept="audio/mpeg,audio/wav,audio/x-wav,audio/aac,audio/mp4,audio/ogg"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ color: "#cbd5e1", fontSize: 12 }}
            />
            <button onClick={upload} disabled={busy} style={btnStyle("#6366f1")}>
              {busy ? "Uploading…" : "Upload"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444", borderRadius: 8, padding: "10px 16px", marginBottom: 20, fontSize: 13, color: "#fca5a5" }}>
          {error}
          <button onClick={() => setError(null)} style={{ ...btnSmall("transparent"), marginLeft: 12 }}>dismiss</button>
        </div>
      )}

      <div style={{ ...cardStyle, flexDirection: "column", alignItems: "stretch", padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "rgba(0,0,0,0.3)" }}>
              <th style={{ textAlign: "left", padding: "10px 14px", color: "#cbd5e1" }}>Name</th>
              <th style={{ textAlign: "left", padding: "10px 14px", color: "#cbd5e1" }}>MOH Class</th>
              <th style={{ textAlign: "left", padding: "10px 14px", color: "#cbd5e1" }}>Size</th>
              <th style={{ textAlign: "left", padding: "10px 14px", color: "#cbd5e1" }}>Status</th>
              <th style={{ textAlign: "right", padding: "10px 14px", color: "#cbd5e1" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} style={{ padding: 18, textAlign: "center", color: "#94a3b8" }}>Loading…</td></tr>}
            {!loading && assets.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 18, textAlign: "center", color: "#94a3b8" }}>
                No MOH assets uploaded yet.
              </td></tr>
            )}
            {assets.map((a) => (
              <tr key={a.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <td style={{ padding: "10px 14px" }}>{a.name}</td>
                <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 12 }}>{a.mohClassName}</td>
                <td style={{ padding: "10px 14px" }}>{(a.sizeBytes / 1024 / 1024).toFixed(2)} MB</td>
                <td style={{ padding: "10px 14px", color: a.status === "ready" ? "#22c55e" : "#f59e0b" }}>{a.status}</td>
                <td style={{ padding: "10px 14px", textAlign: "right" }}>
                  {canUpload && <button onClick={() => remove(a.id)} style={btnSmall("#ef444480")}>Archive</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

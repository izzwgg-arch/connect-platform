"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppContext } from "../../../../hooks/useAppContext";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from "../../../../services/apiClient";

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

const TABS = ["Hold Profiles", "Assets", "Call Types", "Control", "Schedule", "Admin Schedules", "Override", "Publish"] as const;
type Tab = typeof TABS[number];

// Admin (multi-tenant) schedules are a SUPER_ADMIN-only global overlay, so that
// tab is hidden for tenant admins.
const SUPER_ADMIN_ONLY_TABS = new Set<Tab>(["Admin Schedules"]);

// ── Per-call-source policy types (Requirement 5/7) ───────────────────────────
// Mirrors MohSourcePolicy on the API + MohCallSource in packages/shared. A row
// with scope="tenant" (extension="") is a tenant-wide policy; scope="extension"
// targets one channel token. The dialplan resolver reads these as additive
// AstDB keys and only ever ADDS specificity over the tenant/extension default.
interface SourcePolicy {
  id: string;
  tenantId: string;
  scope: "tenant" | "extension";
  extension: string;
  source: string;
  vitalPbxMohClassName: string;
  mohProfileId: string | null;
  enabled: boolean;
}

interface ResolveResult {
  tenantId: string;
  source: string;
  sourceLabel: string;
  extension: string | null;
  at: string;
  resolved: { class: string | null; reason: string; ruleId: string | null; fallbackToPbxDefault: boolean };
  candidates: {
    schedule_extension: string | null;
    extension_source: string | null;
    extension_default: string | null;
    tenant_source: string | null;
    tenant_default: string | null;
    tenant_default_mode: string;
    global_default: string | null;
  };
}

// Human labels for the resolution reason returned by /voice/moh/resolve.
const REASON_LABELS: Record<string, string> = {
  schedule_extension: "Scheduled extension override (active now)",
  extension_source:   "Extension policy for this call type",
  extension_default:  "Extension default MOH",
  tenant_source:      "Tenant policy for this call type",
  tenant_default:     "Tenant default MOH",
  global_default:     "Global system default",
  pbx_default:        "No Connect policy — VitalPBX default plays",
};

// Call sources that CANNOT currently be resolved on a real PBX call path and
// must therefore not be offered in the UI (Requirement 6/8 — never expose
// functionality that isn't actually active).
//   • mobile_app: a softphone that PLACES a call is an ordinary PJSIP extension
//     (CALL_TYPE 1/3), indistinguishable from a desk phone in the generated
//     dialplan; [pjsip-push] only WAKES a called mobile device. No per-call
//     inherited variable identifies the originator as a mobile app.
//   • parked: parking-lot hold music is controlled by res_parking.conf's
//     `musicclass` applied when the call ENTERS the lot — not by CHANNEL(musicclass)
//     on the bridge/connect hooks this resolver runs on. It cannot be set here.
const UNSUPPORTED_MOH_SOURCES = new Set<string>(["mobile_app", "parked"]);

// The candidate chain rendered top→bottom in priority order.
const CANDIDATE_ORDER: Array<{ key: keyof ResolveResult["candidates"]; reason: string; label: string }> = [
  { key: "schedule_extension", reason: "schedule_extension", label: "1 · Scheduled extension override" },
  { key: "extension_source",   reason: "extension_source",   label: "2 · Extension + this call type" },
  { key: "extension_default",  reason: "extension_default",  label: "3 · Extension default" },
  { key: "tenant_source",      reason: "tenant_source",      label: "4 · Tenant + this call type" },
  { key: "tenant_default",     reason: "tenant_default",     label: "5 · Tenant default" },
  { key: "global_default",     reason: "global_default",     label: "6 · Global default" },
];

// ── Control mode (Connect-managed vs native PBX) — Requirement 2/4 ───────────
type TenantControlMode = "connect" | "pbx";
type ExtensionControlMode = "inherit" | "connect" | "pbx";

interface ExtensionControlRow {
  id: string;
  tenantId: string;
  extension: string;
  controlMode: ExtensionControlMode;
  updatedAt?: string;
}

interface ControlPayload {
  tenantId: string;
  tenantControlMode: TenantControlMode;
  extensionControls: ExtensionControlRow[];
}

// ── Admin (multi-tenant) schedule — Requirement 3 (SUPER_ADMIN) ──────────────
interface AdminScheduleTargetRow {
  id?: string;
  tenantId: string;
  extension: string;
}

interface AdminSchedule {
  id: string;
  name: string;
  enabled: boolean;
  scheduleKind: "one_time" | "recurring";
  timezone: string;
  vitalPbxMohClassName: string;
  priority: number;
  startAt: string | null;
  endAt: string | null;
  startWeekday: number | null;
  startTime: string | null;
  endWeekday: number | null;
  endTime: string | null;
  fallbackMode: "restore_previous" | "explicit";
  fallbackClass: string | null;
  isDeleted?: boolean;
  targets: AdminScheduleTargetRow[];
}

interface AdminActivation {
  id: string;
  scheduleId: string;
  tenantId: string;
  extension: string;
  state: string;
  previousClass: string | null;
  previousControlMode: string | null;
  activatedAt?: string;
}

interface AdminTenantLite {
  id: string;
  name: string;
  pbxTenantId: string | null;
  pbxTenantName: string | null;
}

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
  conversionStatus?: string | null;
  conversionError?: string | null;
  pbxStorageKey?: string | null;
  originalStorageKey?: string | null;
  pbxFormat?: string | null;
}

interface MohStatusPayload {
  tenantId: string;
  mohClassName: string;
  classType: "native" | "connect";
  db: {
    profileExists: boolean;
    assetExists: boolean;
    assetStatus: string | null;
    conversionStatus: string | null;
    pbxStorageKey: string | null;
    lastPublishedState: { mohClass: string; holdMode: string; publishedAt: string } | null;
    activeClass: string | null;
  };
  storage: { originalExists: boolean; pbxArtifactExists: boolean; pbxArtifactFormat: string | null; sizeBytes: number | null };
  sync: { manifestAvailable: boolean; lastSyncAt: string | null; lastSyncStatus: string | null };
  pbxExpected: { mohDirectory: string; configFile: string; expectedConfigBlock: string };
  warnings: string[];
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
  // Split permissions: a custom role can grant just publishing or just override
  // toggles. Full manage implies both. Mirrors the server additive-OR gate
  // (can_publish_moh / can_override_moh).
  const canPublish = can("can_publish_moh") || canManage;
  const canOverride = can("can_override_moh") || canManage;

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
        {TABS.filter((tab) => isSuperAdmin || !SUPER_ADMIN_ONLY_TABS.has(tab)).map((tab) => (
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
      {!loading && activeTab === "Call Types" && (
        <CallTypesTab tenantId={tenantId} canManage={canManage} isSuperAdmin={isSuperAdmin} />
      )}
      {!loading && activeTab === "Control" && (
        <ControlTab tenantId={tenantId} canManage={canManage} isSuperAdmin={isSuperAdmin} />
      )}
      {!loading && activeTab === "Admin Schedules" && isSuperAdmin && (
        <AdminSchedulesTab canManage={canManage} />
      )}
      {!loading && activeTab === "Schedule" && (
        <ScheduleTab schedule={schedule} profiles={profiles} tenantId={tenantId} canManage={canManage} onRefresh={reload} />
      )}
      {!loading && activeTab === "Override" && (
        <OverrideTab override={override} profiles={profiles} tenantId={tenantId} canManage={canOverride} onRefresh={reload} />
      )}
      {!loading && activeTab === "Publish" && (
        <PublishTab history={history} preview={preview} tenantId={tenantId} canManage={canPublish} onRefresh={reload} />
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
  pbxTenantId: string | null;
  name: string;
  mohClassName: string;
  displayName?: string;
  runtimeClass?: string;
  classType: string | null;
  isDefault: boolean;
  fileCount: number;
  isActive: boolean;
  origin?: string | null;
  loadedInAsterisk?: boolean | null;
  selectable?: boolean;
  unavailableReason?: string | null;
  filesPresent?: boolean;
}

// ── MOH class picker ─────────────────────────────────────────────────────────
// Dropdown-first picker for the "VitalPBX MOH Class" field on Hold Profiles.
// Merges three sources so the admin never has to guess the right class name:
//   1. This tenant's own classes from ombu_music_groups.
//   2. The PBX-wide "system" classes the admin tenant ships (default / main /
//      No Music) — always appended so a tenant with zero own classes still has
//      working options to pick from.
//   3. Connect-uploaded MOH assets (MohAsset → class connect_<slug>_<name>).
//   4. Runtime values for PBX-native classes are moh<groupId> from ombu_music_groups.
// Legacy-safe: if the saved value isn't in the merged catalog we still render
// it at the top of the options, but the API will block saving until a valid
// runtime class is selected.
function MohClassPicker({
  value, onChange, pbxClasses, assets, loading, placeholder,
  tenantSlug, canSyncPbx, onSync, syncing,
  canIncludeAll, includeAll, onToggleIncludeAll,
}: {
  value: string;
  onChange: (next: string) => void;
  pbxClasses: PbxMohClassRow[];
  assets: MohAsset[];
  loading: boolean;
  placeholder?: string;
  tenantSlug?: string | null;
  canSyncPbx?: boolean;
  onSync?: () => void | Promise<void>;
  syncing?: boolean;
  canIncludeAll?: boolean;
  includeAll?: boolean;
  onToggleIncludeAll?: (next: boolean) => void;
}) {
  type Opt = {
    value: string;
    label: string;
    group: "yours" | "system" | "other" | "upload" | "legacy";
    tenantLabel?: string | null;
    disabled?: boolean;
  };

  const UNAVAILABLE_REASON_LABEL: Record<string, string> = {
    no_files: "no audio files — would play silence",
    not_loaded: "not loaded in Asterisk",
    deactivated: "removed from PBX",
  };

  const GROUP_LABELS: Record<Opt["group"], string> = {
    yours:  tenantSlug ? `This tenant (${tenantSlug})` : "This tenant",
    system: "System (available to all tenants)",
    other:  "Other tenants on this PBX",
    upload: "Uploaded on Connect (connect_* — PBX needs connect-media-sync + musiconhold include)",
    legacy: "Saved value (not in catalog)",
  };

  const options: Opt[] = [];
  const seen = new Set<string>();
  void placeholder;

  const classify = (c: PbxMohClassRow): Opt["group"] => {
    // tenantSlug "vitalpbx" / pbxTenantId "1" is the PBX-admin tenant —
    // its classes are the shared library this PBX uses across customer tenants.
    if (c.tenantSlug === "vitalpbx" || c.pbxTenantId === "1" || c.isDefault) return "system";
    if (tenantSlug && c.tenantSlug && c.tenantSlug.toLowerCase() === tenantSlug.toLowerCase()) return "yours";
    if (!tenantSlug) return "yours";
    return "other";
  };

  const labelFor = (c: PbxMohClassRow): string => {
    const displayName = c.displayName ?? c.name;
    const runtimeClass = c.runtimeClass ?? c.mohClassName;
    const parts: string[] = [displayName === runtimeClass ? runtimeClass : `${displayName} -> ${runtimeClass}`];
    if (c.fileCount) parts.push(`${c.fileCount} file${c.fileCount === 1 ? "" : "s"}`);
    if (c.isDefault) parts.push("default");
    return parts.join(" · ");
  };

  let unavailableCount = 0;
  for (const c of pbxClasses) {
    if (!c.isActive) continue;
    const v = c.runtimeClass ?? c.mohClassName;
    if (seen.has(v)) continue;
    seen.add(v);
    // Playability gate: a class is disabled (not choosable) when Asterisk can't
    // play it. The API also blocks publishing such a class, so this is UI polish
    // on top of a hard server gate.
    const unavailable = c.selectable === false;
    if (unavailable) unavailableCount += 1;
    const reasonText = c.unavailableReason ? (UNAVAILABLE_REASON_LABEL[c.unavailableReason] ?? c.unavailableReason) : "unavailable";
    options.push({
      value: v,
      label: unavailable ? `${labelFor(c)} — ${reasonText}` : labelFor(c),
      group: classify(c),
      tenantLabel: c.tenantSlug ?? null,
      disabled: unavailable,
    });
  }

  for (const a of assets) {
    if (a.status !== "ready") continue;
    if (a.conversionStatus && a.conversionStatus !== "ready") continue;
    const v = (a.mohClassName || "").trim();
    if (!v.startsWith("connect_")) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    options.push({
      value: v,
      label: `${a.name} → ${v} · Connect upload`,
      group: "upload",
    });
  }

  const hasCurrent = !!value && seen.has(value);
  if (value && !hasCurrent) {
    options.unshift({ value, label: `${value} (not in synced PBX catalog — save blocked)`, group: "legacy" });
    seen.add(value);
  }

  const GROUP_ORDER: Array<Opt["group"]> = ["legacy", "yours", "system", "upload", "other"];
  const grouped = new Map<Opt["group"], Opt[]>();
  for (const o of options) {
    const list = grouped.get(o.group) ?? [];
    list.push(o);
    grouped.set(o.group, list);
  }

  const ownCount    = (grouped.get("yours") ?? []).length;
  const systemCount = (grouped.get("system") ?? []).length;
  const otherCount  = (grouped.get("other") ?? []).length;
  const uploadCount = (grouped.get("upload") ?? []).length;

  const controls = (
    <div style={{ fontSize: 11, color: "#64748b", marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      <span>
        {ownCount} yours · {systemCount} system
        {uploadCount ? ` · ${uploadCount} Connect upload${uploadCount === 1 ? "" : "s"}` : ""}
        {otherCount ? ` · ${otherCount} other` : ""}
        {unavailableCount ? ` · ${unavailableCount} unavailable` : ""}
      </span>
      {canSyncPbx && onSync && (
        <button
          type="button"
          onClick={() => onSync()}
          disabled={!!syncing}
          style={{ background: "transparent", border: "none", color: syncing ? "#64748b" : "#818cf8", cursor: syncing ? "wait" : "pointer", fontSize: 11, padding: 0 }}
          title="Re-read MOH classes from VitalPBX's ombutel MySQL"
        >
          {syncing ? "Refreshing…" : "↻ Refresh from PBX"}
        </button>
      )}
      {canIncludeAll && onToggleIncludeAll && (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={!!includeAll}
            onChange={(e) => onToggleIncludeAll(e.target.checked)}
            style={{ accentColor: "#818cf8" }}
          />
          <span>Show all tenants</span>
        </label>
      )}
    </div>
  );

  const allMohOptions = [
    { value: "", label: "— Select MOH class —" },
    ...GROUP_ORDER.flatMap((g) => {
      const list = grouped.get(g);
      if (!list || list.length === 0) return [];
      return list.map((o) => ({
        value: o.value,
        label: `[${GROUP_LABELS[g]}] ${o.tenantLabel && o.group === "other" ? `${o.label} (${o.tenantLabel})` : o.label}`,
        disabled: o.disabled,
      }));
    }),
  ];

  return (
    <div>
      <ConnectSelect
        value={value}
        onChange={onChange}
        style={{ width: "100%", marginBottom: 6 }}
        searchable
        options={allMohOptions}
      />
      {value.trim().toLowerCase().startsWith("connect_") && (
        <div style={{ fontSize: 11, color: "#fbbf24", marginTop: 8, lineHeight: 1.45, padding: "8px 10px", borderRadius: 6, background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.25)" }}>
          <strong>Coverage scope:</strong> Connect-uploaded MOH (<code style={{ color: "#fde68a" }}>connect_*</code>) only applies to <em>Connect-managed routes</em> &mdash; inbound DIDs that flow through Connect&apos;s tenant router/IVR (AstDB <code style={{ color: "#fde68a" }}>connect/t_&lt;slug&gt;/moh_class</code>).
          <br />
          Native VitalPBX inbound routes, extension hold, transfer hold, parking, and queue hold music continue to use <code style={{ color: "#fde68a" }}>mohN</code> unless you map a native music group separately on the PBX. To cover those paths, pick a <code style={{ color: "#fde68a" }}>mohN</code> class instead (or contact ops to map this Connect upload as a native music group).
        </div>
      )}
      {controls}
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
  const [includeAllTenants, setIncludeAllTenants] = useState(false);

  const tenantSlug = (() => {
    if (!tenantId) return null;
    if (tenantId.startsWith("vpbx:")) return tenantId.slice(5);
    return null;
  })();

  const reloadCatalog = useCallback(async () => {
    if (!tenantId) { setPrompts([]); setMohClasses([]); setMohAssetsLite([]); return; }
    setCatalogLoading(true);
    try {
      const qs = `?tenantId=${encodeURIComponent(tenantId)}${isSuperAdmin && includeAllTenants ? "&includeAll=1" : ""}`;
      const qsSimple = `?tenantId=${encodeURIComponent(tenantId)}`;
      const [pR, cR, aR] = await Promise.allSettled([
        apiGet<{ prompts: PromptCatalogRow[] }>(`/voice/ivr/prompts${qsSimple}`),
        apiGet<{ classes: PbxMohClassRow[] }>(`/voice/moh/pbx-classes${qs}`),
        apiGet<{ assets: MohAsset[] }>(`/voice/moh/assets${qsSimple}`),
      ]);
      setPrompts(pR.status === "fulfilled" ? (pR.value.prompts ?? []).filter((p) => p.isActive) : []);
      setMohClasses(cR.status === "fulfilled" ? (cR.value.classes ?? []) : []);
      setMohAssetsLite(aR.status === "fulfilled" ? (aR.value.assets ?? []) : []);
    } finally { setCatalogLoading(false); }
  }, [tenantId, isSuperAdmin, includeAllTenants]);

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
            <ConnectSelect
              value={form.type}
              onChange={(v) => setForm((f) => ({ ...f, type: v as HoldType }))}
              style={{ width: "100%", marginBottom: 14 }}
              options={(Object.entries(TYPE_LABELS) as [HoldType, string][]).map(([v, l]) => ({ value: v, label: l }))}
            />

            <label style={labelStyle}>VitalPBX MOH Class <span style={{ color: "#64748b", fontWeight: 400 }}>(runtime class from synced PBX catalog)</span></label>
            <MohClassPicker
              value={form.vitalPbxMohClassName}
              onChange={(v) => setForm((f) => ({ ...f, vitalPbxMohClassName: v }))}
              pbxClasses={mohClasses}
              assets={mohAssetsLite}
              loading={catalogLoading}
              tenantSlug={tenantSlug}
              canSyncPbx={isSuperAdmin}
              onSync={autoSyncMohClasses}
              syncing={syncing}
              canIncludeAll={isSuperAdmin}
              includeAll={includeAllTenants}
              onToggleIncludeAll={setIncludeAllTenants}
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
      <ConnectSelect
        value={tz}
        onChange={setTz}
        disabled={!canManage}
        searchable
        style={{ maxWidth: 320, width: "100%", marginBottom: 2 }}
        options={ALL_TIMEZONES.map((z) => ({ value: z, label: z }))}
      />

      <SectionLabel>Default Profile Slots</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
        {([["Default / Business Hours", defId, setDefId], ["After Hours Fallback", ahId, setAhId], ["Holiday Fallback", holId, setHolId]] as const).map(([label, val, setter]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 200, fontSize: 13, color: "#94a3b8", flexShrink: 0 }}>{label}</span>
            <ConnectSelect
              value={val}
              onChange={(v) => (setter as (v: string) => void)(v)}
              disabled={!canManage}
              style={{ flex: 1 }}
              options={[
                { value: "", label: "— Not set —" },
                ...profs.map((p) => ({ value: p.id, label: `${p.name} (${p.vitalPbxMohClassName})` })),
              ]}
            />
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
            <ConnectSelect
              value={ruleForm.ruleType}
              onChange={(v) => setRuleForm((f) => ({ ...f, ruleType: v as RuleType }))}
              style={{ width: "100%", marginBottom: 14 }}
              options={(Object.entries(RULE_LABELS) as [RuleType, string][]).map(([v, l]) => ({ value: v, label: l }))}
            />
            <label style={labelStyle}>Hold Profile</label>
            <ConnectSelect
              value={ruleForm.profileId}
              onChange={(v) => setRuleForm((f) => ({ ...f, profileId: v }))}
              style={{ width: "100%", marginBottom: 14 }}
              options={[
                { value: "", label: "— Select —" },
                ...profs.map((p) => ({ value: p.id, label: `${p.name} (${p.vitalPbxMohClassName})` })),
              ]}
            />
            {ruleForm.ruleType === "weekly" && (
              <>
                <label style={labelStyle}>Day</label>
                <ConnectSelect
                  value={String(ruleForm.weekday)}
                  onChange={(v) => setRuleForm((f) => ({ ...f, weekday: parseInt(v) }))}
                  style={{ width: "100%", marginBottom: 14 }}
                  options={DAY_NAMES.map((d, i) => ({ value: String(i), label: d }))}
                />
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
            <ConnectSelect
              value={profileId}
              onChange={setProfileId}
              style={{ width: "100%", marginBottom: 2 }}
              options={[
                { value: "", label: "— Select profile —" },
                ...profiles.filter((p) => p.isActive).map((p) => ({ value: p.id, label: `${p.name} → ${p.vitalPbxMohClassName}${p.holdAnnouncementEnabled ? " + 📢" : ""}` })),
              ]}
            />
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
          <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 12px", lineHeight: 1.5 }}>
            <strong style={{ color: "#94a3b8" }}>Scope:</strong> this publish targets the tenant&apos;s default/channel hold profile (AstDB). Inbound-route MOH on DIDs is configured under DID routing.
            <br />
            For <code style={{ color: "#cbd5e1" }}>connect_*</code> classes the publish only covers Connect-managed inbound routes (DIDs flowing through Connect&apos;s tenant router/IVR). Native VitalPBX inbound routes, extensions, transfers, parking, and queue hold music continue using <code style={{ color: "#cbd5e1" }}>mohN</code> unless a native music group is mapped on the PBX. Pick a <code style={{ color: "#cbd5e1" }}>mohN</code> class to cover those native paths.
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

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Call Types (per-call-source MOH policies + diagnostics)
// ═══════════════════════════════════════════════════════════════════════════════

function CallTypesTab({ tenantId, canManage, isSuperAdmin }: {
  tenantId: string; canManage: boolean; isSuperAdmin?: boolean;
}) {
  const [policies, setPolicies] = useState<SourcePolicy[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [globalDefault, setGlobalDefault] = useState<string | null>(null);
  const [pbxClasses, setPbxClasses] = useState<PbxMohClassRow[]>([]);
  const [assets, setAssets] = useState<MohAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Editor state
  const [scope, setScope] = useState<"tenant" | "extension">("tenant");
  const [extension, setExtension] = useState("");
  const [editSource, setEditSource] = useState("");
  const [editClass, setEditClass] = useState("");
  const [saving, setSaving] = useState(false);

  // Global default editor
  const [gdClass, setGdClass] = useState("");
  const [gdSaving, setGdSaving] = useState(false);

  // Diagnostics
  const [dxSource, setDxSource] = useState("internal");
  const [dxExt, setDxExt] = useState("");
  const [dxResult, setDxResult] = useState<ResolveResult | null>(null);
  const [dxBusy, setDxBusy] = useState(false);

  // Health
  const [health, setHealth] = useState<{ healthy: boolean; warnings: string[] } | null>(null);

  const tenantSlug = tenantId?.startsWith("vpbx:") ? tenantId.slice(5) : null;

  const authFetch = useCallback(async (path: string, method: string, body?: unknown) => {
    const token = typeof window !== "undefined" ? (localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "") : "";
    const apiBase = typeof window !== "undefined" ? `${window.location.origin}/api` : (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001");
    const resp = await fetch(`${apiBase}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!resp.ok) { const b = await resp.json().catch(() => ({})); throw new Error((b as any)?.detail ?? (b as any)?.error ?? `Request failed (${resp.status})`); }
    return resp.json().catch(() => ({}));
  }, []);

  const reload = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true); setErr(null);
    try {
      const qs = `?tenantId=${encodeURIComponent(tenantId)}`;
      const [sp, gd, cls, ast, hl] = await Promise.allSettled([
        apiGet<{ policies: SourcePolicy[]; sources: string[]; labels: Record<string, string> }>(`/voice/moh/source-policies${qs}`),
        apiGet<{ vitalPbxMohClassName: string | null }>(`/voice/moh/global-default`),
        apiGet<{ classes: PbxMohClassRow[] }>(`/voice/moh/pbx-classes${qs}`),
        apiGet<{ assets: MohAsset[] }>(`/voice/moh/assets${qs}`),
        apiGet<{ healthy: boolean; warnings: string[] }>(`/voice/moh/health${qs}`),
      ]);
      if (sp.status === "fulfilled") { setPolicies(sp.value.policies ?? []); setSources(sp.value.sources ?? []); setLabels(sp.value.labels ?? {}); if (!editSource && sp.value.sources?.length) setEditSource(sp.value.sources[0]); }
      if (gd.status === "fulfilled") { setGlobalDefault(gd.value.vitalPbxMohClassName ?? null); setGdClass(gd.value.vitalPbxMohClassName ?? ""); }
      if (cls.status === "fulfilled") setPbxClasses(cls.value.classes ?? []);
      if (ast.status === "fulfilled") setAssets(ast.value.assets ?? []);
      if (hl.status === "fulfilled") setHealth({ healthy: hl.value.healthy, warnings: hl.value.warnings ?? [] });
    } catch (e: any) { setErr(e?.message ?? "Failed to load call-type policies"); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => { reload(); }, [reload]);

  const savePolicy = async () => {
    if (!editSource || !editClass) { setErr("Pick a call type and a MOH class."); return; }
    if (scope === "extension" && !extension.trim()) { setErr("Enter an extension for extension-scope policies."); return; }
    setSaving(true); setErr(null); setMsg(null);
    try {
      await apiPut(`/voice/moh/source-policies`, {
        tenantId, scope, extension: scope === "extension" ? extension.trim() : "", source: editSource, vitalPbxMohClassName: editClass,
      });
      setMsg(`Saved ${labels[editSource] ?? editSource} → ${editClass}`);
      setEditClass("");
      await reload();
    } catch (e: any) { setErr(e?.message ?? "Save failed"); }
    finally { setSaving(false); }
  };

  const deletePolicy = async (p: SourcePolicy) => {
    if (!confirm(`Remove the ${labels[p.source] ?? p.source} policy${p.scope === "extension" ? ` for ext ${p.extension}` : ""}? Calls will fall back to the ${p.scope === "extension" ? "extension/tenant" : "tenant/global"} default.`)) return;
    setErr(null); setMsg(null);
    try {
      await authFetch(`/voice/moh/source-policies`, "DELETE", { tenantId, scope: p.scope, extension: p.extension, source: p.source });
      setMsg("Policy removed.");
      await reload();
    } catch (e: any) { setErr(e?.message ?? "Delete failed"); }
  };

  const saveGlobalDefault = async () => {
    setGdSaving(true); setErr(null); setMsg(null);
    try {
      await apiPut(`/voice/moh/global-default`, { vitalPbxMohClassName: gdClass.trim() || null });
      setGlobalDefault(gdClass.trim() || null);
      setMsg(gdClass.trim() ? `Global default set to ${gdClass.trim()}` : "Global default cleared.");
    } catch (e: any) { setErr(e?.message ?? "Failed to set global default"); }
    finally { setGdSaving(false); }
  };

  const runDiagnostic = async () => {
    setDxBusy(true); setErr(null); setDxResult(null);
    try {
      const qs = `?tenantId=${encodeURIComponent(tenantId)}&source=${encodeURIComponent(dxSource)}${dxExt.trim() ? `&extension=${encodeURIComponent(dxExt.trim())}` : ""}`;
      const r = await apiGet<ResolveResult>(`/voice/moh/resolve${qs}`);
      setDxResult(r);
    } catch (e: any) { setErr(e?.message ?? "Diagnostic failed"); }
    finally { setDxBusy(false); }
  };

  const tenantPolicies = policies.filter((p) => p.scope === "tenant");
  const extPolicies = policies.filter((p) => p.scope === "extension");
  // Only expose sources that resolve on a real PBX call path.
  const supportedSources = sources.filter((s) => !UNSUPPORTED_MOH_SOURCES.has(s));
  const sourceOpts = supportedSources.map((s) => ({ value: s, label: labels[s] ?? s }));

  return (
    <div style={{ maxWidth: 900 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600 }}>MOH by Call Type</h2>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
        Assign a MOH class per call source (inbound direct/IVR/ring-group/queue, internal, outbound, transfer, parked).
        These are <strong>additive</strong>: a call only uses a per-type class when one is set for its source — otherwise it falls through to the extension default, tenant default, then the global default, then the PBX default. Nothing here changes routing.
      </p>
      <p style={{ margin: "0 0 18px", fontSize: 11, color: "#64748b", lineHeight: 1.5 }}>
        <strong style={{ color: "#94a3b8" }}>Mobile app</strong> and <strong style={{ color: "#94a3b8" }}>Parked</strong> are intentionally not offered here. A softphone that places a call is an ordinary extension in the dialplan (indistinguishable from a desk phone), and parking-lot hold music is controlled by the parking lot configuration, not by the bridge-hook resolver these policies use. They will be enabled only when a safe per-call mechanism exists.
      </p>

      {err && <div style={{ color: "#fca5a5", fontSize: 13, marginBottom: 10 }}>{err}</div>}
      {msg && <div style={{ color: "#86efac", fontSize: 13, marginBottom: 10 }}>{msg}</div>}
      {loading && <div style={{ fontSize: 13, color: "#64748b" }}>Loading…</div>}

      {health && health.warnings.length > 0 && (
        <div style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.4)", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#fbbf24", marginBottom: 4 }}>MOH health warnings</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#fcd34d" }}>
            {health.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {health && health.healthy && (
        <div style={{ fontSize: 12, color: "#86efac", marginBottom: 16 }}>✓ MOH config healthy — all referenced classes ready, no stale schedules or failed publishes.</div>
      )}

      {/* Diagnostics */}
      <div style={{ ...cardStyle, flexDirection: "column", alignItems: "stretch", gap: 10, marginBottom: 22, padding: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Why does a call get this MOH? <span style={{ fontWeight: 400, color: "#64748b" }}>(live resolution — read-only)</span></div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div><label style={labelStyle}>Call type</label><ConnectSelect value={dxSource} onChange={setDxSource} style={{ width: 220 }} options={sourceOpts} /></div>
          <div><label style={labelStyle}>Extension (optional)</label><input style={{ ...inputStyle, width: 160, marginBottom: 0 }} value={dxExt} onChange={(e) => setDxExt(e.target.value)} placeholder="e.g. 101" /></div>
          <button onClick={runDiagnostic} disabled={dxBusy} style={btnStyle("#6366f1")}>{dxBusy ? "Resolving…" : "Explain"}</button>
        </div>
        {dxResult && (
          <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 8, padding: "12px 14px", marginTop: 4 }}>
            <div style={{ fontSize: 13, marginBottom: 10 }}>
              Result: {dxResult.resolved.class
                ? <code style={{ color: "#86efac", background: "rgba(34,197,94,0.12)", padding: "2px 8px", borderRadius: 4 }}>{dxResult.resolved.class}</code>
                : <span style={{ color: "#fbbf24" }}>PBX default (no Connect policy)</span>}
              <span style={{ color: "#64748b", marginLeft: 10 }}>{REASON_LABELS[dxResult.resolved.reason] ?? dxResult.resolved.reason}</span>
            </div>
            {CANDIDATE_ORDER.map(({ key, reason, label }) => {
              const val = dxResult.candidates[key];
              const isWinner = dxResult.resolved.reason === reason;
              return (
                <div key={key} style={{ display: "flex", gap: 12, fontSize: 12, padding: "3px 0", opacity: val ? 1 : 0.45 }}>
                  <span style={{ width: 18, textAlign: "center" }}>{isWinner ? "✓" : ""}</span>
                  <span style={{ minWidth: 260, color: isWinner ? "#e2e8f0" : "#94a3b8", fontWeight: isWinner ? 700 : 400 }}>{label}</span>
                  <code style={{ color: val ? "#cbd5e1" : "#475569" }}>{val ?? "—"}</code>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Global default */}
      <SectionLabel>Global Default {isSuperAdmin ? "" : "(SUPER_ADMIN only)"}</SectionLabel>
      <div style={{ ...cardStyle, gap: 12, marginBottom: 22 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>Last-resort Connect default before the PBX's own default MOH.</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Current: {globalDefault ? <code style={{ color: "#cbd5e1" }}>{globalDefault}</code> : <span style={{ color: "#64748b" }}>not set (PBX default)</span>}</div>
        </div>
        {isSuperAdmin && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input style={{ ...inputStyle, width: 180, marginBottom: 0 }} value={gdClass} onChange={(e) => setGdClass(e.target.value)} placeholder="mohN or connect_* (blank=clear)" />
            <button onClick={saveGlobalDefault} disabled={gdSaving} style={btnSmall("#6366f1")}>{gdSaving ? "…" : "Save"}</button>
          </div>
        )}
      </div>

      {/* Editor */}
      {canManage && (
        <div style={{ ...cardStyle, flexDirection: "column", alignItems: "stretch", gap: 12, marginBottom: 22, padding: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Add / update a call-type policy</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <label style={labelStyle}>Scope</label>
              <ConnectSelect value={scope} onChange={(v) => setScope(v as "tenant" | "extension")} style={{ width: 150 }}
                options={[{ value: "tenant", label: "Tenant-wide" }, { value: "extension", label: "Extension" }]} />
            </div>
            {scope === "extension" && (
              <div><label style={labelStyle}>Extension</label><input style={{ ...inputStyle, width: 130, marginBottom: 0 }} value={extension} onChange={(e) => setExtension(e.target.value)} placeholder="e.g. 101" /></div>
            )}
            <div><label style={labelStyle}>Call type</label><ConnectSelect value={editSource} onChange={setEditSource} style={{ width: 210 }} options={sourceOpts} /></div>
          </div>
          <div>
            <label style={labelStyle}>MOH class</label>
            <MohClassPicker value={editClass} onChange={setEditClass} pbxClasses={pbxClasses} assets={assets} loading={loading} tenantSlug={tenantSlug} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={savePolicy} disabled={saving} style={btnStyle("#6366f1")}>{saving ? "Saving…" : "Save policy"}</button>
          </div>
        </div>
      )}

      {/* Tenant policies */}
      <SectionLabel>Tenant call-type policies</SectionLabel>
      {tenantPolicies.length === 0 && <div style={emptyBox}>No tenant call-type policies. All call types use the tenant default.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 22 }}>
        {tenantPolicies.map((p) => (
          <div key={p.id} style={{ ...cardStyle, fontSize: 13 }}>
            <div style={{ flex: 1 }}>
              <span style={{ fontWeight: 600 }}>{labels[p.source] ?? p.source}</span>
              {!p.enabled && <span style={{ marginLeft: 8, fontSize: 10, color: "#f59e0b" }}>(disabled)</span>}
              {UNSUPPORTED_MOH_SOURCES.has(p.source) && <span title="This source is not resolvable on a real call path yet; the policy is stored but never applied." style={{ marginLeft: 8, fontSize: 10, color: "#f59e0b" }}>(not active)</span>}
            </div>
            <code style={{ fontSize: 11, background: "rgba(0,0,0,0.3)", padding: "2px 7px", borderRadius: 4, color: "#94a3b8" }}>{p.vitalPbxMohClassName}</code>
            {canManage && <button onClick={() => deletePolicy(p)} style={btnSmall("#7f1d1d")}>Remove</button>}
          </div>
        ))}
      </div>

      {/* Extension policies */}
      <SectionLabel>Extension call-type policies</SectionLabel>
      {extPolicies.length === 0 && <div style={emptyBox}>No extension call-type policies.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {extPolicies.map((p) => (
          <div key={p.id} style={{ ...cardStyle, fontSize: 13 }}>
            <div style={{ flex: 1 }}>
              <code style={{ color: "#e2e8f0" }}>{p.extension}</code>
              <span style={{ marginLeft: 10, fontWeight: 600 }}>{labels[p.source] ?? p.source}</span>
              {!p.enabled && <span style={{ marginLeft: 8, fontSize: 10, color: "#f59e0b" }}>(disabled)</span>}
              {UNSUPPORTED_MOH_SOURCES.has(p.source) && <span title="This source is not resolvable on a real call path yet; the policy is stored but never applied." style={{ marginLeft: 8, fontSize: 10, color: "#f59e0b" }}>(not active)</span>}
            </div>
            <code style={{ fontSize: 11, background: "rgba(0,0,0,0.3)", padding: "2px 7px", borderRadius: 4, color: "#94a3b8" }}>{p.vitalPbxMohClassName}</code>
            {canManage && <button onClick={() => deletePolicy(p)} style={btnSmall("#7f1d1d")}>Remove</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Control (Connect-managed vs native PBX) — Requirement 2/4/7
// ═══════════════════════════════════════════════════════════════════════════════

const TENANT_MODE_LABELS: Record<TenantControlMode, string> = {
  connect: "Connect-managed",
  pbx:     "PBX / native control",
};
const EXT_MODE_LABELS: Record<ExtensionControlMode, string> = {
  inherit: "Inherit tenant",
  connect: "Connect-managed",
  pbx:     "PBX / native control",
};

function ControlTab({ tenantId, canManage, isSuperAdmin }: {
  tenantId: string; canManage: boolean; isSuperAdmin?: boolean;
}) {
  const [data, setData] = useState<ControlPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  // Extension control editor.
  const [extInput, setExtInput] = useState("");
  const [extMode, setExtMode] = useState<ExtensionControlMode>("pbx");

  const reload = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true); setErr(null);
    try {
      const qs = `?tenantId=${encodeURIComponent(tenantId)}`;
      const r = await apiGet<ControlPayload>(`/voice/moh/control${qs}`);
      setData(r);
    } catch (e: any) { setErr(e?.message ?? "Failed to load control state"); }
    finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => { reload(); }, [reload]);

  const setTenantMode = async (mode: TenantControlMode) => {
    if (data?.tenantControlMode === mode) return;
    if (mode === "pbx" && !confirm("Hand this tenant back to native VitalPBX MOH? Connect will remove its hold-music overrides (tenant default + per-call-type + extension keys) and stop enforcing musicclass. Connect-managed extension islands and active admin schedules are kept.")) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r: any = await apiPut(`/voice/moh/control/tenant`, { tenantId, mode });
      setMsg(`Tenant control set to ${TENANT_MODE_LABELS[mode]}${r?.publish?.class ? ` — published ${r.publish.class}` : ""}.`);
      await reload();
    } catch (e: any) { setErr(e?.message ?? "Failed to change control mode"); }
    finally { setBusy(false); }
  };

  const saveExtControl = async () => {
    const ext = extInput.trim();
    if (!ext) { setErr("Enter an extension."); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      await apiPut(`/voice/moh/control/extension`, { tenantId, extension: ext, mode: extMode });
      setMsg(extMode === "inherit" ? `Extension ${ext} now inherits the tenant default.` : `Extension ${ext} set to ${EXT_MODE_LABELS[extMode]}.`);
      setExtInput("");
      await reload();
    } catch (e: any) { setErr(e?.message ?? "Failed to save extension control"); }
    finally { setBusy(false); }
  };

  const clearExtControl = async (ext: string) => {
    if (!confirm(`Reset extension ${ext} to inherit the tenant default?`)) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      await apiPut(`/voice/moh/control/extension`, { tenantId, extension: ext, mode: "inherit" });
      setMsg(`Extension ${ext} reset to inherit.`);
      await reload();
    } catch (e: any) { setErr(e?.message ?? "Failed to reset extension"); }
    finally { setBusy(false); }
  };

  const reconcile = async () => {
    if (!confirm("Recompute and republish MOH for this tenant now, then verify the live class on the PBX?")) return;
    setReconciling(true); setErr(null); setMsg(null);
    try {
      const r: any = await apiPost(`/voice/moh/reconcile`, { tenantId });
      setMsg(`Reconciled: ${r?.class ?? "(native)"} (${r?.mode ?? "—"}). Live verification recorded in publish history.`);
      await reload();
    } catch (e: any) { setErr(e?.message ?? "Reconcile failed"); }
    finally { setReconciling(false); }
  };

  const tenantMode = data?.tenantControlMode ?? "connect";
  const extControls = data?.extensionControls ?? [];

  return (
    <div style={{ maxWidth: 760 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600 }}>Control Mode</h2>
      <p style={{ margin: "0 0 18px", fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
        Decide <strong>who controls hold music</strong> for this tenant. In <strong>Connect-managed</strong> mode Connect publishes and enforces MOH per your policies/schedules.
        In <strong>PBX / native control</strong> mode Connect stops interfering — it removes its overrides and hands the tenant back to VitalPBX&apos;s own MOH.
        You can still pin individual extensions to Connect or PBX regardless of the tenant default.
      </p>

      {err && <div style={{ color: "#fca5a5", fontSize: 13, marginBottom: 10 }}>{err}</div>}
      {msg && <div style={{ color: "#86efac", fontSize: 13, marginBottom: 10 }}>{msg}</div>}
      {loading && <div style={{ fontSize: 13, color: "#64748b" }}>Loading…</div>}

      {/* Tenant control toggle */}
      <div style={{ ...cardStyle, flexDirection: "column", alignItems: "stretch", gap: 12, marginBottom: 22, padding: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Tenant default</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {(["connect", "pbx"] as TenantControlMode[]).map((m) => {
            const active = tenantMode === m;
            return (
              <button
                key={m}
                onClick={() => canManage && setTenantMode(m)}
                disabled={!canManage || busy}
                style={{
                  flex: 1, minWidth: 220, textAlign: "left", cursor: canManage ? "pointer" : "default",
                  background: active ? (m === "connect" ? "rgba(99,102,241,0.15)" : "rgba(245,158,11,0.12)") : "rgba(15,23,42,0.6)",
                  border: `1px solid ${active ? (m === "connect" ? "#6366f1" : "#f59e0b") : "rgba(255,255,255,0.1)"}`,
                  borderRadius: 10, padding: "12px 14px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: m === "connect" ? "#6366f1" : "#f59e0b" }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{TENANT_MODE_LABELS[m]}</span>
                  {active && <span style={{ fontSize: 10, color: "#86efac", marginLeft: "auto" }}>ACTIVE</span>}
                </div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6, lineHeight: 1.4 }}>
                  {m === "connect"
                    ? "Connect publishes & enforces MOH per your policies and schedules."
                    : "Connect removes its overrides; VitalPBX plays its own MOH."}
                </div>
              </button>
            );
          })}
        </div>
        <div>
          <button onClick={reconcile} disabled={reconciling || !canManage} style={btnSmall("#334155")} title="Recompute desired keys, republish, remove stale AstDB keys, and verify the live class on the PBX.">
            {reconciling ? "Reconciling…" : "↻ Reconcile & verify now"}
          </button>
        </div>
      </div>

      {/* Extension overrides */}
      <SectionLabel>Extension control overrides</SectionLabel>
      <p style={{ margin: "0 0 12px", fontSize: 11, color: "#64748b" }}>
        Pin a specific extension to Connect or PBX control regardless of the tenant default. Choosing <strong>Inherit tenant</strong> removes the override.
      </p>

      {canManage && (
        <div style={{ ...cardStyle, gap: 10, marginBottom: 16 }}>
          <div><label style={labelStyle}>Extension</label><input style={{ ...inputStyle, width: 130, marginBottom: 0 }} value={extInput} onChange={(e) => setExtInput(e.target.value)} placeholder="e.g. 101" /></div>
          <div><label style={labelStyle}>Control</label>
            <ConnectSelect value={extMode} onChange={(v) => setExtMode(v as ExtensionControlMode)} style={{ width: 200 }}
              options={(Object.entries(EXT_MODE_LABELS) as [ExtensionControlMode, string][]).map(([v, l]) => ({ value: v, label: l }))} />
          </div>
          <button onClick={saveExtControl} disabled={busy} style={{ ...btnStyle("#6366f1"), alignSelf: "flex-end" }}>{busy ? "Saving…" : "Save"}</button>
        </div>
      )}

      {extControls.length === 0 && <div style={emptyBox}>No extension overrides. Every extension follows the tenant default ({TENANT_MODE_LABELS[tenantMode]}).</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {extControls.map((c) => (
          <div key={c.id} style={{ ...cardStyle, fontSize: 13 }}>
            <code style={{ color: "#e2e8f0" }}>{c.extension}</code>
            <span style={{
              marginLeft: 10, fontSize: 11, borderRadius: 4, padding: "2px 8px",
              background: c.controlMode === "connect" ? "rgba(99,102,241,0.15)" : "rgba(245,158,11,0.12)",
              color: c.controlMode === "connect" ? "#a5b4fc" : "#fbbf24",
            }}>{EXT_MODE_LABELS[c.controlMode]}</span>
            <div style={{ flex: 1 }} />
            {canManage && <button onClick={() => clearExtControl(c.extension)} style={btnSmall("#334155")}>Reset to inherit</button>}
          </div>
        ))}
      </div>

      {!isSuperAdmin && (
        <p style={{ marginTop: 18, fontSize: 11, color: "#475569" }}>
          Multi-tenant (holiday / Yom Tov) schedules that override every tenant are managed by a platform SUPER_ADMIN under <strong>Admin Schedules</strong>.
        </p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Admin Schedules (multi-tenant global overlay) — Requirement 3 (SUPER_ADMIN)
// ═══════════════════════════════════════════════════════════════════════════════

const WEEKDAY_OPTS = DAY_NAMES.map((d, i) => ({ value: String(i), label: d }));

function emptyAdminForm(): {
  name: string; scheduleKind: "one_time" | "recurring"; timezone: string;
  vitalPbxMohClassName: string; priority: number;
  startAt: string; endAt: string;
  startWeekday: number; startTime: string; endWeekday: number; endTime: string;
  fallbackMode: "restore_previous" | "explicit"; fallbackClass: string;
  targets: AdminScheduleTargetRow[];
} {
  return {
    name: "", scheduleKind: "one_time", timezone: "America/New_York",
    vitalPbxMohClassName: "", priority: 0,
    startAt: "", endAt: "",
    startWeekday: 1, startTime: "09:00", endWeekday: 1, endTime: "17:00",
    fallbackMode: "restore_previous", fallbackClass: "",
    targets: [],
  };
}

function AdminSchedulesTab({ canManage }: { canManage: boolean }) {
  const [schedules, setSchedules] = useState<AdminSchedule[]>([]);
  const [activations, setActivations] = useState<AdminActivation[]>([]);
  const [tenants, setTenants] = useState<AdminTenantLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyAdminForm());
  const [saving, setSaving] = useState(false);

  // Target picker.
  const [targetTenant, setTargetTenant] = useState("");
  const [targetExt, setTargetExt] = useState("");

  const reload = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [sc, tn] = await Promise.allSettled([
        apiGet<{ schedules: AdminSchedule[]; activeActivations: AdminActivation[] }>(`/voice/moh/admin-schedules`),
        apiGet<AdminTenantLite[]>(`/admin/tenants?light=true`),
      ]);
      if (sc.status === "fulfilled") { setSchedules(sc.value.schedules ?? []); setActivations(sc.value.activeActivations ?? []); }
      else setErr(sc.reason?.message ?? "Failed to load admin schedules");
      if (tn.status === "fulfilled") setTenants(Array.isArray(tn.value) ? tn.value : []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const tenantName = useCallback((tid: string) => tenants.find((t) => t.id === tid)?.name ?? tid, [tenants]);

  const openCreate = () => { setEditId(null); setForm(emptyAdminForm()); setTargetTenant(""); setTargetExt(""); setErr(null); setShowForm(true); };
  const openEdit = (s: AdminSchedule) => {
    setEditId(s.id);
    setForm({
      name: s.name, scheduleKind: s.scheduleKind, timezone: s.timezone,
      vitalPbxMohClassName: s.vitalPbxMohClassName, priority: s.priority,
      startAt: s.startAt ? s.startAt.slice(0, 16) : "", endAt: s.endAt ? s.endAt.slice(0, 16) : "",
      startWeekday: s.startWeekday ?? 1, startTime: s.startTime ?? "09:00", endWeekday: s.endWeekday ?? 1, endTime: s.endTime ?? "17:00",
      fallbackMode: s.fallbackMode, fallbackClass: s.fallbackClass ?? "",
      targets: (s.targets ?? []).map((t) => ({ tenantId: t.tenantId, extension: t.extension || "" })),
    });
    setTargetTenant(""); setTargetExt(""); setErr(null); setShowForm(true);
  };

  const addTarget = () => {
    if (!targetTenant) { setErr("Pick a tenant to target."); return; }
    const ext = targetExt.trim();
    if (form.targets.some((t) => t.tenantId === targetTenant && (t.extension || "") === ext)) { setErr("That target is already added."); return; }
    setErr(null);
    setForm((f) => ({ ...f, targets: [...f.targets, { tenantId: targetTenant, extension: ext }] }));
    setTargetExt("");
  };
  const removeTarget = (i: number) => setForm((f) => ({ ...f, targets: f.targets.filter((_, idx) => idx !== i) }));

  const save = async () => {
    if (!form.name.trim()) { setErr("Name is required."); return; }
    if (!form.vitalPbxMohClassName.trim()) { setErr("MOH class is required."); return; }
    if (form.targets.length === 0) { setErr("Add at least one tenant target."); return; }
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      scheduleKind: form.scheduleKind,
      timezone: form.timezone,
      vitalPbxMohClassName: form.vitalPbxMohClassName.trim(),
      priority: form.priority,
      fallbackMode: form.fallbackMode,
      fallbackClass: form.fallbackMode === "explicit" ? (form.fallbackClass.trim() || null) : null,
      targets: form.targets.map((t) => ({ tenantId: t.tenantId, extension: t.extension || undefined })),
    };
    if (form.scheduleKind === "one_time") {
      if (!form.startAt || !form.endAt) { setErr("One-time schedules need a start and end date/time."); return; }
      payload.startAt = new Date(form.startAt).toISOString();
      payload.endAt = new Date(form.endAt).toISOString();
    } else {
      payload.startWeekday = form.startWeekday; payload.startTime = form.startTime;
      payload.endWeekday = form.endWeekday; payload.endTime = form.endTime;
    }
    setSaving(true); setErr(null); setMsg(null);
    try {
      if (editId) await apiPatch(`/voice/moh/admin-schedules/${editId}`, payload);
      else await apiPost(`/voice/moh/admin-schedules`, payload);
      setMsg(editId ? "Admin schedule updated." : "Admin schedule created.");
      setShowForm(false);
      await reload();
    } catch (e: any) { setErr(e?.message ?? "Save failed"); }
    finally { setSaving(false); }
  };

  const remove = async (s: AdminSchedule) => {
    if (!confirm(`Delete admin schedule "${s.name}"? Any tenants it is actively overriding will be restored to their exact prior state on the next worker tick.`)) return;
    setErr(null); setMsg(null);
    try { await apiDelete(`/voice/moh/admin-schedules/${s.id}`); setMsg("Admin schedule deleted. Restore in progress."); await reload(); }
    catch (e: any) { setErr(e?.message ?? "Delete failed"); }
  };

  const toggleEnabled = async (s: AdminSchedule) => {
    setErr(null); setMsg(null);
    try { await apiPatch(`/voice/moh/admin-schedules/${s.id}`, { enabled: !s.enabled }); await reload(); }
    catch (e: any) { setErr(e?.message ?? "Toggle failed"); }
  };

  const activeByScheduleId = new Set(activations.map((a) => a.scheduleId));

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Admin Multi-Tenant Schedules</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "#64748b", lineHeight: 1.5, maxWidth: 640 }}>
            Global holiday / Yom Tov music that takes over MOH for the selected tenants (and optionally specific extensions) during a window.
            While active, an admin schedule <strong>overrides even pinned extension MOH</strong>. When it ends, every affected tenant/extension is restored to its exact prior state.
          </p>
        </div>
        {canManage && <button onClick={openCreate} style={btnStyle("#6366f1")}>+ New Schedule</button>}
      </div>

      {err && <div style={{ color: "#fca5a5", fontSize: 13, marginBottom: 10 }}>{err}</div>}
      {msg && <div style={{ color: "#86efac", fontSize: 13, marginBottom: 10 }}>{msg}</div>}
      {loading && <div style={{ fontSize: 13, color: "#64748b" }}>Loading…</div>}

      {schedules.length === 0 && !loading && <div style={emptyBox}>No admin schedules yet. Create one for holidays or seasonal music across multiple tenants.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {schedules.map((s) => {
          const isActive = activeByScheduleId.has(s.id);
          return (
            <div key={s.id} style={{ ...cardStyle, flexDirection: "column", alignItems: "stretch", gap: 8, borderColor: isActive ? "#22c55e" : "rgba(255,255,255,0.08)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: isActive ? "#22c55e" : (s.enabled ? "#6366f1" : "#475569"), flexShrink: 0 }} />
                <span style={{ fontSize: 14, fontWeight: 700 }}>{s.name}</span>
                {isActive && <span style={{ fontSize: 10, background: "rgba(34,197,94,0.18)", color: "#86efac", borderRadius: 4, padding: "1px 7px" }}>ACTIVE NOW</span>}
                {!s.enabled && <span style={{ fontSize: 10, background: "rgba(100,116,139,0.2)", color: "#94a3b8", borderRadius: 4, padding: "1px 7px" }}>disabled</span>}
                <code style={{ fontSize: 11, background: "rgba(0,0,0,0.3)", padding: "2px 7px", borderRadius: 4, color: "#94a3b8" }}>{s.vitalPbxMohClassName}</code>
                <span style={{ fontSize: 11, color: "#64748b" }}>priority {s.priority}</span>
                <div style={{ flex: 1 }} />
                {canManage && <button onClick={() => toggleEnabled(s)} style={btnSmall("#334155")}>{s.enabled ? "Disable" : "Enable"}</button>}
                {canManage && <button onClick={() => openEdit(s)} style={btnSmall("#334155")}>Edit</button>}
                {canManage && <button onClick={() => remove(s)} style={btnSmall("#7f1d1d")}>Delete</button>}
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8" }}>
                {s.scheduleKind === "one_time"
                  ? <>One-time: {s.startAt ? new Date(s.startAt).toLocaleString() : "?"} → {s.endAt ? new Date(s.endAt).toLocaleString() : "?"} ({s.timezone})</>
                  : <>Weekly: {DAY_NAMES[s.startWeekday ?? 0]} {s.startTime} → {DAY_NAMES[s.endWeekday ?? 0]} {s.endTime} ({s.timezone})</>}
                <span style={{ marginLeft: 10 }}>· Restore: {s.fallbackMode === "restore_previous" ? "exact prior state" : `explicit → ${s.fallbackClass ?? "?"}`}</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(s.targets ?? []).map((t, i) => (
                  <span key={i} style={{ fontSize: 11, background: "rgba(15,23,42,0.8)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 5, padding: "2px 8px", color: "#cbd5e1" }}>
                    {tenantName(t.tenantId)}{t.extension ? ` · ext ${t.extension}` : ""}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {showForm && (
        <div style={modalOverlay}>
          <div style={modalBox}>
            <h3 style={{ margin: "0 0 18px", fontSize: 15, fontWeight: 700 }}>{editId ? "Edit" : "New"} Admin Schedule</h3>
            {err && <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 10 }}>{err}</div>}

            <label style={labelStyle}>Name</label>
            <input style={inputStyle} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Yom Tov Music" />

            <label style={labelStyle}>MOH Class <span style={{ color: "#64748b", fontWeight: 400 }}>(runtime class, e.g. mohN or connect_*)</span></label>
            <input style={inputStyle} value={form.vitalPbxMohClassName} onChange={(e) => setForm((f) => ({ ...f, vitalPbxMohClassName: e.target.value }))} placeholder="mohN or connect_slug_name" />

            <label style={labelStyle}>Schedule kind</label>
            <ConnectSelect value={form.scheduleKind} onChange={(v) => setForm((f) => ({ ...f, scheduleKind: v as "one_time" | "recurring" }))}
              style={{ width: "100%", marginBottom: 14 }}
              options={[{ value: "one_time", label: "One-time window (date/time)" }, { value: "recurring", label: "Recurring weekly window" }]} />

            <label style={labelStyle}>Timezone</label>
            <ConnectSelect value={form.timezone} onChange={(v) => setForm((f) => ({ ...f, timezone: v }))} searchable
              style={{ width: "100%", marginBottom: 14 }} options={ALL_TIMEZONES.map((z) => ({ value: z, label: z }))} />

            {form.scheduleKind === "one_time" ? (
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ flex: 1 }}><label style={labelStyle}>Start</label><input type="datetime-local" style={inputStyle} value={form.startAt} onChange={(e) => setForm((f) => ({ ...f, startAt: e.target.value }))} /></div>
                <div style={{ flex: 1 }}><label style={labelStyle}>End</label><input type="datetime-local" style={inputStyle} value={form.endAt} onChange={(e) => setForm((f) => ({ ...f, endAt: e.target.value }))} /></div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ flex: 1 }}><label style={labelStyle}>Start day</label><ConnectSelect value={String(form.startWeekday)} onChange={(v) => setForm((f) => ({ ...f, startWeekday: parseInt(v) }))} style={{ width: "100%", marginBottom: 8 }} options={WEEKDAY_OPTS} /><input type="time" style={{ ...timeInput, width: "100%" }} value={form.startTime} onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))} /></div>
                <div style={{ flex: 1 }}><label style={labelStyle}>End day</label><ConnectSelect value={String(form.endWeekday)} onChange={(v) => setForm((f) => ({ ...f, endWeekday: parseInt(v) }))} style={{ width: "100%", marginBottom: 8 }} options={WEEKDAY_OPTS} /><input type="time" style={{ ...timeInput, width: "100%" }} value={form.endTime} onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))} /></div>
              </div>
            )}

            <label style={labelStyle}>Priority <span style={{ color: "#64748b", fontWeight: 400 }}>(higher wins when two admin schedules overlap)</span></label>
            <input type="number" style={inputStyle} value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: parseInt(e.target.value) || 0 }))} />

            <label style={labelStyle}>When it ends, restore</label>
            <ConnectSelect value={form.fallbackMode} onChange={(v) => setForm((f) => ({ ...f, fallbackMode: v as "restore_previous" | "explicit" }))}
              style={{ width: "100%", marginBottom: form.fallbackMode === "explicit" ? 8 : 14 }}
              options={[{ value: "restore_previous", label: "Exact prior state (recommended)" }, { value: "explicit", label: "A specific fallback class" }]} />
            {form.fallbackMode === "explicit" && (
              <input style={inputStyle} value={form.fallbackClass} onChange={(e) => setForm((f) => ({ ...f, fallbackClass: e.target.value }))} placeholder="fallback mohN / connect_* class" />
            )}

            <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0 14px" }} />
            <SectionLabel>Targets</SectionLabel>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Tenant</label>
                <ConnectSelect value={targetTenant} onChange={setTargetTenant} searchable style={{ width: "100%" }}
                  options={[{ value: "", label: "— Select tenant —" }, ...tenants.map((t) => ({ value: t.id, label: t.pbxTenantName ? `${t.name} (${t.pbxTenantName})` : t.name }))]} />
              </div>
              <div><label style={labelStyle}>Ext (optional)</label><input style={{ ...inputStyle, width: 110, marginBottom: 0 }} value={targetExt} onChange={(e) => setTargetExt(e.target.value)} placeholder="all" /></div>
              <button onClick={addTarget} style={btnSmall("#334155")}>Add</button>
            </div>
            {form.targets.length === 0 && <div style={{ ...emptyBox, marginBottom: 14 }}>No targets yet — add at least one tenant.</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {form.targets.map((t, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, background: "rgba(15,23,42,0.8)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "6px 10px" }}>
                  <span style={{ color: "#cbd5e1" }}>{tenantName(t.tenantId)}{t.extension ? ` · ext ${t.extension}` : " · all extensions"}</span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => removeTarget(i)} style={btnSmall("#7f1d1d")}>Remove</button>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowForm(false)} style={btnSmall("#334155")}>Cancel</button>
              <button onClick={save} disabled={saving} style={btnStyle("#6366f1")}>{saving ? "Saving…" : "Save Schedule"}</button>
            </div>
          </div>
        </div>
      )}
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
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyFor, setVerifyFor] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<MohStatusPayload | null>(null);

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

  const verifyMoh = useCallback(async (mohClassName: string) => {
    setVerifyBusy(true);
    setError(null);
    setVerifyFor(mohClassName);
    try {
      const qs = `?tenantId=${encodeURIComponent(tenantId)}&mohClassName=${encodeURIComponent(mohClassName)}`;
      const r = await apiGet<MohStatusPayload>(`/voice/moh/status${qs}`);
      setVerifyResult(r);
    } catch (e: any) {
      setVerifyResult(null);
      setError(e?.message ?? "Verify failed");
    } finally {
      setVerifyBusy(false);
    }
  }, [tenantId]);

  return (
    <div>
      {canUpload && (
        <div style={{ ...cardStyle, flexDirection: "column", alignItems: "stretch", gap: 12, padding: 20, marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Upload music on hold</div>
          <p style={{ fontSize: 12, color: "#94a3b8", margin: 0 }}>
            Audio up to 50 MB. The API transcodes to 8 kHz mono 16-bit WAV for Asterisk; the PBX <code style={{ color: "#cbd5e1" }}>connect-media-sync</code> job pulls only that WAV.
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

      {verifyResult && verifyFor && (
        <div style={{ ...cardStyle, flexDirection: "column", alignItems: "stretch", gap: 10, marginBottom: 16, fontSize: 12, color: "#cbd5e1" }}>
          <div style={{ fontWeight: 700, color: "#e2e8f0" }}>Verify: <code style={{ color: "#93c5fd" }}>{verifyFor}</code></div>
          <div>Asset uploaded: {verifyResult.db.assetExists ? "yes" : "no"} · Conversion: {verifyResult.db.conversionStatus ?? "—"} · PBX artifact on Connect disk: {verifyResult.storage.pbxArtifactExists ? "yes" : "no"} · Manifest row: {verifyResult.sync.manifestAvailable ? "yes" : "no"}</div>
          <div>Last publish (proxy): {verifyResult.sync.lastSyncStatus ?? "—"} {verifyResult.sync.lastSyncAt ?? ""}</div>
          {verifyResult.warnings.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, color: "#fbbf24" }}>
              {verifyResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          <button type="button" onClick={() => { setVerifyResult(null); setVerifyFor(null); }} style={btnSmall("#334155")}>Close</button>
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
              <th style={{ textAlign: "left", padding: "10px 14px", color: "#cbd5e1" }}>PBX</th>
              <th style={{ textAlign: "right", padding: "10px 14px", color: "#cbd5e1" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ padding: 18, textAlign: "center", color: "#94a3b8" }}>Loading…</td></tr>}
            {!loading && assets.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 18, textAlign: "center", color: "#94a3b8" }}>
                No MOH assets uploaded yet.
              </td></tr>
            )}
            {assets.map((a) => (
              <tr key={a.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <td style={{ padding: "10px 14px" }}>{a.name}</td>
                <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 12 }}>{a.mohClassName}</td>
                <td style={{ padding: "10px 14px" }}>{(a.sizeBytes / 1024 / 1024).toFixed(2)} MB</td>
                <td style={{ padding: "10px 14px", color: a.status === "ready" ? "#22c55e" : "#f59e0b" }}>{a.status}{a.conversionStatus && a.conversionStatus !== "ready" ? ` · ${a.conversionStatus}` : ""}</td>
                <td style={{ padding: "10px 14px", fontSize: 11, color: a.conversionStatus === "ready" ? "#86efac" : "#94a3b8" }}>
                  {a.conversionStatus === "ready" ? "WAV ready" : (a.conversionError || a.conversionStatus || "—")}
                </td>
                <td style={{ padding: "10px 14px", textAlign: "right" }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                    <button type="button" onClick={() => verifyMoh(a.mohClassName)} disabled={verifyBusy} style={btnSmall("#334155")}>
                      {verifyBusy && verifyFor === a.mohClassName ? "…" : "Verify"}
                    </button>
                    {canUpload && <button onClick={() => remove(a.id)} style={btnSmall("#ef444480")}>Archive</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

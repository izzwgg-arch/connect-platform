"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPost, apiPatch, apiDelete } from "../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

type RouteType = "business_hours" | "after_hours" | "holiday" | "manual_override" | "emergency";

interface RouteProfile {
  id: string;
  tenantId: string;
  name: string;
  type: RouteType;
  pbxDestination: string;
  pbxPromptRef: string | null;
  pbxInvalidPromptRef: string | null;
  pbxTimeoutPromptRef: string | null;
  timeoutSeconds: number;
  maxRetries: number;
  isActive: boolean;
  createdAt: string;
}

// Per-digit option routing row. `optionDigit` uses "0".."9" | "star" | "hash"
// because AstDB keys can't safely contain `*` and `#` — see dialplan docs.
interface IvrOptionRoute {
  id: string;
  profileId: string;
  optionDigit: string;
  destinationType: DestinationType;
  destinationRef: string;
  label: string | null;
  enabled: boolean;
}

type DestinationType =
  | "extension" | "queue" | "ring_group" | "voicemail" | "ivr"
  | "announcement" | "external_number" | "terminate" | "custom";

const DESTINATION_TYPES: DestinationType[] = [
  "extension", "queue", "ring_group", "voicemail", "ivr",
  "announcement", "external_number", "terminate", "custom",
];

const DESTINATION_TYPE_LABELS: Record<DestinationType, string> = {
  extension:        "Extension",
  queue:            "Queue",
  ring_group:       "Ring Group",
  voicemail:        "Voicemail",
  ivr:              "Nested IVR",
  announcement:     "Announcement",
  external_number:  "External Number",
  terminate:        "Hangup / Terminate",
  custom:           "Custom Destination",
};

// Display order for the 12 digit slots shown in the Option Routing table.
const OPTION_DIGIT_ORDER = ["1","2","3","4","5","6","7","8","9","0","star","hash"] as const;
const OPTION_DIGIT_LABEL: Record<string, string> = {
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
  star: "*", hash: "#",
};

interface PreviewActiveProfile {
  id: string;
  name: string;
  type: RouteType;
  pbxDestination: string;
  prompts: { greeting: string | null; invalid: string | null; timeout: string | null };
  timing: { timeoutSeconds: number; maxRetries: number };
  options: Array<{
    digit: string;
    destinationType: DestinationType;
    destinationRef: string;
    label: string | null;
    enabled: boolean;
  }>;
}

interface PreviewResponse {
  mode: string;
  at?: string;
  activeProfile?: PreviewActiveProfile | null;
  reason?: string;
  override?: { isActive: boolean; expiresAt: string | null; reason: string | null } | null;
}

interface BizHoursRule {
  day: number; // 0=Sun…6=Sat
  open: string;
  close: string;
}

interface ScheduleConfig {
  id: string;
  tenantId: string;
  timezone: string;
  businessHoursRules: BizHoursRule[];
  holidayDates: string[];
  defaultProfileId: string | null;
  afterHoursProfileId: string | null;
  holidayProfileId: string | null;
  isActive: boolean;
}

interface OverrideState {
  id: string;
  tenantId: string;
  isActive: boolean;
  profileId: string | null;
  reason: string | null;
  expiresAt: string | null;
  activatedAt: string | null;
}

interface PublishRecord {
  id: string;
  tenantId: string;
  publishedBy: string;
  publishedAt: string;
  mode: string;
  status: string;
  error: string | null;
  isRollback: boolean;
}

// ── Prompt catalog (DB-backed, zero PBX load on page render) ─────────────────
//
// The catalog lives in Connect's `TenantPbxPrompt` table and is populated by:
//   - super-admin manual paste from the "Sync Prompt Library" modal
//   - an optional PBX-host cron POSTing to /voice/ivr/prompts/sync
// The UI NEVER hits the PBX directly — it only reads the catalog via the
// Connect API. This means tens of admins hitting the IVR page simultaneously
// adds zero load to VitalPBX.

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

function usePromptCatalog(tenantId: string | undefined): {
  prompts: PromptCatalogRow[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [prompts, setPrompts] = useState<PromptCatalogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    // Skip the initial placeholder tenantId (set by AppProvider before the
    // real tenant list loads) — it maps to nothing in the DB and would waste
    // a round-trip returning "[]".
    if (!tenantId || tenantId === "local") { setPrompts([]); return; }
    setLoading(true); setError(null);
    try {
      const qs = `?tenantId=${encodeURIComponent(tenantId)}`;
      const r = await apiGet<{ prompts: PromptCatalogRow[] }>(`/voice/ivr/prompts${qs}`);
      setPrompts(r.prompts ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load prompt catalog");
      setPrompts([]);
    } finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => { reload(); }, [reload]);
  return { prompts, loading, error, reload };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ROUTE_TYPE_LABELS: Record<RouteType, string> = {
  business_hours:  "Business Hours",
  after_hours:     "After Hours",
  holiday:         "Holiday",
  manual_override: "Manual Override",
  emergency:       "Emergency",
};

const ROUTE_TYPE_COLORS: Record<RouteType, string> = {
  business_hours:  "#22c55e",
  after_hours:     "#f59e0b",
  holiday:         "#6366f1",
  manual_override: "#ef4444",
  emergency:       "#dc2626",
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const ALL_TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Phoenix", "America/Anchorage", "Pacific/Honolulu",
  "Europe/London", "Europe/Paris", "Europe/Berlin",
  "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata",
  "Australia/Sydney", "UTC",
];

const MODE_LABELS: Record<string, string> = {
  business:   "Business Hours",
  afterhours: "After Hours",
  holiday:    "Holiday",
  override:   "Manual Override",
};

// ── Tab component ─────────────────────────────────────────────────────────────

const TABS = ["Route Profiles", "Schedule", "Override", "Publish"] as const;
type Tab = typeof TABS[number];

// ── Main page ─────────────────────────────────────────────────────────────────

export default function IvrRoutingPage() {
  const { tenantId, tenant, can } = useAppContext();
  const [activeTab, setActiveTab] = useState<Tab>("Route Profiles");
  const [error, setError] = useState<string | null>(null);

  // shared state loaded by most tabs
  const [profiles,   setProfiles]   = useState<RouteProfile[]>([]);
  const [schedule,   setSchedule]   = useState<ScheduleConfig | null>(null);
  const [override,   setOverride]   = useState<OverrideState | null>(null);
  const [history,    setHistory]    = useState<PublishRecord[]>([]);
  const [preview,    setPreview]    = useState<PreviewResponse | null>(null);
  const [loading,    setLoading]    = useState(false);

  const canManage        = can("can_manage_ivr_routing");
  // Prompts permission lets a limited-role user change greetings without
  // having full routing edit rights. The server enforces the same split.
  const canManagePrompts = can("can_manage_ivr_prompts") || canManage;

  const reload = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = `?tenantId=${encodeURIComponent(tenantId)}`;
      const [p, s, o, h, pv] = await Promise.allSettled([
        apiGet<{ profiles: RouteProfile[] }>(`/voice/ivr/route-profiles${qs}`),
        apiGet<{ schedule: ScheduleConfig | null }>(`/voice/ivr/schedule${qs}`),
        apiGet<{ override: OverrideState | null }>(`/voice/ivr/override${qs}`),
        apiGet<{ records: PublishRecord[] }>(`/voice/ivr/publish-history${qs}&limit=20`),
        apiGet<PreviewResponse>(`/voice/ivr/preview${qs}`),
      ]);
      if (p.status === "fulfilled") setProfiles(p.value.profiles);
      if (s.status === "fulfilled") setSchedule(s.value.schedule);
      if (o.status === "fulfilled") setOverride(o.value.override);
      if (h.status === "fulfilled") setHistory(h.value.records);
      if (pv.status === "fulfilled") setPreview(pv.value);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load IVR data");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div style={{ padding: "24px 32px", minHeight: "100vh", color: "var(--text-primary, #f1f5f9)" }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: -0.5 }}>IVR Routing</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted, #94a3b8)" }}>
          Manage call routing profiles, schedules, and overrides — publish live to VitalPBX.
        </p>
        {preview && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8, marginTop: 10,
            background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.3)",
            borderRadius: 8, padding: "6px 14px", fontSize: 13,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#6366f1", display: "inline-block" }} />
            Active now: <strong>{MODE_LABELS[preview.mode] ?? preview.mode}</strong>
          </div>
        )}
      </div>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444", borderRadius: 8, padding: "10px 16px", marginBottom: 20, fontSize: 13, color: "#fca5a5" }}>
          {error}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid rgba(255,255,255,0.08)", marginBottom: 28 }}>
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: "10px 18px", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
              borderRadius: "6px 6px 0 0", transition: "all 0.15s",
              background: activeTab === tab ? "rgba(99,102,241,0.15)" : "transparent",
              color: activeTab === tab ? "#a5b4fc" : "var(--text-muted, #94a3b8)",
              borderBottom: activeTab === tab ? "2px solid #6366f1" : "2px solid transparent",
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {loading && <div style={{ fontSize: 13, color: "#64748b" }}>Loading…</div>}

      {!loading && activeTab === "Route Profiles" && (
        <RouteProfilesTab
          profiles={profiles}
          tenantId={tenantId}
          tenantLabel={tenant?.name || tenantId || "(no tenant)"}
          tenantSlug={tenantId || ""}
          canManage={canManage}
          canManagePrompts={canManagePrompts}
          onRefresh={reload}
        />
      )}
      {!loading && activeTab === "Schedule" && (
        <ScheduleTab
          schedule={schedule}
          profiles={profiles}
          tenantId={tenantId}
          canManage={canManage}
          onRefresh={reload}
        />
      )}
      {!loading && activeTab === "Override" && (
        <OverrideTab
          override={override}
          profiles={profiles}
          tenantId={tenantId}
          canManage={canManage}
          onRefresh={reload}
        />
      )}
      {!loading && activeTab === "Publish" && (
        <PublishTab
          history={history}
          preview={preview}
          tenantId={tenantId}
          canManage={canManage}
          onRefresh={reload}
        />
      )}

      {/* Preview footer — always visible; shows what an inbound call would do
          RIGHT NOW after the last publish. Refreshed by reload(). */}
      {!loading && preview?.activeProfile && (
        <ActiveCallPreview preview={preview} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Route Profiles
// ═══════════════════════════════════════════════════════════════════════════════

function RouteProfilesTab({ profiles, tenantId, tenantLabel, tenantSlug, canManage, canManagePrompts, onRefresh }: {
  profiles: RouteProfile[];
  tenantId: string;
  tenantLabel: string;
  tenantSlug: string;
  canManage: boolean;
  canManagePrompts: boolean;
  onRefresh: () => void;
}) {
  void tenantSlug;
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileFormState>(blankProfileForm());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Which profile card is expanded to show its Prompts + Option Routing.
  // Only one is open at a time — keeps the page scannable with many profiles.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Prompt sync controls (super-admin only).
  //   - "Auto-Sync from VitalPBX" calls POST /voice/ivr/prompts/auto-sync and
  //     pulls the System Recordings straight from the PBX's ombutel MySQL.
  //   - "Paste list…" is a manual fallback when the MySQL link isn't wired.
  const [showSync, setShowSync] = useState(false);
  const [autoSyncing, setAutoSyncing] = useState(false);
  const runAutoSync = useCallback(async () => {
    if (!confirm("Auto-sync all VitalPBX System Recordings into Connect? This reads from the PBX's ombutel MySQL and updates the per-tenant dropdowns.")) return;
    setAutoSyncing(true);
    try {
      const j = await apiPost<{
        ok: boolean;
        result?: {
          table: string;
          tenantColumn: string | null;
          tenantColumnType: "numeric" | "string" | "none";
          ombuTenantsSeen: number;
          rowsRead: number;
          created: number;
          updated: number;
          unassigned: number;
          deactivated: number;
          perTenant: Array<{ tenantId: string | null; tenantSlug: string | null; count: number }>;
          sample: Array<{ ref: string; rawTenant: string | null; resolvedConnectTenantId: string | null; method: string }>;
          errors: string[];
        };
        skipReason?: string;
        hint?: string;
      }>("/voice/ivr/prompts/auto-sync", {});
      if (!j?.ok) {
        const hint = j?.hint ? `\n\nHint: ${j.hint}` : "";
        alert(`Auto-sync failed: ${j?.skipReason ?? "unknown"}${hint}`);
        return;
      }
      const r = j.result!;
      const errLine = r.errors && r.errors.length > 0 ? `\n\nErrors:\n- ${r.errors.join("\n- ")}` : "";
      const perTenantLine = r.perTenant && r.perTenant.length > 0
        ? `\n\nPer tenant:\n${r.perTenant.map((p) => `  • ${p.tenantSlug ?? p.tenantId ?? "(unassigned)"}: ${p.count}`).join("\n")}`
        : "";
      const sampleLine = r.unassigned > 0 && r.sample && r.sample.length > 0
        ? `\n\nSample rows (for debugging):\n${r.sample.map((s) => `  • ${s.ref}  rawTenant=${s.rawTenant ?? "null"}  method=${s.method}`).join("\n")}`
        : "";
      alert(
        `Auto-sync complete.\n\nSource table: ${r.table}\nTenant column: ${r.tenantColumn ?? "(none)"} (${r.tenantColumnType})\nombu_tenants rows: ${r.ombuTenantsSeen}\nRows read: ${r.rowsRead}\nCreated: ${r.created}\nUpdated: ${r.updated}\nUnassigned (no tenant match): ${r.unassigned}${perTenantLine}${sampleLine}${errLine}`,
      );
      await onRefresh?.();
    } catch (e: any) {
      const msg = typeof e?.body === "object"
        ? (e.body?.skipReason ?? e.body?.error ?? e?.message)
        : (e?.message ?? String(e));
      const hint = typeof e?.body === "object" && e.body?.hint ? `\n\nHint: ${e.body.hint}` : "";
      alert(`Auto-sync failed: ${msg}${hint}`);
    } finally {
      setAutoSyncing(false);
    }
  }, [onRefresh]);
  // Catalog scoped to the currently-selected tenant. Shared by the modal form
  // AND every ProfilePromptsSection below, so we only hit the API once.
  const {
    prompts: modalPrompts,
    loading: modalPromptsLoading,
    error: modalPromptsError,
    reload: reloadPrompts,
  } = usePromptCatalog(tenantId);

  const openCreate = () => {
    setEditId(null);
    setForm(blankProfileForm());
    setShowForm(true);
  };

  const openEdit = (p: RouteProfile) => {
    setEditId(p.id);
    setForm(profileToForm(p));
    setShowForm(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.pbxDestination.trim()) { setErr("Name and PBX Destination are required."); return; }
    setSaving(true); setErr(null);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        type: form.type,
        pbxDestination: form.pbxDestination,
        pbxPromptRef:        form.pbxPromptRef        || null,
        pbxInvalidPromptRef: form.pbxInvalidPromptRef || null,
        pbxTimeoutPromptRef: form.pbxTimeoutPromptRef || null,
        timeoutSeconds:      form.timeoutSeconds,
        maxRetries:          form.maxRetries,
      };
      if (editId) {
        await apiPatch(`/voice/ivr/route-profiles/${editId}`, payload);
      } else {
        await apiPost("/voice/ivr/route-profiles", { tenantId, ...payload });
      }
      setShowForm(false);
      onRefresh();
    } catch (e: any) {
      setErr(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (id: string) => {
    if (!confirm("Deactivate this profile?")) return;
    try { await apiDelete(`/voice/ivr/route-profiles/${id}`); onRefresh(); }
    catch (e: any) { alert(e?.message ?? "Failed"); }
  };

  return (
    <div>
      {/* Active-tenant indicator — makes it obvious which tenant the
          prompt dropdowns and profile list are scoped to. Super-admins
          switch tenants via the top-right tenant switcher.
          Also shows the raw tenantId being sent to /voice/ivr/prompts so we
          can tell at a glance when the UI is scoped to a wrong/stale value. */}
      <div style={{
        display: "flex", flexDirection: "column", gap: 4, marginBottom: 14,
        fontSize: 12, color: "#94a3b8",
        background: modalPromptsError
          ? "rgba(248,113,113,0.10)"
          : modalPrompts.length === 0
            ? "rgba(250,204,21,0.08)"
            : "rgba(34,197,94,0.08)",
        border: modalPromptsError
          ? "1px solid rgba(248,113,113,0.35)"
          : modalPrompts.length === 0
            ? "1px solid rgba(250,204,21,0.25)"
            : "1px solid rgba(34,197,94,0.25)",
        borderRadius: 8, padding: "10px 14px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, color: "#c7d2fe" }}>Active tenant:</span>
          <span style={{ color: "#f1f5f9" }}>{tenantLabel || "(no tenant selected)"}</span>
          <span style={{ color: "#64748b" }}>•</span>
          <span style={{ color: "#94a3b8", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
            id=<span style={{ color: "#f1f5f9" }}>{tenantId || "(empty)"}</span>
          </span>
          <span style={{ color: "#64748b" }}>•</span>
          <span>
            {modalPromptsLoading
              ? "loading catalog…"
              : modalPromptsError
                ? <span style={{ color: "#fca5a5" }}>catalog fetch failed — {String(modalPromptsError)}</span>
                : modalPrompts.length === 0
                  ? <span style={{ color: "#fde68a" }}>0 synced recordings for this tenant</span>
                  : <span style={{ color: "#86efac" }}>{modalPrompts.length} synced recording{modalPrompts.length === 1 ? "" : "s"} available</span>}
          </span>
        </div>
        {!modalPromptsLoading && !modalPromptsError && modalPrompts.length === 0 && (
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>
            Click <strong style={{ color: "#c7d2fe" }}>Auto-Sync from VitalPBX</strong> to pull System Recordings for this tenant,
            or pick a different tenant in the top-right switcher.
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={() => reloadPrompts()}
            disabled={modalPromptsLoading || !tenantId || tenantId === "local"}
            style={{
              fontSize: 11, padding: "3px 8px", borderRadius: 4,
              background: "rgba(99,102,241,0.15)", border: "1px solid rgba(99,102,241,0.35)",
              color: "#c7d2fe", cursor: modalPromptsLoading ? "default" : "pointer",
            }}
          >
            {modalPromptsLoading ? "Refreshing…" : "Refresh catalog"}
          </button>
          {modalPrompts.length > 0 && (
            <span style={{ fontSize: 10, color: "#64748b" }}>
              First: {modalPrompts[0]?.displayName} ({modalPrompts[0]?.promptRef})
            </span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Route Profiles</h2>
        <div style={{ display: "flex", gap: 8 }}>
          {canManagePrompts && (
            <>
              <button
                onClick={runAutoSync}
                disabled={autoSyncing}
                style={btnStyle("#0d9488")}
                title="Pull every VitalPBX System Recording into Connect's catalog (read-only MySQL — no filenames to type)"
              >
                {autoSyncing ? "Syncing…" : "Auto-Sync from VitalPBX"}
              </button>
              <button
                onClick={() => setShowSync(true)}
                style={btnSmall("#334155")}
                title="Manual fallback: paste a list of recording names"
              >
                Paste list…
              </button>
            </>
          )}
          {canManage && (
            <button onClick={openCreate} style={btnStyle("#6366f1")}>+ Add Profile</button>
          )}
        </div>
      </div>

      {profiles.length === 0 && (
        <div style={emptyBox}>No route profiles configured. Add at least one for each mode you need.</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {profiles.map((p) => {
          const isExpanded = expandedId === p.id;
          return (
            <div key={p.id} style={{
              background: "rgba(15,23,42,0.6)", border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 10, overflow: "hidden",
            }}>
              {/* Collapsed header row */}
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px" }}>
                <button
                  onClick={() => setExpandedId(isExpanded ? null : p.id)}
                  style={{
                    background: "transparent", border: "none", color: "#64748b", cursor: "pointer",
                    padding: 0, fontSize: 12, width: 16, textAlign: "center",
                  }}
                  aria-label={isExpanded ? "Collapse" : "Expand"}
                >{isExpanded ? "▼" : "▶"}</button>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0, background: ROUTE_TYPE_COLORS[p.type] ?? "#64748b" }} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{ROUTE_TYPE_LABELS[p.type] ?? p.type}</div>
                  </div>
                </div>
                <code style={{ fontSize: 12, background: "rgba(0,0,0,0.3)", padding: "3px 8px", borderRadius: 5, color: "#94a3b8", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.pbxDestination || "—"}
                </code>
                {canManage && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => openEdit(p)} style={btnSmall("#334155")}>Edit</button>
                    <button onClick={() => deactivate(p.id)} style={btnSmall("#7f1d1d")}>Remove</button>
                  </div>
                )}
              </div>

              {/* Expanded detail: Greeting + Option Routing */}
              {isExpanded && (
                <div style={{ padding: "10px 20px 20px 44px", borderTop: "1px solid rgba(255,255,255,0.04)", display: "flex", flexDirection: "column", gap: 18 }}>
                  <ProfilePromptsSection
                    profile={p}
                    canEdit={canManagePrompts}
                    onRefresh={onRefresh}
                  />
                  <ProfileOptionsSection
                    profile={p}
                    canEdit={canManage}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showForm && (
        <div style={modalOverlay}>
          <div style={{ ...modalBox, maxWidth: 640, maxHeight: "85vh", overflowY: "auto" }}>
            <h3 style={{ margin: "0 0 18px", fontSize: 15, fontWeight: 700 }}>{editId ? "Edit" : "Add"} Route Profile</h3>
            {err && <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 10 }}>{err}</div>}

            <label style={labelStyle}>Name</label>
            <input style={inputStyle} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Main Business IVR" />

            <label style={labelStyle}>Type</label>
            <select style={inputStyle} value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as RouteType }))}>
              {(Object.entries(ROUTE_TYPE_LABELS) as [RouteType, string][]).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>

            <label style={labelStyle}>PBX Destination <span style={{ color: "#64748b", fontWeight: 400 }}>(context,exten,priority)</span></label>
            <input style={inputStyle} value={form.pbxDestination} onChange={(e) => setForm((f) => ({ ...f, pbxDestination: e.target.value }))} placeholder="app-ivr,8000,1" />
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 14 }}>
              Used by the legacy single-destination router. Example: <code>app-ivr,8000,1</code> or <code>from-internal,1001,1</code>
            </div>

            <SectionLabel>Greeting &amp; Prompts</SectionLabel>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>
              Pick a VitalPBX System Recording for this tenant (synced via&nbsp;<em>Auto-Sync from VitalPBX</em>).
              Leave blank to use the built-in default. Only consumed by tenants using the Connect-owned IVR context.
            </div>
            <label style={labelStyle}>Greeting recording</label>
            <PromptPicker
              value={form.pbxPromptRef}
              onChange={(v) => setForm((f) => ({ ...f, pbxPromptRef: v }))}
              prompts={modalPrompts}
              catalogLoading={modalPromptsLoading}
              placeholder="custom/acme_normal"
              category="greeting"
            />
            <label style={labelStyle}>Invalid-digit recording (optional)</label>
            <PromptPicker
              value={form.pbxInvalidPromptRef}
              onChange={(v) => setForm((f) => ({ ...f, pbxInvalidPromptRef: v }))}
              prompts={modalPrompts}
              catalogLoading={modalPromptsLoading}
              placeholder="custom/acme_invalid"
              category="invalid"
            />
            <label style={labelStyle}>Timeout recording (optional)</label>
            <PromptPicker
              value={form.pbxTimeoutPromptRef}
              onChange={(v) => setForm((f) => ({ ...f, pbxTimeoutPromptRef: v }))}
              prompts={modalPrompts}
              catalogLoading={modalPromptsLoading}
              placeholder="custom/acme_timeout"
              category="timeout"
            />

            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Digit-wait timeout (sec)</label>
                <input type="number" min={1} max={60} style={inputStyle} value={form.timeoutSeconds} onChange={(e) => setForm((f) => ({ ...f, timeoutSeconds: Math.max(1, Math.min(60, Number(e.target.value) || 7)) }))} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Max retries</label>
                <input type="number" min={1} max={10} style={inputStyle} value={form.maxRetries} onChange={(e) => setForm((f) => ({ ...f, maxRetries: Math.max(1, Math.min(10, Number(e.target.value) || 3)) }))} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
              <button onClick={() => setShowForm(false)} style={btnSmall("#334155")}>Cancel</button>
              <button onClick={save} disabled={saving} style={btnStyle("#6366f1")}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}

      {showSync && (
        <SyncPromptLibraryModal
          onClose={() => setShowSync(false)}
          onDone={() => { reloadPrompts(); }}
        />
      )}
    </div>
  );
}

// ── Profile form helpers ─────────────────────────────────────────────────────

type ProfileFormState = {
  name: string;
  type: RouteType;
  pbxDestination: string;
  pbxPromptRef: string;
  pbxInvalidPromptRef: string;
  pbxTimeoutPromptRef: string;
  timeoutSeconds: number;
  maxRetries: number;
};

function blankProfileForm(): ProfileFormState {
  return {
    name: "", type: "business_hours", pbxDestination: "",
    pbxPromptRef: "", pbxInvalidPromptRef: "", pbxTimeoutPromptRef: "",
    timeoutSeconds: 7, maxRetries: 3,
  };
}

function profileToForm(p: RouteProfile): ProfileFormState {
  return {
    name: p.name, type: p.type, pbxDestination: p.pbxDestination,
    pbxPromptRef:        p.pbxPromptRef        ?? "",
    pbxInvalidPromptRef: p.pbxInvalidPromptRef ?? "",
    pbxTimeoutPromptRef: p.pbxTimeoutPromptRef ?? "",
    timeoutSeconds: p.timeoutSeconds ?? 7,
    maxRetries:     p.maxRetries     ?? 3,
  };
}

// ── Prompt picker (dropdown-first, legacy-safe) ──────────────────────────────
//
// Renders a <select> populated from the tenant's DB-backed prompt catalog. If
// the currently-saved value is NOT in the catalog (legacy row, or not yet
// synced from the PBX), we STILL show it at the top of the list flagged as
// "legacy" so existing profiles never get silently nulled on save. A "Type
// custom" toggle falls back to a free-text input for edge cases where the
// admin needs to point at a prompt that the catalog doesn't know about yet.

function PromptPicker({
  value, onChange, prompts, catalogLoading, placeholder, category,
}: {
  value: string;
  onChange: (next: string) => void;
  prompts: PromptCatalogRow[];
  catalogLoading: boolean;
  placeholder?: string;
  // Category hint to filter the dropdown. "greeting" narrows to greeting + general;
  // "invalid" / "timeout" narrow to that category + general (general = unrestricted).
  category?: "greeting" | "invalid" | "timeout";
}) {
  // Category-aware filter: always include generic rows so admins can point at
  // any recording without re-classifying it first.
  const filtered = prompts.filter((p) => {
    if (!p.isActive) return false;
    if (!category) return true;
    return p.category === category || p.category === "general" || p.category === "unknown";
  });
  const hasCurrent = !!value && filtered.some((p) => p.promptRef === value);
  const showingLegacy = !!value && !hasCurrent;

  // "Manual entry" mode lets the admin type a ref not in the catalog. We
  // auto-enter manual mode when there are zero prompts for this tenant so
  // they're not stuck on an empty dropdown.
  const [manual, setManual] = useState(() => filtered.length === 0 && !!value === false);
  const effectiveManual = manual || (filtered.length === 0 && !value);

  if (effectiveManual) {
    const emptyCatalog = filtered.length === 0 && !catalogLoading;
    return (
      <div>
        <input
          style={inputStyle}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "custom/tenant_main"}
        />
        <div style={{ fontSize: 11, color: emptyCatalog ? "#fbbf24" : "#64748b", marginTop: 4, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {emptyCatalog ? (
            <span>
              No prompt catalog for this tenant yet. Close this dialog and click <strong>Auto-Sync from VitalPBX</strong> to pull every System Recording from the PBX, or type a ref manually.
            </span>
          ) : (
            <span>Manual entry — VitalPBX recording name, no file extension.</span>
          )}
          {filtered.length > 0 && (
            <button
              type="button"
              onClick={() => setManual(false)}
              style={{ background: "transparent", border: "none", color: "#818cf8", cursor: "pointer", fontSize: 11, padding: 0 }}
            >Use dropdown</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <select
        style={inputStyle}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">— (use default / skip)</option>
        {showingLegacy && (
          <option value={value}>{value} — legacy (not in catalog)</option>
        )}
        {filtered.map((p) => (
          <option key={p.id} value={p.promptRef}>
            {p.displayName}{p.displayName !== p.promptRef ? ` (${p.promptRef})` : ""}
          </option>
        ))}
      </select>
      <div style={{ fontSize: 11, color: "#64748b", marginTop: 4, display: "flex", gap: 10, alignItems: "center" }}>
        <span>
          {catalogLoading
            ? "Loading catalog…"
            : filtered.length === 0
              ? "No prompts synced for this tenant."
              : `${filtered.length} recording${filtered.length === 1 ? "" : "s"} available`}
        </span>
        <button
          type="button"
          onClick={() => setManual(true)}
          style={{ background: "transparent", border: "none", color: "#818cf8", cursor: "pointer", fontSize: 11, padding: 0 }}
        >Type custom value</button>
      </div>
    </div>
  );
}

// ── Sync Prompt Library modal (super-admin only) ─────────────────────────────
//
// Lets the admin paste the tenant's VitalPBX recording list and bulk-upsert it
// into the Connect catalog. Accepts:
//   - one ref per line (e.g. "custom/acme_normal" or just "acme_normal")
//   - comma- or space-separated lists
//   - raw filenames with extensions (.wav, .gsm, .g722…) — they're stripped
// Tenant assignment is done server-side by slug prefix matching; the admin
// doesn't have to categorise anything here.
function SyncPromptLibraryModal({ onClose, onDone }: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | { created: number; updated: number; unassigned: number; total: number }>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      // Split on any combo of whitespace/commas. Keep it permissive.
      const refs = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      if (refs.length === 0) { setErr("Paste at least one recording name."); setBusy(false); return; }
      const r = await apiPost<{ ok: boolean; summary: { created: number; updated: number; unassigned: number; total: number } }>(
        "/voice/ivr/prompts/sync",
        { refs, source: "manual" },
      );
      setResult(r.summary);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "Sync failed"); }
    finally { setBusy(false); }
  };

  return (
    <div style={modalOverlay}>
      <div style={{ ...modalBox, maxWidth: 620 }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 700 }}>Sync Prompt Library</h3>
        <p style={{ fontSize: 12, color: "#94a3b8", margin: "0 0 14px" }}>
          Paste VitalPBX System Recording names — one per line or comma-separated.
          File extensions are stripped, and each recording is assigned to the
          tenant whose slug matches its filename prefix (e.g. <code>acme_closed</code> → tenant <code>acme</code>).
          No PBX call is made here; this just updates Connect&apos;s catalog.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"custom/acme_normal\ncustom/acme_closed\ncustom/trimpro_main"}
          style={{ ...inputStyle, minHeight: 180, fontFamily: "monospace", fontSize: 12 }}
        />
        {err && <div style={{ color: "#fca5a5", fontSize: 12, marginTop: 8 }}>{err}</div>}
        {result && (
          <div style={{ fontSize: 12, color: "#a7f3d0", marginTop: 10 }}>
            Synced {result.total} prompt{result.total === 1 ? "" : "s"}: {result.created} new, {result.updated} updated
            {result.unassigned > 0 ? `, ${result.unassigned} unassigned (no tenant slug match)` : ""}.
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button onClick={onClose} style={btnSmall("#334155")}>Close</button>
          <button onClick={submit} disabled={busy} style={btnStyle("#6366f1")}>
            {busy ? "Syncing…" : "Sync"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Greeting & prompts (inline edit) ─────────────────────────────────────────

function ProfilePromptsSection({ profile, canEdit, onRefresh }: {
  profile: RouteProfile;
  canEdit: boolean;
  onRefresh: () => void;
}) {
  const { prompts, loading: catalogLoading } = usePromptCatalog(profile.tenantId);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    pbxPromptRef:        profile.pbxPromptRef        ?? "",
    pbxInvalidPromptRef: profile.pbxInvalidPromptRef ?? "",
    pbxTimeoutPromptRef: profile.pbxTimeoutPromptRef ?? "",
    timeoutSeconds: profile.timeoutSeconds ?? 7,
    maxRetries:     profile.maxRetries     ?? 3,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setForm({
        pbxPromptRef:        profile.pbxPromptRef        ?? "",
        pbxInvalidPromptRef: profile.pbxInvalidPromptRef ?? "",
        pbxTimeoutPromptRef: profile.pbxTimeoutPromptRef ?? "",
        timeoutSeconds: profile.timeoutSeconds ?? 7,
        maxRetries:     profile.maxRetries     ?? 3,
      });
    }
  }, [profile, editing]);

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      await apiPatch(`/voice/ivr/route-profiles/${profile.id}`, {
        pbxPromptRef:        form.pbxPromptRef        || null,
        pbxInvalidPromptRef: form.pbxInvalidPromptRef || null,
        pbxTimeoutPromptRef: form.pbxTimeoutPromptRef || null,
        timeoutSeconds: form.timeoutSeconds,
        maxRetries:     form.maxRetries,
      });
      setEditing(false);
      onRefresh();
    } catch (e: any) { setErr(e?.message ?? "Save failed"); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <SectionLabel>Greeting &amp; Prompts</SectionLabel>
        {canEdit && !editing && (
          <button onClick={() => setEditing(true)} style={btnSmall("#334155")}>Edit prompts</button>
        )}
      </div>
      {err && <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 8 }}>{err}</div>}
      {!editing ? (
        <div style={{ fontSize: 13, color: "#94a3b8", display: "grid", gridTemplateColumns: "140px 1fr", rowGap: 4, columnGap: 10 }}>
          <div>Greeting:</div>          <code style={codePillStyle}>{profile.pbxPromptRef        || "— (use default)"}</code>
          <div>Invalid prompt:</div>    <code style={codePillStyle}>{profile.pbxInvalidPromptRef || "— (skip)"}</code>
          <div>Timeout prompt:</div>    <code style={codePillStyle}>{profile.pbxTimeoutPromptRef || "— (skip)"}</code>
          <div>Digit-wait timeout:</div><code style={codePillStyle}>{profile.timeoutSeconds ?? 7}s</code>
          <div>Max retries:</div>       <code style={codePillStyle}>{profile.maxRetries ?? 3}</code>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 560 }}>
          <div>
            <label style={labelStyle}>Greeting recording</label>
            <PromptPicker
              value={form.pbxPromptRef}
              onChange={(v) => setForm((f) => ({ ...f, pbxPromptRef: v }))}
              prompts={prompts}
              catalogLoading={catalogLoading}
              placeholder="custom/acme_normal"
              category="greeting"
            />
          </div>
          <div>
            <label style={labelStyle}>Invalid-digit recording</label>
            <PromptPicker
              value={form.pbxInvalidPromptRef}
              onChange={(v) => setForm((f) => ({ ...f, pbxInvalidPromptRef: v }))}
              prompts={prompts}
              catalogLoading={catalogLoading}
              placeholder="custom/acme_invalid"
              category="invalid"
            />
          </div>
          <div>
            <label style={labelStyle}>Timeout recording</label>
            <PromptPicker
              value={form.pbxTimeoutPromptRef}
              onChange={(v) => setForm((f) => ({ ...f, pbxTimeoutPromptRef: v }))}
              prompts={prompts}
              catalogLoading={catalogLoading}
              placeholder="custom/acme_timeout"
              category="timeout"
            />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Digit-wait timeout (sec)</label>
              <input type="number" min={1} max={60} style={inputStyle} value={form.timeoutSeconds} onChange={(e) => setForm((f) => ({ ...f, timeoutSeconds: Math.max(1, Math.min(60, Number(e.target.value) || 7)) }))} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Max retries</label>
              <input type="number" min={1} max={10} style={inputStyle} value={form.maxRetries} onChange={(e) => setForm((f) => ({ ...f, maxRetries: Math.max(1, Math.min(10, Number(e.target.value) || 3)) }))} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setEditing(false)} style={btnSmall("#334155")}>Cancel</button>
            <button onClick={save} disabled={saving} style={btnStyle("#6366f1")}>{saving ? "Saving…" : "Save prompts"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Per-digit option routing (inline CRUD) ───────────────────────────────────

function ProfileOptionsSection({ profile, canEdit }: {
  profile: RouteProfile;
  canEdit: boolean;
}) {
  const [options, setOptions] = useState<IvrOptionRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await apiGet<{ options: IvrOptionRoute[] }>(`/voice/ivr/route-profiles/${profile.id}/options`);
      setOptions(r.options);
    } catch (e: any) { setErr(e?.message ?? "Load failed"); }
    finally { setLoading(false); }
  }, [profile.id]);

  useEffect(() => { reload(); }, [reload]);

  const upsert = async (digit: string, existing: IvrOptionRoute | null, patch: Partial<IvrOptionRoute>) => {
    try {
      if (existing) {
        await apiPatch(`/voice/ivr/route-profiles/${profile.id}/options/${existing.id}`, patch);
      } else {
        await apiPost(`/voice/ivr/route-profiles/${profile.id}/options`, {
          optionDigit: digit, enabled: true,
          destinationType: patch.destinationType ?? "extension",
          destinationRef:  patch.destinationRef  ?? "",
          label:           patch.label ?? null,
          ...patch,
        });
      }
      reload();
    } catch (e: any) { setErr(e?.message ?? "Save failed"); }
  };

  const remove = async (opt: IvrOptionRoute) => {
    if (!confirm(`Clear routing for digit "${OPTION_DIGIT_LABEL[opt.optionDigit]}"?`)) return;
    try {
      await apiDelete(`/voice/ivr/route-profiles/${profile.id}/options/${opt.id}`);
      reload();
    } catch (e: any) { setErr(e?.message ?? "Delete failed"); }
  };

  const byDigit = new Map(options.map((o) => [o.optionDigit, o]));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <SectionLabel>Option Routing</SectionLabel>
      </div>
      {err && <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 8 }}>{err}</div>}
      {loading && <div style={{ fontSize: 12, color: "#64748b" }}>Loading options…</div>}
      {!loading && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#64748b", fontSize: 11, textTransform: "uppercase" }}>
              <th style={thStyle}>Digit</th>
              <th style={thStyle}>Label</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Destination (context,exten,priority or +E.164)</th>
              <th style={thStyle}>On</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {OPTION_DIGIT_ORDER.map((digit) => (
              <OptionRow
                key={digit}
                digit={digit}
                existing={byDigit.get(digit) ?? null}
                canEdit={canEdit}
                onSave={(patch) => upsert(digit, byDigit.get(digit) ?? null, patch)}
                onRemove={(opt) => remove(opt)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OptionRow({ digit, existing, canEdit, onSave, onRemove }: {
  digit: string;
  existing: IvrOptionRoute | null;
  canEdit: boolean;
  onSave: (patch: Partial<IvrOptionRoute>) => void;
  onRemove: (opt: IvrOptionRoute) => void;
}) {
  const [draft, setDraft] = useState({
    label: existing?.label ?? "",
    destinationType: (existing?.destinationType ?? "extension") as DestinationType,
    destinationRef:  existing?.destinationRef ?? "",
    enabled: existing?.enabled ?? true,
  });
  const [dirty, setDirty] = useState(false);

  // Re-seed draft when the row's underlying data changes (e.g. after reload
  // from a successful save from another row). Avoids stomping an in-progress
  // edit by gating on `dirty`.
  useEffect(() => {
    if (dirty) return;
    setDraft({
      label: existing?.label ?? "",
      destinationType: (existing?.destinationType ?? "extension") as DestinationType,
      destinationRef:  existing?.destinationRef ?? "",
      enabled: existing?.enabled ?? true,
    });
  }, [existing, dirty]);

  const set = <K extends keyof typeof draft>(k: K, v: typeof draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };

  const save = () => {
    if (!draft.destinationRef.trim()) return;
    onSave({
      label: draft.label || null,
      destinationType: draft.destinationType,
      destinationRef: draft.destinationRef.trim(),
      enabled: draft.enabled,
    });
    setDirty(false);
  };

  return (
    <tr style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
      <td style={{ ...tdStyle, fontWeight: 700, width: 44 }}>{OPTION_DIGIT_LABEL[digit]}</td>
      <td style={tdStyle}>
        <input
          style={{ ...inputStyle, marginBottom: 0, padding: "5px 8px" }}
          value={draft.label}
          placeholder="Sales, Support…"
          disabled={!canEdit}
          onChange={(e) => set("label", e.target.value)}
        />
      </td>
      <td style={tdStyle}>
        <select
          style={{ ...inputStyle, marginBottom: 0, padding: "5px 8px" }}
          value={draft.destinationType}
          disabled={!canEdit}
          onChange={(e) => set("destinationType", e.target.value as DestinationType)}
        >
          {DESTINATION_TYPES.map((t) => (
            <option key={t} value={t}>{DESTINATION_TYPE_LABELS[t]}</option>
          ))}
        </select>
      </td>
      <td style={tdStyle}>
        <input
          style={{ ...inputStyle, marginBottom: 0, padding: "5px 8px", fontFamily: "monospace" }}
          value={draft.destinationRef}
          placeholder={draft.destinationType === "external_number" ? "+15551234567" : "from-internal,101,1"}
          disabled={!canEdit}
          onChange={(e) => set("destinationRef", e.target.value)}
        />
      </td>
      <td style={{ ...tdStyle, width: 44, textAlign: "center" }}>
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={!canEdit}
          onChange={(e) => set("enabled", e.target.checked)}
          style={{ accentColor: "#6366f1" }}
        />
      </td>
      <td style={{ ...tdStyle, width: 140, textAlign: "right" }}>
        {canEdit && (dirty ? (
          <button onClick={save} style={btnSmall("#6366f1")}>Save</button>
        ) : existing ? (
          <button onClick={() => onRemove(existing)} style={btnSmall("#7f1d1d")}>Clear</button>
        ) : (
          <span style={{ fontSize: 11, color: "#475569" }}>Unassigned</span>
        ))}
      </td>
    </tr>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Schedule
// ═══════════════════════════════════════════════════════════════════════════════

function ScheduleTab({ schedule, profiles, tenantId, canManage, onRefresh }: {
  schedule: ScheduleConfig | null;
  profiles: RouteProfile[];
  tenantId: string;
  canManage: boolean;
  onRefresh: () => void;
}) {
  const [form, setForm] = useState<Omit<ScheduleConfig, "id" | "tenantId"> & { tenantId: string }>(() => ({
    tenantId,
    timezone: schedule?.timezone ?? "America/New_York",
    businessHoursRules: schedule?.businessHoursRules ?? [],
    holidayDates: schedule?.holidayDates ?? [],
    defaultProfileId: schedule?.defaultProfileId ?? null,
    afterHoursProfileId: schedule?.afterHoursProfileId ?? null,
    holidayProfileId: schedule?.holidayProfileId ?? null,
    isActive: schedule?.isActive ?? true,
  }));
  const [newHoliday, setNewHoliday] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Sync when parent schedule changes
  useEffect(() => {
    setForm({
      tenantId,
      timezone: schedule?.timezone ?? "America/New_York",
      businessHoursRules: schedule?.businessHoursRules ?? [],
      holidayDates: schedule?.holidayDates ?? [],
      defaultProfileId: schedule?.defaultProfileId ?? null,
      afterHoursProfileId: schedule?.afterHoursProfileId ?? null,
      holidayProfileId: schedule?.holidayProfileId ?? null,
      isActive: schedule?.isActive ?? true,
    });
  }, [schedule, tenantId]);

  const setRule = (day: number, field: "open" | "close", value: string) => {
    setForm((f) => {
      const rules = f.businessHoursRules.filter((r) => r.day !== day);
      const existing = f.businessHoursRules.find((r) => r.day === day);
      if (!existing && !value) return f;
      const updated = existing ? { ...existing, [field]: value } : { day, open: "09:00", close: "17:00", [field]: value };
      return { ...f, businessHoursRules: [...rules, updated].sort((a, b) => a.day - b.day) };
    });
  };

  const toggleDay = (day: number) => {
    setForm((f) => {
      const hasRule = f.businessHoursRules.some((r) => r.day === day);
      if (hasRule) return { ...f, businessHoursRules: f.businessHoursRules.filter((r) => r.day !== day) };
      return { ...f, businessHoursRules: [...f.businessHoursRules, { day, open: "09:00", close: "17:00" }].sort((a, b) => a.day - b.day) };
    });
  };

  const addHoliday = () => {
    if (!newHoliday.match(/^\d{4}-\d{2}-\d{2}$/)) { setErr("Enter date as YYYY-MM-DD"); return; }
    if (form.holidayDates.includes(newHoliday)) return;
    setForm((f) => ({ ...f, holidayDates: [...f.holidayDates, newHoliday].sort() }));
    setNewHoliday("");
    setErr(null);
  };

  const removeHoliday = (d: string) => setForm((f) => ({ ...f, holidayDates: f.holidayDates.filter((x) => x !== d) }));

  const save = async () => {
    setSaving(true); setErr(null); setSaved(false);
    try {
      const token = typeof window !== "undefined" ? (localStorage.getItem("token") || localStorage.getItem("cc-token") || "") : "";
      const apiBase = typeof window !== "undefined"
        ? `${window.location.origin}/api`
        : (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001");
      const resp = await fetch(`${apiBase}/voice/ivr/schedule`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ ...form, tenantId }),
      });
      if (!resp.ok) { const b = await resp.json().catch(() => ({})); throw new Error((b as any)?.error ?? "Save failed"); }
      setSaved(true);
      onRefresh();
    } catch (e: any) {
      setErr(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const profileOptions = profiles.filter((p) => p.isActive);

  return (
    <div style={{ maxWidth: 720 }}>
      <h2 style={{ margin: "0 0 18px", fontSize: 16, fontWeight: 600 }}>Schedule Configuration</h2>

      {err  && <div style={{ color: "#fca5a5", fontSize: 13, marginBottom: 10 }}>{err}</div>}
      {saved && <div style={{ color: "#86efac", fontSize: 13, marginBottom: 10 }}>Schedule saved.</div>}

      {/* Timezone */}
      <SectionLabel>Timezone</SectionLabel>
      <select style={{ ...inputStyle, maxWidth: 320 }} value={form.timezone} onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))} disabled={!canManage}>
        {ALL_TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
      </select>

      {/* Business hours */}
      <SectionLabel>Business Hours</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        {ALL_DAYS.map((day) => {
          const rule = form.businessHoursRules.find((r) => r.day === day);
          return (
            <div key={day} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, width: 56, cursor: "pointer" }}>
                <input type="checkbox" checked={!!rule} onChange={() => canManage && toggleDay(day)} style={{ accentColor: "#6366f1" }} />
                <span style={{ fontSize: 13 }}>{DAY_NAMES[day]}</span>
              </label>
              {rule ? (
                <>
                  <input type="time" value={rule.open} onChange={(e) => canManage && setRule(day, "open", e.target.value)} style={{ ...timeInput, width: 100 }} disabled={!canManage} />
                  <span style={{ fontSize: 12, color: "#64748b" }}>to</span>
                  <input type="time" value={rule.close} onChange={(e) => canManage && setRule(day, "close", e.target.value)} style={{ ...timeInput, width: 100 }} disabled={!canManage} />
                </>
              ) : (
                <span style={{ fontSize: 12, color: "#475569" }}>Closed</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Profile associations */}
      <SectionLabel>Route Profiles</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
        {([ ["defaultProfileId", "Business Hours Profile"], ["afterHoursProfileId", "After Hours Profile"], ["holidayProfileId", "Holiday Profile"] ] as const).map(([field, label]) => (
          <div key={field} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 180, fontSize: 13, color: "#94a3b8" }}>{label}</span>
            <select
              style={{ ...inputStyle, flex: 1 }}
              value={form[field] ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value || null }))}
              disabled={!canManage}
            >
              <option value="">— Not set —</option>
              {profileOptions.map((p) => <option key={p.id} value={p.id}>{p.name} ({ROUTE_TYPE_LABELS[p.type]})</option>)}
            </select>
          </div>
        ))}
      </div>

      {/* Holiday dates */}
      <SectionLabel>Holiday Dates (YYYY-MM-DD)</SectionLabel>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input
          style={{ ...inputStyle, maxWidth: 160 }}
          placeholder="2026-12-25"
          value={newHoliday}
          onChange={(e) => setNewHoliday(e.target.value)}
          disabled={!canManage}
        />
        {canManage && <button onClick={addHoliday} style={btnSmall("#334155")}>Add</button>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 20 }}>
        {form.holidayDates.map((d) => (
          <span key={d} style={{ display: "flex", alignItems: "center", gap: 4, background: "rgba(99,102,241,0.15)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 5, padding: "3px 8px", fontSize: 12 }}>
            {d}
            {canManage && <span onClick={() => removeHoliday(d)} style={{ cursor: "pointer", color: "#ef4444", marginLeft: 4, lineHeight: 1 }}>✕</span>}
          </span>
        ))}
        {form.holidayDates.length === 0 && <span style={{ fontSize: 12, color: "#475569" }}>No holidays configured.</span>}
      </div>

      {canManage && <button onClick={save} disabled={saving} style={btnStyle("#6366f1")}>{saving ? "Saving…" : "Save Schedule"}</button>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab: Override
// ═══════════════════════════════════════════════════════════════════════════════

function OverrideTab({ override, profiles, tenantId, canManage, onRefresh }: {
  override: OverrideState | null;
  profiles: RouteProfile[];
  tenantId: string;
  canManage: boolean;
  onRefresh: () => void;
}) {
  const [profileId, setProfileId] = useState(override?.profileId ?? "");
  const [reason, setReason] = useState(override?.reason ?? "");
  const [expiresAt, setExpiresAt] = useState(override?.expiresAt ? override.expiresAt.slice(0, 16) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isActive = override?.isActive ?? false;

  const activate = async () => {
    if (!profileId) { setErr("Select an override profile."); return; }
    setSaving(true); setErr(null);
    try {
      await apiPost("/voice/ivr/override/activate", {
        tenantId, profileId, reason: reason || undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      onRefresh();
    } catch (e: any) { setErr(e?.message ?? "Failed"); }
    finally { setSaving(false); }
  };

  const deactivate = async () => {
    setSaving(true); setErr(null);
    try { await apiPost("/voice/ivr/override/deactivate", { tenantId }); onRefresh(); }
    catch (e: any) { setErr(e?.message ?? "Failed"); }
    finally { setSaving(false); }
  };

  const overrideProfiles = profiles.filter((p) => p.isActive && (p.type === "manual_override" || p.type === "emergency" || p.type === "after_hours"));

  return (
    <div style={{ maxWidth: 520 }}>
      <h2 style={{ margin: "0 0 18px", fontSize: 16, fontWeight: 600 }}>Manual Override</h2>

      {/* Current status card */}
      <div style={{ ...cardStyle, marginBottom: 24, borderColor: isActive ? "#ef4444" : "rgba(255,255,255,0.08)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
          <span style={{ width: 12, height: 12, borderRadius: "50%", background: isActive ? "#ef4444" : "#22c55e", flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{isActive ? "Override ACTIVE" : "Override inactive"}</div>
            {isActive && override?.profileId && (
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
                Profile: {profiles.find((p) => p.id === override.profileId)?.name ?? override.profileId}
                {override.reason ? ` — ${override.reason}` : ""}
                {override.expiresAt ? ` (expires ${new Date(override.expiresAt).toLocaleString()})` : ""}
              </div>
            )}
          </div>
        </div>
        {isActive && canManage && (
          <button onClick={deactivate} disabled={saving} style={{ ...btnSmall("#7f1d1d"), padding: "6px 14px" }}>Deactivate</button>
        )}
      </div>

      {err && <div style={{ color: "#fca5a5", fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {canManage && !isActive && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={labelStyle}>Override Profile</label>
            <select style={inputStyle} value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">— Select profile —</option>
              {profiles.filter((p) => p.isActive).map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({ROUTE_TYPE_LABELS[p.type]})</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Reason (optional)</label>
            <input style={inputStyle} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Emergency closure" />
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
  history: PublishRecord[];
  preview: PreviewResponse | null;
  tenantId: string;
  canManage: boolean;
  onRefresh: () => void;
}) {
  const [publishing, setPublishing] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const publish = async () => {
    if (!confirm("Publish current routing configuration to the PBX?")) return;
    setPublishing(true); setMsg(null);
    try {
      const r: any = await apiPost("/voice/ivr/publish", { tenantId });
      setMsg({ ok: true, text: `Published successfully. Mode: ${r?.mode ?? "unknown"} (${r?.keysWritten ?? 0} keys written)` });
      onRefresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? "Publish failed" });
    } finally {
      setPublishing(false);
    }
  };

  const rollback = async (id: string) => {
    if (!confirm("Roll back to the keys from this publish record?")) return;
    setRollingBack(id); setMsg(null);
    try {
      await apiPost(`/voice/ivr/rollback/${id}`, {});
      setMsg({ ok: true, text: "Rollback complete." });
      onRefresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? "Rollback failed" });
    } finally {
      setRollingBack(null);
    }
  };

  return (
    <div>
      {/* Publish card */}
      <div style={{ ...cardStyle, marginBottom: 24, alignItems: "flex-start", flexDirection: "column", gap: 14, padding: 20 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Publish to PBX</div>
          <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>
            Computes the current routing mode based on schedule and overrides, then writes
            tenant-scoped keys to Asterisk AstDB via AMI.
          </div>
          {preview && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              Current mode: <strong style={{ color: "#a5b4fc" }}>{MODE_LABELS[preview.mode] ?? preview.mode}</strong>
            </div>
          )}
        </div>
        {msg && (
          <div style={{ fontSize: 13, color: msg.ok ? "#86efac" : "#fca5a5" }}>{msg.text}</div>
        )}
        {canManage && (
          <button onClick={publish} disabled={publishing} style={btnStyle("#6366f1")}>
            {publishing ? "Publishing…" : "Publish Now"}
          </button>
        )}
      </div>

      {/* History */}
      <h3 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 600 }}>Publish History</h3>
      {history.length === 0 && <div style={emptyBox}>No publish records yet.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {history.map((r) => (
          <div key={r.id} style={{ ...cardStyle, fontSize: 13 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.status === "success" ? "#22c55e" : r.status === "failed" ? "#ef4444" : "#f59e0b", flexShrink: 0 }} />
                <strong>{MODE_LABELS[r.mode] ?? r.mode}</strong>
                {r.isRollback && <span style={{ fontSize: 11, background: "rgba(99,102,241,0.2)", color: "#a5b4fc", borderRadius: 4, padding: "1px 6px" }}>rollback</span>}
                <span style={{ color: "#64748b", marginLeft: 4 }}>{new Date(r.publishedAt).toLocaleString()}</span>
              </div>
              <div style={{ marginTop: 3, color: "#64748b" }}>
                by {r.publishedBy}
                {r.status === "failed" && r.error && <span style={{ color: "#fca5a5", marginLeft: 8 }}>{r.error}</span>}
              </div>
            </div>
            {canManage && r.status === "success" && (
              <button
                onClick={() => rollback(r.id)}
                disabled={rollingBack === r.id}
                style={btnSmall("#334155")}
              >
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
// Footer: live call preview
// ═══════════════════════════════════════════════════════════════════════════════
// Shows "what happens right now" for an inbound call — current greeting,
// per-digit routing, and the fallback behavior if a digit isn't pressed.
// Sourced from GET /voice/ivr/preview which resolves against the same logic
// that publishes to AstDB, so this and the dialplan never diverge.

function ActiveCallPreview({ preview }: { preview: PreviewResponse }) {
  const p = preview.activeProfile;
  if (!p) return null;
  const optsByDigit = new Map(p.options.map((o) => [o.digit, o]));
  return (
    <div style={{
      marginTop: 32, padding: 18,
      background: "rgba(15,23,42,0.5)", border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", flexShrink: 0 }} />
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>What happens right now</h3>
        <span style={{ fontSize: 12, color: "#64748b" }}>
          {MODE_LABELS[preview.mode] ?? preview.mode} — using <strong style={{ color: "#a5b4fc" }}>{p.name}</strong>
        </span>
      </div>
      <div style={{ fontSize: 13, color: "#94a3b8", display: "grid", gridTemplateColumns: "160px 1fr", rowGap: 4, columnGap: 12, marginBottom: 12 }}>
        <div>Greeting plays:</div>
        <code style={codePillStyle}>{p.prompts.greeting || "(built-in default)"}</code>
        <div>Waits for digit:</div>
        <code style={codePillStyle}>{p.timing.timeoutSeconds}s, up to {p.timing.maxRetries} retries</code>
        <div>Fallback destination:</div>
        <code style={codePillStyle}>{p.pbxDestination || "connect-default-fallback"}</code>
      </div>
      <div style={{ fontSize: 11, color: "#64748b", marginTop: 10, marginBottom: 6, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase" }}>Per-digit routing</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6 }}>
        {OPTION_DIGIT_ORDER.map((digit) => {
          const o = optsByDigit.get(digit);
          const enabled = o?.enabled ?? false;
          return (
            <div
              key={digit}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 12px", borderRadius: 8,
                background: enabled ? "rgba(34,197,94,0.08)" : "rgba(15,23,42,0.5)",
                border: `1px solid ${enabled ? "rgba(34,197,94,0.25)" : "rgba(255,255,255,0.04)"}`,
                fontSize: 12,
              }}
            >
              <span style={{ fontWeight: 700, fontSize: 13, width: 20 }}>{OPTION_DIGIT_LABEL[digit]}</span>
              {o && o.enabled ? (
                <div style={{ overflow: "hidden" }}>
                  <div style={{ color: "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {o.label || DESTINATION_TYPE_LABELS[o.destinationType]}
                  </div>
                  <code style={{ fontSize: 11, color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                    {o.destinationRef}
                  </code>
                </div>
              ) : (
                <span style={{ color: "#475569" }}>— falls to default</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Micro components / styles ─────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "#64748b", textTransform: "uppercase", marginBottom: 8, marginTop: 18 }}>
      {children}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 14,
  background: "rgba(15,23,42,0.6)", border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 10, padding: "12px 16px",
};

const emptyBox: React.CSSProperties = {
  background: "rgba(15,23,42,0.4)", border: "1px dashed rgba(255,255,255,0.08)",
  borderRadius: 8, padding: "20px 16px", color: "#475569", fontSize: 13, textAlign: "center",
};

const inputStyle: React.CSSProperties = {
  width: "100%", background: "rgba(15,23,42,0.8)", border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 7, padding: "8px 12px", color: "#e2e8f0", fontSize: 13,
  outline: "none", marginBottom: 12, boxSizing: "border-box",
};

const timeInput: React.CSSProperties = {
  background: "rgba(15,23,42,0.8)", border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 7, padding: "5px 8px", color: "#e2e8f0", fontSize: 12, outline: "none",
};

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 4,
};

const modalOverlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 1000,
};

const modalBox: React.CSSProperties = {
  background: "#0f172a", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12,
  padding: 28, minWidth: 420, maxWidth: 520, width: "100%",
};

function btnStyle(bg: string): React.CSSProperties {
  return { background: bg, color: "#fff", border: "none", borderRadius: 7, padding: "9px 18px", cursor: "pointer", fontSize: 13, fontWeight: 600 };
}
function btnSmall(bg: string): React.CSSProperties {
  return { background: bg, color: "#e2e8f0", border: "none", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap" };
}

const thStyle: React.CSSProperties = {
  fontWeight: 600, letterSpacing: 0.5, padding: "6px 8px", borderBottom: "1px solid rgba(255,255,255,0.06)",
};
const tdStyle: React.CSSProperties = {
  padding: "6px 8px", verticalAlign: "middle",
};
const codePillStyle: React.CSSProperties = {
  fontSize: 11, background: "rgba(0,0,0,0.3)", padding: "2px 8px", borderRadius: 5,
  color: "#cbd5e1", fontFamily: "monospace",
};

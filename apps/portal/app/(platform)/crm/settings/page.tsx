"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppContext } from "../../../../hooks/useAppContext";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { apiGet, apiPut, apiPost, apiPatch, apiDelete } from "../../../../services/apiClient";
import { CRMPageShell, crm, cn } from "../../../../components/crm";
import {
  Settings,
  Users,
  Phone,
  SlidersHorizontal,
  MapPin,
  FlaskConical,
  ShieldOff,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Plus,
  Trash2,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type CrmSettings = {
  enabled: boolean;
  localPresenceEnabled: boolean;
  transcriptionEnabled: boolean;
  defaultQueueSort: "SMART" | "ORIGINAL";
  defaultQueueFilter: "PENDING" | "DUE" | "OVERDUE" | "UPCOMING";
};

type CrmUserRow = {
  userId: string;
  email: string;
  displayName: string;
  systemRole: string;
  crmEnabled: boolean;
  crmRole: "AGENT" | "MANAGER" | "ADMIN" | null;
  hasAccess: boolean;
};

type UsersResponse = { users: CrmUserRow[] };

type PoolPhoneNumber = {
  id: string;
  phoneNumber: string;
  friendlyName: string | null;
  areaCode: string | null;
  status: string;
};

type PoolEntry = {
  id: string;
  phoneNumberId: string;
  areaCode3: string;
  label: string | null;
  isActive: boolean;
  phoneNumber: PoolPhoneNumber | null;
};

type SuggestResult = {
  to: string;
  normalizedTo: string | null;
  areaCode3: string | null;
  localPresenceEnabled: boolean;
  selectedCallerId: string | null;
  matched: boolean;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  AGENT: "Agent",
  MANAGER: "Manager",
  ADMIN: "CRM Admin",
};

const SYSTEM_ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Admin",
  TENANT_ADMIN: "Tenant Admin",
  EXTENSION_USER: "Extension User",
  BILLING_ADMIN: "Billing Admin",
  BILLING: "Billing",
  READ_ONLY: "Read Only",
};

// ── CRM-system toggle ──────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-crm-accent/40 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "bg-crm-accent" : "bg-crm-border",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-150",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

// ── Section label ──────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-4 text-[10px] font-bold uppercase tracking-[0.18em] text-crm-muted/70">
      {children}
    </p>
  );
}

// ── Setting row ────────────────────────────────────────────────────────────────

function SettingRow({
  title,
  description,
  badge,
  dim,
  children,
  noBorder,
}: {
  title: string;
  description: string;
  badge?: string;
  dim?: boolean;
  children: React.ReactNode;
  noBorder?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 py-3.5",
        !noBorder && "border-b border-crm-border/40",
        dim && "opacity-45",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-crm-text">{title}</span>
          {badge && (
            <span className="rounded border border-crm-border/70 bg-crm-surface-2 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-crm-muted">
              {badge}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-crm-muted">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function CrmSettingsPage() {
  const { backendJwtRole } = useAppContext();

  const isAdmin =
    backendJwtRole === "ADMIN" ||
    backendJwtRole === "TENANT_ADMIN" ||
    backendJwtRole === "SUPER_ADMIN";

  // ── Settings state ──────────────────────────────────────────────────────────
  const [settings, setSettings] = useState<CrmSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      const s = await apiGet<CrmSettings>("/crm/settings");
      setSettings(s);
    } catch (e: any) {
      setSettingsError(e?.message || "Failed to load CRM settings");
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const updateSetting = async (patch: Partial<CrmSettings>) => {
    if (!settings) return;
    const optimistic = { ...settings, ...patch };
    setSettings(optimistic);
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const saved = await apiPut<CrmSettings>("/crm/settings", patch);
      setSettings(saved);
    } catch (e: any) {
      setSettings(settings); // revert
      setSettingsError(e?.message || "Failed to save");
    } finally {
      setSettingsSaving(false);
    }
  };

  // ── Local Presence pool state ────────────────────────────────────────────
  const [pool, setPool] = useState<PoolEntry[]>([]);
  const [poolLoading, setPoolLoading] = useState(false);
  const [availableNumbers, setAvailableNumbers] = useState<PoolPhoneNumber[]>([]);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [addPoolOpen, setAddPoolOpen] = useState(false);
  const [addPhoneId, setAddPhoneId] = useState("");
  const [addAreaCode, setAddAreaCode] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addSaving, setAddSaving] = useState(false);
  const [suggestTo, setSuggestTo] = useState("");
  const [suggestResult, setSuggestResult] = useState<SuggestResult | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const loadPool = useCallback(async () => {
    if (!isAdmin) return;
    setPoolLoading(true);
    setPoolError(null);
    try {
      const [poolRes, numsRes] = await Promise.all([
        apiGet<{ pool: PoolEntry[] }>("/crm/caller-id-pool?active=false"),
        apiGet<{ numbers: PoolPhoneNumber[] }>("/crm/caller-id-pool/available-numbers"),
      ]);
      setPool(poolRes.pool);
      setAvailableNumbers(numsRes.numbers);
    } catch (e: any) {
      setPoolError(e?.message || "Failed to load pool");
    } finally {
      setPoolLoading(false);
    }
  }, [isAdmin]);

  // ── Users state ─────────────────────────────────────────────────────────────
  const [users, setUsers] = useState<CrmUserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [userSaving, setUserSaving] = useState<Record<string, boolean>>({});

  const loadUsers = useCallback(async () => {
    if (!isAdmin) return;
    setUsersLoading(true);
    setUsersError(null);
    try {
      const res = await apiGet<UsersResponse>("/crm/users");
      setUsers(res.users);
    } catch (e: any) {
      setUsersError(e?.message || "Failed to load users");
    } finally {
      setUsersLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { loadUsers(); }, [loadUsers]);
  useEffect(() => { loadPool(); }, [loadPool]);

  const updateUserAccess = async (userId: string, patch: { enabled?: boolean; role?: string }) => {
    setUserSaving((prev) => ({ ...prev, [userId]: true }));
    try {
      const updated = await apiPut<{ userId: string; enabled: boolean; role: string }>(
        `/crm/users/${userId}`,
        patch,
      );
      setUsers((prev) =>
        prev.map((u) =>
          u.userId === userId
            ? { ...u, crmEnabled: updated.enabled, crmRole: updated.role as any, hasAccess: true }
            : u,
        ),
      );
    } catch {
      loadUsers();
    } finally {
      setUserSaving((prev) => ({ ...prev, [userId]: false }));
    }
  };

  // ── Pool handlers ────────────────────────────────────────────────────────
  const handleAddToPool = async () => {
    if (!addPhoneId || !/^\d{3}$/.test(addAreaCode)) return;
    setAddSaving(true);
    setPoolError(null);
    try {
      await apiPost("/crm/caller-id-pool", {
        phoneNumberId: addPhoneId,
        areaCode3: addAreaCode,
        label: addLabel.trim() || null,
        isActive: true,
      });
      setAddPhoneId(""); setAddAreaCode(""); setAddLabel(""); setAddPoolOpen(false);
      loadPool();
    } catch (e: any) {
      setPoolError(e?.message || "Failed to add");
    } finally {
      setAddSaving(false);
    }
  };

  const handleTogglePoolEntry = async (entry: PoolEntry) => {
    try {
      await apiPatch(`/crm/caller-id-pool/${entry.id}`, { isActive: !entry.isActive });
      loadPool();
    } catch {}
  };

  const handleRemovePoolEntry = async (entry: PoolEntry) => {
    if (!confirm(`Remove ${entry.phoneNumber?.phoneNumber ?? entry.id} from the pool?`)) return;
    try {
      await apiDelete<{ ok: boolean }>(`/crm/caller-id-pool/${entry.id}`);
      loadPool();
    } catch {}
  };

  const handleSuggest = async () => {
    if (!suggestTo.trim()) return;
    setSuggesting(true);
    setSuggestResult(null);
    try {
      const res = await apiGet<SuggestResult>(`/crm/caller-id-pool/suggest?to=${encodeURIComponent(suggestTo.trim())}`);
      setSuggestResult(res);
    } catch {}
    setSuggesting(false);
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!isAdmin) {
    return (
      <CRMPageShell>
        <div className={crm.pageInner}>
          <div className="flex items-center gap-3 pb-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-crm-border/60 bg-crm-surface-2 text-crm-muted">
              <Settings className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-crm-text">CRM Settings</h1>
              <p className="text-xs text-crm-muted">Configuration for the CRM module</p>
            </div>
          </div>
          <div className={cn(crm.card, "px-5 py-4")}>
            <div className="flex items-center gap-2.5">
              <ShieldOff className="h-4 w-4 shrink-0 text-crm-muted" />
              <p className="text-sm text-crm-muted">You need admin access to manage CRM settings.</p>
            </div>
          </div>
        </div>
      </CRMPageShell>
    );
  }

  return (
    <CRMPageShell>
      <div className={crm.pageInner}>

        {/* ── Page header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 pb-1">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-crm-border/60 bg-crm-surface-2 text-crm-muted">
            <Settings className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-crm-text">CRM Settings</h1>
            <p className="text-xs text-crm-muted">Feature flags, queue defaults, local presence, and user access</p>
          </div>
        </div>

        {settingsError && (
          <div className={cn(crm.bannerDanger, "flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm")}>
            <XCircle className="h-4 w-4 shrink-0" />
            {settingsError}
          </div>
        )}

        {/* ── Feature Flags ───────────────────────────────────────────────────── */}
        <div className={cn(crm.card, "overflow-hidden")}>
          <div className="border-b border-crm-border/40 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-3.5 w-3.5 text-crm-muted" />
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-crm-muted/70">Feature Flags</p>
            </div>
          </div>
          <div className="px-5">
            {settingsLoading ? (
              <div className="py-4"><LoadingSkeleton rows={3} /></div>
            ) : settings ? (
              <>
                <SettingRow
                  title="CRM Enabled"
                  description="Activates the CRM module for this tenant. Disabling hides the CRM section from all users without affecting the phone system."
                >
                  <Toggle
                    label="CRM Enabled"
                    checked={settings.enabled}
                    disabled={settingsSaving}
                    onChange={(v) => updateSetting({ enabled: v })}
                  />
                </SettingRow>
                <SettingRow
                  title="Local Presence"
                  description="Allow outbound calls to use a DID from the same area code as the destination number."
                  badge="Phase 2"
                  dim={!settings.enabled}
                >
                  <Toggle
                    label="Local Presence"
                    checked={settings.localPresenceEnabled}
                    disabled={settingsSaving || !settings.enabled}
                    onChange={(v) => updateSetting({ localPresenceEnabled: v })}
                  />
                </SettingRow>
                <SettingRow
                  title="Call Transcription"
                  description="Automatically transcribe call recordings and show transcripts in the customer timeline."
                  badge="Phase 3"
                  dim={!settings.enabled}
                  noBorder
                >
                  <Toggle
                    label="Call Transcription"
                    checked={settings.transcriptionEnabled}
                    disabled={settingsSaving || !settings.enabled}
                    onChange={(v) => updateSetting({ transcriptionEnabled: v })}
                  />
                </SettingRow>
                {settingsSaving && (
                  <p className="pb-3 text-xs text-crm-muted">Saving…</p>
                )}
              </>
            ) : null}
          </div>
        </div>

        {/* ── Queue Defaults ───────────────────────────────────────────────────── */}
        {settings && (
          <div className={cn(crm.card, "overflow-hidden")}>
            <div className="border-b border-crm-border/40 px-5 py-3.5">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-3.5 w-3.5 text-crm-muted" />
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-crm-muted/70">Queue Defaults</p>
              </div>
              <p className="mt-0.5 text-xs text-crm-muted">
                Default sort and filter for agents who have not set a personal preference.
              </p>
            </div>
            <div className="flex flex-col gap-5 px-5 py-4">

              {/* Default Sort */}
              <div>
                <p className="mb-2.5 text-xs font-semibold text-crm-text">Default Sort</p>
                <div className="flex gap-1.5">
                  {(["SMART", "ORIGINAL"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      disabled={settingsSaving}
                      onClick={() => updateSetting({ defaultQueueSort: v })}
                      className={cn(
                        "rounded-lg border px-3.5 py-1.5 text-sm font-medium transition-all duration-150",
                        settings.defaultQueueSort === v
                          ? "border-crm-accent/70 bg-crm-accent/12 text-crm-accent"
                          : "border-crm-border/60 text-crm-muted hover:border-crm-border hover:text-crm-text",
                        settingsSaving && "cursor-not-allowed opacity-60",
                      )}
                    >
                      {v === "SMART" ? "Smart Priority" : "Original Order"}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-crm-muted">
                  {settings.defaultQueueSort === "SMART"
                    ? "Overdue callbacks first, then fresh leads by campaign priority."
                    : "Original import/sort order."}
                </p>
              </div>

              {/* Default Filter */}
              <div>
                <p className="mb-2.5 text-xs font-semibold text-crm-text">Default Filter Tab</p>
                <div className="flex flex-wrap gap-1.5">
                  {(["PENDING", "DUE", "OVERDUE", "UPCOMING"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      disabled={settingsSaving}
                      onClick={() => updateSetting({ defaultQueueFilter: v })}
                      className={cn(
                        "rounded-lg border px-3.5 py-1.5 text-sm font-medium transition-all duration-150",
                        settings.defaultQueueFilter === v
                          ? "border-crm-accent/70 bg-crm-accent/12 text-crm-accent"
                          : "border-crm-border/60 text-crm-muted hover:border-crm-border hover:text-crm-text",
                        settingsSaving && "cursor-not-allowed opacity-60",
                      )}
                    >
                      {v === "PENDING" ? "Next Up" : v === "DUE" ? "Due Today" : v === "OVERDUE" ? "Overdue" : "Upcoming"}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-crm-muted">
                  Which tab agents see first when opening the queue.
                </p>
              </div>

              {settingsSaving && (
                <p className="text-xs text-crm-muted">Saving…</p>
              )}
            </div>
          </div>
        )}

        {/* ── Local Presence Pool ─────────────────────────────────────────────── */}
        {settings?.localPresenceEnabled && (
          <div className={cn(crm.card, "overflow-hidden")}>
            <div className="flex items-start justify-between gap-3 border-b border-crm-border/40 px-5 py-3.5">
              <div>
                <div className="flex items-center gap-2">
                  <MapPin className="h-3.5 w-3.5 text-crm-muted" />
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-crm-muted/70">Local Presence — Caller ID Pool</p>
                </div>
                <p className="mt-0.5 text-xs text-crm-muted">
                  Associate tenant-owned DIDs with US area codes. Only numbers already assigned to your tenant can be added.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAddPoolOpen((v) => !v)}
                className={cn(crm.btnSecondary, "shrink-0 text-xs py-1.5")}
              >
                <Plus className="h-3.5 w-3.5" /> Add Number
              </button>
            </div>

            {poolError && (
              <div className={cn(crm.bannerDanger, "mx-5 mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs")}>
                {poolError}
              </div>
            )}

            {/* Add number form */}
            {addPoolOpen && (
              <div className="border-b border-crm-border/40 bg-crm-surface-2/30 px-5 py-4">
                <p className="mb-3 text-xs font-semibold text-crm-text">Add Number to Pool</p>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">Phone Number</label>
                    <select
                      value={addPhoneId}
                      onChange={(e) => {
                        setAddPhoneId(e.target.value);
                        const n = availableNumbers.find((x) => x.id === e.target.value);
                        if (n?.areaCode) setAddAreaCode(n.areaCode.replace(/\D/g, "").slice(0, 3));
                      }}
                      className={cn(crm.select, "min-w-[200px]")}
                    >
                      <option value="">— select number —</option>
                      {availableNumbers.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.phoneNumber}{n.friendlyName ? ` (${n.friendlyName})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">Area Code</label>
                    <input
                      type="text"
                      value={addAreaCode}
                      onChange={(e) => setAddAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))}
                      placeholder="512"
                      maxLength={3}
                      className={cn(crm.input, "w-20")}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">Label (optional)</label>
                    <input
                      type="text"
                      value={addLabel}
                      onChange={(e) => setAddLabel(e.target.value)}
                      placeholder="e.g. Austin TX"
                      maxLength={100}
                      className={cn(crm.input, "w-40")}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleAddToPool}
                      disabled={addSaving || !addPhoneId || !/^\d{3}$/.test(addAreaCode)}
                      className={crm.btnPrimary}
                    >
                      {addSaving ? "Adding…" : "Add"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAddPoolOpen(false)}
                      className={crm.btnSecondary}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Pool list */}
            <div className="px-5 py-3">
              {poolLoading ? (
                <LoadingSkeleton rows={2} />
              ) : pool.length === 0 ? (
                <div className={cn(crm.emptyWrap, "py-8")}>
                  <Phone className="mx-auto mb-2 h-7 w-7 text-crm-muted/40" />
                  <p className={crm.emptyTitle}>No numbers in the pool</p>
                  <p className={crm.emptyBody}>Click "Add Number" to assign a DID to an area code.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {/* Header row */}
                  <div className="hidden grid-cols-[1fr_80px_120px_90px_120px] gap-3 border-b border-crm-border/40 pb-2 lg:grid">
                    {["Phone Number", "Area Code", "Label", "Status", "Actions"].map((h) => (
                      <span key={h} className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">{h}</span>
                    ))}
                  </div>
                  {pool.map((entry) => (
                    <div
                      key={entry.id}
                      className="grid grid-cols-1 gap-2 rounded-lg border border-crm-border/50 bg-crm-surface-2/20 px-3 py-2.5 transition-colors hover:bg-crm-surface-2/40 lg:grid-cols-[1fr_80px_120px_90px_120px] lg:items-center lg:gap-3"
                    >
                      <div>
                        <div className="text-sm font-medium tabular-nums text-crm-text">
                          {entry.phoneNumber?.phoneNumber ?? entry.phoneNumberId}
                        </div>
                        {entry.phoneNumber?.friendlyName && (
                          <div className="text-xs text-crm-muted">{entry.phoneNumber.friendlyName}</div>
                        )}
                      </div>
                      <div className="font-mono text-sm font-bold text-crm-text">{entry.areaCode3}</div>
                      <div className="text-xs text-crm-muted">{entry.label ?? "—"}</div>
                      <div>
                        <span className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold",
                          entry.isActive
                            ? "border-crm-success/40 bg-crm-success/10 text-crm-success"
                            : "border-crm-border/60 bg-crm-surface-2 text-crm-muted",
                        )}>
                          {entry.isActive ? <CheckCircle2 className="h-2.5 w-2.5" /> : <XCircle className="h-2.5 w-2.5" />}
                          {entry.isActive ? "Active" : "Inactive"}
                        </span>
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleTogglePoolEntry(entry)}
                          className={cn(crm.btnSecondary, "py-1 text-xs")}
                        >
                          {entry.isActive ? "Deactivate" : "Activate"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemovePoolEntry(entry)}
                          className={cn(crm.btnDanger, "py-1 text-xs px-2")}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Test local presence */}
            <div className="border-t border-crm-border/40 px-5 py-4">
              <div className="flex items-center gap-2 mb-2">
                <FlaskConical className="h-3.5 w-3.5 text-crm-muted" />
                <p className="text-xs font-semibold text-crm-text">Test Local Presence</p>
              </div>
              <p className="mb-3 text-xs text-crm-muted">
                Enter a destination number to see which caller ID would be selected.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={suggestTo}
                  onChange={(e) => setSuggestTo(e.target.value)}
                  placeholder="(512) 555-1234"
                  className={cn(crm.input, "max-w-[220px]")}
                  onKeyDown={(e) => e.key === "Enter" && handleSuggest()}
                />
                <button
                  type="button"
                  onClick={handleSuggest}
                  disabled={suggesting || !suggestTo.trim()}
                  className={crm.btnSecondary}
                >
                  {suggesting ? "…" : "Test"}
                </button>
              </div>
              {suggestResult && (
                <div className={cn(
                  "mt-3 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs",
                  suggestResult.matched
                    ? "border-crm-success/35 bg-crm-success/8 text-crm-success"
                    : "border-crm-border/60 bg-crm-surface-2/40 text-crm-muted",
                )}>
                  {suggestResult.matched ? (
                    <>
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        <strong>Match found</strong> — Area code <code className="rounded bg-crm-surface-2 px-1">{suggestResult.areaCode3}</code> → Caller ID: <strong>{suggestResult.selectedCallerId}</strong>
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        <strong>No match</strong> — {suggestResult.localPresenceEnabled
                          ? `Area code ${suggestResult.areaCode3 ?? "?"} not in pool. Default caller ID will be used.`
                          : "Local presence is disabled."}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── User Access ─────────────────────────────────────────────────────── */}
        <div className={cn(crm.card, "overflow-hidden")}>
          <div className="border-b border-crm-border/40 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-crm-muted" />
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-crm-muted/70">User Access</p>
            </div>
            <p className="mt-0.5 text-xs text-crm-muted">
              Control which users can access CRM features and at what role.
            </p>
          </div>

          {usersLoading ? (
            <div className="px-5 py-4"><LoadingSkeleton rows={4} /></div>
          ) : usersError ? (
            <div className={cn(crm.bannerDanger, "mx-5 my-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm")}>
              {usersError}
            </div>
          ) : users.length === 0 ? (
            <div className="px-5 py-4">
              <p className="text-sm text-crm-muted">No users found for this tenant.</p>
            </div>
          ) : (
            <div>
              {/* Table header */}
              <div className="hidden grid-cols-[1fr_120px_120px_140px] gap-4 border-b border-crm-border/40 bg-crm-surface-2/30 px-5 py-2.5 lg:grid">
                {["User", "System Role", "CRM Access", "CRM Role"].map((h) => (
                  <span key={h} className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">{h}</span>
                ))}
              </div>
              {/* User rows */}
              <div className="flex flex-col divide-y divide-crm-border/30">
                {users.map((u) => {
                  const saving = userSaving[u.userId];
                  return (
                    <div
                      key={u.userId}
                      className={cn(
                        "grid grid-cols-1 gap-3 px-5 py-3 transition-opacity lg:grid-cols-[1fr_120px_120px_140px] lg:items-center lg:gap-4",
                        saving && "opacity-50",
                      )}
                    >
                      {/* User */}
                      <div>
                        <div className="text-sm font-medium text-crm-text">{u.displayName || u.email}</div>
                        {u.displayName && u.displayName !== u.email && (
                          <div className="text-xs text-crm-muted">{u.email}</div>
                        )}
                      </div>
                      {/* System role */}
                      <div>
                        <span className="text-xs text-crm-muted">
                          {SYSTEM_ROLE_LABELS[u.systemRole] || u.systemRole}
                        </span>
                      </div>
                      {/* CRM access toggle */}
                      <div className="flex items-center gap-2">
                        <Toggle
                          label={u.crmEnabled ? "Enabled" : "Disabled"}
                          checked={u.crmEnabled}
                          disabled={saving || !settings?.enabled}
                          onChange={(v) => updateUserAccess(u.userId, { enabled: v, role: u.crmRole ?? "AGENT" })}
                        />
                        <span className={cn("text-xs", u.crmEnabled ? "text-crm-success" : "text-crm-muted")}>
                          {u.crmEnabled ? "On" : "Off"}
                        </span>
                      </div>
                      {/* CRM role select */}
                      <div>
                        {u.hasAccess ? (
                          <select
                            value={u.crmRole ?? "AGENT"}
                            disabled={saving || !u.crmEnabled || !settings?.enabled}
                            onChange={(e) =>
                              updateUserAccess(u.userId, { role: e.target.value, enabled: u.crmEnabled })
                            }
                            className={cn(
                              crm.select,
                              "py-1.5 text-xs",
                              (!u.crmEnabled || !settings?.enabled) && "opacity-40",
                            )}
                          >
                            {Object.entries(ROLE_LABELS).map(([val, label]) => (
                              <option key={val} value={val}>{label}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs text-crm-muted">—</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {!settings?.enabled && (
                <div className="border-t border-crm-border/40 px-5 py-2.5">
                  <p className="text-xs text-crm-muted">Enable CRM above to activate user access controls.</p>
                </div>
              )}
            </div>
          )}
        </div>

      </div>
    </CRMPageShell>
  );
}

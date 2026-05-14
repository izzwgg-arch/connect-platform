"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppContext } from "../../../../hooks/useAppContext";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { apiGet, apiPut, apiPost, apiPatch, apiDelete } from "../../../../services/apiClient";

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

// ── Toggle component ───────────────────────────────────────────────────────────

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
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.625rem",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        userSelect: "none",
      }}
    >
      <span
        onClick={() => !disabled && onChange(!checked)}
        style={{
          position: "relative",
          display: "inline-block",
          width: 38,
          height: 22,
          borderRadius: 11,
          background: checked ? "var(--accent, #3b82f6)" : "var(--border, #334155)",
          transition: "background 0.15s",
          flexShrink: 0,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: checked ? 19 : 3,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "#fff",
            transition: "left 0.15s",
            boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          }}
        />
      </span>
      <span style={{ fontSize: "0.875rem", color: "var(--text)" }}>{label}</span>
    </label>
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
      // silently re-load on error
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
      <div className="stack compact-stack">
        <PageHeader title="CRM Settings" subtitle="Configuration for the CRM module." />
        <div className="panel" style={{ padding: "1.5rem" }}>
          <p style={{ margin: 0, color: "var(--text-dim)", fontSize: "0.875rem" }}>
            You need admin access to manage CRM settings.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="stack compact-stack">
      <PageHeader
        title="CRM Settings"
        subtitle="Enable the CRM module, configure feature flags, and manage user access."
      />

      {/* ── Feature flags panel ─────────────────────────────────────────────── */}
      <section className="panel" style={{ padding: "1.5rem" }}>
        <h3 style={{ margin: "0 0 1rem", fontSize: "0.9375rem", fontWeight: 600 }}>Feature Flags</h3>

        {settingsLoading && <LoadingSkeleton rows={3} />}
        {settingsError && (
          <p style={{ color: "#ef4444", fontSize: "0.875rem", margin: 0 }}>{settingsError}</p>
        )}

        {!settingsLoading && settings && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1.125rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", paddingBottom: "1.125rem", borderBottom: "1px solid var(--border)" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>CRM Enabled</div>
                <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)", marginTop: 2 }}>
                  Activates the CRM module for this tenant. Disabling hides the CRM section from all users without affecting the phone system.
                </div>
              </div>
              <Toggle
                label=""
                checked={settings.enabled}
                disabled={settingsSaving}
                onChange={(v) => updateSetting({ enabled: v })}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", opacity: settings.enabled ? 1 : 0.45, paddingBottom: "1.125rem", borderBottom: "1px solid var(--border)" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>Local Presence</div>
                <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)", marginTop: 2 }}>
                  Allow outbound calls to use a DID from the same area code as the destination number.
                  <span style={{ marginLeft: 6, padding: "0.1rem 0.4rem", borderRadius: 4, fontSize: "0.6875rem", fontWeight: 700, background: "var(--surface-hover)", color: "var(--text-dim)" }}>
                    Phase 2
                  </span>
                </div>
              </div>
              <Toggle
                label=""
                checked={settings.localPresenceEnabled}
                disabled={settingsSaving || !settings.enabled}
                onChange={(v) => updateSetting({ localPresenceEnabled: v })}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", opacity: settings.enabled ? 1 : 0.45 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>Call Transcription</div>
                <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)", marginTop: 2 }}>
                  Automatically transcribe call recordings and show transcripts in the customer timeline.
                  <span style={{ marginLeft: 6, padding: "0.1rem 0.4rem", borderRadius: 4, fontSize: "0.6875rem", fontWeight: 700, background: "var(--surface-hover)", color: "var(--text-dim)" }}>
                    Phase 3
                  </span>
                </div>
              </div>
              <Toggle
                label=""
                checked={settings.transcriptionEnabled}
                disabled={settingsSaving || !settings.enabled}
                onChange={(v) => updateSetting({ transcriptionEnabled: v })}
              />
            </div>

            {settingsSaving && (
              <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim)" }}>Saving…</p>
            )}
          </div>
        )}
      </section>

      {/* ── Queue Defaults panel ────────────────────────────────────────────── */}
      {settings && (
        <section className="panel" style={{ padding: "1.5rem" }}>
          <h3 style={{ margin: "0 0 0.25rem", fontSize: "0.9375rem", fontWeight: 600 }}>Queue Defaults</h3>
          <p style={{ margin: "0 0 1.25rem", fontSize: "0.8125rem", color: "var(--text-dim)" }}>
            Default sort and filter applied to agents&apos; queues when they have not set a personal preference.
            Agents can still override these with the UI controls on the queue page.
          </p>

          {/* Default sort */}
          <div style={{ marginBottom: "1.25rem" }}>
            <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.5rem" }}>Default Sort</div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {(["SMART", "ORIGINAL"] as const).map((v) => (
                <button
                  key={v}
                  disabled={settingsSaving}
                  onClick={() => updateSetting({ defaultQueueSort: v })}
                  style={{
                    padding: "0.375rem 1rem",
                    borderRadius: "0.5rem",
                    border: "1px solid",
                    fontSize: "0.875rem",
                    fontWeight: 500,
                    cursor: settingsSaving ? "not-allowed" : "pointer",
                    background: settings.defaultQueueSort === v ? "var(--accent, #3b82f6)" : "var(--surface)",
                    color: settings.defaultQueueSort === v ? "#fff" : "var(--text)",
                    borderColor: settings.defaultQueueSort === v ? "var(--accent, #3b82f6)" : "var(--border)",
                    transition: "all 0.15s",
                  }}
                >
                  {v === "SMART" ? "Smart Priority" : "Original Order"}
                </button>
              ))}
            </div>
            <p style={{ margin: "0.375rem 0 0", fontSize: "0.75rem", color: "var(--text-dim)" }}>
              {settings.defaultQueueSort === "SMART"
                ? "Agents' queues default to Smart Priority — overdue callbacks first, then fresh leads by campaign priority."
                : "Agents' queues default to original import/sort order."}
            </p>
          </div>

          {/* Default filter */}
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.5rem" }}>Default Filter Tab</div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {(["PENDING", "DUE", "OVERDUE", "UPCOMING"] as const).map((v) => (
                <button
                  key={v}
                  disabled={settingsSaving}
                  onClick={() => updateSetting({ defaultQueueFilter: v })}
                  style={{
                    padding: "0.375rem 1rem",
                    borderRadius: "0.5rem",
                    border: "1px solid",
                    fontSize: "0.875rem",
                    fontWeight: 500,
                    cursor: settingsSaving ? "not-allowed" : "pointer",
                    background: settings.defaultQueueFilter === v ? "var(--accent, #3b82f6)" : "var(--surface)",
                    color: settings.defaultQueueFilter === v ? "#fff" : "var(--text)",
                    borderColor: settings.defaultQueueFilter === v ? "var(--accent, #3b82f6)" : "var(--border)",
                    transition: "all 0.15s",
                  }}
                >
                  {v === "PENDING" ? "Next Up" : v === "DUE" ? "Due Today" : v === "OVERDUE" ? "Overdue" : "Upcoming"}
                </button>
              ))}
            </div>
            <p style={{ margin: "0.375rem 0 0", fontSize: "0.75rem", color: "var(--text-dim)" }}>
              Which tab agents see first when they open the queue. Applies when URL has no explicit ?filter= param.
            </p>
          </div>

          {settingsSaving && (
            <p style={{ margin: "0.75rem 0 0", fontSize: "0.8125rem", color: "var(--text-dim)" }}>Saving…</p>
          )}
        </section>
      )}

      {/* ── Local Presence pool panel ───────────────────────────────────────── */}
      {settings?.localPresenceEnabled && (
        <section className="panel" style={{ padding: "1.5rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 600 }}>Local Presence — Caller ID Pool</h3>
              <p style={{ margin: "0.25rem 0 0", fontSize: "0.8125rem", color: "var(--text-dim)" }}>
                Associate tenant-owned DIDs with US area codes. Only numbers already assigned to your tenant can be added.
              </p>
            </div>
            <button
              onClick={() => setAddPoolOpen((v) => !v)}
              style={{ padding: "0.4rem 0.875rem", borderRadius: "0.5rem", background: "var(--accent)", color: "#fff", fontWeight: 600, fontSize: "0.8125rem", border: "none", cursor: "pointer" }}
            >
              + Add Number
            </button>
          </div>

          {poolError && <p style={{ color: "#ef4444", fontSize: "0.8125rem", margin: "0 0 0.75rem" }}>{poolError}</p>}

          {/* Add number form */}
          {addPoolOpen && (
            <div style={{ padding: "1rem", borderRadius: "0.5rem", background: "var(--surface-hover)", marginBottom: "1rem", display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-end" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "var(--text-dim)", marginBottom: 4 }}>Phone Number</label>
                <select
                  value={addPhoneId}
                  onChange={(e) => {
                    setAddPhoneId(e.target.value);
                    const n = availableNumbers.find((x) => x.id === e.target.value);
                    if (n?.areaCode) setAddAreaCode(n.areaCode.replace(/\D/g, "").slice(0, 3));
                  }}
                  style={{ padding: "0.375rem 0.5rem", border: "1px solid var(--border)", borderRadius: "0.375rem", fontSize: "0.875rem", background: "var(--surface)", color: "var(--text)", minWidth: 200 }}
                >
                  <option value="">— select number —</option>
                  {availableNumbers.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.phoneNumber}{n.friendlyName ? ` (${n.friendlyName})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "var(--text-dim)", marginBottom: 4 }}>Area Code (3 digits)</label>
                <input
                  type="text"
                  value={addAreaCode}
                  onChange={(e) => setAddAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))}
                  placeholder="512"
                  maxLength={3}
                  style={{ padding: "0.375rem 0.5rem", border: "1px solid var(--border)", borderRadius: "0.375rem", fontSize: "0.875rem", background: "var(--surface)", color: "var(--text)", width: 80 }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "var(--text-dim)", marginBottom: 4 }}>Label (optional)</label>
                <input
                  type="text"
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  placeholder="e.g. Austin TX"
                  maxLength={100}
                  style={{ padding: "0.375rem 0.5rem", border: "1px solid var(--border)", borderRadius: "0.375rem", fontSize: "0.875rem", background: "var(--surface)", color: "var(--text)", width: 160 }}
                />
              </div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  onClick={handleAddToPool}
                  disabled={addSaving || !addPhoneId || !/^\d{3}$/.test(addAreaCode)}
                  style={{ padding: "0.375rem 0.875rem", borderRadius: "0.375rem", background: "var(--accent)", color: "#fff", fontWeight: 600, fontSize: "0.8125rem", border: "none", cursor: addSaving ? "not-allowed" : "pointer", opacity: (!addPhoneId || !/^\d{3}$/.test(addAreaCode)) ? 0.5 : 1 }}
                >
                  {addSaving ? "Adding…" : "Add"}
                </button>
                <button
                  onClick={() => setAddPoolOpen(false)}
                  style={{ padding: "0.375rem 0.75rem", borderRadius: "0.375rem", background: "var(--surface-hover)", border: "1px solid var(--border)", color: "var(--text)", fontSize: "0.8125rem", cursor: "pointer" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {poolLoading ? <LoadingSkeleton rows={2} /> : pool.length === 0 ? (
            <p style={{ color: "var(--text-dim)", fontSize: "0.875rem" }}>No numbers in the pool yet. Click &ldquo;Add Number&rdquo; to assign a DID to an area code.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                <thead>
                  <tr style={{ background: "var(--surface-hover)" }}>
                    {["Phone Number", "Area Code", "Label", "Status", "Actions"].map((h) => (
                      <th key={h} style={{ padding: "0.45rem 0.875rem", textAlign: "left", fontWeight: 600, fontSize: "0.75rem", color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pool.map((entry, idx) => (
                    <tr key={entry.id} style={{ borderTop: idx === 0 ? undefined : "1px solid var(--border)" }}>
                      <td style={{ padding: "0.5rem 0.875rem", fontWeight: 500 }}>
                        {entry.phoneNumber?.phoneNumber ?? entry.phoneNumberId}
                        {entry.phoneNumber?.friendlyName && (
                          <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{entry.phoneNumber.friendlyName}</div>
                        )}
                      </td>
                      <td style={{ padding: "0.5rem 0.875rem" }}>
                        <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "0.9375rem" }}>{entry.areaCode3}</span>
                      </td>
                      <td style={{ padding: "0.5rem 0.875rem", color: "var(--text-dim)", fontSize: "0.8125rem" }}>{entry.label ?? "—"}</td>
                      <td style={{ padding: "0.5rem 0.875rem" }}>
                        <span style={{ padding: "0.15rem 0.5rem", borderRadius: 4, fontSize: "0.75rem", fontWeight: 700, background: entry.isActive ? "#d1fae5" : "#f1f5f9", color: entry.isActive ? "#065f46" : "#64748b" }}>
                          {entry.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td style={{ padding: "0.5rem 0.875rem" }}>
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <button onClick={() => handleTogglePoolEntry(entry)} style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem", border: "1px solid var(--border)", borderRadius: 4, background: "var(--surface)", color: "var(--text)", cursor: "pointer" }}>
                            {entry.isActive ? "Deactivate" : "Activate"}
                          </button>
                          <button onClick={() => handleRemovePoolEntry(entry)} style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem", border: "1px solid #fca5a5", borderRadius: 4, background: "transparent", color: "#ef4444", cursor: "pointer" }}>
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Test / suggest input */}
          <div style={{ marginTop: "1.25rem", paddingTop: "1rem", borderTop: "1px solid var(--border)" }}>
            <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.5rem" }}>Test Local Presence</div>
            <p style={{ margin: "0 0 0.625rem", fontSize: "0.8125rem", color: "var(--text-dim)" }}>
              Enter a destination number to see which caller ID would be selected.
            </p>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="text"
                value={suggestTo}
                onChange={(e) => setSuggestTo(e.target.value)}
                placeholder="(512) 555-1234"
                style={{ padding: "0.375rem 0.625rem", border: "1px solid var(--border)", borderRadius: "0.375rem", fontSize: "0.875rem", background: "var(--surface)", color: "var(--text)", width: 200 }}
                onKeyDown={(e) => e.key === "Enter" && handleSuggest()}
              />
              <button onClick={handleSuggest} disabled={suggesting || !suggestTo.trim()} style={{ padding: "0.375rem 0.875rem", borderRadius: "0.375rem", background: "var(--accent)", color: "#fff", fontWeight: 600, fontSize: "0.8125rem", border: "none", cursor: "pointer", opacity: !suggestTo.trim() ? 0.5 : 1 }}>
                {suggesting ? "…" : "Test"}
              </button>
            </div>
            {suggestResult && (
              <div style={{ marginTop: "0.625rem", padding: "0.75rem", borderRadius: "0.5rem", background: suggestResult.matched ? "#d1fae5" : "#f1f5f9", border: `1px solid ${suggestResult.matched ? "#6ee7b7" : "var(--border)"}`, fontSize: "0.8125rem" }}>
                {suggestResult.matched ? (
                  <><strong>✓ Match found</strong> — Area code <code>{suggestResult.areaCode3}</code> → Caller ID: <strong>{suggestResult.selectedCallerId}</strong></>
                ) : (
                  <><strong>No match</strong> — {suggestResult.localPresenceEnabled ? `Area code ${suggestResult.areaCode3 ?? "?"} not in pool. Default caller ID will be used.` : "Local presence is disabled."}</>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── User access panel ───────────────────────────────────────────────── */}
      <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "1rem 1.25rem 0.75rem", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: "0.625rem" }}>
          <h3 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 600 }}>User Access</h3>
          <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
            Control which users can access CRM features and at what role.
          </span>
        </div>

        {usersLoading && (
          <div style={{ padding: "1rem 1.25rem" }}>
            <LoadingSkeleton rows={4} />
          </div>
        )}
        {usersError && (
          <div style={{ padding: "1rem 1.25rem", color: "#ef4444", fontSize: "0.875rem" }}>
            {usersError}
          </div>
        )}

        {!usersLoading && users.length === 0 && !usersError && (
          <div style={{ padding: "1.5rem 1.25rem", color: "var(--text-dim)", fontSize: "0.875rem" }}>
            No users found for this tenant.
          </div>
        )}

        {!usersLoading && users.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <thead>
                <tr style={{ background: "var(--surface-hover)" }}>
                  {["User", "System Role", "CRM Access", "CRM Role"].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "0.5rem 1rem",
                        textAlign: "left",
                        fontWeight: 600,
                        fontSize: "0.75rem",
                        color: "var(--text-dim)",
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u, idx) => {
                  const saving = userSaving[u.userId];
                  return (
                    <tr
                      key={u.userId}
                      style={{
                        borderTop: idx === 0 ? undefined : "1px solid var(--border)",
                        opacity: saving ? 0.6 : 1,
                        transition: "opacity 0.1s",
                      }}
                    >
                      <td style={{ padding: "0.625rem 1rem" }}>
                        <div style={{ fontWeight: 500 }}>{u.displayName || u.email}</div>
                        {u.displayName && u.displayName !== u.email && (
                          <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{u.email}</div>
                        )}
                      </td>
                      <td style={{ padding: "0.625rem 1rem" }}>
                        <span style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>
                          {SYSTEM_ROLE_LABELS[u.systemRole] || u.systemRole}
                        </span>
                      </td>
                      <td style={{ padding: "0.625rem 1rem" }}>
                        <Toggle
                          label={u.crmEnabled ? "Enabled" : "Disabled"}
                          checked={u.crmEnabled}
                          disabled={saving || !settings?.enabled}
                          onChange={(v) => updateUserAccess(u.userId, { enabled: v, role: u.crmRole ?? "AGENT" })}
                        />
                      </td>
                      <td style={{ padding: "0.625rem 1rem" }}>
                        {u.hasAccess ? (
                          <select
                            value={u.crmRole ?? "AGENT"}
                            disabled={saving || !u.crmEnabled || !settings?.enabled}
                            onChange={(e) =>
                              updateUserAccess(u.userId, { role: e.target.value, enabled: u.crmEnabled })
                            }
                            style={{
                              padding: "0.3rem 0.5rem",
                              borderRadius: "0.375rem",
                              border: "1px solid var(--border)",
                              background: "var(--surface)",
                              color: "var(--text)",
                              fontSize: "0.8125rem",
                              cursor: saving || !u.crmEnabled ? "not-allowed" : "pointer",
                              opacity: !u.crmEnabled || !settings?.enabled ? 0.45 : 1,
                            }}
                          >
                            {Object.entries(ROLE_LABELS).map(([val, label]) => (
                              <option key={val} value={val}>{label}</option>
                            ))}
                          </select>
                        ) : (
                          <span style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!settings?.enabled && !usersLoading && users.length > 0 && (
          <div style={{ padding: "0.625rem 1rem", borderTop: "1px solid var(--border)", fontSize: "0.75rem", color: "var(--text-dim)" }}>
            Enable CRM above to activate user access controls.
          </div>
        )}
      </section>
    </div>
  );
}

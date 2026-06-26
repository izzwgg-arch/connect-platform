"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppContext } from "../../../../hooks/useAppContext";
import { ConnectSelect } from "../../../../components/ConnectSelect";
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

type DeskPosition = { id: string; name: string; color: string | null };

type AiSettings = {
  aiEnabled: boolean;
  maxDocumentsPerReport: number;
  maxCharsPerDocument: number;
  maxTotalCharsPerReport: number;
  allowBatchGeneration: boolean;
  maxBatchReportsPerRun: number;
  regenerationCooldownMinutes: number;
  isDefault?: boolean;
};

type EmailSender = {
  id: string;
  emailAddress: string;
  label: string | null;
  scope: "USER" | "TENANT";
  status: string;
  replyTrackingEnabled: boolean;
  scopes: string[];
};

type WebsiteSubmissionRule = {
  id: string;
  connectionId: string;
  name: string;
  active: boolean;
  senderEmail: string | null;
  senderDomain: string | null;
  subjectPattern: string | null;
  fieldMap: Record<string, string>;
  attachmentExpectations: Array<{ fileName?: string; mimeType?: string; documentType?: string }>;
  assignmentUserId: string | null;
  confidenceThreshold: number;
  mode: "AUTO_CREATE" | "REVIEW_FIRST";
  lastMatchedAt: string | null;
  connection?: { emailAddress: string; label: string | null };
  _count?: { submissions: number };
};

type WebsiteSubmissionAnalysis = {
  detectedSenderEmail: string | null;
  detectedSenderDomain: string | null;
  detectedSubjectPattern: string | null;
  mappedFields: Record<string, string>;
  unmappedSummary: string[];
  attachmentExpectations: Array<{ fileName?: string; mimeType?: string; documentType: string }>;
  confidence: number;
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
    } catch (e: any) {
      setUsersError(e?.message || "Failed to update user access. Please try again.");
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

  // ── AI Settings state ────────────────────────────────────────────────────
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiSettingsLoading, setAiSettingsLoading] = useState(true);
  const [aiSettingsSaving, setAiSettingsSaving] = useState(false);
  const [aiSettingsError, setAiSettingsError] = useState<string | null>(null);
  const [aiSettingsDraft, setAiSettingsDraft] = useState<AiSettings | null>(null);

  const loadAiSettings = useCallback(async () => {
    setAiSettingsLoading(true);
    setAiSettingsError(null);
    try {
      const s = await apiGet<AiSettings>("/crm/ai-settings");
      setAiSettings(s);
      setAiSettingsDraft(s);
    } catch (e: any) {
      setAiSettingsError(e?.message || "Failed to load AI settings");
    } finally {
      setAiSettingsLoading(false);
    }
  }, []);

  useEffect(() => { if (isAdmin) loadAiSettings(); }, [isAdmin, loadAiSettings]);

  const saveAiSettings = async () => {
    if (!aiSettingsDraft) return;
    setAiSettingsSaving(true);
    setAiSettingsError(null);
    try {
      const saved = await apiPut<AiSettings>("/crm/ai-settings", aiSettingsDraft);
      setAiSettings(saved);
      setAiSettingsDraft(saved);
    } catch (e: any) {
      setAiSettingsError(e?.message || "Failed to save AI settings");
    } finally {
      setAiSettingsSaving(false);
    }
  };

  const patchAiDraft = (patch: Partial<AiSettings>) => {
    setAiSettingsDraft((prev) => prev ? { ...prev, ...patch } : null);
  };

  // ── Desk Positions (contact tags) ──────────────────────────────────────────
  const [positions, setPositions] = useState<DeskPosition[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(true);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [newPositionName, setNewPositionName] = useState("");
  const [newPositionColor, setNewPositionColor] = useState("#6366f1");
  const [addingPosition, setAddingPosition] = useState(false);
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);
  const [editPositionName, setEditPositionName] = useState("");
  const [editPositionColor, setEditPositionColor] = useState("");
  const [savingPositionId, setSavingPositionId] = useState<string | null>(null);
  const [deletingPositionId, setDeletingPositionId] = useState<string | null>(null);

  const loadPositions = useCallback(async () => {
    setPositionsLoading(true);
    setPositionsError(null);
    try {
      const res = await apiGet<{ tags: DeskPosition[] }>("/crm/contact-tags");
      setPositions(res.tags);
    } catch (e: any) {
      setPositionsError(e?.message || "Failed to load positions");
    } finally {
      setPositionsLoading(false);
    }
  }, []);

  useEffect(() => { loadPositions(); }, [loadPositions]);

  const addPosition = async () => {
    const name = newPositionName.trim();
    if (!name) return;
    setAddingPosition(true);
    setPositionsError(null);
    try {
      const res = await apiPost<{ tag: DeskPosition }>("/crm/contact-tags", { name, color: newPositionColor });
      setPositions((prev) => [...prev, res.tag].sort((a, b) => a.name.localeCompare(b.name)));
      setNewPositionName("");
    } catch (e: any) {
      setPositionsError(e?.message || "Failed to create position");
    } finally {
      setAddingPosition(false);
    }
  };

  const savePosition = async (id: string) => {
    const name = editPositionName.trim();
    if (!name) return;
    setSavingPositionId(id);
    setPositionsError(null);
    try {
      const res = await apiPatch<{ tag: DeskPosition }>(`/crm/contact-tags/${id}`, { name, color: editPositionColor || null });
      setPositions((prev) => prev.map((p) => p.id === id ? res.tag : p).sort((a, b) => a.name.localeCompare(b.name)));
      setEditingPositionId(null);
    } catch (e: any) {
      setPositionsError(e?.message || "Failed to save position");
    } finally {
      setSavingPositionId(null);
    }
  };

  const deletePosition = async (id: string) => {
    if (!confirm("Delete this desk position? It will be removed from all contacts.")) return;
    setDeletingPositionId(id);
    setPositionsError(null);
    try {
      await apiDelete(`/crm/contact-tags/${id}`);
      setPositions((prev) => prev.filter((p) => p.id !== id));
    } catch (e: any) {
      setPositionsError(e?.message || "Failed to delete position");
    } finally {
      setDeletingPositionId(null);
    }
  };

  // ── Website submission email rules ─────────────────────────────────────────
  const [emailSenders, setEmailSenders] = useState<EmailSender[]>([]);
  const [websiteRules, setWebsiteRules] = useState<WebsiteSubmissionRule[]>([]);
  const [websiteRulesLoading, setWebsiteRulesLoading] = useState(false);
  const [websiteRulesError, setWebsiteRulesError] = useState<string | null>(null);
  const [learnOpen, setLearnOpen] = useState(false);
  const [sampleEmail, setSampleEmail] = useState("");
  const [analysis, setAnalysis] = useState<WebsiteSubmissionAnalysis | null>(null);
  const [analyzingSample, setAnalyzingSample] = useState(false);
  const [savingRule, setSavingRule] = useState(false);
  const [ruleDraft, setRuleDraft] = useState({
    name: "Website submission",
    connectionId: "",
    assignmentUserId: "",
    mode: "AUTO_CREATE" as "AUTO_CREATE" | "REVIEW_FIRST",
    confidenceThreshold: 0.75,
    active: true,
  });

  const loadWebsiteSubmissionRules = useCallback(async () => {
    if (!isAdmin) return;
    setWebsiteRulesLoading(true);
    setWebsiteRulesError(null);
    try {
      const [rulesRes, sendersRes] = await Promise.all([
        apiGet<{ rules: WebsiteSubmissionRule[] }>("/crm/email/website-submission-rules"),
        apiGet<{ senders: EmailSender[] }>("/crm/email/connections"),
      ]);
      setWebsiteRules(rulesRes.rules);
      const usableSenders = sendersRes.senders.filter((s) => s.status === "CONNECTED" && s.replyTrackingEnabled && s.scopes?.includes("https://www.googleapis.com/auth/gmail.readonly"));
      setEmailSenders(usableSenders);
      setRuleDraft((prev) => ({ ...prev, connectionId: prev.connectionId || usableSenders[0]?.id || "" }));
    } catch (e: any) {
      setWebsiteRulesError(e?.message || "Failed to load website submission rules");
    } finally {
      setWebsiteRulesLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { loadWebsiteSubmissionRules(); }, [loadWebsiteSubmissionRules]);

  const analyzeSample = async () => {
    if (!sampleEmail.trim()) return;
    setAnalyzingSample(true);
    setWebsiteRulesError(null);
    try {
      const res = await apiPost<{ analysis: WebsiteSubmissionAnalysis }>("/crm/email/website-submission-rules/analyze-sample", { rawEmail: sampleEmail });
      setAnalysis(res.analysis);
      setRuleDraft((prev) => ({
        ...prev,
        name: prev.name || "Website submission",
      }));
    } catch (e: any) {
      setWebsiteRulesError(e?.message || "Failed to analyze sample");
    } finally {
      setAnalyzingSample(false);
    }
  };

  const saveWebsiteRule = async () => {
    if (!analysis || !ruleDraft.connectionId) return;
    setSavingRule(true);
    setWebsiteRulesError(null);
    try {
      await apiPost("/crm/email/website-submission-rules", {
        ...ruleDraft,
        assignmentUserId: ruleDraft.assignmentUserId || null,
        senderEmail: analysis.detectedSenderEmail,
        senderDomain: analysis.detectedSenderDomain,
        subjectPattern: analysis.detectedSubjectPattern,
        fieldMap: analysis.mappedFields,
        attachmentExpectations: analysis.attachmentExpectations,
        sampleMetadata: {
          senderEmail: analysis.detectedSenderEmail,
          senderDomain: analysis.detectedSenderDomain,
          subjectPattern: analysis.detectedSubjectPattern,
          mappedFieldKeys: Object.keys(analysis.mappedFields),
          unmappedCount: analysis.unmappedSummary.length,
        },
      });
      setLearnOpen(false);
      setSampleEmail("");
      setAnalysis(null);
      loadWebsiteSubmissionRules();
    } catch (e: any) {
      setWebsiteRulesError(e?.message || "Failed to save rule");
    } finally {
      setSavingRule(false);
    }
  };

  const toggleWebsiteRule = async (rule: WebsiteSubmissionRule) => {
    try {
      await apiPatch(`/crm/email/website-submission-rules/${rule.id}`, { active: !rule.active });
      loadWebsiteSubmissionRules();
    } catch (e: any) {
      setWebsiteRulesError(e?.message || "Failed to update rule");
    }
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

      {/* ── Website Submission Email Rules ─────────────────────────────────── */}
      <section className="panel" style={{ padding: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", marginBottom: "1rem" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 600 }}>Email / Website Submissions</h3>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.8125rem", color: "var(--text-dim)" }}>
              Teach Connect what website form emails look like. Matching future emails can create or update CRM contacts, attach documents, and notify the assigned user.
            </p>
          </div>
          <button
            onClick={() => setLearnOpen((v) => !v)}
            style={{ padding: "0.4rem 0.875rem", borderRadius: "0.5rem", background: "var(--accent)", color: "#fff", fontWeight: 600, fontSize: "0.8125rem", border: "none", cursor: "pointer" }}
          >
            Learn Website Submission Email
          </button>
        </div>

        {websiteRulesError && <p style={{ color: "#ef4444", fontSize: "0.8125rem", margin: "0 0 0.75rem" }}>{websiteRulesError}</p>}
        {websiteRulesLoading ? <LoadingSkeleton rows={2} /> : websiteRules.length === 0 ? (
          <p style={{ margin: 0, color: "var(--text-dim)", fontSize: "0.875rem" }}>No learned website submission rules yet.</p>
        ) : (
          <div style={{ display: "grid", gap: "0.75rem", marginBottom: learnOpen ? "1rem" : 0 }}>
            {websiteRules.map((rule) => (
              <div key={rule.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", padding: "0.875rem", border: "1px solid var(--border)", borderRadius: "0.75rem", background: "var(--surface)" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <strong style={{ fontSize: "0.9rem" }}>{rule.name}</strong>
                    <span style={{ padding: "0.1rem 0.45rem", borderRadius: 999, fontSize: "0.7rem", fontWeight: 700, background: rule.active ? "#d1fae5" : "#f1f5f9", color: rule.active ? "#065f46" : "#64748b" }}>
                      {rule.active ? "Active" : "Disabled"}
                    </span>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{rule.mode === "AUTO_CREATE" ? "Auto-create" : "Review first"}</span>
                  </div>
                  <div style={{ marginTop: 4, fontSize: "0.78rem", color: "var(--text-dim)" }}>
                    {rule.connection?.label || rule.connection?.emailAddress || "Mailbox"} · {rule.senderEmail || rule.senderDomain || "Any sender"} · {Object.keys(rule.fieldMap || {}).length} mapped fields · {rule._count?.submissions ?? 0} submissions
                  </div>
                </div>
                <button
                  onClick={() => toggleWebsiteRule(rule)}
                  style={{ padding: "0.35rem 0.75rem", borderRadius: "0.5rem", background: "var(--surface-hover)", border: "1px solid var(--border)", color: "var(--text)", fontWeight: 600, fontSize: "0.78rem", cursor: "pointer" }}
                >
                  {rule.active ? "Disable" : "Enable"}
                </button>
              </div>
            ))}
          </div>
        )}

        {learnOpen && (
          <div style={{ marginTop: "1rem", padding: "1rem", border: "1px solid var(--border)", borderRadius: "0.75rem", background: "var(--surface-hover)" }}>
            <div style={{ display: "grid", gap: "0.75rem" }}>
              <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 700, color: "var(--text-dim)", marginBottom: 4 }}>Rule name</label>
                  <input value={ruleDraft.name} onChange={(e) => setRuleDraft((p) => ({ ...p, name: e.target.value }))} style={{ width: "100%", padding: "0.45rem 0.6rem", border: "1px solid var(--border)", borderRadius: "0.5rem", background: "var(--surface)", color: "var(--text)" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 700, color: "var(--text-dim)", marginBottom: 4 }}>Mailbox/account</label>
                  <ConnectSelect
                    value={ruleDraft.connectionId}
                    onChange={(value) => setRuleDraft((p) => ({ ...p, connectionId: value }))}
                    placeholder="Select connected mailbox"
                    options={emailSenders.map((s) => ({ value: s.id, label: `${s.label || s.emailAddress} (${s.scope})` }))}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 700, color: "var(--text-dim)", marginBottom: 4 }}>Assigned user</label>
                  <ConnectSelect
                    value={ruleDraft.assignmentUserId}
                    onChange={(value) => setRuleDraft((p) => ({ ...p, assignmentUserId: value }))}
                    placeholder="First available admin/user"
                    options={[{ value: "", label: "Auto assign" }, ...users.filter((u) => u.crmEnabled).map((u) => ({ value: u.userId, label: u.displayName || u.email }))]}
                  />
                </div>
              </div>

              <textarea
                value={sampleEmail}
                onChange={(e) => setSampleEmail(e.target.value)}
                placeholder="Paste the raw sample email or copied message body here..."
                rows={8}
                style={{ width: "100%", padding: "0.65rem", border: "1px solid var(--border)", borderRadius: "0.75rem", background: "var(--surface)", color: "var(--text)", fontFamily: "monospace", fontSize: "0.8rem" }}
              />
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                <button onClick={analyzeSample} disabled={analyzingSample || !sampleEmail.trim()} style={{ padding: "0.4rem 0.875rem", borderRadius: "0.5rem", background: "var(--accent)", color: "#fff", fontWeight: 700, fontSize: "0.8125rem", border: "none", cursor: analyzingSample ? "not-allowed" : "pointer", opacity: !sampleEmail.trim() ? 0.55 : 1 }}>
                  {analyzingSample ? "Analyzing..." : "Test extraction"}
                </button>
                <select value={ruleDraft.mode} onChange={(e) => setRuleDraft((p) => ({ ...p, mode: e.target.value as any }))} style={{ padding: "0.4rem 0.6rem", borderRadius: "0.5rem", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)" }}>
                  <option value="AUTO_CREATE">Auto-create when confident</option>
                  <option value="REVIEW_FIRST">Review first</option>
                </select>
              </div>

              {analysis && (
                <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                  <div style={{ padding: "0.75rem", borderRadius: "0.65rem", background: "var(--surface)", border: "1px solid var(--border)" }}>
                    <strong style={{ fontSize: "0.8rem" }}>Detected match</strong>
                    <p style={{ margin: "0.35rem 0 0", fontSize: "0.78rem", color: "var(--text-dim)" }}>Sender: {analysis.detectedSenderEmail || analysis.detectedSenderDomain || "Unknown"}</p>
                    <p style={{ margin: "0.2rem 0 0", fontSize: "0.78rem", color: "var(--text-dim)" }}>Subject: {analysis.detectedSubjectPattern || "Any"}</p>
                    <p style={{ margin: "0.2rem 0 0", fontSize: "0.78rem", color: "var(--text-dim)" }}>Confidence: {Math.round(analysis.confidence * 100)}%</p>
                  </div>
                  <div style={{ padding: "0.75rem", borderRadius: "0.65rem", background: "var(--surface)", border: "1px solid var(--border)" }}>
                    <strong style={{ fontSize: "0.8rem" }}>Mapped CRM fields</strong>
                    <p style={{ margin: "0.35rem 0 0", fontSize: "0.78rem", color: "var(--text-dim)" }}>{Object.keys(analysis.mappedFields).length ? Object.keys(analysis.mappedFields).join(", ") : "No CRM fields detected yet"}</p>
                  </div>
                  <div style={{ padding: "0.75rem", borderRadius: "0.65rem", background: "var(--surface)", border: "1px solid var(--border)" }}>
                    <strong style={{ fontSize: "0.8rem" }}>Unmapped summary</strong>
                    <p style={{ margin: "0.35rem 0 0", fontSize: "0.78rem", color: "var(--text-dim)" }}>{analysis.unmappedSummary.slice(0, 3).join("; ") || "None"}</p>
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                <button onClick={() => setLearnOpen(false)} style={{ padding: "0.4rem 0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", cursor: "pointer" }}>Cancel</button>
                <button onClick={saveWebsiteRule} disabled={!analysis || !ruleDraft.connectionId || savingRule} style={{ padding: "0.4rem 0.875rem", borderRadius: "0.5rem", border: "none", background: "var(--accent)", color: "#fff", fontWeight: 700, cursor: savingRule ? "not-allowed" : "pointer", opacity: (!analysis || !ruleDraft.connectionId) ? 0.55 : 1 }}>
                  {savingRule ? "Saving..." : "Save rule"}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

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
                <ConnectSelect
                  value={addPhoneId}
                  onChange={(value) => {
                    setAddPhoneId(value);
                    const n = availableNumbers.find((x) => x.id === value);
                    if (n?.areaCode) setAddAreaCode(n.areaCode.replace(/\D/g, "").slice(0, 3));
                  }}
                  placeholder="— select number —"
                  style={{ minWidth: 200 }}
                  options={availableNumbers.map((n) => ({
                    value: n.id,
                    label: `${n.phoneNumber}${n.friendlyName ? ` (${n.friendlyName})` : ""}`,
                  }))}
                />
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
                          <ConnectSelect
                            value={u.crmRole ?? "AGENT"}
                            disabled={saving || !u.crmEnabled || !settings?.enabled}
                            onChange={(value) =>
                              updateUserAccess(u.userId, { role: value, enabled: u.crmEnabled })
                            }
                            size="sm"
                            options={Object.entries(ROLE_LABELS).map(([val, label]) => ({ value: val, label }))}
                          />
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

      {/* ── AI Intelligence Settings ────────────────────────────────────────── */}
      <section className="panel" style={{ overflow: "hidden" }}>
        <div
          style={{
            padding: "1rem 1.25rem",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 600 }}>AI Intelligence Settings</h3>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.8125rem", color: "var(--text-dim)" }}>
              Control AI Lead Intelligence limits and cost guardrails for this tenant.
              Only CRM admins can change these settings.
            </p>
          </div>
        </div>

        {aiSettingsLoading ? (
          <div style={{ padding: "1.5rem" }}>
            <LoadingSkeleton rows={5} />
          </div>
        ) : aiSettingsError ? (
          <div style={{ padding: "1rem 1.25rem", color: "var(--error, #ef4444)", fontSize: "0.875rem" }}>
            {aiSettingsError}
          </div>
        ) : aiSettingsDraft ? (
          <div style={{ padding: "1.25rem" }}>
            {/* Master switch */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0.75rem 1rem",
                background: "var(--surface-2, rgba(255,255,255,0.04))",
                borderRadius: "0.375rem",
                marginBottom: "1.25rem",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>AI Intelligence Enabled</div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: 2 }}>
                  Master switch — disabling blocks all AI generation for this tenant.
                </div>
              </div>
              <Toggle
                label={aiSettingsDraft.aiEnabled ? "Enabled" : "Disabled"}
                checked={aiSettingsDraft.aiEnabled}
                onChange={(v) => patchAiDraft({ aiEnabled: v })}
                disabled={aiSettingsSaving}
              />
            </div>

            {/* Numeric settings grid */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                gap: "1rem",
                marginBottom: "1.25rem",
              }}
            >
              {[
                {
                  key: "maxDocumentsPerReport" as const,
                  label: "Max Documents per Report",
                  min: 1,
                  max: 10,
                  help: "Maximum imported documents sent to the AI per contact (hard cap: 10).",
                },
                {
                  key: "maxCharsPerDocument" as const,
                  label: "Max Chars per Document",
                  min: 100,
                  max: 5000,
                  help: "Characters of extracted text included per document (hard cap: 5 000).",
                },
                {
                  key: "maxTotalCharsPerReport" as const,
                  label: "Max Total Chars per Report",
                  min: 500,
                  max: 25000,
                  help: "Total characters across all documents sent to the AI (hard cap: 25 000).",
                },
                {
                  key: "maxBatchReportsPerRun" as const,
                  label: "Max Batch Reports per Run",
                  min: 1,
                  max: 25,
                  help: "Maximum contacts processed in a single batch generation call (hard cap: 25).",
                },
                {
                  key: "regenerationCooldownMinutes" as const,
                  label: "Regeneration Cooldown (minutes)",
                  min: 0,
                  max: 10080,
                  help: "Minimum minutes between force-regenerations for the same contact. 0 = no cooldown. CRM admins can bypass.",
                },
              ].map(({ key, label, min, max, help }) => (
                <div key={key}>
                  <label style={{ fontSize: "0.8125rem", fontWeight: 500, display: "block", marginBottom: "0.375rem" }}>
                    {label}
                  </label>
                  <input
                    type="number"
                    min={min}
                    max={max}
                    value={aiSettingsDraft[key]}
                    disabled={aiSettingsSaving || !aiSettingsDraft.aiEnabled}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (!isNaN(n)) patchAiDraft({ [key]: Math.max(min, Math.min(max, n)) });
                    }}
                    style={{
                      width: "100%",
                      padding: "0.4375rem 0.625rem",
                      background: "var(--input-bg, rgba(255,255,255,0.06))",
                      border: "1px solid var(--border)",
                      borderRadius: "0.375rem",
                      color: "var(--text)",
                      fontSize: "0.875rem",
                    }}
                  />
                  <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.25rem" }}>
                    {help}
                  </div>
                </div>
              ))}
            </div>

            {/* Batch generation toggle */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0.75rem 1rem",
                background: "var(--surface-2, rgba(255,255,255,0.04))",
                borderRadius: "0.375rem",
                marginBottom: "1.25rem",
              }}
            >
              <div>
                <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>Allow Batch Generation</div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: 2 }}>
                  If disabled, the "Generate Intelligence" action on import batches is blocked.
                </div>
              </div>
              <Toggle
                label={aiSettingsDraft.allowBatchGeneration ? "Allowed" : "Blocked"}
                checked={aiSettingsDraft.allowBatchGeneration}
                onChange={(v) => patchAiDraft({ allowBatchGeneration: v })}
                disabled={aiSettingsSaving || !aiSettingsDraft.aiEnabled}
              />
            </div>

            {/* Error */}
            {aiSettingsError && (
              <div style={{ color: "var(--error, #ef4444)", fontSize: "0.8125rem", marginBottom: "0.75rem" }}>
                {aiSettingsError}
              </div>
            )}

            {/* Save button */}
            <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
              <button
                onClick={saveAiSettings}
                disabled={aiSettingsSaving}
                style={{
                  padding: "0.5rem 1.25rem",
                  background: "var(--accent, #3b82f6)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "0.375rem",
                  cursor: aiSettingsSaving ? "not-allowed" : "pointer",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                  opacity: aiSettingsSaving ? 0.6 : 1,
                }}
              >
                {aiSettingsSaving ? "Saving…" : "Save AI Settings"}
              </button>
              {aiSettings && (
                <button
                  onClick={() => setAiSettingsDraft(aiSettings)}
                  disabled={aiSettingsSaving}
                  style={{
                    padding: "0.5rem 1rem",
                    background: "transparent",
                    color: "var(--text-dim)",
                    border: "1px solid var(--border)",
                    borderRadius: "0.375rem",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                  }}
                >
                  Reset
                </button>
              )}
              {aiSettings?.isDefault && (
                <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
                  Using defaults — no custom settings saved yet.
                </span>
              )}
            </div>
          </div>
        ) : null}
      </section>

      {/* ── Desk Positions ──────────────────────────────────────────────────── */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "1rem" }}>Desk Positions</h2>
        <p style={{ fontSize: "0.8125rem", color: "var(--text-dim)", marginBottom: "1.25rem" }}>
          Desk positions are custom labels you can assign to contacts. They appear as filter options on the My Queue,
          Campaign, and Contacts pages automatically.
        </p>

        {positionsError && (
          <div style={{ color: "var(--error, #ef4444)", fontSize: "0.8125rem", marginBottom: "0.75rem" }}>
            {positionsError}
          </div>
        )}

        {/* Existing positions list */}
        {positionsLoading ? (
          <LoadingSkeleton lines={3} />
        ) : positions.length === 0 ? (
          <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)", marginBottom: "1rem" }}>
            No desk positions yet. Add one below.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "1.25rem" }}>
            {positions.map((pos) =>
              editingPositionId === pos.id ? (
                <div
                  key={pos.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    padding: "0.5rem 0.75rem",
                    background: "var(--surface-2, rgba(255,255,255,0.04))",
                    borderRadius: "0.375rem",
                    border: "1px solid var(--border)",
                  }}
                >
                  <input
                    type="color"
                    value={editPositionColor || "#6366f1"}
                    onChange={(e) => setEditPositionColor(e.target.value)}
                    style={{ width: 28, height: 28, border: "none", background: "none", cursor: "pointer", padding: 0 }}
                  />
                  <input
                    autoFocus
                    type="text"
                    value={editPositionName}
                    onChange={(e) => setEditPositionName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") savePosition(pos.id); if (e.key === "Escape") setEditingPositionId(null); }}
                    style={{
                      flex: 1,
                      padding: "0.3125rem 0.5rem",
                      background: "var(--input-bg, rgba(255,255,255,0.06))",
                      border: "1px solid var(--border)",
                      borderRadius: "0.25rem",
                      color: "var(--text)",
                      fontSize: "0.875rem",
                    }}
                  />
                  <button
                    onClick={() => savePosition(pos.id)}
                    disabled={savingPositionId === pos.id}
                    style={{ padding: "0.3125rem 0.75rem", background: "var(--accent, #3b82f6)", color: "#fff", border: "none", borderRadius: "0.25rem", cursor: "pointer", fontSize: "0.8125rem" }}
                  >
                    {savingPositionId === pos.id ? "Saving…" : "Save"}
                  </button>
                  <button
                    onClick={() => setEditingPositionId(null)}
                    style={{ padding: "0.3125rem 0.75rem", background: "transparent", color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: "0.25rem", cursor: "pointer", fontSize: "0.8125rem" }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div
                  key={pos.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                    padding: "0.5rem 0.75rem",
                    background: "var(--surface-2, rgba(255,255,255,0.04))",
                    borderRadius: "0.375rem",
                    border: "1px solid var(--border)",
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      background: pos.color || "var(--text-dim)",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ flex: 1, fontSize: "0.875rem" }}>{pos.name}</span>
                  <button
                    onClick={() => { setEditingPositionId(pos.id); setEditPositionName(pos.name); setEditPositionColor(pos.color || "#6366f1"); }}
                    style={{ padding: "0.25rem 0.625rem", background: "transparent", color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: "0.25rem", cursor: "pointer", fontSize: "0.75rem" }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deletePosition(pos.id)}
                    disabled={deletingPositionId === pos.id}
                    style={{ padding: "0.25rem 0.625rem", background: "transparent", color: "var(--error, #ef4444)", border: "1px solid var(--error, #ef4444)", borderRadius: "0.25rem", cursor: "pointer", fontSize: "0.75rem" }}
                  >
                    {deletingPositionId === pos.id ? "…" : "Delete"}
                  </button>
                </div>
              )
            )}
          </div>
        )}

        {/* Add new position */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.75rem",
            background: "var(--surface-2, rgba(255,255,255,0.04))",
            borderRadius: "0.375rem",
            border: "1px solid var(--border)",
          }}
        >
          <input
            type="color"
            value={newPositionColor}
            onChange={(e) => setNewPositionColor(e.target.value)}
            title="Pick a color"
            style={{ width: 28, height: 28, border: "none", background: "none", cursor: "pointer", padding: 0 }}
          />
          <input
            type="text"
            placeholder="New position name…"
            value={newPositionName}
            onChange={(e) => setNewPositionName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addPosition(); }}
            style={{
              flex: 1,
              padding: "0.4375rem 0.625rem",
              background: "var(--input-bg, rgba(255,255,255,0.06))",
              border: "1px solid var(--border)",
              borderRadius: "0.375rem",
              color: "var(--text)",
              fontSize: "0.875rem",
            }}
          />
          <button
            onClick={addPosition}
            disabled={addingPosition || !newPositionName.trim()}
            style={{
              padding: "0.4375rem 1rem",
              background: "var(--accent, #3b82f6)",
              color: "#fff",
              border: "none",
              borderRadius: "0.375rem",
              cursor: addingPosition || !newPositionName.trim() ? "not-allowed" : "pointer",
              opacity: addingPosition || !newPositionName.trim() ? 0.6 : 1,
              fontSize: "0.875rem",
              fontWeight: 500,
              whiteSpace: "nowrap",
            }}
          >
            {addingPosition ? "Adding…" : "Add Position"}
          </button>
        </div>
      </section>
    </div>
  );
}

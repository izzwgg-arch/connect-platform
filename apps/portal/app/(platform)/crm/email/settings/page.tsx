"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Mail,
  Users,
  User as UserIcon,
  Lock,
  Star,
  Send,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plus,
  Pencil,
  X,
  Save,
} from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../../components/crm";
import { apiGet, apiPost, apiPatch, apiDelete } from "../../../../../services/apiClient";

type Sender = {
  id: string;
  scope: "USER" | "TENANT";
  emailAddress: string;
  displayName: string | null;
  label: string | null;
  senderName: string | null;
  isDefaultForTenant: boolean;
  status: string;
  isMine: boolean;
  canManage: boolean;
  replyTrackingEnabled?: boolean;
  lastSyncAt?: string | null;
  lastError?: string | null;
};

type ConnectionsResp = { senders: Sender[]; canManageTenantSenders: boolean; autoSyncEnabled?: boolean; autoSyncIntervalMs?: number };

function isConnected(s: Sender): boolean {
  return s.status === "CONNECTED";
}

export default function CrmEmailSettingsPage() {
  const [data, setData] = useState<ConnectionsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | "_connect_user_" | "_connect_tenant_" | null>(null);

  // Inline edit state (per-row)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editSenderName, setEditSenderName] = useState("");

  const justConnected = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("connected") === "1";
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<ConnectionsResp>("/crm/email/connections");
      setData(res);
    } catch (e: any) {
      setError(e?.message || "Failed to load email connections");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const userSender = data?.senders.find((s) => s.scope === "USER" && s.isMine) ?? null;
  const tenantSenders = data?.senders.filter((s) => s.scope === "TENANT") ?? [];
  const canManageTenant = Boolean(data?.canManageTenantSenders);
  const autoSyncEnabled = Boolean(data?.autoSyncEnabled);
  const autoSyncIntervalMs = Math.max(60000, Number(data?.autoSyncIntervalMs || 0));

  const startOAuth = async (
    scope: "USER" | "TENANT",
    label?: string,
    isDefaultForTenant?: boolean,
    enableReplyTracking?: boolean,
  ) => {
    setBusyId(scope === "USER" ? "_connect_user_" : "_connect_tenant_");
    setError(null);
    try {
      const res = await apiPost<{ url: string }>("/crm/email/oauth/start", {
        scope,
        label: label ?? undefined,
        isDefaultForTenant: isDefaultForTenant ?? undefined,
        bodyCacheMode: "METADATA_ONLY",
        enableReplyTracking: Boolean(enableReplyTracking),
      });
      if (res?.url) window.location.href = res.url;
    } catch (e: any) {
      setError(e?.message || "Failed to start OAuth");
    } finally {
      setBusyId(null);
    }
  };

  const handleConnectTenant = async () => {
    const label = window.prompt(
      "Optional label for this shared mailbox (e.g. 'Sales Inbox'). Leave blank to use the mailbox display name.",
      "",
    );
    if (label === null) return; // user cancelled
    await startOAuth("TENANT", label.trim() || undefined, true);
  };

  const handleEnableReplyTracking = async (s: Sender) => {
    setBusyId(s.id);
    setError(null);
    try {
      await startOAuth(s.scope, undefined, undefined, true);
    } catch (e: any) {
      setError(e?.message || "Failed to enable reply tracking");
    } finally {
      setBusyId(null);
    }
  };

  const handleSyncNow = async (s: Sender) => {
    setBusyId(s.id);
    setError(null);
    try {
      await apiPost<{ ok: boolean; queued: number }>("/crm/email/sync-now", { connectionId: s.id });
      alert("Sync queued. Check Recent replies in CRM Email.");
    } catch (e: any) {
      setError(e?.message || "Failed to queue sync");
    } finally {
      setBusyId(null);
    }
  };

  const handleDisconnect = async (s: Sender) => {
    const what = s.scope === "USER" ? "your personal email connection" : `the shared mailbox ${s.emailAddress}`;
    if (!confirm(`Disconnect ${what}?`)) return;
    setBusyId(s.id);
    setError(null);
    try {
      await apiDelete(`/crm/email/connections/${s.id}`);
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to disconnect");
    } finally {
      setBusyId(null);
    }
  };

  const handleTest = async (s: Sender) => {
    setBusyId(s.id);
    setError(null);
    try {
      await apiPost<{ ok: boolean }>("/crm/email/connection/test", { connectionId: s.id });
      alert(`Test email queued. Check ${s.emailAddress}.`);
    } catch (e: any) {
      setError(e?.message || "Failed to queue test email");
    } finally {
      setBusyId(null);
    }
  };

  const handleSetDefault = async (s: Sender) => {
    setBusyId(s.id);
    setError(null);
    try {
      await apiPatch(`/crm/email/connections/${s.id}`, { isDefaultForTenant: true });
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to set default");
    } finally {
      setBusyId(null);
    }
  };

  const startEdit = (s: Sender) => {
    setEditingId(s.id);
    setEditLabel(s.label || "");
    setEditSenderName(s.senderName || "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditLabel("");
    setEditSenderName("");
  };

  const saveEdit = async (s: Sender) => {
    setBusyId(s.id);
    setError(null);
    try {
      await apiPatch(`/crm/email/connections/${s.id}`, {
        label: editLabel.trim(),
        senderName: editSenderName.trim(),
      });
      cancelEdit();
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to save");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <CRMPageShell innerClassName="space-y-4">
      <CRMPageHeader
        icon={<Mail className="h-5 w-5" />}
        title="CRM Email Settings"
        subtitle="Send CRM emails from your personal Google account or a tenant-shared mailbox. Metadata-first — Connect never archives inboxes."
      />

      <div className="flex items-center gap-2 rounded-crm border border-crm-border/70 bg-crm-surface-2/40 px-3 py-2 text-xs text-crm-muted">
        <span className="font-semibold text-crm-text">Auto-sync:</span>
        {autoSyncEnabled ? (
          <>
            <span className="text-crm-success">Enabled</span>
            {autoSyncIntervalMs ? <span>· every {Math.round(autoSyncIntervalMs / 60000)} min</span> : null}
          </>
        ) : (
          <span className="text-crm-warning">Disabled</span>
        )}
      </div>

      {justConnected && (
        <div className="flex items-center gap-2 rounded-crm border border-crm-success/40 bg-crm-success/10 px-3 py-2 text-sm text-crm-success">
          <CheckCircle2 className="h-4 w-4" /> Connected successfully.
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-crm border border-crm-danger/40 bg-crm-danger/10 px-3 py-2 text-sm text-crm-danger">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      {/* ─── My Email ────────────────────────────────────────────────────────── */}
      <CRMCard className="p-4 sm:p-5">
        <div className="mb-3 flex items-center gap-2">
          <UserIcon className="h-4 w-4 text-crm-muted" />
          <h3 className="text-sm font-semibold text-crm-text">My Email</h3>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-crm-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : !userSender || !isConnected(userSender) ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-crm border border-crm-border/70 bg-crm-surface-2/40 px-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-crm-text">No personal sender connected</p>
              <p className="mt-0.5 text-xs text-crm-muted">
                Connect your Google account to send CRM emails as yourself. Send-only scope — Connect never reads your inbox.
              </p>
            </div>
            <button
              type="button"
              className={cn(crm.btnPrimary, "text-xs")}
              onClick={() => startOAuth("USER")}
              disabled={busyId === "_connect_user_"}
            >
              {busyId === "_connect_user_" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
              Connect Google
            </button>
          </div>
        ) : (
          <SenderRow
            sender={userSender}
            editingId={editingId}
            editLabel={editLabel}
            editSenderName={editSenderName}
            busyId={busyId}
            onEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSaveEdit={saveEdit}
            onLabelChange={setEditLabel}
            onSenderNameChange={setEditSenderName}
            onTest={handleTest}
            onEnableReplyTracking={handleEnableReplyTracking}
            onSyncNow={handleSyncNow}
            onDisconnect={handleDisconnect}
            onSetDefault={handleSetDefault}
            isAdmin={canManageTenant}
          />
        )}
      </CRMCard>

      {/* ─── Tenant Shared Email ─────────────────────────────────────────────── */}
      <CRMCard className="p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-crm-muted" />
            <h3 className="text-sm font-semibold text-crm-text">Tenant Shared Email</h3>
            {!canManageTenant && (
              <span className={cn(crm.chip, "text-[10px]")} title="Read-only — ask a CRM admin to manage shared senders">
                <Lock className="h-3 w-3" /> Read-only
              </span>
            )}
          </div>
          {canManageTenant && (
            <button
              type="button"
              className={cn(crm.btnPrimary, "text-xs")}
              onClick={handleConnectTenant}
              disabled={busyId === "_connect_tenant_"}
            >
              {busyId === "_connect_tenant_" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Connect shared mailbox
            </button>
          )}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-crm-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : tenantSenders.length === 0 ? (
          <div className="rounded-crm border border-crm-border/70 bg-crm-surface-2/40 px-3 py-3 text-sm text-crm-muted">
            {canManageTenant ? (
              <>
                No shared mailboxes connected yet. Connect one (e.g. <code>sales@</code>) so agents without personal senders can still email from your team.
              </>
            ) : (
              <>No shared mailboxes are connected. A CRM admin can connect one to enable team-wide sending.</>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {tenantSenders.map((s) => (
              <li key={s.id}>
                <SenderRow
                  sender={s}
                  editingId={editingId}
                  editLabel={editLabel}
                  editSenderName={editSenderName}
                  busyId={busyId}
                  onEdit={startEdit}
                  onCancelEdit={cancelEdit}
                  onSaveEdit={saveEdit}
                  onLabelChange={setEditLabel}
                  onSenderNameChange={setEditSenderName}
                  onTest={handleTest}
                  onEnableReplyTracking={handleEnableReplyTracking}
                  onSyncNow={handleSyncNow}
                  onDisconnect={handleDisconnect}
                  onSetDefault={handleSetDefault}
                  isAdmin={canManageTenant}
                />
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-[11px] text-crm-muted">
          Send fallback: <strong className="text-crm-text">your sender</strong> → <strong className="text-crm-text">tenant default</strong> → <strong className="text-crm-text">single shared sender</strong>.
          Compose lets you override per send.
        </p>
      </CRMCard>
    </CRMPageShell>
  );
}

// ─── Sender row ───────────────────────────────────────────────────────────────

function SenderRow({
  sender,
  editingId,
  editLabel,
  editSenderName,
  busyId,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  onLabelChange,
  onSenderNameChange,
  onTest,
  onEnableReplyTracking,
  onSyncNow,
  onDisconnect,
  onSetDefault,
  isAdmin,
}: {
  sender: Sender;
  editingId: string | null;
  editLabel: string;
  editSenderName: string;
  busyId: string | null;
  onEdit: (s: Sender) => void;
  onCancelEdit: () => void;
  onSaveEdit: (s: Sender) => void | Promise<void>;
  onLabelChange: (v: string) => void;
  onSenderNameChange: (v: string) => void;
  onTest: (s: Sender) => void | Promise<void>;
  onEnableReplyTracking: (s: Sender) => void | Promise<void>;
  onSyncNow: (s: Sender) => void | Promise<void>;
  onDisconnect: (s: Sender) => void | Promise<void>;
  onSetDefault: (s: Sender) => void | Promise<void>;
  isAdmin: boolean;
}) {
  const editing = editingId === sender.id;
  const busy = busyId === sender.id;
  const isUser = sender.scope === "USER";
  const connected = isConnected(sender);

  return (
    <div className="rounded-crm border border-crm-border/70 bg-crm-surface-2/40 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-semibold text-crm-text">
              {sender.label || sender.displayName || sender.emailAddress}
            </p>
            {isUser ? (
              <span className={cn(crm.chip, "text-[10px]")}><UserIcon className="h-3 w-3" /> My email</span>
            ) : (
              <span className={cn(crm.chip, "text-[10px]")}><Users className="h-3 w-3" /> Shared</span>
            )}
            {sender.isDefaultForTenant && (
              <span className={cn(crm.chip, crm.chipActive, "text-[10px]")} title="Default sender for this tenant">
                <Star className="h-3 w-3" /> Default
              </span>
            )}
            {!connected && (
              <span className={cn(crm.chip, "text-[10px] text-crm-danger")} title={sender.lastError || undefined}>
                Disconnected
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-crm-muted">{sender.emailAddress}</p>
          {sender.senderName && !editing && (
            <p className="mt-0.5 text-[11px] text-crm-muted">
              Sends as <span className="text-crm-text">{sender.senderName}</span>
            </p>
          )}
          {!editing && (
            <p className="mt-1 text-[11px] text-crm-muted">
              Reply tracking: {sender.replyTrackingEnabled ? (
                <span className="text-crm-success">Enabled</span>
              ) : (
                <span className="text-crm-warning">Disabled</span>
              )}
              {sender.lastSyncAt && (
                <>
                  {" · Last synced "}
                  <span className="text-crm-text">{new Date(sender.lastSyncAt).toLocaleString()}</span>
                </>
              )}
            </p>
          )}
        </div>

        {sender.canManage && !editing && (
          <div className="flex items-center gap-1.5">
            {connected && (
              <button type="button" className={cn(crm.btnGhost, "text-xs")} onClick={() => onTest(sender)} disabled={busy} title="Send a test email">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Test
              </button>
            )}
            {connected && !sender.replyTrackingEnabled && (
              <button type="button" className={cn(crm.btnGhost, "text-xs")} onClick={() => onEnableReplyTracking(sender)} disabled={busy} title="Enable reply tracking (re-consent)">
                <Lock className="h-3.5 w-3.5" /> Enable Reply Tracking
              </button>
            )}
            {connected && sender.replyTrackingEnabled && (
              <button type="button" className={cn(crm.btnGhost, "text-xs")} onClick={() => onSyncNow(sender)} disabled={busy} title="Sync replies now">
                <Loader2 className="h-3.5 w-3.5" /> Sync now
              </button>
            )}
            {!isUser && connected && !sender.isDefaultForTenant && isAdmin && (
              <button type="button" className={cn(crm.btnGhost, "text-xs")} onClick={() => onSetDefault(sender)} disabled={busy} title="Make this the tenant default sender">
                <Star className="h-3.5 w-3.5" /> Set default
              </button>
            )}
            <button type="button" className={cn(crm.btnGhost, "text-xs")} onClick={() => onEdit(sender)} disabled={busy} title="Edit label and sender name">
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
            <button type="button" className={cn(crm.btnGhost, "text-xs text-crm-danger")} onClick={() => onDisconnect(sender)} disabled={busy} title="Disconnect">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-crm-muted">Label</label>
              <input
                className={crm.input}
                value={editLabel}
                onChange={(e) => onLabelChange(e.target.value)}
                placeholder="e.g. Sales Inbox"
                maxLength={120}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-crm-muted">From name</label>
              <input
                className={crm.input}
                value={editSenderName}
                onChange={(e) => onSenderNameChange(e.target.value)}
                placeholder={sender.displayName || "Acme Sales"}
                maxLength={120}
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <button type="button" className={cn(crm.btnGhost, "text-xs")} onClick={onCancelEdit} disabled={busy}>
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
            <button type="button" className={cn(crm.btnPrimary, "text-xs")} onClick={() => onSaveEdit(sender)} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

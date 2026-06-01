"use client";
// noop: rollout bump for CRM Email diagnostics visibility

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
  Server,
  ShieldCheck,
  RefreshCcw,
  Activity,
  Clock3,
  WifiOff,
} from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../../components/crm";
import { PermissionGate } from "../../../../../components/PermissionGate";
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
  scopes?: string[];
};

type ConnectionsResp = { senders: Sender[]; canManageTenantSenders: boolean; autoSyncEnabled?: boolean; autoSyncIntervalMs?: number };

function isConnected(s: Sender): boolean {
  return s.status === "CONNECTED";
}

function formatWhen(iso?: string | null): string {
  if (!iso) return "Never";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function hasReadonlyScope(scopes?: string[]): boolean {
  return Array.isArray(scopes) && scopes.includes(GMAIL_READONLY_SCOPE);
}

/** Returns "healthy" | "no_scope" | "disabled" | "off" mirroring the API helper. */
function replyTrackingState(s: Sender): "healthy" | "no_scope" | "disabled" | "off" {
  if (!isConnected(s)) return "off";
  const scope = hasReadonlyScope(s.scopes);
  if (s.replyTrackingEnabled && scope) return "healthy";
  if (!scope) return "no_scope";
  return "disabled";
}

function ReplyTrackingStatePill({ state }: { state: "healthy" | "no_scope" | "disabled" | "off" }) {
  if (state === "healthy")
    return (
      <span className={cn(crm.chip, "text-[10px] border-crm-success/35 bg-crm-success/10 text-crm-success")}>
        <ShieldCheck className="h-3 w-3" /> Reply tracking active
      </span>
    );
  if (state === "no_scope")
    return (
      <span className={cn(crm.chip, "text-[10px] border-crm-danger/35 bg-crm-danger/10 text-crm-danger")}>
        <AlertCircle className="h-3 w-3" /> Reconnect required
      </span>
    );
  if (state === "disabled")
    return (
      <span className={cn(crm.chip, "text-[10px] border-crm-warning/35 bg-crm-warning/10 text-crm-warning")}>
        <AlertCircle className="h-3 w-3" /> Reply tracking off
      </span>
    );
  return null;
}

function ConnectionBadge({ connected, busy }: { connected: boolean; busy?: boolean }) {
  return (
    <span
      className={cn(
        crm.chip,
        "text-[10px] uppercase tracking-wide",
        busy
          ? "border-crm-accent/35 bg-crm-accent/10 text-crm-accent"
          : connected
            ? "border-crm-success/35 bg-crm-success/10 text-crm-success"
            : "border-crm-danger/35 bg-crm-danger/10 text-crm-danger",
      )}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className={connected ? crm.statusDotLive : crm.statusDotDanger} />}
      {busy ? "Working" : connected ? "Connected" : "Disconnected"}
    </span>
  );
}

function InfraStatPill({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "success" | "warning" | "danger" | "syncing";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
        tone === "success"
          ? "border-crm-success/30 bg-crm-success/10 text-crm-success"
          : tone === "warning"
            ? "border-crm-warning/30 bg-crm-warning/10 text-crm-warning"
            : tone === "danger"
              ? "border-crm-danger/30 bg-crm-danger/10 text-crm-danger"
              : tone === "syncing"
                ? "border-crm-accent/30 bg-crm-accent/10 text-crm-accent"
                : "border-crm-border/65 bg-crm-surface-2/45 text-crm-muted",
      )}
    >
      <span className="text-crm-muted">{label}</span>
      <span className="font-mono text-crm-text">{value}</span>
    </span>
  );
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
    await startOAuth("TENANT", undefined, true, true);
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
    <PermissionGate permission="can_view_crm_settings" fallback={<div className="state-box">You do not have CRM Email settings access.</div>}>
    <CRMPageShell innerClassName={cn(crm.pageInnerWide, "gap-4")}>
      <CRMPageHeader
        icon={<Server className="h-5 w-5" />}
        title="CRM Email Settings"
        subtitle="Sender infrastructure, reply tracking, and sync diagnostics for CRM email. Metadata-first — Connect never archives inboxes."
      />

      <div className="sticky top-2 z-20 rounded-crm-lg border border-crm-border/75 bg-crm-surface/90 px-3 py-2 shadow-[0_14px_40px_-24px_rgba(0,0,0,0.7)] backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-crm-muted">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold uppercase tracking-wide",
                autoSyncEnabled
                  ? "border-crm-success/35 bg-crm-success/10 text-crm-success"
                  : "border-crm-warning/35 bg-crm-warning/10 text-crm-warning",
              )}
            >
              <span className={autoSyncEnabled ? crm.statusDotLive : crm.statusDotWarn} />
              Auto-sync {autoSyncEnabled ? "enabled" : "disabled"}
            </span>
            {autoSyncEnabled && autoSyncIntervalMs ? <span>Every {Math.round(autoSyncIntervalMs / 60000)} min</span> : null}
            <span><strong className="font-semibold text-crm-text">{data?.senders.length ?? 0}</strong> sender{(data?.senders.length ?? 0) === 1 ? "" : "s"}</span>
            <span><strong className="font-semibold text-crm-text">{tenantSenders.length}</strong> shared</span>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-crm-muted">
            <Activity className="h-3.5 w-3.5 text-crm-accent" />
            Last activity is shown per sender
          </span>
        </div>
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
      <CRMCard className={cn("p-4 sm:p-5", crm.opCard, "border-crm-border/80")}>
        <div className={crm.opCardGlow} />
        <div className="relative z-[1]">
        <div className="mb-3 flex items-center gap-2">
          <UserIcon className="h-4 w-4 text-crm-accent" />
          <h3 className="text-sm font-semibold text-crm-text">My Email</h3>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-crm-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : !userSender || !isConnected(userSender) ? (
          <div className={cn(crm.opInset, "flex flex-wrap items-center justify-between gap-3 px-3 py-3")}>
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
        </div>
      </CRMCard>

      {/* ─── Tenant Shared Email ─────────────────────────────────────────────── */}
      <CRMCard className={cn("p-4 sm:p-5", crm.opCard, "border-crm-border/80")}>
        <div className={crm.opCardGlow} />
        <div className="relative z-[1]">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-crm-accent" />
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
          <div className={cn(crm.opInset, "px-3 py-3 text-sm text-crm-muted")}>
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
          Send fallback: <strong className="text-crm-text">tenant default</strong> → <strong className="text-crm-text">single shared sender</strong> → <strong className="text-crm-text">your sender</strong>.
          Shared mailbox connect requests send + reply-tracking access.
        </p>
        </div>
      </CRMCard>
    </CRMPageShell>
    </PermissionGate>
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

  // Diagnostics state (visible for any connected sender the user can see)
  const [diag, setDiag] = useState<{
    threadsChecked: number;
    fetched: number;
    inserted: number;
    skippedNotInbound: number;
    skippedDuplicates: number;
    errors: number;
  } | null>(null);
  const [diagAt, setDiagAt] = useState<string | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);

  const loadDiag = useCallback(async () => {
    setDiagLoading(true);
    setDiagError(null);
    try {
      const res = await apiGet<{ last: { createdAt?: string; metadata?: any } | null }>(`/crm/email/sync-last?connectionId=${sender.id}`);
      const last = res?.last || null;
      const md = (last?.metadata as any) || {};
      if (last) {
        setDiag({
          threadsChecked: Number(md.threadsChecked || 0),
          fetched: Number(md.fetched || 0),
          inserted: Number(md.inserted || 0),
          skippedNotInbound: Number(md.skippedNotInbound || 0),
          skippedDuplicates: Number(md.skippedDuplicates || 0),
          errors: Number(md.errors || 0),
        });
        setDiagAt(last.createdAt ? String(last.createdAt) : null);
      } else {
        setDiag(null);
        setDiagAt(null);
      }
    } catch (e: any) {
      // Gracefully degrade without exposing details
      setDiag(null);
      setDiagAt(null);
      setDiagError(e?.message || "Failed to load diagnostics");
    } finally {
      setDiagLoading(false);
    }
  }, [sender.id]);

  useEffect(() => {
    if (connected) void loadDiag();
  }, [connected, loadDiag]);

  const diagErrors = diag?.errors ?? 0;
  const rtState = replyTrackingState(sender);
  const syncHealthy = connected && rtState === "healthy" && diagErrors === 0;
  const syncTone = !connected ? "danger" : rtState !== "healthy" ? "warning" : diagErrors > 0 ? "danger" : "success";
  const lastActivity = diagAt || sender.lastSyncAt || null;

  return (
    <div className={cn(crm.opCard, crm.opCardHover, "border-crm-border/75 bg-crm-surface/95")}>
      <div className={crm.opCardGlow} />
      <div className="relative z-[1] px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/60 bg-crm-surface-2/60 text-crm-accent">
              {isUser ? <UserIcon className="h-4 w-4" /> : <Users className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-crm-text">
              {sender.label || sender.displayName || sender.emailAddress}
              </p>
              <p className="mt-0.5 truncate font-mono text-xs text-crm-muted">{sender.emailAddress}</p>
            </div>
            <ConnectionBadge connected={connected} busy={busy} />
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
                <WifiOff className="h-3 w-3" /> Disconnected
              </span>
            )}
          </div>
          {sender.senderName && !editing && (
            <p className="ml-11 mt-1 text-[11px] text-crm-muted">
              Sends as <span className="text-crm-text">{sender.senderName}</span>
            </p>
          )}
          {!editing && (
            <div className="ml-11 mt-2 flex flex-wrap gap-1.5">
              <ReplyTrackingStatePill state={rtState} />
              <InfraStatPill
                label="sync"
                value={syncHealthy ? "healthy" : connected ? "watch" : "down"}
                tone={syncTone}
              />
              <InfraStatPill label="last" value={formatWhen(lastActivity)} tone={lastActivity ? "neutral" : "warning"} />
            </div>
          )}
        </div>

        {!editing && (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {connected && sender.replyTrackingEnabled && (
              <button type="button" className={cn(crm.btnGhost, "text-xs")} onClick={() => onSyncNow(sender)} disabled={busy} title="Sync replies now">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />} Sync now
              </button>
            )}
            {sender.canManage && connected && (
              <button type="button" className={cn(crm.btnGhost, "text-xs")} onClick={() => onTest(sender)} disabled={busy} title="Send a test email">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Test
              </button>
            )}
            {sender.canManage && connected && rtState === "no_scope" && (
              <button
                type="button"
                className={cn(crm.btnGhost, "text-xs border-crm-danger/35 text-crm-danger")}
                onClick={() => onEnableReplyTracking(sender)}
                disabled={busy}
                title="gmail.readonly scope not granted — reconnect to add reply tracking"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertCircle className="h-3.5 w-3.5" />}
                Reconnect for reply tracking
              </button>
            )}
            {sender.canManage && connected && rtState === "disabled" && (
              <button
                type="button"
                className={cn(crm.btnGhost, "text-xs")}
                onClick={() => onEnableReplyTracking(sender)}
                disabled={busy}
                title="Enable reply tracking (scope already granted — re-consent to confirm)"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
                Enable reply tracking
              </button>
            )}
            {sender.canManage && !isUser && connected && !sender.isDefaultForTenant && isAdmin && (
              <button type="button" className={cn(crm.btnGhost, "text-xs")} onClick={() => onSetDefault(sender)} disabled={busy} title="Make this the tenant default sender">
                <Star className="h-3.5 w-3.5" /> Set default
              </button>
            )}
            {sender.canManage && (
              <button type="button" className={cn(crm.btnGhost, "text-xs")} onClick={() => onEdit(sender)} disabled={busy} title="Edit label and sender name">
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            )}
            {sender.canManage && (
              <button type="button" className={cn(crm.btnGhost, "text-xs text-crm-danger")} onClick={() => onDisconnect(sender)} disabled={busy} title="Disconnect">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {connected && (
        <div className={cn(crm.opInset, "mt-3 px-3 py-2.5")}>
          {rtState === "no_scope" && (
            <div className="mb-2.5 flex items-start gap-2 rounded-crm border border-crm-danger/35 bg-crm-danger/10 px-3 py-2 text-xs text-crm-danger">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                <strong>Reconnect required.</strong> The <code>gmail.readonly</code> permission was not granted when this account was connected. Reply sync is disabled. Click <strong>Reconnect for reply tracking</strong> above to grant the scope.
              </div>
            </div>
          )}
          {rtState === "disabled" && (
            <div className="mb-2.5 flex items-start gap-2 rounded-crm border border-crm-warning/35 bg-crm-warning/10 px-3 py-2 text-xs text-crm-warning">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                Reply tracking is off for this sender. The <code>gmail.readonly</code> scope was granted — click <strong>Enable reply tracking</strong> above to activate it.
              </div>
            </div>
          )}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-crm-muted">
              <ShieldCheck className="h-3.5 w-3.5 text-crm-accent" />
              Sync diagnostics
            </span>
            <button
              type="button"
              className={cn(crm.btnGhost, "text-[11px]")}
              onClick={loadDiag}
              disabled={diagLoading}
              title="Refresh diagnostics"
            >
              {diagLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Refresh diagnostics
            </button>
          </div>
          {diagError ? (
            <div className="flex items-center gap-1 text-[11px] text-crm-danger">
              <AlertCircle className="h-3 w-3" /> {diagError}
            </div>
          ) : diag ? (
            <div className="flex flex-wrap gap-1.5">
              <InfraStatPill label="threads" value={diag.threadsChecked} tone="neutral" />
              <InfraStatPill label="fetched" value={diag.fetched} tone="syncing" />
              <InfraStatPill label="inserted" value={diag.inserted} tone="success" />
              <InfraStatPill label="not inbound" value={diag.skippedNotInbound} tone="neutral" />
              <InfraStatPill label="dupes" value={diag.skippedDuplicates} tone="neutral" />
              <InfraStatPill label="errors" value={diag.errors} tone={diag.errors > 0 ? "danger" : "success"} />
              <span className="inline-flex items-center gap-1.5 rounded-full border border-crm-border/65 bg-crm-surface-2/45 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-crm-muted">
                <Clock3 className="h-3 w-3 text-crm-accent" />
                <span>last</span>
                <span className="font-mono text-crm-text">{formatWhen(diagAt)}</span>
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[11px] text-crm-muted">
              <span className={cn(crm.statusDot, "bg-crm-muted/60")} />
              No sync diagnostics yet. Click <span className="text-crm-text">Sync now</span>, then <span className="text-crm-text">Refresh diagnostics</span>.
            </div>
          )}
        </div>
      )}

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
    </div>
  );
}

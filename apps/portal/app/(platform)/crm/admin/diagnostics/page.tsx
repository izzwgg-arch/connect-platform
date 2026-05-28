"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  RefreshCw,
  ListOrdered,
  FileUp,
  Megaphone,
  Settings2,
  BarChart3,
  LayoutGrid,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  Activity,
  ShieldOff,
} from "lucide-react";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { apiGet } from "../../../../../services/apiClient";
import { CRMPageShell, crm, cn } from "../../../../../components/crm";

type Diagnostics = {
  generatedAt: string;
  queue: {
    totalActiveMembers: number;
    unassignedMembers: number;
    callbackOverdue: number;
    duplicateCampaignContactPairGroups: number;
    membersMissingContact: number;
    membersMissingCampaign: number;
    membersAssignedToDisabledUsers: number;
    membersAssignedWithoutCrmAccess: number;
  };
  imports: {
    recentBatches: Array<{
      id: string;
      status: string;
      fileName: string;
      createdCount: number;
      updatedCount: number;
      skippedCount: number;
      errorCount: number;
      createdAt: string;
    }>;
  };
  sms: {
    providerConfigured: boolean;
    providerMissingWarning: string | null;
    smsSentToday: number;
    smsReceivedToday: number;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    contactsWithDoNotSms: number;
    crmTimelineSmsFailureEvents: number;
    crmTimelineSmsNote: string | null;
    marketingSmsFailedToday: number;
  };
  ownership: {
    membersOnArchivedOrInactiveContacts: number;
    crossTenantMemberRows: number;
    activeCampaignCallbackWithNullCallbackAt: number;
  };
  campaigns: {
    active: number;
    activeWithZeroMembers: number;
    campaignsWithOver1000Members: number;
    activeNoMemberActivity30d: number;
    staleActivityNote: string | null;
    activeAllMembersTerminal: number;
  };
  wallboard: {
    telephonyFetchOk: boolean;
    telephonyFetchError: string | null;
    activeTelephonyCalls: number | null;
    activeTelephonyQueues: number | null;
    telephonyStatus: string | null;
    pbxLinkState: string | null;
    crmQueueRemainingPendingOrInProgress: number;
    wallboardReportsRefreshNote: string;
    snapshotAt: string;
  };
};

type Severity = "ok" | "warn" | "bad";

// ── CRM-system section card ───────────────────────────────────────────────────

function DiagCard({
  title,
  severity,
  children,
  actions,
}: {
  title: string;
  severity: Severity;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const Icon = severity === "ok" ? CheckCircle2 : severity === "warn" ? AlertTriangle : AlertCircle;
  const borderClass =
    severity === "ok"
      ? "border-crm-success/40"
      : severity === "warn"
        ? "border-crm-warning/40"
        : "border-crm-danger/40";
  const bgClass =
    severity === "ok"
      ? "bg-crm-success/[0.04]"
      : severity === "warn"
        ? "bg-crm-warning/[0.04]"
        : "bg-crm-danger/[0.04]";
  const iconClass =
    severity === "ok"
      ? "text-crm-success"
      : severity === "warn"
        ? "text-crm-warning"
        : "text-crm-danger";

  return (
    <div className={cn("overflow-hidden rounded-xl border", borderClass, bgClass)}>
      <div className="flex items-center justify-between gap-3 border-b border-crm-border/30 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-bold text-crm-text">
          <Icon className={cn("h-4 w-4 shrink-0", iconClass)} aria-hidden />
          {title}
        </h2>
        {actions}
      </div>
      <div className="flex flex-col gap-0 divide-y divide-crm-border/25 px-4 py-2">
        {children}
      </div>
    </div>
  );
}

// ── Metric line ───────────────────────────────────────────────────────────────

function MetricLine({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  const isZero = value === 0 || value === "0";
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-crm-muted">{label}</span>
        <span className={cn(
          "shrink-0 text-xs font-bold tabular-nums",
          isZero ? "text-crm-muted/60" : "text-crm-text",
        )}>
          {value}
        </span>
      </div>
      {hint && (
        <p className="mt-0.5 text-[10px] leading-relaxed text-crm-muted/70">{hint}</p>
      )}
    </div>
  );
}

// ── Warn line ─────────────────────────────────────────────────────────────────

function WarnLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-1.5 py-2 text-xs text-crm-warning">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {text}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function CrmAdminDiagnosticsPage() {
  const { backendJwtRole } = useAppContext();
  const router = useRouter();
  const [data, setData] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isAdmin =
    backendJwtRole === "ADMIN" ||
    backendJwtRole === "TENANT_ADMIN" ||
    backendJwtRole === "SUPER_ADMIN";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<Diagnostics>("/crm/admin/diagnostics");
      setData(res);
    } catch (e: unknown) {
      const msg =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : "Failed to load diagnostics";
      setError(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      router.replace("/crm/dashboard");
      return;
    }
    void load();
  }, [isAdmin, load, router]);

  if (!isAdmin) return null;

  // Quick links bar
  const quickLinks = (
    <div className="flex flex-wrap items-center gap-1.5">
      {[
        { href: "/crm/queue", label: "Queue", Icon: ListOrdered },
        { href: "/crm/campaigns", label: "Campaigns", Icon: Megaphone },
        { href: "/crm/import", label: "Imports", Icon: FileUp },
        { href: "/crm/settings", label: "Users & access", Icon: Settings2 },
        { href: "/crm/reports", label: "Reports", Icon: BarChart3 },
        { href: "/crm/wallboard", label: "Wallboard", Icon: LayoutGrid },
      ].map(({ href, label, Icon }) => (
        <Link
          key={href}
          href={href}
          className={cn(crm.chip, "gap-1.5 hover:text-crm-text transition-colors no-underline")}
        >
          <Icon className="h-3 w-3" />
          {label}
        </Link>
      ))}
    </div>
  );

  if (loading && !data) {
    return (
      <CRMPageShell>
        <div className={crm.pageInner}>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-crm-border/60 bg-crm-surface-2 text-crm-muted">
              <Activity className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-crm-text">CRM Diagnostics</h1>
              <p className="text-xs text-crm-muted">Operational health snapshot — admin only</p>
            </div>
          </div>
          {quickLinks}
          <div className={cn(crm.card, "px-5 py-4")}><LoadingSkeleton rows={6} /></div>
        </div>
      </CRMPageShell>
    );
  }

  if (error || !data) {
    return (
      <CRMPageShell>
        <div className={crm.pageInner}>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-crm-border/60 bg-crm-surface-2 text-crm-muted">
              <Activity className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-crm-text">CRM Diagnostics</h1>
              <p className="text-xs text-crm-muted">Operational health snapshot — admin only</p>
            </div>
          </div>
          {quickLinks}
          <div className={cn(crm.card, "flex items-start gap-3 px-5 py-4")}>
            <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-crm-danger" />
            <div>
              <p className="text-sm text-crm-text">{error ?? "Unknown error"}</p>
              <button
                type="button"
                onClick={() => void load()}
                className={cn(crm.btnSecondary, "mt-3 text-xs")}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </button>
            </div>
          </div>
        </div>
      </CRMPageShell>
    );
  }

  const q = data.queue;
  const queueSeverity: Severity =
    q.membersMissingContact > 0 ||
    q.membersMissingCampaign > 0 ||
    q.duplicateCampaignContactPairGroups > 0
      ? "bad"
      : q.callbackOverdue > 0 || q.membersAssignedWithoutCrmAccess > 0 || q.membersAssignedToDisabledUsers > 0
        ? "warn"
        : "ok";

  const imp = data.imports.recentBatches;
  const importSeverity: Severity = imp.some((b) => b.status === "FAILED" || b.errorCount > 0) ? "warn" : "ok";

  const s = data.sms;
  const smsSeverity: Severity =
    !s.providerConfigured || s.marketingSmsFailedToday > 0 ? "warn" : "ok";

  const o = data.ownership;
  const ownSeverity: Severity =
    o.crossTenantMemberRows > 0 ? "bad" : o.activeCampaignCallbackWithNullCallbackAt > 0 ? "bad" : o.membersOnArchivedOrInactiveContacts > 0 ? "warn" : "ok";

  const c = data.campaigns;
  const campSeverity: Severity =
    c.activeAllMembersTerminal > 0 || c.activeWithZeroMembers > 0 ? "warn" : c.campaignsWithOver1000Members > 0 ? "warn" : "ok";

  const w = data.wallboard;
  const wallSeverity: Severity =
    !w.telephonyFetchOk || w.telephonyStatus === "down" || w.pbxLinkState === "reconnecting" || w.pbxLinkState === "stale"
      ? "bad"
      : w.telephonyStatus === "degraded" || w.pbxLinkState === "degraded"
        ? "warn"
        : "ok";

  return (
    <CRMPageShell>
      <div className={crm.pageInner}>

        {/* Page header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-crm-border/60 bg-crm-surface-2 text-crm-muted">
              <Activity className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-crm-text">CRM Diagnostics</h1>
              <p className="text-xs text-crm-muted">
                Snapshot at {new Date(data.generatedAt).toLocaleString()} · Manual refresh only
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className={cn(crm.btnSecondary, "shrink-0 text-xs")}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {/* Quick links */}
        {quickLinks}

        {/* ── Diagnostic sections ──────────────────────────────────────────── */}

        <DiagCard
          title="Queue Integrity"
          severity={queueSeverity}
          actions={<Link href="/crm/queue" className="text-[11px] font-semibold text-crm-accent hover:opacity-80">Open queue →</Link>}
        >
          <MetricLine label="Active work-queue members (ACTIVE campaign · PENDING / IN_PROGRESS / CALLBACK)" value={q.totalActiveMembers} />
          <MetricLine
            label="Unassigned in that set"
            value={q.unassignedMembers}
            hint="Unassigned rows do not show in 'My Queue' for agents."
          />
          <MetricLine
            label="CALLBACK overdue (before today, ACTIVE campaign)"
            value={q.callbackOverdue}
            hint="Agents often report 'callbacks vanished' when these age out of their filter."
          />
          <MetricLine
            label="Duplicate (campaignId, contactId) groups"
            value={q.duplicateCampaignContactPairGroups}
            hint="Schema enforces uniqueness; non-zero indicates historic corruption."
          />
          <MetricLine label="Members missing contact row" value={q.membersMissingContact} hint="Should be impossible with FKs; indicates damaged data." />
          <MetricLine label="Members missing campaign row" value={q.membersMissingCampaign} hint="Should be impossible with FKs; indicates damaged data." />
          <MetricLine label="Assigned to DISABLED users" value={q.membersAssignedToDisabledUsers} hint="Work may stall because disabled users cannot work their assignments." />
          <MetricLine label="Assigned users without CRM access" value={q.membersAssignedWithoutCrmAccess} hint="Assignees cannot open CRM to disposition; they will see permission errors." />
        </DiagCard>

        <DiagCard
          title="Import Health (last 20 batches)"
          severity={importSeverity}
          actions={<Link href="/crm/import" className="text-[11px] font-semibold text-crm-accent hover:opacity-80">Import leads →</Link>}
        >
          <p className="py-1.5 text-xs text-crm-muted">
            Imports are not linked to a single campaign in the database; assign routing happens inside each import run.
          </p>
          {imp.length === 0 ? (
            <p className="py-2 text-xs text-crm-muted">No import batches yet.</p>
          ) : (
            <div className="flex flex-col gap-1 py-1">
              {imp.map((b) => (
                <div
                  key={b.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-crm-border/50 bg-crm-surface-2/30 px-3 py-2 text-xs"
                >
                  <div>
                    <div className="font-medium text-crm-text">{b.fileName}</div>
                    <div className="mt-0.5 text-crm-muted">
                      {b.status} · +{b.createdCount} ~{b.updatedCount} skip {b.skippedCount} err {b.errorCount}
                    </div>
                  </div>
                  <span className="shrink-0 text-crm-muted/70">{new Date(b.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </DiagCard>

        <DiagCard
          title="SMS Health"
          severity={smsSeverity}
          actions={<Link href="/settings/messaging" className="text-[11px] font-semibold text-crm-accent hover:opacity-80">Messaging settings →</Link>}
        >
          {!s.providerConfigured && s.providerMissingWarning ? <WarnLine text={s.providerMissingWarning} /> : null}
          <MetricLine label="SMS_SENT today (CRM timeline)" value={s.smsSentToday} />
          <MetricLine label="SMS_RECEIVED today (CRM timeline)" value={s.smsReceivedToday} />
          <MetricLine label="Last inbound SMS (any day)" value={s.lastInboundAt ? new Date(s.lastInboundAt).toLocaleString() : "—"} />
          <MetricLine label="Last CRM SMS_SENT (any day)" value={s.lastOutboundAt ? new Date(s.lastOutboundAt).toLocaleString() : "—"} />
          <MetricLine label="Contacts with doNotSms" value={s.contactsWithDoNotSms} hint="These numbers are blocked for compliance — sends will be rejected." />
          <MetricLine label="CRM timeline SMS failure events" value={s.crmTimelineSmsFailureEvents} hint={s.crmTimelineSmsNote ?? undefined} />
          <MetricLine label="Marketing / broadcast SMS FAILED today" value={s.marketingSmsFailedToday} hint="Separate from CRM contact SMS; counts tenant-scoped campaign messages that failed today." />
        </DiagCard>

        <DiagCard
          title="Queue Ownership & Data Quality"
          severity={ownSeverity}
          actions={<Link href="/crm/settings" className="text-[11px] font-semibold text-crm-accent hover:opacity-80">User access →</Link>}
        >
          <MetricLine
            label="Members on ACTIVE campaigns tied to archived/inactive contacts"
            value={o.membersOnArchivedOrInactiveContacts}
            hint="Contacts hidden or inactive while still enrolled confuse agents and wallboards."
          />
          <MetricLine
            label="Cross-tenant member rows (member vs contact/campaign tenant)"
            value={o.crossTenantMemberRows}
            hint="Must always be zero; non-zero is a serious integrity defect."
          />
          <MetricLine
            label="CALLBACK rows with null callbackAt"
            value={o.activeCampaignCallbackWithNullCallbackAt}
            hint="Callbacks cannot sort or filter correctly without a scheduled time."
          />
        </DiagCard>

        <DiagCard
          title="Campaign Health"
          severity={campSeverity}
          actions={<Link href="/crm/campaigns" className="text-[11px] font-semibold text-crm-accent hover:opacity-80">Campaigns →</Link>}
        >
          <MetricLine label="ACTIVE campaigns" value={c.active} />
          <MetricLine
            label="ACTIVE with zero members"
            value={c.activeWithZeroMembers}
            hint="Empty active campaigns inflate dashboards and can hide that a list was never loaded."
          />
          <MetricLine
            label="Campaigns with &gt;1000 members"
            value={c.campaignsWithOver1000Members}
            hint="Large lists are valid but slow bulk operations; watch import and assignment tooling."
          />
          <MetricLine label="ACTIVE, no campaign/member updates in 30d" value={c.activeNoMemberActivity30d} hint={c.staleActivityNote ?? undefined} />
          <MetricLine
            label="ACTIVE with all members terminal"
            value={c.activeAllMembersTerminal}
            hint="Should usually auto-complete; if stuck ACTIVE, completion hooks may not have run."
          />
        </DiagCard>

        <DiagCard
          title="Wallboard & Telephony Snapshot"
          severity={wallSeverity}
          actions={<Link href="/crm/wallboard" className="text-[11px] font-semibold text-crm-accent hover:opacity-80">Wallboard →</Link>}
        >
          {!w.telephonyFetchOk ? <WarnLine text={`Telephony health fetch failed: ${w.telephonyFetchError ?? "unknown"}`} /> : null}
          <MetricLine label="Active telephony calls (service /health)" value={w.activeTelephonyCalls ?? "—"} />
          <MetricLine label="Active telephony queues" value={w.activeTelephonyQueues ?? "—"} />
          <MetricLine label="Telephony status" value={w.telephonyStatus ?? "—"} />
          <MetricLine label="PBX link state" value={w.pbxLinkState ?? "—"} />
          <MetricLine
            label="CRM queue remaining (PENDING + IN_PROGRESS on ACTIVE campaigns)"
            value={w.crmQueueRemainingPendingOrInProgress}
            hint="Same definition as reports queueRemaining for wallboard panels."
          />
          <p className="py-1.5 text-[10px] leading-relaxed text-crm-muted/70">{w.wallboardReportsRefreshNote}</p>
        </DiagCard>

      </div>
    </CRMPageShell>
  );
}

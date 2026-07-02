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
} from "lucide-react";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { PageHeader } from "../../../../../components/PageHeader";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { apiGet } from "../../../../../services/apiClient";
import { crm } from "../../../../../components/crm/crmClasses";
import { cn } from "../../../../../components/crm/cn";

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
      campaignId: string | null;
    }>;
  };
  sms: {
    smsSentToday: number;
    smsReceivedToday: number;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    contactsWithDoNotSms: number;
    crmTimelineSmsFailureEvents: number;
    crmTimelineSmsNote: string;
    marketingSmsFailedToday: number;
    providerConfigured: boolean;
    providerMissingWarning: string | null;
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
    activeAllMembersTerminal: number;
    staleActivityNote: string;
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

function severityClass(sev: Severity) {
  if (sev === "ok") return "border-crm-success/35";
  if (sev === "warn") return "border-crm-warning/35";
  return "border-crm-danger/40";
}

function severityTextClass(sev: Severity) {
  if (sev === "ok") return "text-crm-success";
  if (sev === "warn") return "text-crm-warning";
  return "text-crm-danger";
}

function SectionCard({
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
  return (
    <section
      className={cn(
        crm.card,
        crm.cardPad,
        "mb-4 border-crm-border bg-crm-surface",
        severityClass(severity),
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="m-0 flex items-center gap-2 text-sm font-bold text-crm-text">
          <Icon size={18} className={severityTextClass(severity)} aria-hidden />
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function MetricLine({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="mb-2 text-[0.8125rem] leading-relaxed">
      <span className="text-crm-muted">{label}: </span>
      <strong className="text-crm-text">{value}</strong>
      {hint ? (
        <div className="mt-0.5 text-xs text-crm-muted">{hint}</div>
      ) : null}
    </div>
  );
}

function warnLine(text: string) {
  return (
    <div className="mt-1.5 text-xs leading-relaxed text-crm-warning">
      {text}
    </div>
  );
}

function actionLink(label: string, href: string) {
  return (
    <Link href={href} className="text-xs font-semibold text-crm-accent hover:text-crm-accent/85">
      {label} →
    </Link>
  );
}

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

  if (loading && !data) {
    return (
      <div className={cn("crm-page-shell min-h-full", crm.reportsWorkspace)}>
        <div className={crm.pageInnerReports}>
          <PageHeader title="CRM diagnostics" subtitle="Operational health snapshot (admin only)" />
          <LoadingSkeleton rows={6} />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={cn("crm-page-shell min-h-full", crm.reportsWorkspace)}>
        <div className={crm.pageInnerReports}>
          <PageHeader title="CRM diagnostics" subtitle="Operational health snapshot (admin only)" />
          <div className={cn(crm.card, crm.cardPad)}>
          <p className="mb-3 mt-0 text-crm-text">{error ?? "Unknown error"}</p>
          <button
            type="button"
            onClick={() => void load()}
            className={crm.btnSecondary}
          >
            <RefreshCw size={16} /> Retry
          </button>
          </div>
        </div>
      </div>
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

  const quickLinks = (
    <div className="mb-5 flex flex-wrap gap-2">
      <Link href="/crm/queue" className={crm.btnGhost}>
        <ListOrdered size={14} /> Queue
      </Link>
      <Link href="/crm/campaigns" className={crm.btnGhost}>
        <Megaphone size={14} /> Campaigns
      </Link>
      <Link href="/crm/import" className={crm.btnGhost}>
        <FileUp size={14} /> Imports
      </Link>
      <Link href="/crm/settings" className={crm.btnGhost}>
        <Settings2 size={14} /> Users &amp; access
      </Link>
      <Link href="/crm/reports" className={crm.btnGhost}>
        <BarChart3 size={14} /> Reports
      </Link>
      <Link href="/crm/wallboard" className={crm.btnGhost}>
        <LayoutGrid size={14} /> Wallboard
      </Link>
    </div>
  );

  return (
    <div className={cn("crm-page-shell min-h-full", crm.reportsWorkspace)}>
      <div className={crm.pageInnerReports}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <PageHeader
            title="CRM diagnostics"
            subtitle={`Snapshot at ${new Date(data.generatedAt).toLocaleString()} · Refresh is manual only (no auto-polling)`}
          />
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className={crm.btnSecondary}
          >
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
        {quickLinks}

      <SectionCard
        title="Queue integrity"
        severity={queueSeverity}
        actions={actionLink("Open queue", "/crm/queue")}
      >
        <MetricLine label="Active work-queue members (ACTIVE campaign · PENDING / IN_PROGRESS / CALLBACK)" value={q.totalActiveMembers} />
        <MetricLine
          label="Unassigned in that set"
          value={q.unassignedMembers}
          hint="Unassigned rows do not show in ‘My Queue’ for agents and can look like leads vanished."
        />
        <MetricLine
          label="CALLBACK overdue (before today, ACTIVE campaign)"
          value={q.callbackOverdue}
          hint="Agents often report ‘callbacks vanished’ when these age out of their filter; overdue still need action."
        />
        <MetricLine
          label="Duplicate (campaignId, contactId) groups"
          value={q.duplicateCampaignContactPairGroups}
          hint="Schema enforces uniqueness; a non-zero count means historic corruption or a failed constraint."
        />
        <MetricLine label="Members missing contact row" value={q.membersMissingContact} hint="Should be impossible with FKs; indicates damaged data." />
        <MetricLine label="Members missing campaign row" value={q.membersMissingCampaign} hint="Should be impossible with FKs; indicates damaged data." />
        <MetricLine
          label="Assigned to DISABLED users"
          value={q.membersAssignedToDisabledUsers}
          hint="Work may stall because disabled users cannot work their assignments."
        />
        <MetricLine
          label="Assigned users without CRM access"
          value={q.membersAssignedWithoutCrmAccess}
          hint="Assignees cannot open CRM to disposition; they will see permission errors."
        />
      </SectionCard>

      <SectionCard
        title="Import health (last 20 batches)"
        severity={importSeverity}
        actions={actionLink("Import leads", "/crm/import")}
      >
        <p className="mb-2 mt-0 text-xs text-crm-muted">
          Imports are not linked to a single campaign in the database; assign routing happens inside each import run.
        </p>
        <div className="grid gap-1.5">
          {imp.length === 0 ? (
            <span className="text-[0.8125rem] text-crm-muted">No import batches yet.</span>
          ) : (
            imp.map((b) => (
              <div
                key={b.id}
                className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-crm border border-crm-border/70 bg-crm-surface-2/50 px-2.5 py-2 text-xs"
              >
                <span className="font-semibold text-crm-text">{b.fileName}</span>
                <span className="text-right text-crm-muted">{new Date(b.createdAt).toLocaleString()}</span>
                <span className="text-crm-muted">
                  {b.status} · +{b.createdCount} ~{b.updatedCount} skip {b.skippedCount} err {b.errorCount}
                </span>
              </div>
            ))
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="SMS health"
        severity={smsSeverity}
        actions={actionLink("Messaging settings", "/settings/messaging")}
      >
        {!s.providerConfigured && s.providerMissingWarning ? warnLine(s.providerMissingWarning) : null}
        <MetricLine label="SMS_SENT today (CRM timeline)" value={s.smsSentToday} />
        <MetricLine label="SMS_RECEIVED today (CRM timeline)" value={s.smsReceivedToday} />
        <MetricLine label="Last inbound SMS (any day)" value={s.lastInboundAt ? new Date(s.lastInboundAt).toLocaleString() : "—"} />
        <MetricLine label="Last CRM SMS_SENT (any day)" value={s.lastOutboundAt ? new Date(s.lastOutboundAt).toLocaleString() : "—"} />
        <MetricLine
          label="Contacts with doNotSms"
          value={s.contactsWithDoNotSms}
          hint="These numbers are blocked for compliance — sends will be rejected."
        />
        <MetricLine label="CRM timeline SMS failure events" value={s.crmTimelineSmsFailureEvents} hint={s.crmTimelineSmsNote} />
        <MetricLine
          label="Marketing / broadcast SMS FAILED today (SmsMessage)"
          value={s.marketingSmsFailedToday}
          hint="Separate from CRM contact SMS; counts tenant-scoped campaign messages that failed today."
        />
      </SectionCard>

      <SectionCard
        title="Queue ownership & data quality"
        severity={ownSeverity}
        actions={actionLink("User access", "/crm/settings")}
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
      </SectionCard>

      <SectionCard
        title="Campaign health"
        severity={campSeverity}
        actions={actionLink("Campaigns", "/crm/campaigns")}
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
        <MetricLine label="ACTIVE, no campaign/member updates in 30d" value={c.activeNoMemberActivity30d} hint={c.staleActivityNote} />
        <MetricLine
          label="ACTIVE with all members terminal"
          value={c.activeAllMembersTerminal}
          hint="Should usually auto-complete; if stuck ACTIVE, completion hooks may not have run."
        />
      </SectionCard>

      <SectionCard
        title="Wallboard & telephony snapshot"
        severity={wallSeverity}
        actions={actionLink("Wallboard", "/crm/wallboard")}
      >
        {!w.telephonyFetchOk ? warnLine(`Telephony health fetch failed: ${w.telephonyFetchError ?? "unknown"}`) : null}
        <MetricLine label="Active telephony calls (service /health)" value={w.activeTelephonyCalls ?? "—"} />
        <MetricLine label="Active telephony queues" value={w.activeTelephonyQueues ?? "—"} />
        <MetricLine label="Telephony status" value={w.telephonyStatus ?? "—"} />
        <MetricLine label="PBX link state" value={w.pbxLinkState ?? "—"} />
        <MetricLine
          label="CRM queue remaining (PENDING + IN_PROGRESS on ACTIVE campaigns)"
          value={w.crmQueueRemainingPendingOrInProgress}
          hint="Same definition as reports `queueRemaining` for wallboard panels."
        />
        <p className="mt-1.5 text-xs leading-relaxed text-crm-muted">{w.wallboardReportsRefreshNote}</p>
      </SectionCard>
      </div>
    </div>
  );
}

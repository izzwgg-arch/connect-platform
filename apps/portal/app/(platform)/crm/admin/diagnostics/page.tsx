"use client";

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
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

function cardTone(sev: Severity): { border: string; background: string } {
  if (sev === "ok") return { border: "#86efac", background: "#f0fdf4" };
  if (sev === "warn") return { border: "#fcd34d", background: "#fffbeb" };
  return { border: "#fca5a5", background: "#fef2f2" };
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
  const t = cardTone(severity);
  const Icon = severity === "ok" ? CheckCircle2 : severity === "warn" ? AlertTriangle : AlertCircle;
  const iconColor = severity === "ok" ? "#15803d" : severity === "warn" ? "#b45309" : "#b91c1c";
  return (
    <section
      style={{
        border: `1px solid ${t.border}`,
        background: t.background,
        borderRadius: "0.75rem",
        padding: "1rem 1.125rem",
        marginBottom: "1rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem", marginBottom: "0.75rem" }}>
        <h2 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text)" }}>
          <Icon size={18} style={{ color: iconColor }} aria-hidden />
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
    <div style={{ marginBottom: "0.5rem", fontSize: "0.8125rem", lineHeight: 1.5 }}>
      <span style={{ color: "var(--text-dim)" }}>{label}: </span>
      <strong style={{ color: "var(--text)" }}>{value}</strong>
      {hint ? (
        <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.15rem" }}>{hint}</div>
      ) : null}
    </div>
  );
}

function warnLine(text: string) {
  return (
    <div style={{ fontSize: "0.75rem", color: "#b45309", marginTop: "0.35rem", lineHeight: 1.45 }}>
      {text}
    </div>
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
      <div style={{ padding: "1.5rem" }}>
        <PageHeader title="CRM diagnostics" subtitle="Operational health snapshot (admin only)" />
        <LoadingSkeleton rows={6} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ padding: "1.5rem", maxWidth: 640 }}>
        <PageHeader title="CRM diagnostics" subtitle="Operational health snapshot (admin only)" />
        <div style={{ padding: "1rem", borderRadius: "0.75rem", border: "1px solid var(--border)", background: "var(--surface)" }}>
          <p style={{ margin: "0 0 0.75rem", color: "var(--text)" }}>{error ?? "Unknown error"}</p>
          <button
            type="button"
            onClick={() => void load()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "1px solid var(--border)",
              background: "var(--background)",
              cursor: "pointer",
            }}
          >
            <RefreshCw size={16} /> Retry
          </button>
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
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "1.25rem" }}>
      <Link href="/crm/queue" style={linkPill()}>
        <ListOrdered size={14} /> Queue
      </Link>
      <Link href="/crm/campaigns" style={linkPill()}>
        <Megaphone size={14} /> Campaigns
      </Link>
      <Link href="/crm/import" style={linkPill()}>
        <FileUp size={14} /> Imports
      </Link>
      <Link href="/crm/settings" style={linkPill()}>
        <Settings2 size={14} /> Users &amp; access
      </Link>
      <Link href="/crm/reports" style={linkPill()}>
        <BarChart3 size={14} /> Reports
      </Link>
      <Link href="/crm/wallboard" style={linkPill()}>
        <LayoutGrid size={14} /> Wallboard
      </Link>
    </div>
  );

  return (
    <div style={{ padding: "1.5rem", maxWidth: 920 }}>
      <PageHeader
        title="CRM diagnostics"
        subtitle={`Snapshot at ${new Date(data.generatedAt).toLocaleString()} · Refresh is manual only (no auto-polling)`}
      />
      {quickLinks}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
            padding: "0.45rem 0.9rem",
            borderRadius: "0.5rem",
            border: "1px solid var(--border)",
            background: "var(--surface)",
            cursor: loading ? "wait" : "pointer",
            fontSize: "0.8125rem",
            fontWeight: 600,
          }}
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      <SectionCard
        title="Queue integrity"
        severity={queueSeverity}
        actions={<Link href="/crm/queue" style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--accent)" }}>Open queue →</Link>}
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
        actions={<Link href="/crm/import" style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--accent)" }}>Import leads →</Link>}
      >
        <p style={{ margin: "0 0 0.5rem", fontSize: "0.75rem", color: "var(--text-dim)" }}>
          Imports are not linked to a single campaign in the database; assign routing happens inside each import run.
        </p>
        <div style={{ display: "grid", gap: "0.35rem" }}>
          {imp.length === 0 ? (
            <span style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>No import batches yet.</span>
          ) : (
            imp.map((b) => (
              <div
                key={b.id}
                style={{
                  fontSize: "0.75rem",
                  padding: "0.45rem 0.6rem",
                  borderRadius: "0.5rem",
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "0.25rem 0.75rem",
                }}
              >
                <span style={{ fontWeight: 600, color: "var(--text)" }}>{b.fileName}</span>
                <span style={{ textAlign: "right", color: "var(--text-dim)" }}>{new Date(b.createdAt).toLocaleString()}</span>
                <span style={{ color: "var(--text-dim)" }}>
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
        actions={<Link href="/settings/messaging" style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--accent)" }}>Messaging settings →</Link>}
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
        actions={<Link href="/crm/settings" style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--accent)" }}>User access →</Link>}
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
        actions={<Link href="/crm/campaigns" style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--accent)" }}>Campaigns →</Link>}
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
        actions={<Link href="/crm/wallboard" style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--accent)" }}>Wallboard →</Link>}
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
        <p style={{ margin: "0.35rem 0 0", fontSize: "0.75rem", color: "var(--text-dim)", lineHeight: 1.45 }}>{w.wallboardReportsRefreshNote}</p>
      </SectionCard>
    </div>
  );
}

function linkPill(): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.35rem",
    padding: "0.35rem 0.65rem",
    borderRadius: "999px",
    border: "1px solid var(--border)",
    background: "var(--surface)",
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "var(--text)",
    textDecoration: "none",
  };
}

"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  FileText,
  Inbox,
  Loader2,
  Mail,
  MessageCircle,
  Send,
  Settings,
  Sparkles,
  ShieldCheck,
  Clock3,
  WifiOff,
} from "lucide-react";
import { CRMPageShell, CRMCard, crm, cn } from "../../../../components/crm";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPost } from "../../../../services/apiClient";

type EmailConnection = {
  connected: boolean;
  emailAddress: string | null;
  displayName: string | null;
  replyTrackingEnabled?: boolean;
};

type ReplyTrackingDiag = {
  trackedThreads: number;
  inboundReplies: number;
  outboundMessages: number;
  legacyThreadsWithNullSender: number;
  connectionsTotal: number;
  connectionsEnabled: number;
  connectionsDisabled: number;
  connectionsMissingScope: number;
  lastSyncAt: string | null;
  autoSyncEnabled: boolean;
  autoSyncIntervalMs: number;
};


type RecentSent = {
  id: string;
  toEmail: string;
  subject: string | null;
  status: "SENT" | "FAILED" | string;
  errorMessage: string | null;
  sentAt: string;
  contactId: string | null;
};

type RecentReply = {
  id: string;
  gmailMessageId: string;
  gmailThreadId: string | null;
  subject: string | null;
  fromEmail: string | null;
  toEmail: string | null;
  previewSnippet: string | null;
  receivedAt: string | null;
  contactId: string | null;
};

function formatWhen(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function formatCompactWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function initialsFor(conn: EmailConnection | null): string {
  const source = conn?.displayName || conn?.emailAddress || "Email";
  const parts = source
    .replace(/@.*/, "")
    .split(/\s+|[._-]+/)
    .filter(Boolean);
  return (parts[0]?.[0] || "E").toUpperCase() + (parts[1]?.[0] || "").toUpperCase();
}

function EmptyRepliesState() {
  return (
    <div className="crm-email-empty flex min-h-[7rem] flex-col items-center justify-center rounded-crm-lg border border-dashed border-crm-border/70 bg-crm-surface-2/25 px-4 py-4 text-center">
      <span className={cn(crm.emailIconWell, "crm-email-empty-icon mb-2 h-10 w-10 text-crm-accent")}>
        <MessageCircle className="h-4 w-4" />
      </span>
      <h3 className="text-base font-bold tracking-tight text-crm-text">No replies synced</h3>
      <p className="mt-1.5 max-w-[19rem] text-xs leading-relaxed text-crm-muted">
        Enable reply tracking in Settings, then sync now to fetch metadata.
      </p>
      <Link href="/crm/email/settings" className={cn(crm.btnPrimary, "crm-email-sync-cta mt-3")}>
        Sync now
      </Link>
    </div>
  );
}

function EmptySentState() {
  return (
    <div className="rounded-crm-lg border border-dashed border-crm-border/70 bg-crm-surface-2/25 px-4 py-8 text-center">
      <span className={cn(crm.emailIconWell, "mx-auto mb-3 h-12 w-12 text-crm-accent")}>
        <Send className="h-5 w-5" />
      </span>
      <p className="text-sm font-bold text-crm-text">No outbound sends</p>
      <p className="mt-1 text-xs leading-relaxed text-crm-muted">
        Open a contact and send CRM email to begin outreach.
      </p>
    </div>
  );
}

function KpiCard({
  label,
  value,
  detail,
  icon,
  accent,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: ReactNode;
  accent: "blue" | "green" | "violet" | "rose";
}) {
  return (
    <div className={cn(crm.emailKpiCard, `crm-email-kpi-${accent}`)}>
      <div className="relative z-[1] flex h-full flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="crm-email-kpi-label text-[0.68rem] font-bold uppercase tracking-wider text-crm-muted">{label}</p>
            <p className="crm-email-kpi-value mt-2 text-3xl font-bold tracking-tight text-crm-text">{value}</p>
          </div>
          <span className={cn(crm.emailIconWell, "crm-email-kpi-icon h-11 w-11")}>{icon}</span>
        </div>
        <p className="mt-auto text-xs font-medium leading-relaxed text-crm-muted">{detail}</p>
      </div>
    </div>
  );
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch { return iso; }
}

function ReplyTrackingHealthBanner({
  conn,
  diag,
  loading,
  showSettingsLink,
}: {
  conn: EmailConnection | null;
  diag: ReplyTrackingDiag | null;
  loading: boolean;
  showSettingsLink: boolean;
}) {
  if (loading || !conn?.connected) return null;

  // Show warning when no connection has reply tracking enabled
  const noTracking = diag !== null && diag.connectionsEnabled === 0;
  const missingScope = diag !== null && diag.connectionsMissingScope > 0;

  if (!noTracking && !missingScope) return null;

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-crm-lg border border-crm-warning/40 bg-crm-warning/10 px-4 py-3">
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-crm-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-crm-text">Reply tracking not active</p>
        <p className="mt-0.5 text-xs text-crm-muted">
          {missingScope
            ? `${diag!.connectionsMissingScope} sender${diag!.connectionsMissingScope !== 1 ? "s" : ""} need${diag!.connectionsMissingScope === 1 ? "s" : ""} to be reconnected to grant the gmail.readonly scope. `
            : ""}
          {noTracking && !missingScope
            ? "Reply tracking is disabled on all connected senders. "
            : ""}
          Replies will not be synced until reply tracking is enabled.
        </p>
      </div>
      {showSettingsLink ? (
        <Link href="/crm/email/settings" className={cn(crm.btnPrimary, "shrink-0 text-xs")}>
          <Settings className="h-3.5 w-3.5" /> Fix in Settings
        </Link>
      ) : null}
    </div>
  );
}

export default function CrmEmailLandingPage() {
  const { can } = useAppContext();
  const canEmailSettings = can("can_view_crm_settings");
  const [conn, setConn] = useState<EmailConnection | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [recent, setRecent] = useState<RecentSent[]>([]);
  const [replies, setReplies] = useState<RecentReply[]>([]);
  const [diag, setDiag] = useState<ReplyTrackingDiag | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMoreSent, setLoadingMoreSent] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, r, rr, d] = await Promise.all([
        apiGet<EmailConnection>("/crm/email/connection").catch(() => null),
        apiGet<{ sent: RecentSent[] }>("/crm/email/recent?limit=10").catch(() => ({ sent: [] })),
        apiGet<{ replies: RecentReply[] }>("/crm/email/replies/recent?limit=5").catch(() => ({ replies: [] })),
        canEmailSettings
          ? apiGet<ReplyTrackingDiag>("/crm/email/diagnostics/reply-tracking").catch(() => null)
          : Promise.resolve(null),
      ]);
      setConn(c);
      setRecent(r?.sent ?? []);
      setReplies(rr?.replies ?? []);
      setDiag(d);
    } finally {
      setLoading(false);
    }
  }, [canEmailSettings]);

  useEffect(() => { void load(); }, [load]);

  const startUserOAuth = async () => {
    setConnectBusy(true);
    try {
      const res = await apiPost<{ url: string }>("/crm/email/oauth/start", {
        scope: "USER",
        bodyCacheMode: "METADATA_ONLY",
        enableReplyTracking: true,
      });
      if (res?.url) window.location.href = res.url;
    } finally {
      setConnectBusy(false);
    }
  };

  const loadMoreSent = useCallback(async () => {
    setLoadingMoreSent(true);
    try {
      const r = await apiGet<{ sent: RecentSent[] }>("/crm/email/recent?limit=50").catch(() => ({ sent: [] }));
      setRecent(r.sent ?? []);
    } finally {
      setLoadingMoreSent(false);
    }
  }, []);

  const connected = Boolean(conn?.connected);
  const senderName = connected ? conn?.displayName || conn?.emailAddress || "Connected sender" : "Email channel not connected";
  const senderEmail = conn?.emailAddress || "Connect Google in Settings";
  const sentCount = recent.length;
  const deliveredCount = recent.filter((message) => message.status === "SENT").length;
  const failedCount = recent.filter((message) => message.status === "FAILED").length;
  const replyCount = replies.length;
  const replyRate = sentCount > 0 ? Math.round((replyCount / sentCount) * 100) : 0;
  const lastActivity =
    replies[0]?.receivedAt
      ? { when: replies[0].receivedAt, label: "Latest tracked reply metadata" }
      : recent[0]?.sentAt
        ? { when: recent[0].sentAt, label: "Latest outbound CRM email" }
        : null;

  return (
    <PermissionGate permission="can_view_crm_email" fallback={<div className="state-box">You do not have CRM Email access.</div>}>
    <CRMPageShell className={crm.emailWorkspace} innerClassName={crm.pageInnerEmail}>
      <section className={crm.emailHero}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <span className={cn(crm.emailIconWell, "crm-email-hero-icon h-12 w-12 text-crm-accent")}>
              <Mail className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h1 className="crm-email-title text-2xl font-bold tracking-tight text-crm-text">CRM Email</h1>
              <p className="crm-email-subtitle mt-1 text-sm leading-relaxed text-crm-muted">
                Metadata-first email operations. Connect never archives your inbox.
              </p>
            </div>
          </div>
          <div className="crm-email-hero-actions flex flex-wrap items-center gap-2">
            <Link href="/crm/email/templates" className={cn(crm.btnSecondary, "crm-email-btn-secondary")}>
              <FileText className="h-4 w-4" /> Templates
            </Link>
            {canEmailSettings ? (
              <Link href="/crm/email/settings" className={cn(crm.btnPrimary, "crm-email-btn-primary")}>
                <Settings className="h-4 w-4" /> Settings
              </Link>
            ) : null}
          </div>
        </div>
      </section>

      <ReplyTrackingHealthBanner conn={conn} diag={diag} loading={loading} showSettingsLink={canEmailSettings} />

      <CRMCard padding="none" className={cn(crm.emailPanel, "crm-email-sender-card")}>
        <div className="crm-email-card-glow" />
        <div className="relative z-[1] grid min-h-[10.75rem] gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.36fr)]">
          <div className="flex min-w-0 flex-col justify-between gap-4 p-4 sm:p-5">
            <div>
              <p className={cn(crm.label, "crm-email-section-label")}>Sender infrastructure</p>
              <div className="mt-4 flex min-w-0 items-start gap-4">
                <span className="crm-email-avatar flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-base font-bold">
                  {initialsFor(conn)}
                </span>
                <div className="min-w-0">
                  <h2 className="break-words text-xl font-bold tracking-tight text-crm-text">{senderName}</h2>
                  <p className="mt-1 max-w-2xl text-sm leading-relaxed text-crm-muted">
                    {connected
                      ? "CRM contact pages can send through the connected Google account while reply metadata stays scoped to CRM."
                      : "Connect a Google account in Settings to unlock CRM sending and reply tracking."}
                  </p>
                  <span
                    className={cn(
                      "crm-email-status-pill mt-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide",
                      loading
                        ? "border-crm-accent/35 bg-crm-accent/10 text-crm-accent"
                        : connected
                          ? "border-crm-success/35 bg-crm-success/10 text-crm-success"
                          : "border-crm-warning/35 bg-crm-warning/10 text-crm-warning",
                    )}
                  >
                    {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className={connected ? crm.statusDotLive : crm.statusDotWarn} />}
                    {loading ? "Checking" : connected ? "Connected" : "Disconnected"}
                  </span>
                </div>
              </div>
            </div>

            <div className="crm-email-sender-metrics grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-[0.65rem] font-bold uppercase tracking-wider text-crm-muted">Connection</p>
                <p className="mt-1 text-sm font-bold text-crm-text">{connected ? "Google OAuth active" : "Action needed"}</p>
              </div>
              <div>
                <p className="text-[0.65rem] font-bold uppercase tracking-wider text-crm-muted">Recent replies</p>
                <p className="mt-1 text-lg font-bold tabular-nums text-crm-text">{loading ? "..." : replyCount}</p>
              </div>
              <div>
                <p className="text-[0.65rem] font-bold uppercase tracking-wider text-crm-muted">Recent sent</p>
                <p className="mt-1 text-lg font-bold tabular-nums text-crm-text">{loading ? "..." : sentCount}</p>
              </div>
            </div>
            {diag && (
              <div className="flex flex-wrap items-center gap-2 border-t border-crm-border/50 pt-3">
                <span className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                  diag.connectionsEnabled > 0
                    ? "border-crm-success/30 bg-crm-success/10 text-crm-success"
                    : "border-crm-warning/30 bg-crm-warning/10 text-crm-warning",
                )}>
                  <ShieldCheck className="h-3 w-3" />
                  {diag.connectionsEnabled > 0 ? "Reply tracking active" : "Reply tracking off"}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-crm-border/65 bg-crm-surface-2/45 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-crm-muted">
                  <Clock3 className="h-3 w-3 text-crm-accent" />
                  Last sync <span className="font-mono text-crm-text">{formatRelative(diag.lastSyncAt)}</span>
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-crm-border/65 bg-crm-surface-2/45 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-crm-muted">
                  <span className="text-crm-muted">tracked</span>
                  <span className="font-mono text-crm-text">{diag.trackedThreads}</span>
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-crm-border/65 bg-crm-surface-2/45 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-crm-muted">
                  <span className="text-crm-muted">replies</span>
                  <span className="font-mono text-crm-text">{diag.inboundReplies}</span>
                </span>
              </div>
            )}
          </div>

          <div className="crm-email-sender-aside flex min-w-0 flex-col justify-between gap-4 p-4 sm:p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className={cn(crm.label, "crm-email-section-label")}>Last activity</p>
                <p className="mt-2 text-sm font-bold text-crm-text">
                  {lastActivity ? formatWhen(lastActivity.when) : "No activity yet"}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-crm-muted">
                  {lastActivity ? lastActivity.label : "Activity appears after sends or reply syncs."}
                </p>
              </div>
              <span className={cn(crm.emailIconWell, "crm-email-mail-illus h-16 w-16 text-crm-accent")}>
                <Mail className="h-7 w-7" />
                <Sparkles className="crm-email-mail-spark h-4 w-4" />
              </span>
            </div>
            {canEmailSettings ? (
              <Link href="/crm/email/settings" className={cn(connected ? crm.btnSecondary : crm.btnPrimary, "crm-email-manage-btn w-full")}>
                {connected ? "Manage sender" : "Connect Google"}
              </Link>
            ) : (
              <button
                type="button"
                disabled={connectBusy || connected}
                onClick={() => void startUserOAuth()}
                className={cn(connected ? crm.btnSecondary : crm.btnPrimary, "crm-email-manage-btn w-full")}
              >
                {connectBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {connected ? "Google connected" : "Connect Google"}
              </button>
            )}
          </div>
        </div>
      </CRMCard>

      <div className="crm-email-workspace-grid grid gap-4 lg:grid-cols-[minmax(0,1.08fr)_minmax(22rem,0.92fr)]">
        <CRMCard padding="none" className={cn(crm.emailPanel, "crm-email-replies-card")}>
          <div className="relative z-[1] flex min-h-[11rem] flex-col p-3.5 sm:p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-sm font-bold tracking-tight text-crm-text">
                <span className={cn(crm.emailIconWell, "crm-email-card-title-icon h-8 w-8 text-crm-accent")}>
                  <Inbox className="h-4 w-4" />
                </span>
                Recent replies
              </h3>
              {canEmailSettings ? (
                <Link href="/crm/email/settings" className="crm-email-action-link inline-flex items-center gap-1 text-xs font-bold text-crm-accent">
                  Reply tracking <ArrowRight className="h-3 w-3" />
                </Link>
              ) : null}
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-crm-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading replies...</div>
            ) : replies.length === 0 ? (
              <EmptyRepliesState />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {replies.map((message) => (
                  <li key={message.id} className="crm-email-reply-row rounded-crm border border-crm-border/65 bg-crm-surface-2/35 px-3.5 py-3">
                    <div className="flex items-start gap-3">
                      <span className={cn(crm.statusDotSync, "mt-2")} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-crm-text">{message.subject || "(no subject)"}</p>
                        <p className="mt-1 truncate text-xs text-crm-muted">
                          {message.contactId ? (
                            <Link href={`/crm/contacts/${message.contactId}`} className="text-crm-accent">
                              {message.fromEmail || "(unknown)"}
                            </Link>
                          ) : (message.fromEmail || "(unknown)")}
                          {message.receivedAt ? ` · ${formatCompactWhen(message.receivedAt)}` : null}
                        </p>
                        {message.previewSnippet ? (
                          <p className="mt-2 line-clamp-1 text-xs leading-relaxed text-crm-muted">{message.previewSnippet}</p>
                        ) : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CRMCard>

        <CRMCard padding="none" className={cn(crm.emailPanel, "crm-email-sent-card")}>
          <div className="relative z-[1] flex min-h-[11rem] flex-col p-3.5 sm:p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-sm font-bold tracking-tight text-crm-text">
                <span className={cn(crm.emailIconWell, "crm-email-card-title-icon h-8 w-8 text-crm-accent")}>
                  <Send className="h-4 w-4" />
                </span>
                Recent sent
              </h3>
              <Link href="/crm/email/templates" className="crm-email-action-link inline-flex items-center gap-1 text-xs font-bold text-crm-accent">
                Templates <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-crm-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading sends...</div>
            ) : recent.length === 0 ? (
              <EmptySentState />
            ) : (
              <>
                <ul className="m-0 flex list-none flex-col divide-y divide-crm-border/55 p-0">
                  {recent.slice(0, 7).map((message) => (
                    <li key={message.id} className="crm-email-sent-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5 first:pt-0">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold leading-tight text-crm-text">{message.subject || "(no subject)"}</p>
                        <p className="mt-1 truncate text-xs text-crm-muted">
                          {message.contactId ? (
                            <Link href={`/crm/contacts/${message.contactId}`} className="text-crm-accent">
                              {message.toEmail}
                            </Link>
                          ) : message.toEmail}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="hidden text-[11px] font-medium text-crm-muted sm:inline">{formatCompactWhen(message.sentAt)}</span>
                        <span
                          className={cn(
                            "crm-email-status-badge inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide",
                            message.status === "SENT" ? "crm-email-status-sent text-crm-success" : "crm-email-status-failed text-crm-danger",
                          )}
                          title={message.errorMessage || undefined}
                        >
                          {message.status === "SENT" ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                          {message.status}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => void loadMoreSent()}
                  disabled={loadingMoreSent}
                  className="crm-email-view-all mt-auto inline-flex items-center justify-center gap-1.5 border-t border-crm-border/60 pt-4 text-xs font-bold text-crm-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loadingMoreSent ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  View all sent emails <ArrowRight className="h-3 w-3" />
                </button>
              </>
            )}
          </div>
        </CRMCard>
      </div>

      <section className="crm-email-kpi-strip grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Sent"
          value={loading ? "..." : sentCount}
          detail={failedCount > 0 ? `${failedCount} failed in recent activity` : "Live from recent CRM sends"}
          icon={<Send className="h-5 w-5" />}
          accent="blue"
        />
        <KpiCard
          label="Delivered"
          value={loading ? "..." : deliveredCount}
          detail={sentCount > 0 ? `${Math.round((deliveredCount / sentCount) * 100)}% of recent sends` : "No recent delivery metadata"}
          icon={<CheckCircle2 className="h-5 w-5" />}
          accent="green"
        />
        <KpiCard
          label="Replies"
          value={loading ? "..." : replyCount}
          detail={replyCount > 0 ? "Tracked reply metadata visible" : "No replies from recent sync"}
          icon={<MessageCircle className="h-5 w-5" />}
          accent="violet"
        />
        <KpiCard
          label="Reply rate"
          value={loading ? "..." : `${replyRate}%`}
          detail={sentCount > 0 ? "Replies divided by recent sends" : "Awaiting recent send volume"}
          icon={<BarChart3 className="h-5 w-5" />}
          accent="rose"
        />
      </section>
    </CRMPageShell>
    </PermissionGate>
  );
}

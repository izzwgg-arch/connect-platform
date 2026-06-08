"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ExternalLink,
  FileText,
  Inbox,
  Loader2,
  Mail,
  MessageCircle,
  Send,
  Settings,
  ShieldCheck,
  Clock3,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import {
  CRMPageShell,
  CRMPageHeader,
  CRMWorkspaceShell,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceToolbar,
  CRMWorkspaceBody,
  CRMWorkspaceMain,
  CRMWorkspaceScrollRegion,
  crm,
  cn,
} from "../../../../components/crm";
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
  gmailMessageId?: string | null;
};

type RecentReply = {
  id: string;
  gmailMessageId: string;
  gmailThreadId: string | null;
  subject: string | null;
  fromEmail: string | null;
  toEmail: string | null;
  previewSnippet: string | null;
  replyText?: string | null;
  receivedAt: string | null;
  contactId: string | null;
};

const DEV_PREVIEW_ENABLED = process.env.NODE_ENV === "development";

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const DEV_PREVIEW_CONN: EmailConnection = {
  connected: true,
  emailAddress: "alex@connectcomms.example",
  displayName: "Alex Morgan",
  replyTrackingEnabled: true,
};

const DEV_PREVIEW_REPLIES: RecentReply[] = [
  {
    id: "preview-reply-1",
    gmailMessageId: "preview-message-1",
    gmailThreadId: "thread-a:r9146529078213651041",
    subject: "Re: Funding application next steps",
    fromEmail: "jordan@northstar.example",
    toEmail: "alex@connectcomms.example",
    previewSnippet: "Thanks for sending this over. Friday afternoon works for a quick follow-up call.",
    replyText: "Thanks for sending this over. Friday afternoon works for a quick follow-up call.",
    receivedAt: minutesAgo(28),
    contactId: null,
  },
  {
    id: "preview-reply-2",
    gmailMessageId: "preview-message-2",
    gmailThreadId: null,
    subject: "Re: Updated offer summary",
    fromEmail: "maria@harbor-retail.example",
    toEmail: "alex@connectcomms.example",
    previewSnippet: "Can you send the shorter version to my partner before we decide?",
    replyText: "Can you send the shorter version to my partner before we decide?",
    receivedAt: minutesAgo(94),
    contactId: null,
  },
  {
    id: "preview-reply-3",
    gmailMessageId: "preview-message-3",
    gmailThreadId: "thread-a:r7284065119736402218",
    subject: "Re: Checking in after your call",
    fromEmail: "sam@greenfield.example",
    toEmail: "alex@connectcomms.example",
    previewSnippet: "Looks good. Please keep me posted once underwriting has the package.",
    replyText: "Looks good. Please keep me posted once underwriting has the package.",
    receivedAt: minutesAgo(210),
    contactId: null,
  },
];

const DEV_PREVIEW_SENT: RecentSent[] = [
  {
    id: "preview-sent-1",
    toEmail: "jordan@northstar.example",
    subject: "Funding application next steps",
    status: "SENT",
    errorMessage: null,
    sentAt: minutesAgo(65),
    contactId: null,
    gmailMessageId: "preview-sent-message-1",
  },
  {
    id: "preview-sent-2",
    toEmail: "maria@harbor-retail.example",
    subject: "Updated offer summary",
    status: "SENT",
    errorMessage: null,
    sentAt: minutesAgo(138),
    contactId: null,
    gmailMessageId: "preview-sent-message-2",
  },
  {
    id: "preview-sent-3",
    toEmail: "sam@greenfield.example",
    subject: "Checking in after your call",
    status: "SENT",
    errorMessage: null,
    sentAt: minutesAgo(260),
    contactId: null,
    gmailMessageId: "preview-sent-message-3",
  },
  {
    id: "preview-sent-4",
    toEmail: "lee@crescent.example",
    subject: "Documents needed for review",
    status: "FAILED",
    errorMessage: "Mailbox rejected the recipient address.",
    sentAt: minutesAgo(390),
    contactId: null,
    gmailMessageId: null,
  },
];

const DEV_PREVIEW_DIAG: ReplyTrackingDiag = {
  trackedThreads: 18,
  inboundReplies: 7,
  outboundMessages: 42,
  legacyThreadsWithNullSender: 0,
  connectionsTotal: 1,
  connectionsEnabled: 1,
  connectionsDisabled: 0,
  connectionsMissingScope: 0,
  lastSyncAt: minutesAgo(11),
  autoSyncEnabled: true,
  autoSyncIntervalMs: 300_000,
};

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
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
  } catch {
    return iso;
  }
}

function gmailInboxUrl(): string {
  return "https://mail.google.com/mail/u/0/#inbox";
}

function gmailThreadUrl(threadId: string): string {
  const safeThreadId = threadId.replace(/[<>"']/g, "");
  return `https://mail.google.com/mail/u/0/#inbox/${safeThreadId}`;
}

function gmailSearchUrl(params: { to?: string | null; from?: string | null; subject?: string | null }): string {
  const parts: string[] = [];
  if (params.from) parts.push(`from:${params.from}`);
  if (params.to) parts.push(`to:${params.to}`);
  if (params.subject) {
    const safeSubject = params.subject.replace(/"/g, "").trim();
    if (safeSubject) parts.push(`subject:"${safeSubject}"`);
  }
  const query = parts.length > 0 ? parts.join(" ") : "in:sent";
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
}

function resolveReplyGmailHref(message: RecentReply): string {
  if (message.gmailThreadId) return gmailThreadUrl(message.gmailThreadId);
  return gmailSearchUrl({ from: message.fromEmail, subject: message.subject });
}

function resolveSentGmailHref(message: RecentSent): string {
  return gmailSearchUrl({ to: message.toEmail, subject: message.subject });
}

function EmailKpiTile({
  label,
  value,
  hint,
  icon: Icon,
  tone,
  loading,
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: LucideIcon;
  tone: "blue" | "green" | "violet" | "rose" | "cyan" | "amber";
  loading?: boolean;
}) {
  return (
    <div className={cn(crm.queueCountPill, `crm-queue-kpi-${tone}`, "relative overflow-hidden bg-crm-surface-2")}>
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">
            {label}
          </span>
          {loading ? (
            <span className="crm-queue-kpi-value mt-1 block h-7 w-12 animate-pulse rounded bg-crm-surface-2" />
          ) : (
            <span className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">
              {value}
            </span>
          )}
        </span>
        <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
          <Icon className="h-4 w-4" />
        </span>
      </span>
      <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">{hint}</span>
    </div>
  );
}

function GmailLinkButton({
  href,
  label,
  compact = false,
}: {
  href: string;
  label: string;
  compact?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        compact ? "crm-email-gmail-link-compact" : "crm-email-gmail-link",
        "inline-flex items-center gap-1.5 rounded-crm border border-crm-border/70 bg-crm-surface-2/60 text-xs font-bold text-crm-text transition hover:border-crm-accent/35 hover:bg-crm-accent/5 hover:text-crm-accent",
        compact ? "px-2 py-1" : "px-2.5 py-1.5",
      )}
    >
      <Mail className="h-3 w-3" />
      {label}
      <ExternalLink className="h-3 w-3 opacity-70" />
    </a>
  );
}

function EmptyRepliesState({
  connected,
  canEmailSettings,
}: {
  connected: boolean;
  canEmailSettings: boolean;
}) {
  return (
    <div className="crm-email-empty tasks-empty-state flex min-h-[12rem] flex-col items-center justify-center px-6 py-8 text-center">
      <span className="crm-email-empty-icon mb-3 flex h-11 w-11 items-center justify-center rounded-crm border border-crm-border/60 bg-crm-surface-2 text-crm-accent">
        <MessageCircle className="h-5 w-5" />
      </span>
      <h3 className="text-base font-semibold text-crm-text">No replies synced yet</h3>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-crm-muted">
        Connect tracks reply metadata only - conversations stay in Gmail. Enable reply tracking, then sync to see activity here.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {canEmailSettings ? (
          <Link href="/crm/email/settings" className="campaigns-btn-secondary inline-flex items-center gap-2">
            <Settings className="h-4 w-4" />
            Email settings
          </Link>
        ) : null}
        {connected ? (
          <a href={gmailInboxUrl()} target="_blank" rel="noopener noreferrer" className="campaigns-btn-primary inline-flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Open Gmail
          </a>
        ) : null}
      </div>
    </div>
  );
}

function EmptySentState() {
  return (
    <div className="crm-email-empty tasks-empty-state flex min-h-[12rem] flex-col items-center justify-center px-6 py-8 text-center">
      <span className="crm-email-empty-icon mb-3 flex h-11 w-11 items-center justify-center rounded-crm border border-crm-border/60 bg-crm-surface-2 text-crm-accent">
        <Send className="h-5 w-5" />
      </span>
      <h3 className="text-base font-semibold text-crm-text">No outbound sends yet</h3>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-crm-muted">
        Send CRM email from a contact record to start outreach. Connect logs send metadata - replies happen in Gmail.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Link href="/crm/contacts" className="campaigns-btn-secondary inline-flex items-center gap-2">
          Open contacts
        </Link>
        <Link href="/crm/email/templates" className="campaigns-btn-secondary inline-flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Templates
        </Link>
      </div>
    </div>
  );
}

function EmptyConnectionState({
  canEmailSettings,
  connectBusy,
  onConnect,
}: {
  canEmailSettings: boolean;
  connectBusy: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="crm-email-empty tasks-empty-state flex min-h-[8rem] flex-col items-center justify-center px-6 py-6 text-center sm:min-h-0 sm:flex-row sm:items-center sm:justify-between sm:text-left">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-crm-text">Email channel not connected</h3>
        <p className="mt-1 max-w-xl text-sm leading-relaxed text-crm-muted">
          Connect Google to send CRM email and optionally track reply metadata. Connect does not store your inbox.
        </p>
      </div>
      <div className="mt-4 flex shrink-0 flex-wrap items-center gap-2 sm:mt-0">
        {canEmailSettings ? (
          <Link href="/crm/email/settings" className="campaigns-btn-primary inline-flex items-center gap-2">
            Connect Google
          </Link>
        ) : (
          <button type="button" disabled={connectBusy} onClick={onConnect} className="campaigns-btn-primary inline-flex items-center gap-2">
            {connectBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Connect Google
          </button>
        )}
      </div>
    </div>
  );
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

  const noTracking = diag !== null && diag.connectionsEnabled === 0;
  const missingScope = diag !== null && diag.connectionsMissingScope > 0;

  if (!noTracking && !missingScope) return null;

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-crm-lg border border-crm-warning/40 bg-crm-warning/10 px-4 py-3">
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-crm-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-crm-text">Reply tracking needs attention</p>
        <p className="mt-0.5 text-xs leading-relaxed text-crm-muted">
          {missingScope
            ? `${diag!.connectionsMissingScope} sender${diag!.connectionsMissingScope !== 1 ? "s" : ""} need${diag!.connectionsMissingScope === 1 ? "s" : ""} to be reconnected for Gmail read access. `
            : ""}
          {noTracking && !missingScope ? "Reply tracking is off for all connected senders. " : ""}
          Reply metadata will not sync until this is fixed. Conversations still happen in Gmail.
        </p>
      </div>
      {showSettingsLink ? (
        <Link href="/crm/email/settings" className="campaigns-btn-secondary shrink-0 inline-flex items-center gap-1.5 text-xs">
          <Settings className="h-3.5 w-3.5" />
          Fix in settings
        </Link>
      ) : null}
    </div>
  );
}

function EmailStatusRow({
  connected,
  loading,
  senderEmail,
  senderName,
  replyTrackingActive,
  lastSyncAt,
}: {
  connected: boolean;
  loading: boolean;
  senderEmail: string;
  senderName: string;
  replyTrackingActive: boolean;
  lastSyncAt: string | null;
}) {
  return (
    <section className="crm-email-status-row grid gap-3 md:grid-cols-3" aria-label="Email channel status">
      <div className="crm-email-status-card rounded-crm-lg border border-crm-border/70 bg-crm-surface px-4 py-3">
        <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Gmail connection</p>
        <div className="mt-2 flex items-center gap-2">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-crm-muted" />
          ) : (
            <span className={connected ? crm.statusDotLive : crm.statusDotWarn} />
          )}
          <p className="text-sm font-semibold text-crm-text">
            {loading ? "Checking..." : connected ? "Connected" : "Not connected"}
          </p>
        </div>
        <p className="mt-1 truncate text-xs text-crm-muted">{connected ? senderEmail : "Connect Google to send CRM email"}</p>
      </div>

      <div className="crm-email-status-card rounded-crm-lg border border-crm-border/70 bg-crm-surface px-4 py-3">
        <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Reply tracking</p>
        <div className="mt-2 flex items-center gap-2">
          <ShieldCheck className={cn("h-4 w-4", replyTrackingActive ? "text-crm-success" : "text-crm-warning")} />
          <p className="text-sm font-semibold text-crm-text">
            {loading ? "Checking..." : replyTrackingActive ? "Active" : connected ? "Disabled" : "Unavailable"}
          </p>
        </div>
        <p className="mt-1 text-xs text-crm-muted">
          {replyTrackingActive ? "Metadata sync enabled" : "Enable in settings to track replies"}
        </p>
      </div>

      <div className="crm-email-status-card rounded-crm-lg border border-crm-border/70 bg-crm-surface px-4 py-3">
        <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Sender account</p>
        <div className="mt-2 flex items-center gap-2">
          <Mail className="h-4 w-4 text-crm-accent" />
          <p className="truncate text-sm font-semibold text-crm-text">{loading ? "..." : senderName}</p>
        </div>
        <p className="mt-1 text-xs text-crm-muted">
          Last sync {formatRelative(lastSyncAt)}
        </p>
      </div>
    </section>
  );
}

function ActivityPanel({
  title,
  icon,
  action,
  children,
  className,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("crm-email-activity-card crm-queue-list-panel flex min-h-[20rem] min-w-0 flex-col", className)}>
      <div className="crm-email-activity-head flex items-center justify-between gap-3 border-b border-crm-border/60 px-4 py-3">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-bold tracking-tight text-crm-text">
          <span className="crm-email-card-title-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-crm border border-crm-border/60 bg-crm-surface-2 text-crm-accent">
            {icon}
          </span>
          {title}
        </h3>
        {action}
      </div>
      <div className="crm-email-panel-scroll custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </section>
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

  useEffect(() => {
    void load();
  }, [load]);

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

  const showPreviewData = DEV_PREVIEW_ENABLED && !loading && recent.length === 0 && replies.length === 0;
  const displayedConn = showPreviewData && !conn?.connected ? DEV_PREVIEW_CONN : conn;
  const displayedDiag = showPreviewData ? DEV_PREVIEW_DIAG : diag;
  const displayedRecent = showPreviewData ? DEV_PREVIEW_SENT : recent;
  const displayedReplies = showPreviewData ? DEV_PREVIEW_REPLIES : replies;

  const connected = Boolean(displayedConn?.connected);
  const senderName = connected ? displayedConn?.displayName || displayedConn?.emailAddress || "Connected sender" : "Not connected";
  const senderEmail = displayedConn?.emailAddress || "Connect Google in Settings";
  const sentCount = displayedRecent.length;
  const deliveredCount = displayedRecent.filter((message) => message.status === "SENT").length;
  const failedCount = displayedRecent.filter((message) => message.status === "FAILED").length;
  const replyCount = displayedReplies.length;
  const replyRate = sentCount > 0 ? Math.round((replyCount / sentCount) * 100) : 0;
  const replyTrackingActive = Boolean(
    connected && (displayedConn?.replyTrackingEnabled || (displayedDiag?.connectionsEnabled ?? 0) > 0),
  );
  const lastActivity =
    displayedReplies[0]?.receivedAt
      ? { when: displayedReplies[0].receivedAt, label: showPreviewData ? "Preview tracked reply metadata" : "Latest tracked reply metadata" }
      : displayedRecent[0]?.sentAt
        ? { when: displayedRecent[0].sentAt, label: showPreviewData ? "Preview outbound CRM email" : "Latest outbound CRM email" }
        : null;

  return (
    <PermissionGate permission="can_view_crm_email" fallback={<div className="state-box">You do not have CRM Email access.</div>}>
      <CRMPageShell className={crm.emailWorkspace} innerClassName={crm.pageInnerEmail}>
        <CRMWorkspaceShell>
          <CRMWorkspaceChrome>
            <CRMWorkspaceHeader>
              <CRMPageHeader
                compact
                icon={<Mail className="h-6 w-6" aria-hidden />}
                title="CRM Email"
                subtitle="Metadata-first email operations. Send from Connect - reply and converse in Gmail."
                className={cn(crm.contactsHeaderPanel, "campaigns-command-header")}
                actions={
                  <div className="campaigns-hero-actions flex flex-wrap items-center gap-2">
                    <Link href="/crm/email/templates" className="campaigns-btn-secondary inline-flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Templates
                    </Link>
                    {canEmailSettings ? (
                      <Link href="/crm/email/settings" className="campaigns-btn-secondary inline-flex items-center gap-2">
                        <Settings className="h-4 w-4" />
                        Settings
                      </Link>
                    ) : null}
                    {connected ? (
                      <a href={gmailInboxUrl()} target="_blank" rel="noopener noreferrer" className="campaigns-btn-primary inline-flex items-center gap-2">
                        <Mail className="h-4 w-4" />
                        Open Gmail
                        <ExternalLink className="h-3.5 w-3.5 opacity-80" />
                      </a>
                    ) : canEmailSettings ? (
                      <Link href="/crm/email/settings" className="campaigns-btn-primary inline-flex items-center gap-2">
                        Connect Google
                      </Link>
                    ) : (
                      <button type="button" disabled={connectBusy} onClick={() => void startUserOAuth()} className="campaigns-btn-primary inline-flex items-center gap-2">
                        {connectBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Connect Google
                      </button>
                    )}
                  </div>
                }
              />
            </CRMWorkspaceHeader>

            <CRMWorkspaceToolbar className="flex flex-col gap-3">
              <ReplyTrackingHealthBanner conn={displayedConn} diag={displayedDiag} loading={loading} showSettingsLink={canEmailSettings} />

              <section className="crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-4 xl:grid-cols-4" aria-label="Email metrics">
                <EmailKpiTile
                  label="Sent"
                  value={sentCount}
                  hint={failedCount > 0 ? `${failedCount} failed in recent activity` : "Recent CRM sends"}
                  icon={Send}
                  tone="blue"
                  loading={loading}
                />
                <EmailKpiTile
                  label="Delivered"
                  value={deliveredCount}
                  hint={sentCount > 0 ? `${Math.round((deliveredCount / sentCount) * 100)}% of recent sends` : "No recent delivery metadata"}
                  icon={CheckCircle2}
                  tone="green"
                  loading={loading}
                />
                <EmailKpiTile
                  label="Replies"
                  value={replyCount}
                  hint={replyCount > 0 ? "Tracked reply metadata" : "No replies synced yet"}
                  icon={MessageCircle}
                  tone="violet"
                  loading={loading}
                />
                <EmailKpiTile
                  label="Reply rate"
                  value={`${replyRate}%`}
                  hint={sentCount > 0 ? "Replies ÷ recent sends" : "Awaiting send volume"}
                  icon={BarChart3}
                  tone="cyan"
                  loading={loading}
                />
              </section>

              {!loading && !connected ? (
                <EmptyConnectionState
                  canEmailSettings={canEmailSettings}
                  connectBusy={connectBusy}
                  onConnect={() => void startUserOAuth()}
                />
              ) : (
                <EmailStatusRow
                  connected={connected}
                  loading={loading}
                  senderEmail={senderEmail}
                  senderName={senderName}
                  replyTrackingActive={replyTrackingActive}
                  lastSyncAt={displayedDiag?.lastSyncAt ?? null}
                />
              )}
            </CRMWorkspaceToolbar>
          </CRMWorkspaceChrome>

          <CRMWorkspaceBody>
            <CRMWorkspaceMain className="crm-queue-main-workspace min-w-0">
              <CRMWorkspaceScrollRegion className="crm-queue-center-workspace flex min-w-0 flex-col gap-4">
                <div className="crm-email-workspace-grid grid w-full min-w-0 gap-4 xl:grid-cols-2">
                  <ActivityPanel
                    title="Recent replies"
                    icon={<Inbox className="h-4 w-4" />}
                    action={
                      canEmailSettings ? (
                        <Link href="/crm/email/settings" className="crm-email-action-link inline-flex items-center gap-1 text-xs font-bold text-crm-accent">
                          Reply tracking <ArrowRight className="h-3 w-3" />
                        </Link>
                      ) : connected ? (
                        <GmailLinkButton href={gmailInboxUrl()} label="Open Gmail" compact />
                      ) : null
                    }
                  >
                    {loading ? (
                      <div className="flex items-center gap-2 text-sm text-crm-muted">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading replies...
                      </div>
                    ) : displayedReplies.length === 0 ? (
                      <EmptyRepliesState connected={connected} canEmailSettings={canEmailSettings} />
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-2 p-0">
                        {displayedReplies.map((message) => (
                          <li key={message.id} className="crm-email-reply-row rounded-crm border border-crm-border/65 bg-crm-surface-2/35 px-3.5 py-3">
                            <div className="flex items-start gap-3">
                              <span className={cn(crm.statusDotSync, "mt-2 shrink-0")} />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <p className="min-w-0 truncate text-sm font-bold text-crm-text">{message.subject || "(no subject)"}</p>
                                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                                    <GmailLinkButton href={resolveReplyGmailHref(message)} label="Reply in Gmail" compact />
                                    {message.gmailThreadId ? (
                                      <GmailLinkButton href={gmailThreadUrl(message.gmailThreadId)} label="View thread" compact />
                                    ) : null}
                                  </div>
                                </div>
                                <p className="mt-1 truncate text-xs text-crm-muted">
                                  {message.contactId ? (
                                    <Link href={`/crm/contacts/${message.contactId}`} className="text-crm-accent hover:underline">
                                      {message.fromEmail || "(unknown)"}
                                    </Link>
                                  ) : (
                                    message.fromEmail || "(unknown)"
                                  )}
                                  {message.receivedAt ? ` · ${formatCompactWhen(message.receivedAt)}` : null}
                                </p>
                                {message.replyText || message.previewSnippet ? (
                                  <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-crm-muted">
                                    {message.replyText || message.previewSnippet}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </ActivityPanel>

                  <ActivityPanel
                    title="Recent sent"
                    icon={<Send className="h-4 w-4" />}
                    action={
                      <Link href="/crm/email/templates" className="crm-email-action-link inline-flex items-center gap-1 text-xs font-bold text-crm-accent">
                        Templates <ArrowRight className="h-3 w-3" />
                      </Link>
                    }
                  >
                    {loading ? (
                      <div className="flex items-center gap-2 text-sm text-crm-muted">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading sends...
                      </div>
                    ) : displayedRecent.length === 0 ? (
                      <EmptySentState />
                    ) : (
                      <>
                        <ul className="m-0 flex list-none flex-col divide-y divide-crm-border/55 p-0">
                          {displayedRecent.map((message) => (
                            <li key={message.id} className="crm-email-sent-row grid grid-cols-1 items-start gap-2 py-3 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-bold leading-tight text-crm-text">{message.subject || "(no subject)"}</p>
                                <p className="mt-1 truncate text-xs text-crm-muted">
                                  {message.contactId ? (
                                    <Link href={`/crm/contacts/${message.contactId}`} className="text-crm-accent hover:underline">
                                      {message.toEmail}
                                    </Link>
                                  ) : (
                                    message.toEmail
                                  )}
                                </p>
                              </div>
                              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                                <span className="text-[11px] font-medium text-crm-muted">{formatCompactWhen(message.sentAt)}</span>
                                {connected && message.status === "SENT" ? (
                                  <GmailLinkButton href={resolveSentGmailHref(message)} label="View in Gmail" compact />
                                ) : null}
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
                          className="crm-email-action-link crm-email-view-all mt-2 inline-flex items-center gap-1 text-xs font-bold text-crm-accent disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {loadingMoreSent ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                          View all sent emails <ArrowRight className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </ActivityPanel>
                </div>

                <section className="crm-email-quick-actions crm-queue-list-panel px-4 py-4 sm:px-5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Gmail-first workflow</p>
                  <h3 className="mt-1 text-sm font-bold text-crm-text">Reply in Gmail, track activity in Connect</h3>
                  <p className="mt-1 max-w-2xl text-xs leading-relaxed text-crm-muted">
                    Connect sends outbound CRM email and stores metadata only. When a contact replies, open the thread in Gmail to continue the conversation.
                    {lastActivity ? ` Last activity: ${formatWhen(lastActivity.when)} - ${lastActivity.label}.` : null}
                  </p>
                  {displayedDiag ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-crm-border/65 bg-crm-surface-2/45 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-crm-muted">
                        <Clock3 className="h-3 w-3 text-crm-accent" />
                        Sync {formatRelative(displayedDiag.lastSyncAt)}
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-crm-border/65 bg-crm-surface-2/45 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-crm-muted">
                        {displayedDiag.trackedThreads} tracked threads
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-crm-border/65 bg-crm-surface-2/45 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-crm-muted">
                        {displayedDiag.inboundReplies} total replies
                      </span>
                    </div>
                  ) : null}
                </section>
              </CRMWorkspaceScrollRegion>
            </CRMWorkspaceMain>
          </CRMWorkspaceBody>
        </CRMWorkspaceShell>
      </CRMPageShell>
    </PermissionGate>
  );
}

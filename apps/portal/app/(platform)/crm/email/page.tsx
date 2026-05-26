"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Mail, Settings, FileText, Send, Loader2, Inbox, ArrowRight } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { apiGet } from "../../../../services/apiClient";

type EmailConnection = {
  connected: boolean;
  emailAddress: string | null;
  displayName: string | null;
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

function EmptyOperationalState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-crm border border-dashed border-crm-border/70 bg-crm-surface-2/25 px-3 py-5">
      <div className="mb-2 flex items-center gap-2">
        <span className={cn(crm.statusDot, "bg-crm-muted/60")} />
        <p className="text-sm font-semibold text-crm-text">{title}</p>
      </div>
      <p className="text-xs leading-relaxed text-crm-muted">{body}</p>
    </div>
  );
}

export default function CrmEmailLandingPage() {
  const [conn, setConn] = useState<EmailConnection | null>(null);
  const [recent, setRecent] = useState<RecentSent[]>([]);
  const [replies, setReplies] = useState<RecentReply[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, r, rr] = await Promise.all([
        apiGet<EmailConnection>("/crm/email/connection").catch(() => null),
        apiGet<{ sent: RecentSent[] }>("/crm/email/recent?limit=10").catch(() => ({ sent: [] })),
        apiGet<{ replies: RecentReply[] }>("/crm/email/replies/recent?limit=5").catch(() => ({ replies: [] })),
      ]);
      setConn(c);
      setRecent(r?.sent ?? []);
      setReplies(rr?.replies ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <CRMPageShell innerClassName={cn(crm.pageInnerWide, "gap-4")}>
      <CRMPageHeader
        icon={<Mail className="h-5 w-5" />}
        title="CRM Email"
        subtitle={`Metadata-first email operations. Connect never archives your inbox.${replies.length ? ` ${replies.length} recent repl${replies.length === 1 ? "y" : "ies"} visible.` : ""}`}
        actions={
          <>
            <Link href="/crm/email/templates" className={crm.btnSecondary}>
              <FileText className="h-4 w-4" /> Templates
            </Link>
            <Link href="/crm/email/settings" className={crm.btnPrimary}>
              <Settings className="h-4 w-4" /> Settings
            </Link>
          </>
        }
      />

      <CRMCard className={cn("p-0", crm.opCard, "border-crm-border/80")}>
        <div className={crm.opCardGlow} />
        <div className="relative z-[1] grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.38fr)] lg:divide-x lg:divide-crm-border/60">
          <div className="p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className={crm.label}>Sender infrastructure</p>
                <h2 className="mt-1 text-lg font-semibold tracking-tight text-crm-text">
                  {conn?.connected ? conn.displayName || conn.emailAddress : "Email channel not connected"}
                </h2>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-crm-muted">
                  {conn?.connected
                    ? "CRM contact pages can send through the connected Google account while reply metadata stays scoped to CRM."
                    : "Connect a Google account in Settings to unlock CRM sending and reply tracking."}
                </p>
              </div>
              <span
                className={cn(
                  crm.chip,
                  "text-[10px] uppercase tracking-wide",
                  loading
                    ? "border-crm-accent/35 bg-crm-accent/10 text-crm-accent"
                    : conn?.connected
                      ? "border-crm-success/35 bg-crm-success/10 text-crm-success"
                      : "border-crm-warning/35 bg-crm-warning/10 text-crm-warning",
                )}
              >
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className={conn?.connected ? crm.statusDotLive : crm.statusDotWarn} />}
                {loading ? "Syncing" : conn?.connected ? "Connected" : "Disconnected"}
              </span>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <div className={cn(crm.opInset, "px-3 py-2.5")}>
                <p className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">Connection</p>
                <p className="mt-1 text-sm font-semibold text-crm-text">{conn?.connected ? "Google OAuth active" : "Action needed"}</p>
              </div>
              <div className={cn(crm.opInset, "px-3 py-2.5")}>
                <p className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">Recent replies</p>
                <p className="mt-1 font-mono text-lg font-semibold text-crm-text">{loading ? "—" : replies.length}</p>
              </div>
              <div className={cn(crm.opInset, "px-3 py-2.5")}>
                <p className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">Recent sent</p>
                <p className="mt-1 font-mono text-lg font-semibold text-crm-text">{loading ? "—" : recent.length}</p>
              </div>
            </div>
          </div>

          <div className="flex flex-col justify-between gap-4 bg-crm-surface-2/20 p-4 sm:p-5">
            <div>
              <p className={crm.label}>Last activity</p>
              <p className="mt-1 text-sm font-semibold text-crm-text">
                {replies[0]?.receivedAt
                  ? formatWhen(replies[0].receivedAt)
                  : recent[0]?.sentAt
                    ? formatWhen(recent[0].sentAt)
                    : "No activity yet"}
              </p>
              <p className="mt-1 text-xs text-crm-muted">
                {replies[0]?.receivedAt ? "Latest tracked reply metadata" : recent[0]?.sentAt ? "Latest outbound CRM email" : "Activity appears after sends or reply syncs."}
              </p>
            </div>
            {!conn?.connected ? (
              <Link href="/crm/email/settings" className={cn(crm.btnPrimary, "text-xs")}>Connect Google</Link>
            ) : (
              <Link href="/crm/email/settings" className={cn(crm.btnSecondary, "text-xs")}>Manage sender</Link>
            )}
          </div>
        </div>
      </CRMCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <CRMCard className={cn("p-4 sm:p-5", crm.opCard, "border-crm-border/80")}>
          <div className={crm.opCardGlow} />
          <div className="relative z-[1]">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-crm-text">
                <span className="flex h-8 w-8 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface-2/60 text-crm-accent"><Inbox className="h-4 w-4" /></span>
                Recent replies
              </h3>
              <Link href="/crm/email/settings" className="inline-flex items-center gap-1 text-xs font-semibold text-crm-accent hover:brightness-110">Reply tracking <ArrowRight className="h-3 w-3" /></Link>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-crm-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : replies.length === 0 ? (
              <EmptyOperationalState title="No replies synced" body="Enable reply tracking in Settings, then click Sync now to fetch metadata." />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {replies.map((m) => (
                  <li key={m.id} className="group rounded-crm border border-crm-border/60 bg-crm-surface-2/35 px-3 py-2 transition-all duration-200 hover:-translate-y-px hover:border-crm-border hover:bg-crm-surface-2/60">
                    <div className="flex items-start gap-2">
                      <span className={cn(crm.statusDotSync, "mt-1.5")} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-crm-text">{m.subject || "(no subject)"}</p>
                        <p className="truncate text-xs text-crm-muted">
                          {m.contactId ? (
                            <Link href={`/crm/contacts/${m.contactId}`} className="text-crm-accent hover:brightness-110">
                              {m.fromEmail || "(unknown)"}
                            </Link>
                          ) : (m.fromEmail || "(unknown)")}
                          {m.receivedAt ? ` · ${formatWhen(m.receivedAt)}` : null}
                        </p>
                        {m.previewSnippet && (
                          <p className="mt-1 line-clamp-1 text-[11px] text-crm-muted">{m.previewSnippet}</p>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CRMCard>

        <CRMCard className={cn("p-4 sm:p-5", crm.opCard, "border-crm-border/80")}>
          <div className={crm.opCardGlow} />
          <div className="relative z-[1]">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-crm-text">
                <span className="flex h-8 w-8 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface-2/60 text-crm-accent"><Send className="h-4 w-4" /></span>
                Recent sent
              </h3>
              <Link href="/crm/email/templates" className="inline-flex items-center gap-1 text-xs font-semibold text-crm-accent hover:brightness-110">Templates <ArrowRight className="h-3 w-3" /></Link>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-crm-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : recent.length === 0 ? (
              <EmptyOperationalState title="No outbound sends" body="Open any contact and click Send Email to begin CRM outreach." />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {recent.map((r) => (
                  <li key={r.id} className="group flex items-center justify-between gap-3 rounded-crm border border-crm-border/60 bg-crm-surface-2/35 px-3 py-2 transition-all duration-200 hover:-translate-y-px hover:border-crm-border hover:bg-crm-surface-2/60">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-crm-text">{r.subject || "(no subject)"}</p>
                      <p className="truncate text-xs text-crm-muted">
                        {r.contactId ? (
                          <Link href={`/crm/contacts/${r.contactId}`} className="text-crm-accent hover:brightness-110">
                            {r.toEmail}
                          </Link>
                        ) : r.toEmail}
                        {" · "}{formatWhen(r.sentAt)}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                        r.status === "SENT"
                          ? "border-crm-success/35 bg-crm-success/10 text-crm-success"
                          : "border-crm-danger/35 bg-crm-danger/10 text-crm-danger",
                      )}
                      title={r.errorMessage || undefined}
                    >
                      <span className={r.status === "SENT" ? crm.statusDotLive : crm.statusDotDanger} />
                      {r.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CRMCard>
      </div>
    </CRMPageShell>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Mail, Settings, FileText, Send, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
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
    <CRMPageShell innerClassName="space-y-4">
      <CRMPageHeader
        icon={<Mail className="h-5 w-5" />}
        title="CRM Email"
        subtitle={`Send CRM emails from your connected Google account. Metadata-first — Connect never archives your inbox.${replies.length ? ` · ${replies.length} recent repl${replies.length === 1 ? "y" : "ies"}` : ""}`}
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

      <CRMCard className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-crm-muted" />
            ) : conn?.connected ? (
              <CheckCircle2 className="h-5 w-5 text-crm-success" />
            ) : (
              <AlertCircle className="h-5 w-5 text-crm-warning" />
            )}
            <div>
              <p className="text-sm font-semibold text-crm-text">
                {conn?.connected ? `Connected as ${conn.displayName || conn.emailAddress}` : "Not connected"}
              </p>
              <p className="text-xs text-crm-muted">
                {conn?.connected
                  ? "You can send emails from CRM contact pages."
                  : "Connect a Google account in Settings to start sending."}
              </p>
            </div>
          </div>
          {!conn?.connected ? (
            <Link href="/crm/email/settings" className={cn(crm.btnPrimary, "text-xs")}>Connect Google</Link>
          ) : null}
        </div>
      </CRMCard>

      <CRMCard className="p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-crm-text">
            <Mail className="mr-1.5 inline h-4 w-4 text-crm-muted" />
            Recent replies
          </h3>
          <Link href="/crm/email/settings" className="text-xs text-crm-accent hover:underline">Reply tracking →</Link>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-crm-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : replies.length === 0 ? (
          <p className="py-6 text-center text-sm text-crm-muted">
            No recent replies. Enable reply tracking in Settings, then click Sync now to fetch metadata.
          </p>
        ) : (
          <ul className="divide-y divide-crm-border/70">
            {replies.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-crm-text">{m.subject || "(no subject)"}</p>
                  <p className="truncate text-xs text-crm-muted">
                    {m.contactId ? (
                      <Link href={`/crm/contacts/${m.contactId}`} className="text-crm-accent hover:underline">
                        {m.fromEmail || "(unknown)"}
                      </Link>
                    ) : (m.fromEmail || "(unknown)")}
                    {m.receivedAt ? ` · ${formatWhen(m.receivedAt)}` : null}
                  </p>
                  {m.previewSnippet && (
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-crm-muted">{m.previewSnippet}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CRMCard>

      <CRMCard className="p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-crm-text">
            <Send className="mr-1.5 inline h-4 w-4 text-crm-muted" />
            Recent sent
          </h3>
          <Link href="/crm/email/templates" className="text-xs text-crm-accent hover:underline">Manage templates →</Link>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-crm-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : recent.length === 0 ? (
          <p className="py-6 text-center text-sm text-crm-muted">
            No emails sent yet. Open any contact and click <span className="font-semibold text-crm-text">Send Email</span> to begin.
          </p>
        ) : (
          <ul className="divide-y divide-crm-border/70">
            {recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-crm-text">{r.subject || "(no subject)"}</p>
                  <p className="truncate text-xs text-crm-muted">
                    {r.contactId ? (
                      <Link href={`/crm/contacts/${r.contactId}`} className="text-crm-accent hover:underline">
                        {r.toEmail}
                      </Link>
                    ) : r.toEmail}
                    {" · "}{formatWhen(r.sentAt)}
                  </p>
                </div>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase",
                    r.status === "SENT"
                      ? "bg-crm-success/15 text-crm-success"
                      : "bg-crm-danger/15 text-crm-danger",
                  )}
                  title={r.errorMessage || undefined}
                >
                  {r.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CRMCard>
    </CRMPageShell>
  );
}

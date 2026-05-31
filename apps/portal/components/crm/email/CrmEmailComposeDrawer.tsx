"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Mail, X, Send, FileText, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { htmlToCrmPlainText, renderCrmMergeTemplate } from "@connect/shared";
import { apiGet, apiPost } from "../../../services/apiClient";
import { crm } from "../crmClasses";
import { cn } from "../cn";

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
};

type ConnectionsResp = { senders: Sender[]; canManageTenantSenders: boolean };

type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  visibility: "SHARED" | "PRIVATE";
};

type ContactMergeFields = {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  company?: string | null;
  email?: string | null;
};

function applyMergeFields(text: string, fields: ContactMergeFields): string {
  return renderCrmMergeTemplate(text, {
    "contact.firstName": fields.firstName || "",
    "contact.lastName": fields.lastName || "",
    "contact.fullName": fields.displayName || "",
    "contact.displayName": fields.displayName || "",
    "contact.company": fields.company || "",
    "contact.email": fields.email || "",
  });
}

export function CrmEmailComposeDrawer({
  open,
  onClose,
  contactId,
  contactName,
  contactEmail,
  mergeFields,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  mergeFields: ContactMergeFields;
  onSent?: () => void;
}) {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [connLoading, setConnLoading] = useState(false);
  const [senderId, setSenderId] = useState<string>("");
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateId, setTemplateId] = useState<string>("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const loadConn = useCallback(async () => {
    setConnLoading(true);
    try {
      const res = await apiGet<ConnectionsResp>("/crm/email/connections");
      const usable = (res?.senders ?? []).filter((s) => s.status === "CONNECTED");
      setSenders(usable);
      // Default selection per fallback chain: my USER → tenant default → first
      const mine = usable.find((s) => s.scope === "USER" && s.isMine);
      const def = usable.find((s) => s.scope === "TENANT" && s.isDefaultForTenant);
      setSenderId(mine?.id || def?.id || usable[0]?.id || "");
    } catch (e: any) {
      setError(e?.message || "Failed to load email senders");
    } finally {
      setConnLoading(false);
    }
  }, []);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const res = await apiGet<{ templates: EmailTemplate[] }>("/crm/email/templates");
      setTemplates(res?.templates ?? []);
    } catch {
      setTemplates([]);
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSent(false);
    void loadConn();
    void loadTemplates();
  }, [open, loadConn, loadTemplates]);

  const applyTemplate = useCallback((id: string) => {
    setTemplateId(id);
    if (!id) {
      setSubject("");
      setBodyText("");
      return;
    }
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    setSubject(applyMergeFields(tpl.subject, mergeFields));
    setBodyText(applyMergeFields(tpl.bodyText || htmlToCrmPlainText(tpl.bodyHtml || ""), mergeFields));
  }, [templates, mergeFields]);

  const selectedSender = useMemo(() => senders.find((s) => s.id === senderId) ?? null, [senders, senderId]);

  const canSend = useMemo(() => {
    if (!selectedSender) return false;
    if (!contactEmail) return false;
    if (!subject.trim()) return false;
    if (!bodyText.trim()) return false;
    return !sending;
  }, [selectedSender, contactEmail, subject, bodyText, sending]);

  const handleSend = async () => {
    if (!canSend || !selectedSender) return;
    setSending(true);
    setError(null);
    try {
      await apiPost<{ ok: boolean }>("/crm/email/send", {
        contactId,
        subject: subject.trim().slice(0, 500),
        bodyText: bodyText.slice(0, 50000),
        templateId: templateId || undefined,
        connectionId: selectedSender.id,
      });
      setSent(true);
      onSent?.();
      setTimeout(() => { onClose(); }, 900);
    } catch (e: any) {
      setError(e?.message || "Failed to send email");
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Compose email"
      className="fixed inset-0 z-[60] flex justify-end bg-black/40 backdrop-blur-[2px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-full w-full max-w-[640px] flex-col border-l border-crm-border bg-crm-surface shadow-2xl">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-crm-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <Mail className="h-5 w-5 text-crm-accent" />
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-crm-text">Email {contactName}</h2>
              <p className="truncate text-xs text-crm-muted">
                {contactEmail ? <>To <span className="text-crm-text">{contactEmail}</span></> : "No email on file"}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-crm-muted hover:bg-crm-surface-2 hover:text-crm-text" aria-label="Close compose">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {connLoading ? (
            <div className="flex items-center gap-2 text-sm text-crm-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : senders.length === 0 ? (
            <div className="flex flex-col gap-3 rounded-crm border border-crm-warning/40 bg-crm-warning/10 p-4">
              <div className="flex items-start gap-2 text-sm text-crm-warning">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">No sender available</p>
                  <p className="mt-1 text-crm-text/80">Connect your own Google account, or ask a CRM admin to connect a shared mailbox. Send-only — Connect never reads your inbox.</p>
                </div>
              </div>
              <Link href="/crm/email/settings" className={cn(crm.btnPrimary, "self-start text-xs")} onClick={onClose}>
                Go to Email Settings
              </Link>
            </div>
          ) : !contactEmail ? (
            <div className="flex flex-col gap-3 rounded-crm border border-crm-warning/40 bg-crm-warning/10 p-4">
              <div className="flex items-start gap-2 text-sm text-crm-warning">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">No email on this contact</p>
                  <p className="mt-1 text-crm-text/80">Add an email address to {contactName} first, then return here to compose.</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {senders.length > 1 ? (
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-crm-muted">Send from</label>
                  <select
                    value={senderId}
                    onChange={(e) => setSenderId(e.target.value)}
                    className={crm.select}
                  >
                    {senders.map((s) => {
                      const display = s.label || s.senderName || s.displayName || s.emailAddress;
                      const tag = s.scope === "USER" ? "My email" : s.isDefaultForTenant ? "Shared (default)" : "Shared";
                      return (
                        <option key={s.id} value={s.id}>
                          {tag} — {display} &lt;{s.emailAddress}&gt;
                        </option>
                      );
                    })}
                  </select>
                </div>
              ) : (
                <div className="rounded-crm border border-crm-border/70 bg-crm-surface-2/40 px-3 py-2 text-xs text-crm-muted">
                  Sending as{" "}
                  <span className="font-medium text-crm-text">
                    {selectedSender?.label || selectedSender?.senderName || selectedSender?.displayName || selectedSender?.emailAddress}
                  </span>
                  {selectedSender && selectedSender.scope === "TENANT" && (
                    <span className="ml-1">(shared{selectedSender.isDefaultForTenant ? ", default" : ""})</span>
                  )}
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-crm-muted">
                  Template
                </label>
                <select
                  value={templateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                  disabled={templatesLoading}
                  className={crm.select}
                >
                  <option value="">— None —</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}{t.visibility === "PRIVATE" ? " (private)" : ""}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-crm-muted">
                  <FileText className="mr-1 inline h-3 w-3" />
                  <Link href="/crm/email/templates" className="text-crm-accent hover:underline" onClick={onClose}>
                    Manage templates
                  </Link>
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-crm-muted">Subject</label>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  maxLength={500}
                  className={crm.input}
                  placeholder="Subject line"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-crm-muted">Message</label>
                <textarea
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  rows={12}
                  maxLength={50000}
                  className={cn(crm.input, "font-sans")}
                  placeholder={`Hi ${mergeFields.firstName || "there"},`}
                />
                <p className="mt-1 text-[11px] text-crm-muted">
                  Merge tokens: <code>{"{{contact.firstName}}"}</code>, <code>{"{{contact.lastName}}"}</code>, <code>{"{{contact.company}}"}</code>, <code>{"{{contact.email}}"}</code>
                </p>
              </div>

              {error && (
                <div className="rounded-crm border border-crm-danger/40 bg-crm-danger/10 px-3 py-2 text-xs text-crm-danger">{error}</div>
              )}
              {sent && (
                <div className="flex items-center gap-2 rounded-crm border border-crm-success/40 bg-crm-success/10 px-3 py-2 text-xs text-crm-success">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Sending… Email queued for delivery.
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-crm-border px-5 py-3">
          <p className="text-[11px] text-crm-muted">
            Metadata-first. Connect stores subject + snippet only — never your full inbox.
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className={cn(crm.btnGhost, "text-xs")} disabled={sending}>Cancel</button>
            <button type="button" onClick={handleSend} disabled={!canSend} className={cn(crm.btnPrimary, "text-xs")}>
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {sending ? "Sending…" : "Send email"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

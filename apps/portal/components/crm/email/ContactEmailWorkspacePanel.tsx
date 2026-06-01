"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, FileText, Loader2, Mail, Paperclip, Search, Send } from "lucide-react";
import { htmlToCrmPlainText, renderCrmMergeTemplate } from "@connect/shared";
import { apiGet, apiPost } from "../../../services/apiClient";
import { cn } from "../cn";
import { crm } from "../crmClasses";

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
  previewText?: string | null;
  category?: string | null;
  visibility: "SHARED" | "PRIVATE";
  isDraft?: boolean;
  attachments?: Array<{ id: string; originalFileName: string; sizeBytes: number }>;
};

export type ContactEmailMergeFields = {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  company?: string | null;
  email?: string | null;
};

function applyMergeFields(text: string, fields: ContactEmailMergeFields): string {
  return renderCrmMergeTemplate(text, {
    "contact.firstName": fields.firstName || "",
    "contact.lastName": fields.lastName || "",
    "contact.fullName": fields.displayName || "",
    "contact.displayName": fields.displayName || "",
    "contact.company": fields.company || "",
    "contact.email": fields.email || "",
  });
}

function senderLabel(sender: Sender | null): string {
  if (!sender) return "No sender";
  const label = sender.label || sender.senderName || sender.displayName || sender.emailAddress;
  return `${label} <${sender.emailAddress}>`;
}

function chooseImplicitSender(senders: Sender[]): Sender | null {
  const connected = senders.filter((s) => s.status === "CONNECTED");
  const def = connected.find((s) => s.scope === "TENANT" && s.isDefaultForTenant);
  if (def) return def;
  const tenantSenders = connected.filter((s) => s.scope === "TENANT");
  if (tenantSenders.length === 1) return tenantSenders[0];
  return connected.find((s) => s.scope === "USER" && s.isMine) || null;
}

export function ContactEmailWorkspacePanel({
  contactId,
  contactName,
  contactEmail,
  mergeFields,
  currentUserEmail,
  disabled,
  onSent,
}: {
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  mergeFields: ContactEmailMergeFields;
  currentUserEmail?: string | null;
  disabled?: boolean;
  onSent?: () => void;
}) {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [canManageTenantSenders, setCanManageTenantSenders] = useState(false);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [query, setQuery] = useState("");
  const [ccSelf, setCcSelf] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [connResp, tplResp] = await Promise.all([
        apiGet<ConnectionsResp>("/crm/email/connections"),
        apiGet<{ templates: EmailTemplate[] }>("/crm/email/templates"),
      ]);
      setSenders(connResp?.senders ?? []);
      setCanManageTenantSenders(Boolean(connResp?.canManageTenantSenders));
      setTemplates((tplResp?.templates ?? []).filter((tpl) => !tpl.isDraft));
    } catch (e: any) {
      setError(e?.body?.detail || e?.message || "Failed to load email templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedSender = useMemo(() => chooseImplicitSender(senders), [senders]);
  const selectedTemplate = useMemo(
    () => templates.find((tpl) => tpl.id === selectedTemplateId) || null,
    [templates, selectedTemplateId],
  );
  const filteredTemplates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((tpl) =>
      [tpl.name, tpl.subject, tpl.category || ""].some((value) => String(value || "").toLowerCase().includes(q)),
    );
  }, [query, templates]);
  const ccEmail = String(currentUserEmail || "").trim();
  const ccSelfAvailable = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ccEmail);

  const selectTemplate = (tpl: EmailTemplate) => {
    setSelectedTemplateId(tpl.id);
    setError(null);
    setSuccess(null);
    setSubject(applyMergeFields(tpl.subject || "", mergeFields));
    setBodyText(applyMergeFields(tpl.bodyText || htmlToCrmPlainText(tpl.bodyHtml || ""), mergeFields));
  };

  const canSend = Boolean(
    selectedSender &&
      contactEmail &&
      selectedTemplate &&
      subject.trim() &&
      bodyText.trim() &&
      !sending &&
      !disabled,
  );

  const handleSend = async () => {
    if (!canSend || !selectedTemplate) return;
    if (ccSelf && !ccSelfAvailable) {
      setError("Your user email is missing or invalid, so CC myself cannot be used.");
      return;
    }
    setSending(true);
    setError(null);
    setSuccess(null);
    try {
      await apiPost<{ ok: boolean }>("/crm/email/send", {
        contactId,
        templateId: selectedTemplate.id,
        subject: subject.trim().slice(0, 500),
        bodyText: bodyText.slice(0, 50000),
        ccSelf,
      });
      setSuccess("Email queued for delivery.");
      onSent?.();
    } catch (e: any) {
      setError(e?.body?.detail || e?.message || "Failed to send email");
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-5">
        <div className="flex items-center gap-2 text-sm text-crm-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading templates and sender...
        </div>
      </div>
    );
  }

  if (!contactEmail) {
    return (
      <div className="rounded-[1.35rem] border border-crm-warning/35 bg-crm-warning/10 p-5">
        <div className="flex gap-3 text-sm text-crm-warning">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">No email on this contact</p>
            <p className="mt-1 text-crm-text/80">Add an email address to {contactName} before sending a template.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!selectedSender) {
    return (
      <div className="rounded-[1.35rem] border border-crm-warning/35 bg-crm-warning/10 p-5">
        <div className="flex gap-3 text-sm text-crm-warning">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">Email sender not configured</p>
            <p className="mt-1 text-crm-text/80">
              {canManageTenantSenders
                ? "Connect Google in CRM Email Settings to send from the tenant sender."
                : "Ask an admin to connect Google."}
            </p>
            {canManageTenantSenders ? (
              <Link href="/crm/email/settings" className={cn(crm.btnPrimary, "mt-3 inline-flex text-xs")}>
                Connect Google
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(15rem,0.85fr)_minmax(0,1.35fr)]">
      <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-crm-accent">Email Templates</p>
            <h3 className="mt-1 text-lg font-bold text-crm-text">Select a template</h3>
          </div>
          <Mail className="h-5 w-5 text-crm-accent" />
        </div>

        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crm-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={cn(crm.input, "pl-9")}
            placeholder="Search templates"
          />
        </label>

        <div className="mt-3 flex max-h-[23rem] flex-col gap-2 overflow-y-auto pr-1">
          {filteredTemplates.length === 0 ? (
            <div className="rounded-crm border border-dashed border-crm-border/70 p-4 text-sm text-crm-muted">
              <p className="font-semibold text-crm-text">No templates yet</p>
              <p className="mt-1">Create a saved template to send from the contact workspace.</p>
              <Link href="/crm/email/templates" className="mt-3 inline-flex text-xs font-semibold text-crm-accent hover:underline">
                Open templates
              </Link>
            </div>
          ) : (
            filteredTemplates.map((tpl) => {
              const active = tpl.id === selectedTemplateId;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => selectTemplate(tpl)}
                  className={cn(
                    "rounded-crm border p-3 text-left transition",
                    active
                      ? "border-crm-accent/55 bg-crm-accent/10"
                      : "border-crm-border/70 bg-crm-surface/70 hover:border-crm-accent/35",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-crm-text">{tpl.name}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-crm-muted">{applyMergeFields(tpl.subject || "", mergeFields) || "No subject"}</p>
                    </div>
                    {tpl.attachments?.length ? <Paperclip className="h-3.5 w-3.5 shrink-0 text-crm-muted" /> : null}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-crm-accent">Preview & Send</p>
            <h3 className="mt-1 text-lg font-bold text-crm-text">To {contactName}</h3>
            <p className="mt-1 text-xs text-crm-muted">From {senderLabel(selectedSender)}</p>
          </div>
          {selectedSender.scope === "TENANT" ? (
            <span className="rounded-full border border-crm-success/35 bg-crm-success/10 px-2.5 py-1 text-[11px] font-semibold text-crm-success">
              Tenant sender
            </span>
          ) : null}
        </div>

        {!selectedTemplate ? (
          <div className="rounded-crm border border-dashed border-crm-border/70 p-6 text-center text-sm text-crm-muted">
            <FileText className="mx-auto mb-2 h-5 w-5" />
            Select a saved template to preview merge fields and send one email.
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-crm-muted">Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={500} className={crm.input} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-crm-muted">Message</label>
              <textarea
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={10}
                maxLength={50000}
                className={cn(crm.input, "resize-y font-sans")}
              />
            </div>
            {selectedTemplate.attachments?.length ? (
              <div className="rounded-crm border border-crm-border/70 bg-crm-surface/60 p-3 text-xs text-crm-muted">
                <p className="mb-1 font-semibold text-crm-text">Template attachments included</p>
                {selectedTemplate.attachments.map((attachment) => (
                  <p key={attachment.id} className="truncate">
                    <Paperclip className="mr-1 inline h-3 w-3" />
                    {attachment.originalFileName}
                  </p>
                ))}
              </div>
            ) : null}
            <label className="flex items-start gap-2 rounded-crm border border-crm-border/70 bg-crm-surface/60 p-3 text-sm text-crm-text">
              <input
                type="checkbox"
                checked={ccSelf}
                onChange={(e) => setCcSelf(e.target.checked)}
                disabled={!ccSelfAvailable}
                className="mt-1"
              />
              <span>
                <span className="font-semibold">CC myself</span>
                <span className="block text-xs text-crm-muted">
                  {ccSelfAvailable ? ccEmail : "Your user email is missing or invalid."}
                </span>
              </span>
            </label>
          </div>
        )}

        {error ? <div className="mt-3 rounded-crm border border-crm-danger/40 bg-crm-danger/10 px-3 py-2 text-xs text-crm-danger">{error}</div> : null}
        {success ? (
          <div className="mt-3 flex items-center gap-2 rounded-crm border border-crm-success/40 bg-crm-success/10 px-3 py-2 text-xs text-crm-success">
            <CheckCircle2 className="h-3.5 w-3.5" /> {success}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-crm-border/60 pt-3">
          <p className="text-[11px] text-crm-muted">
            Contact replies to the tenant sender stay in the tracked Gmail thread when reply tracking is enabled.
          </p>
          <button type="button" onClick={handleSend} disabled={!canSend} className={cn(crm.btnPrimary, "text-xs")}>
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {sending ? "Sending..." : "Send email"}
          </button>
        </div>
      </div>
    </div>
  );
}

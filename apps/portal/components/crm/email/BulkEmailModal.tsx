"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mail,
  Send,
  Tag,
  Users,
  X,
} from "lucide-react";
import { apiGet, apiPost } from "../../../services/apiClient";
import { crm } from "../crmClasses";
import { cn } from "../cn";

// ── Types ─────────────────────────────────────────────────────────────────────

type CrmTag = {
  id: string;
  name: string;
  color?: string | null;
};

type Sender = {
  id: string;
  scope: "USER" | "TENANT";
  emailAddress: string;
  displayName: string | null;
  label: string | null;
  senderName: string | null;
  status: string;
  isMine: boolean;
};

type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  category?: string | null;
  isDraft?: boolean;
  visibility: "SHARED" | "PRIVATE";
};

export type BulkEmailAudience =
  | {
      sourceType: "CONTACTS";
      /** Explicit contact IDs. Pass empty array + selectAll=true to send to all filtered contacts. */
      contactIds: string[];
      selectAll?: boolean;
      /** Current tag filter applied on the contacts page (for "all filtered" path). */
      tagId?: string;
      stage?: string;
    }
  | {
      sourceType: "CAMPAIGN";
      campaignId: string;
      campaignName: string;
      /** Optional: only selected member contactIds. Empty = all campaign members. */
      contactIds?: string[];
      tagId?: string;
    }
  | {
      sourceType: "FUNDERS";
      funderIds: string[];
      selectAll?: boolean;
      tagId?: string;
    };

type BulkJobResult = {
  jobId: string;
  status: string;
  totalCount: number;
  queuedCount: number;
  skippedCount: number;
};

// ── Component ─────────────────────────────────────────────────────────────────

export function BulkEmailModal({
  audience,
  onClose,
  onQueued,
}: {
  audience: BulkEmailAudience;
  onClose: () => void;
  /** Called with the job result after successful queue. */
  onQueued?: (result: BulkJobResult) => void;
}) {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [sendersLoading, setSendersLoading] = useState(true);
  const [senderId, setSenderId] = useState<string>("");

  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templateId, setTemplateId] = useState<string>("");

  // Tag picker state — starts from the page-level filter but user can override
  const [tags, setTags] = useState<CrmTag[]>([]);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [localTagId, setLocalTagId] = useState<string>(audience.tagId ?? "");
  // "all-with-tag" scope: when true, send to all contacts/funders with selected tag
  // (not just the explicitly selected rows).  Only available for CONTACTS and FUNDERS.
  const [sendToAllWithTag, setSendToAllWithTag] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkJobResult | null>(null);

  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;
  const selectedSender = senders.find((s) => s.id === senderId) ?? null;
  const connectedSenders = senders.filter((s) => s.status === "CONNECTED");
  const selectedTag = tags.find((t) => t.id === localTagId) ?? null;

  // Load senders
  useEffect(() => {
    apiGet<{ senders: Sender[] }>("/crm/email/connections")
      .then((data) => {
        setSenders(data.senders ?? []);
        const first = data.senders?.find((s) => s.status === "CONNECTED");
        if (first) setSenderId(first.id);
      })
      .catch(() => undefined)
      .finally(() => setSendersLoading(false));
  }, []);

  // Load templates
  useEffect(() => {
    apiGet<{ templates: EmailTemplate[] }>("/crm/email/templates")
      .then((data) => {
        setTemplates(data.templates ?? []);
      })
      .catch(() => undefined)
      .finally(() => setTemplatesLoading(false));
  }, []);

  // Load tags — contact tags for CONTACTS/CAMPAIGN, funder tags for FUNDERS
  useEffect(() => {
    const endpoint =
      audience.sourceType === "FUNDERS" ? "/crm/funder-tags" : "/crm/contact-tags";
    apiGet<{ tags: CrmTag[] }>(endpoint)
      .then((data) => setTags(data.tags ?? []))
      .catch(() => undefined)
      .finally(() => setTagsLoading(false));
  }, [audience.sourceType]);

  // When sendToAllWithTag is turned on but no tag chosen, auto-select first tag
  useEffect(() => {
    if (sendToAllWithTag && !localTagId && tags.length > 0) {
      setLocalTagId(tags[0].id);
    }
  }, [sendToAllWithTag, localTagId, tags]);

  const audienceLabel = (): string => {
    if (sendToAllWithTag && localTagId) {
      const tagName = selectedTag?.name ?? localTagId;
      if (audience.sourceType === "FUNDERS") return `All funders — tag: ${tagName}`;
      return `All contacts — tag: ${tagName}`;
    }
    if (audience.sourceType === "CONTACTS") {
      if (audience.selectAll) return "All filtered contacts";
      return `${audience.contactIds.length} selected contact${audience.contactIds.length !== 1 ? "s" : ""}`;
    }
    if (audience.sourceType === "CAMPAIGN") {
      const extra =
        audience.contactIds && audience.contactIds.length > 0
          ? ` (${audience.contactIds.length} selected)`
          : " (all members)";
      return `Campaign: ${audience.campaignName}${extra}`;
    }
    if (audience.sourceType === "FUNDERS") {
      if (audience.selectAll) return "All filtered funders";
      return `${audience.funderIds.length} selected funder${audience.funderIds.length !== 1 ? "s" : ""}`;
    }
    return "Unknown audience";
  };

  const handleSubmit = async () => {
    if (!templateId) {
      setError("Please choose an email template.");
      return;
    }
    if (!senderId) {
      setError("Please choose a sender.");
      return;
    }
    if (sendToAllWithTag && !localTagId) {
      setError("Please choose a tag to send to all contacts with that tag.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        templateId,
        connectionId: senderId,
      };

      // When "send to all with tag" is on, override to selectAll=true with the chosen tag.
      const effectiveTagId = localTagId || undefined;
      const effectiveSelectAll = sendToAllWithTag;

      if (audience.sourceType === "CONTACTS") {
        payload.sourceType = "CONTACTS";
        payload.selectAll = effectiveSelectAll || (audience.selectAll ?? false);
        if (!effectiveSelectAll) payload.contactIds = audience.contactIds;
        if (effectiveTagId) payload.tagId = effectiveTagId;
        if (audience.stage) payload.stage = audience.stage;
      } else if (audience.sourceType === "CAMPAIGN") {
        payload.sourceType = "CAMPAIGN";
        payload.campaignId = audience.campaignId;
        if (!effectiveSelectAll && audience.contactIds && audience.contactIds.length > 0) {
          payload.contactIds = audience.contactIds;
        }
        if (effectiveTagId) payload.tagId = effectiveTagId;
      } else if (audience.sourceType === "FUNDERS") {
        payload.sourceType = "FUNDERS";
        payload.selectAll = effectiveSelectAll || (audience.selectAll ?? false);
        if (!effectiveSelectAll) payload.contactIds = audience.funderIds;
        if (effectiveTagId) payload.tagId = effectiveTagId;
      }

      const res = await apiPost<BulkJobResult>("/crm/email/bulk-jobs", payload);
      setResult(res);
      onQueued?.(res);
    } catch (err: unknown) {
      setError((err as Error)?.message || "Failed to queue bulk email");
      setSubmitting(false);
    }
  };

  // ── Post-success view ──────────────────────────────────────────────────────
  if (result) {
    return (
      <div
        className={crm.contactsModalBackdrop}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className={cn(crm.contactsModalPanel, "border-crm-border bg-crm-surface shadow-xl max-w-md w-full")}>
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-crm-success" />
              <h3 className="text-base font-semibold text-crm-text">Bulk email queued</h3>
            </div>
            <button type="button" onClick={onClose} className="rounded p-1 text-crm-muted hover:bg-crm-surface-2">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3 rounded-crm border border-crm-border bg-crm-surface-2 p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-crm-muted">Job ID</span>
              <span className="font-mono text-xs text-crm-text">{result.jobId.slice(-8)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-crm-muted">Queued to send</span>
              <span className="font-bold text-crm-text">{result.queuedCount}</span>
            </div>
            {result.skippedCount > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-amber-600 dark:text-amber-400">Skipped (missing email / duplicate)</span>
                <span className="font-bold text-amber-600 dark:text-amber-400">{result.skippedCount}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-crm-muted">Total resolved</span>
              <span className="text-crm-text">{result.totalCount}</span>
            </div>
          </div>

          <p className="mt-3 text-xs text-crm-muted">
            Emails are sent in the background. Check{" "}
            <strong>CRM → Email → Bulk Jobs</strong> for progress and results.
          </p>

          <div className="mt-4 flex justify-end">
            <button type="button" onClick={onClose} className={crm.btnPrimary}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main modal ────────────────────────────────────────────────────────────
  return (
    <div
      className={crm.contactsModalBackdrop}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={cn(crm.contactsModalPanel, "border-crm-border bg-crm-surface shadow-xl max-w-lg w-full")}>
        {/* Header */}
        <div className="mb-5 flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-crm bg-crm-accent/10">
              <Mail className="h-4 w-4 text-crm-accent" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-crm-text">Send Bulk Email</h3>
              <p className="text-xs text-crm-muted">Server-side queued — safe for hundreds of recipients</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-crm-muted hover:bg-crm-surface-2"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5">
          {/* Audience */}
          <section>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-crm-muted">Audience</p>
            <div className="flex items-center gap-2 rounded-crm border border-crm-border bg-crm-surface-2 px-3 py-2.5">
              <Users className="h-4 w-4 shrink-0 text-crm-accent" />
              <span className="text-sm font-medium text-crm-text">{audienceLabel()}</span>
              {selectedTag && (
                <span
                  className="ml-auto rounded-full px-2 py-0.5 text-xs font-medium"
                  style={
                    selectedTag.color
                      ? { background: `${selectedTag.color}22`, color: selectedTag.color }
                      : undefined
                  }
                >
                  {selectedTag.name}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-xs text-crm-muted">
              Recipients with no email address are skipped automatically. Duplicate emails are deduplicated.
            </p>

            {/* Tag filter picker */}
            <div className="mt-3 space-y-2.5">
              <div className="flex items-center gap-2">
                <Tag className="h-3.5 w-3.5 shrink-0 text-crm-muted" />
                <label className="text-xs font-medium text-crm-muted">Narrow by tag</label>
              </div>
              {tagsLoading ? (
                <div className="flex items-center gap-1.5 text-xs text-crm-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading tags…
                </div>
              ) : tags.length === 0 ? (
                <p className="text-xs text-crm-muted">No tags found for this tenant.</p>
              ) : (
                <select
                  value={localTagId}
                  onChange={(e) => {
                    setLocalTagId(e.target.value);
                    if (!e.target.value) setSendToAllWithTag(false);
                  }}
                  className={crm.select}
                >
                  <option value="">No tag filter — all recipients</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              )}

              {/* Scope toggle — only for CONTACTS and FUNDERS where "all with tag" makes sense */}
              {localTagId && audience.sourceType !== "CAMPAIGN" && (
                <label className="flex cursor-pointer items-center gap-2.5 rounded-crm border border-crm-border bg-crm-surface-2 px-3 py-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={sendToAllWithTag}
                    onChange={(e) => setSendToAllWithTag(e.target.checked)}
                    className={crm.checkbox}
                  />
                  <span className="text-crm-text">
                    Send to <strong>all</strong>{" "}
                    {audience.sourceType === "FUNDERS" ? "funders" : "contacts"} with this tag
                    <span className="ml-1 text-xs text-crm-muted">(ignores row selection)</span>
                  </span>
                </label>
              )}
            </div>
          </section>

          {/* Template picker */}
          <section>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-crm-muted">
              Email Template *
            </label>
            {templatesLoading ? (
              <div className="flex items-center gap-2 text-sm text-crm-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading templates…
              </div>
            ) : templates.length === 0 ? (
              <p className="rounded-crm border border-crm-border bg-crm-surface-2 px-3 py-2 text-sm text-crm-muted">
                No templates found.{" "}
                <a href="/crm/email/templates" className="text-crm-accent underline-offset-2 hover:underline">
                  Create one
                </a>{" "}
                first.
              </p>
            ) : (
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className={crm.select}
              >
                <option value="">Choose template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} — {t.subject}
                  </option>
                ))}
              </select>
            )}

            {selectedTemplate && (
              <div className="mt-2 rounded-crm border border-crm-border bg-crm-surface-2 p-3 text-xs">
                <p className="mb-1 font-semibold text-crm-text">Subject: {selectedTemplate.subject}</p>
                <p className="line-clamp-3 whitespace-pre-wrap text-crm-muted">
                  {selectedTemplate.bodyText.slice(0, 300)}
                  {selectedTemplate.bodyText.length > 300 && "…"}
                </p>
                <p className="mt-1.5 text-crm-muted/70">
                  Merge tokens (e.g. {"{{"} contact.firstName {"}}"}){" "}
                  are rendered per-recipient.
                </p>
              </div>
            )}
          </section>

          {/* Sender */}
          <section>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-crm-muted">
              Send From *
            </label>
            {sendersLoading ? (
              <div className="flex items-center gap-2 text-sm text-crm-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading senders…
              </div>
            ) : connectedSenders.length === 0 ? (
              <div className="flex items-center gap-2 rounded-crm border border-crm-danger/40 bg-crm-danger/10 px-3 py-2 text-sm text-crm-danger">
                <AlertCircle className="h-4 w-4 shrink-0" />
                No connected email sender.{" "}
                <a href="/crm/email/settings" className="underline-offset-2 hover:underline">
                  Connect one
                </a>
                .
              </div>
            ) : (
              <select
                value={senderId}
                onChange={(e) => setSenderId(e.target.value)}
                className={crm.select}
              >
                <option value="">Choose sender…</option>
                {connectedSenders.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label || s.displayName || s.emailAddress}
                    {s.scope === "TENANT" ? " (shared)" : ""}
                    {" — "}
                    {s.emailAddress}
                  </option>
                ))}
              </select>
            )}
            {selectedSender && selectedSender.status !== "CONNECTED" && (
              <p className="mt-1 text-xs text-crm-danger">
                This sender is disconnected. Choose a connected sender.
              </p>
            )}
          </section>

          {/* Safety notice */}
          {templateId && senderId && (
            <div className="rounded-crm border border-amber-300/40 bg-amber-50/60 p-3 text-xs text-amber-700 dark:border-amber-700/30 dark:bg-amber-900/10 dark:text-amber-400">
              <strong>Before sending:</strong> Emails are queued and sent one at a time in the background.
              Recipients with missing or duplicate email addresses are automatically skipped.
              This action cannot be undone once the job starts processing.
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-crm border border-crm-danger/40 bg-crm-danger/10 px-3 py-2 text-sm text-crm-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={crm.btnSecondary} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !templateId || !senderId || connectedSenders.length === 0}
            className={cn(crm.btnPrimary, "disabled:opacity-50")}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Queueing…
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Queue bulk send
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

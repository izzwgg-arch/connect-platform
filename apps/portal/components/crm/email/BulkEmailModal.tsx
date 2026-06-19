"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Mail,
  Plus,
  Send,
  Tag,
  Users,
  X,
} from "lucide-react";
import { apiGet, apiPost } from "../../../services/apiClient";
import { crm } from "../crmClasses";
import { cn } from "../cn";
import { ConnectSelect } from "../../ConnectSelect";

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
  scheduledAt?: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** ISO local datetime string for <input type="datetime-local"> min value (now + 5 min). */
function minDatetimeLocal(): string {
  const d = new Date(Date.now() + 5 * 60 * 1000);
  d.setSeconds(0, 0);
  return d.toISOString().slice(0, 16);
}

/** Format an ISO string for display (e.g. "Jun 22, 2026 · 9:00 AM"). */
function formatScheduledAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

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
  const [sendToAllWithTag, setSendToAllWithTag] = useState(false);

  // ── Scheduling ──────────────────────────────────────────────────────────────
  // Each entry is a datetime-local string (e.g. "2026-06-22T09:00")
  const [scheduledSlots, setScheduledSlots] = useState<string[]>([]);
  const addSlotRef = useRef<HTMLButtonElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const [schedulingInProgress, setSchedulingInProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = not submitted yet; array = results (first entry is immediate if sent, rest are scheduled)
  const [results, setResults] = useState<BulkJobResult[] | null>(null);

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

  // Load tags
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

  // Build the shared POST payload (without scheduledAt)
  const buildPayload = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      templateId,
      connectionId: senderId,
    };
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
    return payload;
  };

  const validate = (): string | null => {
    if (!templateId) return "Please choose an email template.";
    if (!senderId) return "Please choose a sender.";
    if (sendToAllWithTag && !localTagId) return "Please choose a tag.";
    return null;
  };

  // Send immediately (no scheduledAt)
  const handleSendNow = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiPost<BulkJobResult>("/crm/email/bulk-jobs", buildPayload());
      setResults([res]);
      onQueued?.(res);
    } catch (err: unknown) {
      setError((err as Error)?.message || "Failed to queue bulk email");
      setSubmitting(false);
    }
  };

  // Schedule one job per slot
  const handleSchedule = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    if (scheduledSlots.length === 0) return;

    // Validate all slots are in the future
    const now = Date.now();
    const invalid = scheduledSlots.find((s) => new Date(s).getTime() <= now + 60_000);
    if (invalid) {
      setError("All scheduled times must be at least 1 minute in the future.");
      return;
    }

    setSchedulingInProgress(true);
    setError(null);
    const allResults: BulkJobResult[] = [];
    try {
      for (const slot of scheduledSlots) {
        const payload = { ...buildPayload(), scheduledAt: new Date(slot).toISOString() };
        const res = await apiPost<BulkJobResult>("/crm/email/bulk-jobs", payload);
        allResults.push({ ...res, scheduledAt: slot });
      }
      setResults(allResults);
      onQueued?.(allResults[0]!);
    } catch (err: unknown) {
      setError((err as Error)?.message || "Failed to schedule bulk email");
      setSchedulingInProgress(false);
    }
  };

  const addSlot = () => {
    setScheduledSlots((prev) => [...prev, ""]);
    // Focus the new input after render
    setTimeout(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>(".bulk-email-schedule-slot");
      inputs[inputs.length - 1]?.focus();
    }, 50);
  };

  const updateSlot = (index: number, value: string) => {
    setScheduledSlots((prev) => prev.map((s, i) => (i === index ? value : s)));
  };

  const removeSlot = (index: number) => {
    setScheduledSlots((prev) => prev.filter((_, i) => i !== index));
  };

  // ── Post-success view ──────────────────────────────────────────────────────
  if (results) {
    const immediateResult = results.find((r) => !r.scheduledAt);
    const scheduledResults = results.filter((r) => r.scheduledAt);

    return (
      <div
        className={crm.contactsModalBackdrop}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className={cn(crm.contactsModalPanel, "border-crm-border bg-crm-surface shadow-xl max-w-md w-full")}>
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-crm-success" />
              <h3 className="text-base font-semibold text-crm-text">
                {scheduledResults.length > 0 && !immediateResult
                  ? `${scheduledResults.length} send${scheduledResults.length !== 1 ? "s" : ""} scheduled`
                  : "Bulk email queued"}
              </h3>
            </div>
            <button type="button" onClick={onClose} className="rounded p-1 text-crm-muted hover:bg-crm-surface-2">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Audience summary */}
          <div className="mb-3 flex items-center gap-2 rounded-crm border border-crm-border bg-crm-surface-2 px-3 py-2.5">
            <Users className="h-4 w-4 shrink-0 text-crm-accent" />
            <span className="text-sm font-medium text-crm-text">{audienceLabel()}</span>
          </div>

          {/* Immediate result */}
          {immediateResult && (
            <div className="space-y-2 rounded-crm border border-crm-border bg-crm-surface-2 p-4 text-sm mb-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-crm-muted mb-2">Sent now</p>
              <div className="flex items-center justify-between">
                <span className="text-crm-muted">Job ID</span>
                <span className="font-mono text-xs text-crm-text">{immediateResult.jobId.slice(-8)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-crm-muted">Queued to send</span>
                <span className="font-bold text-crm-text">{immediateResult.queuedCount}</span>
              </div>
              {immediateResult.skippedCount > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-amber-600 dark:text-amber-400">Skipped</span>
                  <span className="font-bold text-amber-600 dark:text-amber-400">{immediateResult.skippedCount}</span>
                </div>
              )}
            </div>
          )}

          {/* Scheduled results */}
          {scheduledResults.length > 0 && (
            <div className="space-y-1.5 rounded-crm border border-crm-border bg-crm-surface-2 p-4 text-sm mb-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-crm-muted mb-2">Scheduled sends</p>
              {scheduledResults.map((r, i) => (
                <div key={r.jobId} className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-crm-muted">
                    <CalendarClock className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
                    <span>{r.scheduledAt ? formatScheduledAt(r.scheduledAt) : `Schedule ${i + 1}`}</span>
                  </div>
                  <span className="font-mono text-xs text-crm-muted">{r.jobId.slice(-8)}</span>
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-crm-muted">
            Emails are sent in the background.{" "}
            <a
              href="/crm/email"
              className="inline-flex items-center gap-0.5 text-crm-accent underline-offset-2 hover:underline"
            >
              View bulk jobs
              <ExternalLink className="h-3 w-3" />
            </a>{" "}
            for progress and results.
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
  const isReady = !!templateId && !!senderId && connectedSenders.length > 0;
  const validSlots = scheduledSlots.filter((s) => s.length > 0 && new Date(s).getTime() > Date.now() + 60_000);

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
                <ConnectSelect
                  value={localTagId}
                  onChange={(value) => {
                    setLocalTagId(value);
                    if (!value) setSendToAllWithTag(false);
                  }}
                  className="w-full"
                  options={[
                    { value: "", label: "No tag filter — all recipients" },
                    ...tags.map((t) => ({ value: t.id, label: t.name })),
                  ]}
                />
              )}

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
              <ConnectSelect
                value={templateId}
                onChange={(value) => setTemplateId(value)}
                className="w-full"
                placeholder="Choose template…"
                options={templates.map((t) => ({ value: t.id, label: `${t.name} — ${t.subject}` }))}
              />
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
              <ConnectSelect
                value={senderId}
                onChange={(value) => setSenderId(value)}
                className="w-full"
                placeholder="Choose sender…"
                options={connectedSenders.map((s) => ({
                  value: s.id,
                  label: `${s.label || s.displayName || s.emailAddress}${s.scope === "TENANT" ? " (shared)" : ""} — ${s.emailAddress}`,
                }))}
              />
            )}
            {selectedSender && selectedSender.status !== "CONNECTED" && (
              <p className="mt-1 text-xs text-crm-danger">
                This sender is disconnected. Choose a connected sender.
              </p>
            )}
          </section>

          {/* ── Schedule sends section ── */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <CalendarClock className="h-3.5 w-3.5 text-crm-muted" />
                <span className="text-xs font-semibold uppercase tracking-wide text-crm-muted">
                  Scheduled sends
                  {scheduledSlots.length > 0 && (
                    <span className="ml-1 rounded-full bg-crm-accent/15 px-1.5 py-0.5 text-crm-accent">
                      {scheduledSlots.length}
                    </span>
                  )}
                </span>
              </div>
              <button
                ref={addSlotRef}
                type="button"
                onClick={addSlot}
                className={cn(crm.btnGhost, "gap-1 py-1 text-xs")}
              >
                <Plus className="h-3.5 w-3.5" />
                Add scheduled send
              </button>
            </div>

            {scheduledSlots.length === 0 ? (
              <p className="text-xs text-crm-muted">
                No schedules added. Use "Queue bulk send" to send immediately, or add one or more
                scheduled times to send later.
              </p>
            ) : (
              <div className="space-y-2">
                {scheduledSlots.map((slot, i) => {
                  const isValid = slot.length > 0 && new Date(slot).getTime() > Date.now() + 60_000;
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <CalendarClock className="h-4 w-4 shrink-0 text-crm-accent" />
                      <input
                        type="datetime-local"
                        value={slot}
                        min={minDatetimeLocal()}
                        onChange={(e) => updateSlot(i, e.target.value)}
                        className={cn(
                          crm.input,
                          "bulk-email-schedule-slot flex-1 !py-1 text-sm",
                          slot && !isValid && "border-crm-danger/60 focus:border-crm-danger",
                        )}
                      />
                      <button
                        type="button"
                        onClick={() => removeSlot(i)}
                        className="rounded p-1 text-crm-muted hover:bg-crm-surface-2 hover:text-crm-danger"
                        aria-label="Remove schedule"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
                {scheduledSlots.some((s) => s && new Date(s).getTime() <= Date.now() + 60_000) && (
                  <p className="text-xs text-crm-danger">
                    Scheduled times must be at least 1 minute in the future.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Safety notice */}
          {isReady && (
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
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={crm.btnSecondary} disabled={submitting || schedulingInProgress}>
            Cancel
          </button>
          {/* Schedule button — only shown when slots are added */}
          {scheduledSlots.length > 0 && (
            <button
              type="button"
              onClick={handleSchedule}
              disabled={schedulingInProgress || submitting || !isReady || validSlots.length === 0}
              className={cn(crm.btnSecondary, "gap-1.5 disabled:opacity-50")}
            >
              {schedulingInProgress ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Scheduling…
                </>
              ) : (
                <>
                  <CalendarClock className="h-4 w-4" />
                  Schedule ({validSlots.length})
                </>
              )}
            </button>
          )}
          {/* Immediate send button */}
          <button
            type="button"
            onClick={handleSendNow}
            disabled={submitting || schedulingInProgress || !isReady}
            className={cn(crm.btnPrimary, "gap-1.5 disabled:opacity-50")}
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

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, ChevronRight, Edit2, ExternalLink, Mail, MessageSquare, PhoneCall, X } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { ConnectSelect } from "../../ConnectSelect";
import { apiPatch } from "../../../services/apiClient";
import { avatarGradient, initials } from "../contact/contactFormatters";
import type { CampaignMember, MemberStatus } from "./campaignTypes";
import { MEMBER_STATUS_CHIP, MEMBER_STATUS_LABELS } from "./campaignTypes";
import { callbackUrgency, memberNextAction, relativeTime } from "./campaignUtils";

export function CampaignMemberCard({
  member,
  campaignId,
  selected,
  readOnly,
  rowMode,
  rowNumber,
  onSelect,
  onUpdated,
  onStatusChange,
  onOpenWorkspace,
  token,
}: {
  member: CampaignMember;
  campaignId: string;
  selected: boolean;
  readOnly: boolean;
  rowMode?: boolean;
  rowNumber?: number;
  onSelect: (checked: boolean) => void;
  onUpdated: () => void;
  onStatusChange: (memberId: string, status: MemberStatus) => void;
  onOpenWorkspace?: () => void;
  token?: string;
}) {
  const router = useRouter();
  const archivedLead = member.queueWorkEligible === false;
  const terminal = member.status === "CONVERTED" || member.status === "SKIPPED" || member.status === "DO_NOT_CALL";
  const activeWork = member.status === "PENDING" || member.status === "IN_PROGRESS";
  const cb = callbackUrgency(member.callbackAt);
  const nextAction = memberNextAction(member.status, member.callbackAt);
  const isOverdue = cb.tier === "overdue";
  const lastTouch =
    member.contact?.lastActivityAt
      ? relativeTime(member.contact.lastActivityAt)
      : member.lastAttemptAt
        ? relativeTime(member.lastAttemptAt)
        : "—";

  if (rowMode) {
    const displayName = member.contact?.displayName ?? "Unknown";
    const displayRank = rowNumber ?? (Number.isFinite(member.sortOrder) ? member.sortOrder + 1 : 1);
    const workspaceParams = `campaignId=${encodeURIComponent(campaignId)}&memberId=${encodeURIComponent(member.id)}`;
    const workspaceHref = `/crm/contacts/${member.contactId}?${workspaceParams}`;
    const callHref = `${workspaceHref}&action=call`;
    const smsHref = `${workspaceHref}&workspace=sms`;
    const emailHref = `${workspaceHref}&workspace=email`;

    return (
      <article
        className={cn(
          "crm-queue-row crm-contact-row crm-funder-row campaign-member-list-row group",
          selected && "crm-queue-row-selected",
          !selected && isOverdue && "campaign-member-list-row-attention",
          terminal && "opacity-85",
          archivedLead && "opacity-80",
        )}
      >
        <div className="crm-queue-row-grid">
          <label
            className="crm-contact-row-check"
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${displayName}`}
          >
            <input
              type="checkbox"
              checked={selected}
              disabled={readOnly}
              onChange={(e) => onSelect(e.target.checked)}
            />
          </label>
          <span className="crm-queue-row-rank tabular-nums">{displayRank}</span>
          <div
            className="crm-queue-row-avatar funders-avatar"
            style={{ background: avatarGradient(member.contact?.id ?? member.contactId ?? displayName) }}
            aria-hidden
          >
            {initials(displayName)}
          </div>
          <div className="crm-queue-row-main min-w-0">
            <div className="crm-queue-row-title-line">
              <button
                type="button"
                onClick={() => router.push(`/crm/contacts/${member.contactId}`)}
                className="crm-queue-row-name campaigns-row-title truncate"
              >
                {displayName}
              </button>
              {readOnly ? (
                <span className={cn("campaigns-status-pill campaign-member-status-pill", MEMBER_STATUS_CHIP[member.status])}>
                  <span className="campaigns-status-dot" />
                  {MEMBER_STATUS_LABELS[member.status]}
                </span>
              ) : (
                <ConnectSelect
                  value={member.status}
                  onChange={(value) => onStatusChange(member.id, value as MemberStatus)}
                  size="sm"
                  className={cn("campaign-member-status-select", MEMBER_STATUS_CHIP[member.status])}
                  options={(Object.keys(MEMBER_STATUS_LABELS) as MemberStatus[]).map((s) => ({
                    value: s,
                    label: MEMBER_STATUS_LABELS[s],
                  }))}
                />
              )}
              <span className="funders-tag-pill">{member.assignedTo?.displayName ?? "Unassigned"}</span>
              {archivedLead ? <span className="funders-tag-pill campaign-member-type-warning">Archived</span> : null}
              {member.status === "CALLBACK" && member.callbackAt ? (
                <span className={cn("funders-tag-pill", isOverdue ? "campaign-member-type-danger" : "campaign-member-type-warning")}>
                  {cb.label}
                </span>
              ) : null}
            </div>
            <p className="crm-queue-row-sub truncate">
              {[member.contact?.company, member.contact?.primaryPhone, member.contact?.primaryEmail]
                .filter((value): value is string => Boolean(value && value.trim()))
                .join(" · ") || "Missing phone, email, and company"}
            </p>
          </div>
          <div className="crm-queue-row-phone hidden md:flex">
            <PhoneCall className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-mono">{member.contact?.primaryPhone || "No phone"}</span>
          </div>
          <div className="crm-queue-row-email hidden lg:flex">
            <Mail className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{member.contact?.primaryEmail || "No email"}</span>
          </div>
          <div className="crm-queue-row-meta hidden xl:flex">
            <span className="crm-queue-pill crm-queue-pill-muted inline-flex items-center gap-0.5">
              {lastTouch}
            </span>
          </div>
          <div className="campaigns-row-actions campaign-member-channel-actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => router.push(emailHref)}
              className="crm-queue-detail-channel crm-queue-detail-channel-email campaign-member-channel-action"
              aria-label={`Email ${displayName}`}
              title="Open email workspace"
              disabled={readOnly || !member.contact?.primaryEmail}
            >
              <Mail className="h-3.5 w-3.5" />
              <span>Email</span>
            </button>
            <button
              type="button"
              onClick={() => router.push(smsHref)}
              className="crm-queue-detail-channel crm-queue-detail-channel-sms campaign-member-channel-action"
              aria-label={`SMS ${displayName}`}
              title="Open SMS workspace"
              disabled={readOnly || !member.contact?.primaryPhone}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span>SMS</span>
            </button>
            <button
              type="button"
              onClick={() => router.push(callHref)}
              className="crm-queue-detail-channel crm-queue-detail-channel-call campaign-member-channel-action"
              aria-label={`Call ${displayName}`}
              title="Fill dialer"
              disabled={readOnly || !member.contact?.primaryPhone}
            >
              <PhoneCall className="h-3.5 w-3.5" />
              <span>Call</span>
            </button>
          </div>
          <button
            type="button"
            className="crm-queue-row-chevron-button shrink-0"
            onClick={(event) => {
              event.stopPropagation();
              if (onOpenWorkspace) {
                onOpenWorkspace();
                return;
              }
              router.push(workspaceHref);
            }}
            aria-label={`Open workspace for ${displayName}`}
            title="Open workspace"
          >
            <ChevronRight className="crm-queue-row-chevron h-4 w-4" />
          </button>
        </div>
      </article>
    );
  }

  return (
    <article
      className={cn(
        "rounded-crm-lg border px-3 py-3 sm:px-4 transition-all",
        selected && "border-crm-accent/40 bg-crm-accent/8 ring-1 ring-crm-accent/20",
        !selected && activeWork && !archivedLead && "border-crm-accent/30 bg-crm-surface hover:border-crm-accent/45",
        !selected && isOverdue && "border-crm-danger/40 bg-crm-danger/5",
        !selected && terminal && "border-crm-border/60 bg-crm-surface-2/50 opacity-80",
        !selected && !activeWork && !isOverdue && !terminal && "border-crm-border bg-crm-surface hover:border-crm-border/90",
        archivedLead && "opacity-85",
      )}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="flex items-start gap-2 shrink-0">
          <input
            type="checkbox"
            checked={selected}
            disabled={readOnly}
            onChange={(e) => onSelect(e.target.checked)}
            className="mt-1 rounded border-crm-border disabled:opacity-40"
            aria-label={`Select ${member.contact?.displayName ?? "member"}`}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => router.push(`/crm/contacts/${member.contactId}`)}
              className="text-left text-base font-semibold text-crm-text hover:text-crm-accent truncate"
            >
              {member.contact?.displayName ?? "Unknown"}
            </button>
            {archivedLead && (
              <span className="text-[10px] font-bold uppercase tracking-wide text-crm-warning bg-crm-warning/12 px-1.5 py-0.5 rounded border border-crm-warning/30">
                Archived
              </span>
            )}
            <span className={cn("rounded border px-2 py-0.5 text-[10px] font-semibold uppercase", MEMBER_STATUS_CHIP[member.status])}>
              {MEMBER_STATUS_LABELS[member.status]}
            </span>
            {member.status === "CALLBACK" && member.callbackAt && (
              <span
                className={cn(
                  "text-[10px] font-semibold px-1.5 py-0.5 rounded",
                  isOverdue ? "text-crm-danger bg-crm-danger/10" : "text-crm-warning bg-crm-warning/10",
                )}
              >
                {cb.label}
              </span>
            )}
          </div>

          <p className="mt-1 text-sm text-crm-muted truncate">{member.contact?.primaryPhone ?? "—"}</p>

          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-crm-muted">Agent</dt>
              <dd className="font-medium text-crm-text truncate">{member.assignedTo?.displayName ?? "Unassigned"}</dd>
            </div>
            <div>
              <dt className="text-crm-muted">Stage</dt>
              <dd className="text-crm-text">{member.contact?.crmStage ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-crm-muted">Attempts</dt>
              <dd className="tabular-nums text-crm-text">{member.attemptCount}</dd>
            </div>
            <div>
              <dt className="text-crm-muted">Last touch</dt>
              <dd className="text-crm-text">
                {member.contact?.lastActivityAt ? relativeTime(member.contact.lastActivityAt) : member.lastAttemptAt ? relativeTime(member.lastAttemptAt) : "—"}
              </dd>
            </div>
          </dl>

          {member.contact?.lastDisposition && (
            <p className="mt-1.5 text-xs text-crm-muted">
              Disposition: <span className="text-crm-text font-medium">{member.contact.lastDisposition}</span>
            </p>
          )}

          <p className="mt-2 text-[11px] font-semibold text-crm-accent">{nextAction}</p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row lg:flex-col lg:items-stretch shrink-0 lg:w-44">
          {readOnly ? (
            <span className={cn("text-xs px-2 py-1.5 rounded border text-center", MEMBER_STATUS_CHIP[member.status])}>
              {MEMBER_STATUS_LABELS[member.status]}
            </span>
          ) : (
            <ConnectSelect
              value={member.status}
              onChange={(value) => onStatusChange(member.id, value as MemberStatus)}
              size="sm"
              className={cn("w-full", MEMBER_STATUS_CHIP[member.status])}
              options={(Object.keys(MEMBER_STATUS_LABELS) as MemberStatus[]).map((s) => ({
                value: s,
                label: MEMBER_STATUS_LABELS[s],
              }))}
            />
          )}

          <MemberCallbackEditor
            member={member}
            campaignId={campaignId}
            readOnly={readOnly}
            token={token}
            onUpdated={onUpdated}
          />

          <button
            type="button"
            onClick={() =>
              router.push(
                `/crm/contacts/${member.contactId}?campaignId=${encodeURIComponent(campaignId)}&memberId=${encodeURIComponent(member.id)}`,
              )
            }
            disabled={readOnly}
            className={cn(crm.btnPrimary, "text-xs py-2 justify-center disabled:opacity-40")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Workspace
          </button>
          <button
            type="button"
            onClick={() => router.push(`/crm/contacts/${member.contactId}`)}
            className={cn(crm.campaignDetailBtnTertiary, "text-xs py-1.5 justify-center")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Contact
          </button>
        </div>
      </div>
    </article>
  );
}

function MemberCallbackEditor({
  member,
  campaignId,
  readOnly,
  token,
  onUpdated,
}: {
  member: CampaignMember;
  campaignId: string;
  readOnly?: boolean;
  token?: string;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() => {
    if (!member.callbackAt) return "";
    const d = new Date(member.callbackAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await apiPatch(
        `/crm/campaigns/${campaignId}/members/${member.id}`,
        {
          callbackAt: value ? new Date(value).toISOString() : null,
          ...(value && member.status !== "CALLBACK" ? { status: "CALLBACK" } : {}),
        },
        token,
      );
      setEditing(false);
      onUpdated();
    } catch {
      /* keep UI */
    }
    setSaving(false);
  }

  async function clear() {
    setSaving(true);
    try {
      await apiPatch(`/crm/campaigns/${campaignId}/members/${member.id}`, { callbackAt: null, callbackNote: null }, token);
      setValue("");
      setEditing(false);
      onUpdated();
    } catch {
      /* keep UI */
    }
    setSaving(false);
  }

  if (readOnly) {
    if (!member.callbackAt) return <p className="text-[11px] text-crm-muted text-center">No callback</p>;
    const d = new Date(member.callbackAt);
    return (
      <p className="text-[11px] text-crm-muted text-center">
        {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
        {d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
      </p>
    );
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={cn(crm.input, "text-xs py-1")}
        />
        <div className="flex gap-1">
          <button type="button" onClick={save} disabled={saving} className={cn(crm.btnPrimary, "flex-1 text-xs py-1")}>
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className={cn(crm.campaignDetailBtnTertiary, "px-2 py-1")}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  if (member.callbackAt) {
    const { label, tier } = callbackUrgency(member.callbackAt);
    return (
      <div className="flex items-center justify-between gap-1 rounded-crm border border-crm-border/70 bg-crm-surface-2/60 px-2 py-1.5">
        <span className={cn("text-[11px] font-medium", tier === "overdue" ? "text-crm-danger" : "text-crm-warning")}>{label}</span>
        <div className="flex gap-0.5">
          <button type="button" onClick={() => setEditing(true)} className="p-0.5 text-crm-muted hover:text-crm-text">
            <Edit2 className="h-3 w-3" />
          </button>
          <button type="button" onClick={clear} disabled={saving} className="p-0.5 text-crm-muted hover:text-crm-danger">
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <button type="button" onClick={() => setEditing(true)} className={cn(crm.campaignDetailBtnTertiary, "text-xs py-1.5 justify-center w-full")}>
      <CalendarClock className="h-3.5 w-3.5" />
      Set callback
    </button>
  );
}


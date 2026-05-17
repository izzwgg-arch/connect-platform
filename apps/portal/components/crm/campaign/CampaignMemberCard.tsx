"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Edit2, ExternalLink, PhoneCall, X } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { apiPatch } from "../../../services/apiClient";
import type { CampaignMember, MemberStatus } from "./campaignTypes";
import { MEMBER_STATUS_CHIP, MEMBER_STATUS_LABELS } from "./campaignTypes";
import { callbackUrgency, memberNextAction, relativeTime } from "./campaignUtils";

export function CampaignMemberCard({
  member,
  campaignId,
  selected,
  readOnly,
  onSelect,
  onUpdated,
  onStatusChange,
  token,
}: {
  member: CampaignMember;
  campaignId: string;
  selected: boolean;
  readOnly: boolean;
  onSelect: (checked: boolean) => void;
  onUpdated: () => void;
  onStatusChange: (memberId: string, status: MemberStatus) => void;
  token?: string;
}) {
  const router = useRouter();
  const archivedLead = member.queueWorkEligible === false;
  const terminal = member.status === "CONVERTED" || member.status === "SKIPPED" || member.status === "DO_NOT_CALL";
  const activeWork = member.status === "PENDING" || member.status === "IN_PROGRESS";
  const cb = callbackUrgency(member.callbackAt);
  const nextAction = memberNextAction(member.status, member.callbackAt);
  const isOverdue = cb.tier === "overdue";

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
            <select
              value={member.status}
              onChange={(e) => onStatusChange(member.id, e.target.value as MemberStatus)}
              className={cn(crm.input, "text-xs py-1.5", MEMBER_STATUS_CHIP[member.status])}
            >
              {(Object.keys(MEMBER_STATUS_LABELS) as MemberStatus[]).map((s) => (
                <option key={s} value={s}>
                  {MEMBER_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
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
                `/crm/live-call?contactId=${member.contactId}&campaignId=${campaignId}&memberId=${member.id}`,
              )
            }
            disabled={readOnly}
            className={cn(crm.btnPrimary, "text-xs py-2 justify-center disabled:opacity-40")}
          >
            <PhoneCall className="h-3.5 w-3.5" />
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


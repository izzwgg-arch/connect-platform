"use client";

import type { ReactNode } from "react";
import {
  CheckCheck,
  CheckSquare,
  Clock,
  GitCommitHorizontal,
  GitMerge,
  Mail,
  MessageSquare,
  MessageSquareDot,
  PhoneIncoming,
  PhoneOutgoing,
  User,
  UserPlus,
  ClipboardList,
  Voicemail,
} from "lucide-react";
import { CrmRecordingPlayer } from "../../CrmRecordingPlayer";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { TimelineEvent } from "./contactTypes";
import { formatDateTime } from "./contactFormatters";

function TimelineIcon({ type }: { type: string }) {
  const sz = 13;
  const wrap = "h-3.5 w-3.5";
  if (type === "NOTE_ADDED" || type === "NOTE_EDITED")
    return <MessageSquare className={cn(wrap, "text-crm-accent")} size={sz} />;
  if (type === "STAGE_CHANGED")
    return <GitCommitHorizontal className={cn(wrap, "text-crm-success")} size={sz} />;
  if (type === "CONTACT_CREATED")
    return <UserPlus className={cn(wrap, "text-crm-accent")} size={sz} />;
  if (type === "CDR_INBOUND")
    return <PhoneIncoming className={cn(wrap, "text-crm-success")} size={sz} />;
  if (type === "CDR_OUTBOUND")
    return <PhoneOutgoing className={cn(wrap, "text-crm-accent")} size={sz} />;
  if (type === "TASK_CREATED" || type === "TASK_COMPLETED" || type === "TASK_CANCELED")
    return <CheckSquare className={cn(wrap, "text-crm-warning")} size={sz} />;
  if (type === "CHECKLIST_COMPLETED")
    return <ClipboardList className={cn(wrap, "text-purple-400")} size={sz} />;
  if (type === "DISPOSITION_SET")
    return <CheckCheck className={cn(wrap, "text-sky-400")} size={sz} />;
  if (type === "CONTACT_MERGED")
    return <GitMerge className={cn(wrap, "text-purple-400")} size={sz} />;
  if (type === "ASSIGNED_TO_USER")
    return <User className={cn(wrap, "text-sky-400")} size={sz} />;
  if (type === "SMS_SENT")
    return <MessageSquareDot className={cn(wrap, "text-cyan-400")} size={sz} />;
  if (type === "SMS_RECEIVED")
    return <MessageSquareDot className={cn(wrap, "text-violet-400")} size={sz} />;
  if (type === "EMAIL_SENT")
    return <Mail className={cn(wrap, "text-emerald-400")} size={sz} />;
  if (type === "EMAIL_RECEIVED" || type === "EMAIL_REPLY")
    return <Mail className={cn(wrap, "text-sky-400")} size={sz} />;
  if (type === "VOICEMAIL_DROP")
    return <Voicemail className={cn(wrap, "text-violet-400")} size={sz} />;
  return <Clock className={cn(wrap, "text-crm-muted")} size={sz} />;
}

function eventTypeChip(type: string): string | null {
  if (type.startsWith("CDR_")) return "Call";
  if (type.startsWith("SMS_")) return "SMS";
  if (type.startsWith("EMAIL_")) return "Email";
  if (type === "VOICEMAIL_DROP") return "Voicemail Dropped";
  if (type.startsWith("NOTE_")) return "Note";
  if (type.startsWith("TASK_")) return "Task";
  if (type === "STAGE_CHANGED") return "Pipeline";
  if (type === "DISPOSITION_SET") return "Outcome";
  if (type === "ASSIGNED_TO_USER") return "Assignment";
  if (type === "CONTACT_MERGED") return "Merge";
  return null;
}

export function ContactTimelineItem({
  event,
  currentUserId,
  onEditNote,
  onDeleteNote,
  allowNoteMutations = true,
}: {
  event: TimelineEvent;
  currentUserId: string | undefined;
  onEditNote: (linkedId: string, currentBody: string) => void;
  onDeleteNote: (linkedId: string) => void;
  allowNoteMutations?: boolean;
}) {
  const isNote = event.type === "NOTE_ADDED";
  const isDeleted = event.body === "(deleted)";
  const chip = eventTypeChip(event.type);
  const isComm =
    event.type === "CDR_INBOUND" ||
    event.type === "CDR_OUTBOUND" ||
    event.type === "SMS_SENT" ||
    event.type === "SMS_RECEIVED" ||
    event.type === "VOICEMAIL_DROP";

  return (
    <article
      className={cn(
        "group relative flex gap-2 rounded-xl border px-2.5 py-1.5 transition-colors sm:px-3",
        isComm
          ? "border-crm-accent/20 bg-crm-accent/6 hover:border-crm-accent/35"
          : "border-crm-border/70 bg-crm-surface/90 hover:bg-crm-surface-2/40",
      )}
    >
      <div
        className="absolute bottom-2 left-[1.1rem] top-8 w-px bg-crm-border/60 group-last:hidden"
        aria-hidden
      />
      <TimelineIconBox type={event.type} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold leading-snug text-crm-text">{event.title}</span>
            {chip ? <span className={cn(crm.chip, "py-0 text-[10px]")}>{chip}</span> : null}
          </div>
          <time className="shrink-0 text-[11px] tabular-nums text-crm-muted">
            {formatDateTime(event.createdAt)}
          </time>
        </div>
        {isDeleted ? (
          <p className="mt-0.5 text-sm italic text-crm-muted">(note deleted)</p>
        ) : event.body ? (
          <p
            className={cn(
              "mt-0.5 text-sm leading-snug text-crm-text",
              isNote ? "whitespace-pre-wrap" : "",
            )}
          >
            {event.body}
          </p>
        ) : null}
        <EventMeta event={event} />
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {event.createdBy ? (
            <span className="text-[11px] text-crm-muted">{event.createdBy.displayName}</span>
          ) : null}
          {allowNoteMutations &&
            isNote &&
            !isDeleted &&
            event.linkedId &&
            event.createdBy?.id === currentUserId && (
              <>
                <button
                  type="button"
                  onClick={() => onEditNote(event.linkedId!, event.body ?? "")}
                  title="Edit note"
                  className="border-0 bg-transparent p-0 text-sm leading-none opacity-50 transition-opacity hover:opacity-100"
                >
                  ✏️
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteNote(event.linkedId!)}
                  title="Delete note"
                  className="border-0 bg-transparent p-0 text-sm leading-none opacity-50 transition-opacity hover:opacity-100"
                >
                  🗑️
                </button>
              </>
            )}
        </div>
      </div>
    </article>
  );
}

function TimelineIconBox({ type }: { type: string }) {
  return (
    <div className="relative z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-crm-border/60 bg-crm-surface-2">
      <TimelineIcon type={type} />
    </div>
  );
}

function MetaRow({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">{children}</div>;
}

function EventMeta({ event }: { event: TimelineEvent }) {
  if (event.type === "STAGE_CHANGED" && event.metadata) {
    return (
      <MetaRow>
        <span className="text-crm-muted">{String(event.metadata.from ?? "—")}</span>
        <span className="text-crm-muted">→</span>
        <span className="font-semibold text-crm-success">{String(event.metadata.to ?? "—")}</span>
      </MetaRow>
    );
  }
  if (event.type === "ASSIGNED_TO_USER" && event.metadata) {
    return (
      <MetaRow>
        <span className="text-crm-muted">{String(event.metadata.fromName ?? "—")}</span>
        <span className="text-crm-muted">→</span>
        <span className="font-semibold text-sky-400">{String(event.metadata.toName ?? "—")}</span>
      </MetaRow>
    );
  }
  if (
    (event.type === "CDR_INBOUND" || event.type === "CDR_OUTBOUND") &&
    event.metadata
  ) {
    const m = event.metadata as Record<string, unknown>;
    const talkSec = typeof m.talkSec === "number" ? m.talkSec : 0;
    const disposition = typeof m.disposition === "string" ? m.disposition : "unknown";
    const fromNumber = typeof m.fromNumber === "string" ? m.fromNumber : null;
    const toNumber = typeof m.toNumber === "string" ? m.toNumber : null;
    const recordingAvailable = Boolean(m.recordingAvailable);
    const displayNumber = event.type === "CDR_INBOUND" ? fromNumber : toNumber;
    const answered = disposition === "answered";
    return (
      <MetaRow>
        {displayNumber ? (
          <span className="font-mono text-[11px] text-crm-text">{displayNumber}</span>
        ) : null}
        {talkSec > 0 ? (
          <span className="text-[11px] text-crm-muted">
            {Math.floor(talkSec / 60)}m {talkSec % 60}s
          </span>
        ) : null}
        <span
          className={cn(
            "rounded px-1 py-0 text-[0.625rem] font-semibold uppercase",
            answered
              ? "bg-crm-success/15 text-crm-success"
              : "bg-crm-danger/15 text-crm-danger",
          )}
        >
          {disposition}
        </span>
        {recordingAvailable && event.linkedId ? (
          <CrmRecordingPlayer linkedId={event.linkedId} />
        ) : null}
      </MetaRow>
    );
  }
  if (event.type === "SMS_SENT" && event.metadata) {
    const m = event.metadata as Record<string, unknown>;
    const to = typeof m.to === "string" ? m.to : null;
    const from = typeof m.from === "string" ? m.from : null;
    const provider = typeof m.provider === "string" ? m.provider : null;
    return (
      <MetaRow>
        {to ? <span className="font-mono text-[11px] text-crm-text">→ {to}</span> : null}
        {from ? <span className="text-[11px] text-crm-muted">from {from}</span> : null}
        {provider ? <span className={cn(crm.chip, "py-0 text-[10px]")}>{provider.toLowerCase()}</span> : null}
      </MetaRow>
    );
  }
  if (event.type === "EMAIL_SENT" && event.metadata) {
    const m = event.metadata as Record<string, unknown>;
    const to = typeof m.to === "string" ? m.to : null;
    return (
      <MetaRow>
        {to ? <span className="font-mono text-[11px] text-crm-text">→ {to}</span> : null}
        <span className="rounded bg-emerald-500/15 px-1 py-0 text-[0.625rem] font-semibold text-emerald-300">
          sent
        </span>
      </MetaRow>
    );
  }
  if (event.type === "SMS_RECEIVED" && event.metadata) {
    const m = event.metadata as Record<string, unknown>;
    const from = typeof m.from === "string" ? m.from : null;
    const to = typeof m.to === "string" ? m.to : null;
    return (
      <MetaRow>
        {from ? <span className="font-mono text-[11px] text-crm-text">from {from}</span> : null}
        {to ? <span className="text-[11px] text-crm-muted">→ {to}</span> : null}
        <span className="rounded bg-violet-500/15 px-1 py-0 text-[0.625rem] font-semibold text-violet-300">
          inbound
        </span>
      </MetaRow>
    );
  }
  if (event.type === "VOICEMAIL_DROP" && event.metadata) {
    const m = event.metadata as Record<string, unknown>;
    const duration = typeof m.durationSeconds === "number" ? m.durationSeconds : null;
    const status = typeof m.status === "string" ? m.status : "Voicemail Dropped";
    return (
      <MetaRow>
        {duration ? <span className="text-[11px] text-crm-muted">{Math.floor(duration / 60)}m {duration % 60}s</span> : null}
        <span className="rounded bg-violet-500/15 px-1 py-0 text-[0.625rem] font-semibold text-violet-300">
          {status}
        </span>
      </MetaRow>
    );
  }
  return null;
}

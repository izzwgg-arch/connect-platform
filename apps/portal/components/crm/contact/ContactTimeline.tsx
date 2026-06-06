"use client";

import { useMemo, useState } from "react";
import { Filter } from "lucide-react";
import { ConnectSelect, type SelectOption } from "../../ConnectSelect";
import { CRMSection, crm } from "..";
import { LoadingSkeleton } from "../../LoadingSkeleton";
import { cn } from "../cn";
import type { TimelineEvent } from "./contactTypes";
import { ContactTimelineItem } from "./ContactTimelineItem";

type TimelineFilter =
  | "all"
  | "email_replies"
  | "sms_replies"
  | "email"
  | "sms"
  | "calls"
  | "checklist"
  | "script"
  | "forms"
  | "tasks"
  | "notes"
  | "voicemail"
  | "activity";

const BASE_FILTERS: { value: TimelineFilter; label: string }[] = [
  { value: "all", label: "All timeline" },
  { value: "email_replies", label: "Email replies" },
  { value: "sms_replies", label: "SMS replies" },
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
  { value: "calls", label: "Calls" },
  { value: "checklist", label: "Checklist" },
  { value: "script", label: "Script" },
  { value: "forms", label: "Forms" },
  { value: "tasks", label: "Tasks" },
  { value: "notes", label: "Notes" },
  { value: "voicemail", label: "Voicemail" },
  { value: "activity", label: "Activity" },
];

function isEmailReplyEvent(event: TimelineEvent) {
  return event.type === "EMAIL_RECEIVED" || event.type === "EMAIL_REPLY";
}

function isSmsReplyEvent(event: TimelineEvent) {
  return event.type === "SMS_RECEIVED";
}

function isActivityEvent(event: TimelineEvent) {
  return (
    event.type === "CONTACT_CREATED" ||
    event.type === "STAGE_CHANGED" ||
    event.type === "DISPOSITION_SET" ||
    event.type === "CONTACT_MERGED" ||
    event.type === "ASSIGNED_TO_USER"
  );
}

function matchesTimelineFilter(event: TimelineEvent, filter: TimelineFilter) {
  if (filter === "all") return true;
  if (filter === "email_replies") return isEmailReplyEvent(event);
  if (filter === "sms_replies") return isSmsReplyEvent(event);
  if (filter === "email") return event.type.startsWith("EMAIL_");
  if (filter === "sms") return event.type.startsWith("SMS_");
  if (filter === "calls") return event.type.startsWith("CDR_");
  if (filter === "checklist") return event.type.startsWith("CHECKLIST_");
  if (filter === "script") return event.type.startsWith("SCRIPT_");
  if (filter === "forms") return event.type.startsWith("FORM_");
  if (filter === "tasks") return event.type.startsWith("TASK_");
  if (filter === "notes") return event.type.startsWith("NOTE_");
  if (filter === "voicemail") return event.type === "VOICEMAIL_DROP";
  return isActivityEvent(event);
}

function buildTimelineFilterOptions(events: TimelineEvent[]): SelectOption[] {
  return BASE_FILTERS.map((filter) => {
    const count = events.filter((event) => matchesTimelineFilter(event, filter.value)).length;
    return {
      value: filter.value,
      label: filter.value === "all" ? `${filter.label} (${events.length})` : `${filter.label} (${count})`,
      disabled: filter.value !== "all" && count === 0,
    };
  });
}

export function ContactTimeline({
  events,
  loading,
  currentUserId,
  editingNoteLinkedId,
  editingNoteText,
  allowNoteMutations,
  onEditNote,
  onDeleteNote,
  isArchived,
  onStartOutreach,
  outreachStarting,
}: {
  events: TimelineEvent[];
  loading: boolean;
  currentUserId: string | undefined;
  editingNoteLinkedId: string | null;
  editingNoteText: string;
  allowNoteMutations: boolean;
  onEditNote: (linkedId: string, body: string) => void;
  onDeleteNote: (linkedId: string) => void;
  isArchived: boolean;
  onStartOutreach?: () => void;
  outreachStarting?: boolean;
}) {
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");
  const callCount = events.filter((e) => e.type.startsWith("CDR_")).length;
  const smsCount = events.filter((e) => e.type.startsWith("SMS_")).length;
  const filterOptions = useMemo(() => buildTimelineFilterOptions(events), [events]);
  const filteredEvents = useMemo(
    () => events.filter((event) => matchesTimelineFilter(event, timelineFilter)),
    [events, timelineFilter],
  );
  const selectedFilterLabel =
    BASE_FILTERS.find((filter) => filter.value === timelineFilter)?.label ?? "timeline";

  return (
    <div className="flex flex-col gap-4">
      <CRMSection
        title="Activity timeline"
        description={
          events.length > 0
            ? `${filteredEvents.length} of ${events.length} events${callCount ? ` · ${callCount} calls` : ""}${smsCount ? ` · ${smsCount} SMS` : ""}`
            : "Every call, message, note, and task in one stream"
        }
        actions={
          <div className="flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-crm-muted" />
            <ConnectSelect
              size="sm"
              value={timelineFilter}
              onChange={(value) => setTimelineFilter(value as TimelineFilter)}
              options={filterOptions}
              dropdownWidth={220}
              searchable={false}
              className="min-w-[12rem]"
            />
          </div>
        }
      >
        {loading ? (
          <LoadingSkeleton rows={5} />
        ) : events.length === 0 ? (
          <div className="py-2 text-sm">
            <p className="font-semibold text-crm-text">
              {isArchived ? "No activity on record" : "No conversations yet"}
            </p>
            <p className="mt-1 text-crm-muted">
              {isArchived
                ? "This archived contact has no timeline entries to show."
                : "Start first outreach with a note, SMS, or workspace call."}
            </p>
            {!isArchived && onStartOutreach ? (
              <button
                type="button"
                onClick={onStartOutreach}
                disabled={outreachStarting}
                className={cn(crm.btnPrimary, "mt-3")}
              >
                {outreachStarting ? "Opening notes…" : "Start outreach"}
              </button>
            ) : null}
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="rounded-crm border border-dashed border-crm-border/70 bg-crm-surface-2/35 px-4 py-6 text-sm">
            <p className="font-semibold text-crm-text">No {selectedFilterLabel.toLowerCase()} entries</p>
            <p className="mt-1 text-crm-muted">Choose another filter to see the rest of the timeline.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {filteredEvents.map((event) => (
              <ContactTimelineItem
                key={event.id}
                event={
                  editingNoteLinkedId === event.linkedId
                    ? { ...event, body: editingNoteText }
                    : event
                }
                currentUserId={currentUserId}
                onEditNote={onEditNote}
                onDeleteNote={onDeleteNote}
                allowNoteMutations={allowNoteMutations}
              />
            ))}
          </div>
        )}
      </CRMSection>
    </div>
  );
}

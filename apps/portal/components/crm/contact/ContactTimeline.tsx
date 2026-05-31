"use client";

import { Filter } from "lucide-react";
import { CRMSection, crm } from "..";
import { LoadingSkeleton } from "../../LoadingSkeleton";
import { cn } from "../cn";
import type { TimelineEvent } from "./contactTypes";
import { ContactTimelineItem } from "./ContactTimelineItem";

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
  const callCount = events.filter((e) => e.type.startsWith("CDR_")).length;
  const smsCount = events.filter((e) => e.type.startsWith("SMS_")).length;

  return (
    <div className="flex flex-col gap-4">
      <CRMSection
        title="Activity timeline"
        description={
          events.length > 0
            ? `${events.length} events${callCount ? ` · ${callCount} calls` : ""}${smsCount ? ` · ${smsCount} SMS` : ""}`
            : "Every call, message, note, and task in one stream"
        }
        actions={
          <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-crm-border bg-crm-surface-2 px-3 py-1.5 text-xs font-bold text-crm-muted hover:text-crm-text">
            <Filter className="h-3.5 w-3.5" />
            Filter
          </button>
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
        ) : (
          <div className="flex flex-col gap-1">
            {events.map((event) => (
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

"use client";

import { Activity } from "lucide-react";
import { CRMCard, CRMEmptyState, CRMSection, crm } from "..";
import { LoadingSkeleton } from "../../LoadingSkeleton";
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
}) {
  const callCount = events.filter((e) => e.type.startsWith("CDR_")).length;
  const smsCount = events.filter((e) => e.type.startsWith("SMS_")).length;

  return (
    <CRMCard padding="lg" className="flex flex-col gap-4">
      <CRMSection
        title="Relationship timeline"
        description={
          events.length > 0
            ? `${events.length} events${callCount ? ` · ${callCount} calls` : ""}${smsCount ? ` · ${smsCount} SMS` : ""}`
            : "Every call, message, note, and task in one stream"
        }
      >
        {loading ? (
          <LoadingSkeleton rows={5} />
        ) : events.length === 0 ? (
          <CRMEmptyState
            icon={<Activity className="h-8 w-8" />}
            title={isArchived ? "No activity on record" : "No conversations yet"}
            description={
              isArchived
                ? "This archived contact has no timeline entries to show."
                : "Start first outreach — add a note, send SMS, or open the live workspace to log a call."
            }
            action={
              !isArchived && onStartOutreach ? (
                <button type="button" onClick={onStartOutreach} className={crm.btnPrimary}>
                  Start outreach
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5">
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
    </CRMCard>
  );
}

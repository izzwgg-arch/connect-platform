"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Phone, Mail, Clock, User, MessageSquare,
  GitCommitHorizontal, UserPlus, Pencil, Trash2,
  CheckSquare, Circle, Plus, PhoneIncoming, PhoneOutgoing,
  ClipboardList, CheckCheck, GitMerge, AlertTriangle, Calendar, MessageSquareDot, Send,
  Archive, ArchiveRestore, Radio, ExternalLink, ChevronRight,
} from "lucide-react";
import { CRMPageShell } from "../../../../../components/crm";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { CrmRecordingPlayer } from "../../../../../components/CrmRecordingPlayer";
import { apiGet, apiPatch, apiPost, apiDelete } from "../../../../../services/apiClient";
import { useAppContext } from "../../../../../hooks/useAppContext";

// ── Types ─────────────────────────────────────────────────────────────────────

type CrmStage = "LEAD" | "CONTACTED" | "QUALIFIED" | "CUSTOMER" | "CLOSED_LOST";

type AssignedUser = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  email: string;
};

type ContactPhone = { id: string; type: string; numberRaw: string; isPrimary: boolean };
type ContactEmail = { id: string; type: string; email: string; isPrimary: boolean };

type CrmContactDetail = {
  id: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  notes?: string | null;
  phones: ContactPhone[];
  emails: ContactEmail[];
  crmStage?: CrmStage | null;
  assignedTo?: AssignedUser | null;
  doNotCall: boolean;
  doNotSms: boolean;
  lastActivityAt?: string | null;
  lastDisposition?: string | null;
  lastDispositionAt?: string | null;
  createdAt: string;
  updatedAt: string;
  active?: boolean;
  archivedAt?: string | null;
};

type TimelineEventType =
  | "CONTACT_CREATED"
  | "STAGE_CHANGED"
  | "NOTE_ADDED"
  | "NOTE_EDITED"
  | "CDR_INBOUND"
  | "CDR_OUTBOUND"
  | "TASK_CREATED" | "TASK_COMPLETED" | "TASK_CANCELED"
  | "CHECKLIST_COMPLETED"
  | "DISPOSITION_SET"
  | "CONTACT_MERGED"
  | "ASSIGNED_TO_USER"
  | "SMS_SENT"
  | "SMS_RECEIVED";

type TimelineEventCreatedBy = { id: string; displayName: string };

type TimelineEvent = {
  id: string;
  /** Typed as string so unknown future event types render gracefully (Clock icon fallback) */
  type: TimelineEventType | string;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  linkedId?: string | null;
  createdAt: string;
  createdBy?: TimelineEventCreatedBy | null;
};

type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
type TaskStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELED";

type DuplicateContact = {
  id: string;
  displayName: string;
  company: string | null;
  crmStage: CrmStage | null;
  primaryPhone: string | null;
  primaryEmail: string | null;
  matchReasons: string[];
};

type CrmTask = {
  id: string;
  title: string;
  dueAt?: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  completedAt?: string | null;
  assignedTo?: { id: string; displayName: string } | null;
};

const TASK_PRIORITY_COLOR: Record<TaskPriority, string> = {
  LOW: "#6b7280", MEDIUM: "#3b82f6", HIGH: "#f59e0b", URGENT: "#ef4444",
};

// ── Stage config ──────────────────────────────────────────────────────────────

const STAGE_OPTIONS: { value: CrmStage; label: string; color: string }[] = [
  { value: "LEAD", label: "Lead", color: "#6366f1" },
  { value: "CONTACTED", label: "Contacted", color: "#f59e0b" },
  { value: "QUALIFIED", label: "Qualified", color: "#10b981" },
  { value: "CUSTOMER", label: "Customer", color: "#3b82f6" },
  { value: "CLOSED_LOST", label: "Closed Lost", color: "#6b7280" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatTimeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 7 ? `${days}d ago` : formatDate(iso);
}

function stageColor(stage: CrmStage): string {
  return STAGE_OPTIONS.find((s) => s.value === stage)?.color ?? "#6b7280";
}

function stageLabel(stage: CrmStage): string {
  return STAGE_OPTIONS.find((s) => s.value === stage)?.label ?? stage;
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.4375rem 0.625rem",
  border: "1px solid var(--border)",
  borderRadius: "0.375rem",
  background: "var(--surface-hover)",
  color: "var(--text)",
  fontSize: "0.875rem",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  marginBottom: "0.3rem",
};

const btnSmall: React.CSSProperties = {
  padding: "0.25rem 0.625rem",
  fontSize: "0.8125rem",
  borderRadius: "0.3rem",
  border: "1px solid var(--border)",
  cursor: "pointer",
  background: "var(--surface-hover)",
  color: "var(--text-dim)",
};

// ── Timeline item component ────────────────────────────────────────────────────

function TimelineIcon({ type }: { type: string }) {
  const sz = 15;
  if (type === "NOTE_ADDED" || type === "NOTE_EDITED")
    return <MessageSquare size={sz} style={{ color: "#6366f1" }} />;
  if (type === "STAGE_CHANGED")
    return <GitCommitHorizontal size={sz} style={{ color: "#10b981" }} />;
  if (type === "CONTACT_CREATED")
    return <UserPlus size={sz} style={{ color: "#3b82f6" }} />;
  if (type === "CDR_INBOUND")
    return <PhoneIncoming size={sz} style={{ color: "#10b981" }} />;
  if (type === "CDR_OUTBOUND")
    return <PhoneOutgoing size={sz} style={{ color: "#3b82f6" }} />;
  if (type === "TASK_CREATED" || type === "TASK_COMPLETED" || type === "TASK_CANCELED")
    return <CheckSquare size={sz} style={{ color: "#f59e0b" }} />;
  if (type === "CHECKLIST_COMPLETED")
    return <ClipboardList size={sz} style={{ color: "#8b5cf6" }} />;
  if (type === "DISPOSITION_SET")
    return <CheckCheck size={sz} style={{ color: "#0ea5e9" }} />;
  if (type === "CONTACT_MERGED")
    return <GitMerge size={sz} style={{ color: "#8b5cf6" }} />;
  if (type === "ASSIGNED_TO_USER")
    return <User size={sz} style={{ color: "#0ea5e9" }} />;
  if (type === "SMS_SENT")
    return <MessageSquareDot size={sz} style={{ color: "#0891b2" }} />;
  if (type === "SMS_RECEIVED")
    return <MessageSquareDot size={sz} style={{ color: "#7c3aed" }} />;
  return <Clock size={sz} style={{ color: "var(--text-dim)" }} />;
}

interface TimelineItemProps {
  event: TimelineEvent;
  currentUserId: string | undefined;
  onEditNote: (linkedId: string, currentBody: string) => void;
  onDeleteNote: (linkedId: string) => void;
  allowNoteMutations?: boolean;
}

function TimelineItem({
  event,
  currentUserId,
  onEditNote,
  onDeleteNote,
  allowNoteMutations = true,
}: TimelineItemProps) {
  const isNote = event.type === "NOTE_ADDED";
  const isDeleted = event.body === "(deleted)";

  return (
    <div className="mb-2 flex gap-3 rounded-crm border border-crm-border/80 bg-crm-surface px-3 py-2.5 shadow-crm">
      {/* Icon column */}
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-crm-surface-2">
        <TimelineIcon type={event.type} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem" }}>
          <span className="text-[0.8125rem] font-semibold text-crm-text">
            {event.title}
          </span>
          <span className="shrink-0 text-xs text-crm-muted">
            {formatDateTime(event.createdAt)}
          </span>
        </div>

        {event.body && !isDeleted && (
          <p style={{ margin: "0.25rem 0 0", fontSize: "0.8125rem", color: "var(--text)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
            {event.body}
          </p>
        )}

        {isDeleted && (
          <p style={{ margin: "0.25rem 0 0", fontSize: "0.8125rem", color: "var(--text-dim)", fontStyle: "italic" }}>
            (note deleted)
          </p>
        )}

        {/* Stage change metadata */}
        {event.type === "STAGE_CHANGED" && event.metadata && (
          <div style={{ marginTop: "0.25rem", display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.75rem" }}>
            <span style={{ color: "var(--text-dim)" }}>
              {String(event.metadata.from ?? "—")}
            </span>
            <span style={{ color: "var(--text-dim)" }}>→</span>
            <span style={{ color: "#10b981", fontWeight: 600 }}>
              {String(event.metadata.to ?? "—")}
            </span>
          </div>
        )}

        {/* Assignment metadata */}
        {event.type === "ASSIGNED_TO_USER" && event.metadata && (
          <div style={{ marginTop: "0.25rem", display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.75rem" }}>
            <span style={{ color: "var(--text-dim)" }}>
              {String(event.metadata.fromName ?? "—")}
            </span>
            <span style={{ color: "var(--text-dim)" }}>→</span>
            <span style={{ color: "#0ea5e9", fontWeight: 600 }}>
              {String(event.metadata.toName ?? "—")}
            </span>
          </div>
        )}

        {/* CDR call metadata */}
        {(event.type === "CDR_INBOUND" || event.type === "CDR_OUTBOUND") && event.metadata && (() => {
          const m = event.metadata as Record<string, unknown>;
          const talkSec = typeof m.talkSec === "number" ? m.talkSec : 0;
          const disposition = typeof m.disposition === "string" ? m.disposition : "unknown";
          const fromNumber = typeof m.fromNumber === "string" ? m.fromNumber : null;
          const toNumber = typeof m.toNumber === "string" ? m.toNumber : null;
          const recordingAvailable = Boolean(m.recordingAvailable);
          const displayNumber = event.type === "CDR_INBOUND" ? fromNumber : toNumber;
          return (
            <div style={{ marginTop: "0.25rem", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              {displayNumber && (
                <span style={{ fontSize: "0.75rem", color: "var(--text)", fontFamily: "monospace" }}>
                  {displayNumber}
                </span>
              )}
              {talkSec > 0 && (
                <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
                  {Math.floor(talkSec / 60)}m {talkSec % 60}s
                </span>
              )}
              <span style={{
                fontSize: "0.6875rem",
                fontWeight: 600,
                padding: "0.125rem 0.375rem",
                borderRadius: 4,
                background: disposition === "answered" ? "#d1fae5" : "#fee2e2",
                color: disposition === "answered" ? "#065f46" : "#991b1b",
              }}>
                {disposition}
              </span>
              {recordingAvailable && event.linkedId && (
                <CrmRecordingPlayer linkedId={event.linkedId} />
              )}
            </div>
          );
        })()}

        {/* SMS_SENT metadata */}
        {event.type === "SMS_SENT" && event.metadata && (() => {
          const m = event.metadata as Record<string, unknown>;
          const to = typeof m.to === "string" ? m.to : null;
          const from = typeof m.from === "string" ? m.from : null;
          const provider = typeof m.provider === "string" ? m.provider : null;
          return (
            <div style={{ marginTop: "0.25rem", display: "flex", alignItems: "center", gap: "0.375rem", flexWrap: "wrap" }}>
              {to && <span style={{ fontSize: "0.75rem", color: "var(--text)", fontFamily: "monospace" }}>→ {to}</span>}
              {from && <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>from {from}</span>}
              {provider && (
                <span style={{ fontSize: "0.6875rem", fontWeight: 600, padding: "0.1rem 0.3rem", borderRadius: 4, background: "#e0f2fe", color: "#0369a1" }}>
                  {provider.toLowerCase()}
                </span>
              )}
            </div>
          );
        })()}

        {/* SMS_RECEIVED metadata */}
        {event.type === "SMS_RECEIVED" && event.metadata && (() => {
          const m = event.metadata as Record<string, unknown>;
          const from = typeof m.from === "string" ? m.from : null;
          const to = typeof m.to === "string" ? m.to : null;
          return (
            <div style={{ marginTop: "0.25rem", display: "flex", alignItems: "center", gap: "0.375rem", flexWrap: "wrap" }}>
              {from && <span style={{ fontSize: "0.75rem", color: "var(--text)", fontFamily: "monospace" }}>from {from}</span>}
              {to && <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>→ {to}</span>}
              <span style={{ fontSize: "0.6875rem", fontWeight: 600, padding: "0.1rem 0.3rem", borderRadius: 4, background: "#f3e8ff", color: "#6d28d9" }}>
                inbound
              </span>
            </div>
          );
        })()}

        {/* Author + actions row */}
        <div style={{ marginTop: "0.25rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {event.createdBy && (
            <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
              {event.createdBy.displayName}
            </span>
          )}

          {/* Note actions — only show for non-deleted NOTE_ADDED events authored by current user */}
          {allowNoteMutations &&
            isNote &&
            !isDeleted &&
            event.linkedId &&
            event.createdBy?.id === currentUserId && (
            <>
              <button
                onClick={() => onEditNote(event.linkedId!, event.body ?? "")}
                title="Edit note"
                style={{ background: "none", border: "none", cursor: "pointer", padding: "0.125rem", color: "var(--text-dim)", lineHeight: 1 }}
              >
                <Pencil size={11} />
              </button>
              <button
                onClick={() => onDeleteNote(event.linkedId!)}
                title="Delete note"
                style={{ background: "none", border: "none", cursor: "pointer", padding: "0.125rem", color: "#ef4444", lineHeight: 1 }}
              >
                <Trash2 size={11} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CrmContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { backendJwtRole, user: appUser, can } = useAppContext();

  const canLiveWorkspace = can("can_view_crm_live_call");

  const isAdmin =
    backendJwtRole === "ADMIN" ||
    backendJwtRole === "TENANT_ADMIN" ||
    backendJwtRole === "SUPER_ADMIN";

  // ── Contact state ──────────────────────────────────────────────────────────
  const [contact, setContact] = useState<CrmContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editFirstName, setEditFirstName] = useState("");
  const [editLastName, setEditLastName] = useState("");
  const [editCompany, setEditCompany] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editStage, setEditStage] = useState<CrmStage>("LEAD");
  const [editDoNotCall, setEditDoNotCall] = useState(false);
  const [editDoNotSms, setEditDoNotSms] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Duplicate detection + merge state
  const [duplicates, setDuplicates] = useState<DuplicateContact[]>([]);
  const [mergeTarget, setMergeTarget] = useState<DuplicateContact | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [archivePosting, setArchivePosting] = useState(false);
  const [restorePosting, setRestorePosting] = useState(false);

  // ── Timeline state ─────────────────────────────────────────────────────────
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(true);

  // ── Tasks state ────────────────────────────────────────────────────────────
  const [tasks, setTasks] = useState<CrmTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [addingTask, setAddingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDueAt, setNewTaskDueAt] = useState("");
  const [newTaskPosting, setNewTaskPosting] = useState(false);

  // Note composer
  const [noteText, setNoteText] = useState("");
  const [notePosting, setNotePosting] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);
  const noteComposerRef = useRef<HTMLDivElement>(null);
  const smsPanelRef = useRef<HTMLDivElement>(null);
  const tasksPanelRef = useRef<HTMLDivElement>(null);

  // Inline note edit
  const [editingNoteLinkedId, setEditingNoteLinkedId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState("");
  const [editingNoteSaving, setEditingNoteSaving] = useState(false);

  // Phone add / remove
  const [addingPhone, setAddingPhone] = useState(false);
  const [newPhoneRaw, setNewPhoneRaw] = useState("");
  const [newPhoneType, setNewPhoneType] = useState<"MOBILE" | "OFFICE" | "HOME" | "OTHER">("MOBILE");
  const [newPhonePosting, setNewPhonePosting] = useState(false);

  // Email add / remove
  const [addingEmail, setAddingEmail] = useState(false);
  const [newEmailAddress, setNewEmailAddress] = useState("");
  const [newEmailType, setNewEmailType] = useState<"WORK" | "PERSONAL" | "OTHER">("WORK");
  const [newEmailPosting, setNewEmailPosting] = useState(false);

  // SMS panel state
  const [smsPhone, setSmsPhone] = useState<string>("");
  const [smsMessage, setSmsMessage] = useState("");
  const [smsSending, setSmsSending] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [smsSuccess, setSmsSuccess] = useState(false);

  // ── Loaders ────────────────────────────────────────────────────────────────

  const loadContact = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await apiGet<CrmContactDetail>(`/crm/contacts/${id}`);
      setContact(c);
      setEditDisplayName(c.displayName);
      setEditFirstName(c.firstName ?? "");
      setEditLastName(c.lastName ?? "");
      setEditCompany(c.company ?? "");
      setEditTitle(c.title ?? "");
      setEditNotes(c.notes ?? "");
      setEditStage(c.crmStage ?? "LEAD");
      setEditDoNotCall(c.doNotCall);
      setEditDoNotSms(c.doNotSms);
      if (c.archivedAt != null || c.active === false) setEditing(false);
    } catch (e: any) {
      setError(e?.message || "Failed to load contact");
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadDuplicates = useCallback(async () => {
    try {
      const data = await apiGet<{ duplicates: DuplicateContact[] }>(`/crm/contacts/${id}/duplicates`);
      setDuplicates(data.duplicates ?? []);
    } catch {
      // Non-fatal — duplicate detection failure must not block the contact view
    }
  }, [id]);

  const loadTimeline = useCallback(async () => {
    setTimelineLoading(true);
    try {
      const data = await apiGet<{ contactId: string; events: TimelineEvent[] }>(
        `/crm/contacts/${id}/timeline`
      );
      setTimeline(data.events);
    } catch {
      // Non-fatal — timeline failure should not block the contact view
    } finally {
      setTimelineLoading(false);
    }
  }, [id]);

  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    try {
      const data = await apiGet<{ contactId: string; tasks: CrmTask[] }>(
        `/crm/contacts/${id}/tasks?status=open`
      );
      setTasks(data.tasks);
    } catch {
      // Non-fatal
    } finally {
      setTasksLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadContact();
    loadTimeline();
    loadTasks();
    loadDuplicates();
  }, [loadContact, loadTimeline, loadTasks, loadDuplicates]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!editDisplayName.trim()) {
      setSaveError("Display name is required");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await apiPatch<CrmContactDetail>(`/crm/contacts/${id}`, {
        displayName: editDisplayName.trim(),
        firstName: editFirstName.trim() || undefined,
        lastName: editLastName.trim() || undefined,
        company: editCompany.trim() || undefined,
        title: editTitle.trim() || undefined,
        notes: editNotes,
        stage: editStage,
        doNotCall: editDoNotCall,
        doNotSms: editDoNotSms,
      });
      setContact(updated);
      setEditing(false);
      // Reload timeline in case stage changed
      loadTimeline();
    } catch (e: any) {
      setSaveError(e?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleMerge = async (dupId: string) => {
    setMerging(true);
    setMergeError(null);
    try {
      await apiPost("/crm/contacts/merge", {
        keepContactId: id,
        mergeContactId: dupId,
      });
      setMergeTarget(null);
      setDuplicates([]);
      // Refresh contact (phones/emails may have been added) + timeline
      await loadContact();
      loadTimeline();
    } catch (e: any) {
      setMergeError(e?.message || "Merge failed");
    } finally {
      setMerging(false);
    }
  };

  const handleArchiveContact = async () => {
    if (
      !window.confirm(
        "Archive this contact? They will be removed from active CRM lists and search. Timeline, tasks, and campaign history are preserved.",
      )
    ) {
      return;
    }
    setArchivePosting(true);
    setError(null);
    try {
      await apiDelete(`/crm/contacts/${id}`);
      await loadContact();
      loadTimeline();
      loadTasks();
      loadDuplicates();
    } catch (e: any) {
      setError(e?.message || "Archive failed");
    } finally {
      setArchivePosting(false);
    }
  };

  const handleRestoreContact = async () => {
    if (!window.confirm("Restore this contact to the active CRM list?")) return;
    setRestorePosting(true);
    setError(null);
    try {
      await apiPost(`/crm/contacts/${id}/restore`, {});
      await loadContact();
      loadTimeline();
      loadTasks();
      loadDuplicates();
    } catch (e: any) {
      setError(e?.message || "Restore failed");
    } finally {
      setRestorePosting(false);
    }
  };

  const handlePostNote = async () => {
    if (!noteText.trim()) return;
    setNotePosting(true);
    setNoteError(null);
    try {
      await apiPost(`/crm/contacts/${id}/notes`, { body: noteText.trim() });
      setNoteText("");
      await loadTimeline();
    } catch (e: any) {
      setNoteError(e?.message || "Failed to post note");
    } finally {
      setNotePosting(false);
    }
  };

  const handleEditNote = (linkedId: string, currentBody: string) => {
    setEditingNoteLinkedId(linkedId);
    setEditingNoteText(currentBody);
  };

  const handleSaveEditedNote = async () => {
    if (!editingNoteLinkedId || !editingNoteText.trim()) return;
    setEditingNoteSaving(true);
    try {
      await apiPatch(`/crm/contacts/${id}/notes/${editingNoteLinkedId}`, {
        body: editingNoteText.trim(),
      });
      setEditingNoteLinkedId(null);
      setEditingNoteText("");
      await loadTimeline();
    } catch (e: any) {
      alert(e?.message || "Failed to update note");
    } finally {
      setEditingNoteSaving(false);
    }
  };

  const handleCompleteTask = async (taskId: string) => {
    await apiPatch(`/crm/contacts/${id}/tasks/${taskId}`, { status: "DONE" });
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    loadTimeline();
  };

  const handleCreateTask = async () => {
    if (!newTaskTitle.trim()) return;
    setNewTaskPosting(true);
    try {
      await apiPost(`/crm/contacts/${id}/tasks`, {
        title: newTaskTitle.trim(),
        dueAt: newTaskDueAt || undefined,
      });
      setNewTaskTitle("");
      setNewTaskDueAt("");
      setAddingTask(false);
      await loadTasks();
      loadTimeline();
    } catch { /* silent */ } finally {
      setNewTaskPosting(false);
    }
  };

  const handleDeleteNote = async (linkedId: string) => {
    if (!confirm("Delete this note?")) return;
    try {
      await apiDelete(`/crm/contacts/${id}/notes/${linkedId}`);
      await loadTimeline();
    } catch (e: any) {
      alert(e?.message || "Failed to delete note");
    }
  };

  const handleAddPhone = async () => {
    if (!newPhoneRaw.trim()) return;
    setNewPhonePosting(true);
    try {
      const updated = await apiPost<CrmContactDetail>(`/crm/contacts/${id}/phones`, {
        numberRaw: newPhoneRaw.trim(),
        type: newPhoneType,
        isPrimary: false,
      });
      setContact(updated);
      setNewPhoneRaw("");
      setAddingPhone(false);
    } catch (e: any) {
      alert(e?.message || "Failed to add phone");
    } finally {
      setNewPhonePosting(false);
    }
  };

  const handleRemovePhone = async (phoneId: string) => {
    if (!confirm("Remove this phone number?")) return;
    try {
      await apiDelete(`/crm/contacts/${id}/phones/${phoneId}`);
      setContact((prev) => prev ? { ...prev, phones: prev.phones.filter((p) => p.id !== phoneId) } : prev);
    } catch (e: any) {
      alert(e?.message || "Failed to remove phone");
    }
  };

  const handleAddEmail = async () => {
    if (!newEmailAddress.trim()) return;
    setNewEmailPosting(true);
    try {
      const updated = await apiPost<CrmContactDetail>(`/crm/contacts/${id}/emails`, {
        email: newEmailAddress.trim(),
        type: newEmailType,
        isPrimary: false,
      });
      setContact(updated);
      setNewEmailAddress("");
      setAddingEmail(false);
    } catch (e: any) {
      alert(e?.message || "Failed to add email");
    } finally {
      setNewEmailPosting(false);
    }
  };

  const handleRemoveEmail = async (emailId: string) => {
    if (!confirm("Remove this email address?")) return;
    try {
      await apiDelete(`/crm/contacts/${id}/emails/${emailId}`);
      setContact((prev) => prev ? { ...prev, emails: prev.emails.filter((e) => e.id !== emailId) } : prev);
    } catch (e: any) {
      alert(e?.message || "Failed to remove email");
    }
  };

  const handleSendSms = async () => {
    if (!smsMessage.trim() || smsSending) return;
    setSmsSending(true);
    setSmsError(null);
    setSmsSuccess(false);
    try {
      await apiPost(`/crm/contacts/${id}/sms`, {
        message: smsMessage.trim(),
        ...(smsPhone ? { phone: smsPhone } : {}),
      });
      setSmsSuccess(true);
      setSmsMessage("");
      await loadTimeline();
      setTimeout(() => setSmsSuccess(false), 3000);
    } catch (e: any) {
      setSmsError(e?.message || "Failed to send SMS");
    } finally {
      setSmsSending(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: "2rem" }}>
        <LoadingSkeleton rows={8} />
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div style={{ padding: "2rem" }}>
        <button
          onClick={() => router.push("/crm/contacts")}
          style={{ display: "flex", alignItems: "center", gap: "0.375rem", background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: "0.875rem", marginBottom: "1rem", padding: 0 }}
        >
          <ArrowLeft size={14} /> Back to Contacts
        </button>
        <p style={{ color: "#ef4444", fontSize: "0.875rem" }}>{error || "Contact not found"}</p>
      </div>
    );
  }

  const stage = contact.crmStage ?? "LEAD";
  const isArchived = !!(contact.archivedAt != null || contact.active === false);

  // Derive SMS conversation from timeline — newest-first, capped at 25.
  // No new API call; reuses the timeline already loaded for the Activity feed.
  const smsEvents = timeline
    .filter((e) => e.type === "SMS_SENT" || e.type === "SMS_RECEIVED")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 25);

  const lastSmsIn = smsEvents.find((e) => e.type === "SMS_RECEIVED") ?? null;

  const primaryPhoneRow = contact.phones.find((p) => p.isPrimary) ?? contact.phones[0] ?? null;
  const primaryEmailRow = contact.emails.find((e) => e.isPrimary) ?? contact.emails[0] ?? null;

  const scrollToNoteComposer = () => {
    noteComposerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => noteTextareaRef.current?.focus(), 300);
  };

  const scrollToTasks = () => {
    tasksPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const scrollToSms = () => {
    smsPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const nextStep = useMemo((): {
    title: string;
    detail: string;
    actionLabel?: string;
    action: "none" | "add_phone" | "scroll_tasks" | "scroll_notes";
  } => {
    if (isArchived) {
      return {
        title: "Archived — read-only",
        detail:
          "This record is out of active CRM rotation. Review the timeline below; restore from the banner when you need to edit or message again.",
        action: "none",
      };
    }
    if (contact.phones.length === 0) {
      return {
        title: "Add a phone number",
        detail: "Voice and SMS both need a number on file. Add one under Contact info.",
        actionLabel: "Add phone",
        action: "add_phone",
      };
    }
    const open = tasks.filter((t) => t.status !== "DONE" && t.status !== "CANCELED");
    const sorted = [...open].sort((a, b) => {
      const ta = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const tb = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      return ta - tb;
    });
    const dueSoon = sorted.find((t) => t.dueAt);
    const overdue = sorted.find((t) => t.dueAt && new Date(t.dueAt) < new Date());
    if (overdue || dueSoon) {
      const t = overdue ?? dueSoon;
      if (t) {
        const late = t.dueAt && new Date(t.dueAt) < new Date();
        return {
          title: late ? "Overdue follow-up" : "Open task",
          detail: `${t.title}${t.dueAt ? ` · Due ${formatDate(t.dueAt)}` : ""}`,
          actionLabel: "View tasks",
          action: "scroll_tasks",
        };
      }
    }
    if (contact.doNotSms) {
      return {
        title: "SMS opted out",
        detail: "This contact cannot receive SMS. Use voice or email, and log updates in the timeline.",
        actionLabel: "Add note",
        action: "scroll_notes",
      };
    }
    return {
      title: "Keep the record current",
      detail: "Review recent activity, add a note, or schedule a follow-up so the next touch is intentional.",
      actionLabel: "Add note",
      action: "scroll_notes",
    };
  }, [contact.phones.length, contact.doNotSms, isArchived, tasks]);

  return (
    <CRMPageShell>
      <div className="space-y-4 md:space-y-5">
        <button
          type="button"
          onClick={() => router.push("/crm/contacts")}
          className="flex items-center gap-1.5 text-sm font-medium text-crm-muted hover:text-crm-text"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" />
          Back to Contacts
        </button>

        {/* Command header */}
        <div className="rounded-crm-lg border border-crm-border bg-crm-surface p-5 shadow-crm md:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
            <div
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-crm-lg text-lg font-bold text-white"
              style={{ background: stageColor(stage) }}
            >
              {initials(contact.displayName)}
            </div>

            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-crm-text">
                  {contact.displayName}
                </h1>
                <span
                  className="rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide"
                  style={{
                    background: stageColor(stage) + "22",
                    color: stageColor(stage),
                  }}
                >
                  {stageLabel(stage)}
                </span>
                {isArchived && (
                  <span className="rounded-full bg-gray-200 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-crm-text">
                    Archived
                  </span>
                )}
                {contact.doNotCall && (
                  <span className="text-xs font-semibold text-crm-danger">DNC</span>
                )}
              </div>

              <p className="text-sm leading-relaxed text-crm-muted">
                {isArchived
                  ? "Read-only archive — timeline stays visible; restore when you need to work the record again."
                  : contact.lastActivityAt
                    ? `Last activity ${formatDate(contact.lastActivityAt)}${
                        contact.assignedTo
                          ? ` · Owner: ${
                              contact.assignedTo.displayName ||
                              [contact.assignedTo.firstName, contact.assignedTo.lastName].filter(Boolean).join(" ") ||
                              contact.assignedTo.email
                            }`
                          : ""
                      }`
                    : contact.assignedTo
                      ? `Owner: ${
                          contact.assignedTo.displayName ||
                          [contact.assignedTo.firstName, contact.assignedTo.lastName].filter(Boolean).join(" ") ||
                          contact.assignedTo.email
                        } — add a note or task to capture the next touch.`
                      : "Capture the next touch with a note, task, or workspace session."}
              </p>

              <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-crm-text">
                {primaryPhoneRow ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <Phone className="h-4 w-4 shrink-0 text-crm-muted/80" aria-hidden />
                    <span className="truncate font-medium tabular-nums">{primaryPhoneRow.numberRaw}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-amber-700">
                    <Phone className="h-4 w-4 shrink-0" aria-hidden />
                    No phone on file
                  </span>
                )}
                {primaryEmailRow ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <Mail className="h-4 w-4 shrink-0 text-crm-muted/80" aria-hidden />
                    <span className="truncate">{primaryEmailRow.email}</span>
                  </span>
                ) : (
                  <span className="text-crm-muted/80">No email on file</span>
                )}
              </div>

              {(contact.title || contact.company) && (
                <p className="text-sm text-crm-muted">
                  {[contact.title, contact.company].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>

            <div className="flex w-full flex-col gap-2 border-t border-crm-border/60 pt-4 lg:w-auto lg:min-w-[200px] lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
              <div className="flex flex-wrap gap-2">
                {canLiveWorkspace && !isArchived && (
                  <Link
                    href={`/crm/live-call?contactId=${encodeURIComponent(contact.id)}`}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-crm-accent px-3 py-2 text-sm font-medium text-white hover:brightness-110 lg:flex-none"
                  >
                    <Radio className="h-4 w-4" aria-hidden />
                    Workspace
                    <ExternalLink className="h-3.5 w-3.5 opacity-80" aria-hidden />
                  </Link>
                )}
                <button
                  type="button"
                  disabled={isArchived}
                  onClick={scrollToNoteComposer}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg disabled:cursor-not-allowed disabled:opacity-45 lg:flex-none"
                >
                  <MessageSquare className="h-4 w-4" aria-hidden />
                  Add note
                </button>
                <button
                  type="button"
                  disabled={isArchived}
                  onClick={() => {
                    setAddingTask(true);
                    scrollToTasks();
                  }}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg disabled:cursor-not-allowed disabled:opacity-45 lg:flex-none"
                >
                  <Calendar className="h-4 w-4" aria-hidden />
                  Schedule task
                </button>
                <button
                  type="button"
                  disabled={isArchived || contact.phones.length === 0 || contact.doNotSms}
                  onClick={scrollToSms}
                  title={
                    contact.doNotSms
                      ? "SMS opt-out"
                      : contact.phones.length === 0
                        ? "Add a phone first"
                        : "Open SMS"
                  }
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-bg disabled:cursor-not-allowed disabled:opacity-45 lg:flex-none"
                >
                  <MessageSquareDot className="h-4 w-4" aria-hidden />
                  Send SMS
                </button>
              </div>

              <div className="flex flex-wrap gap-2 border-t border-crm-border/60 pt-3">
                {!isArchived && (
                  <>
                    {!editing ? (
                      <button
                        type="button"
                        onClick={() => setEditing(true)}
                        className="inline-flex items-center gap-1 rounded-lg border border-crm-border px-2.5 py-1.5 text-xs font-medium text-crm-muted hover:bg-crm-bg"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit fields
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(false);
                            setSaveError(null);
                          }}
                          disabled={saving}
                          className="rounded-lg border border-crm-border px-2.5 py-1.5 text-xs font-medium text-crm-muted"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleSave}
                          disabled={saving}
                          className="rounded-lg bg-crm-accent px-2.5 py-1.5 text-xs font-medium text-white hover:brightness-110"
                        >
                          {saving ? "Saving…" : "Save"}
                        </button>
                      </>
                    )}
                  </>
                )}
                {isAdmin && !isArchived && (
                  <button
                    type="button"
                    onClick={handleArchiveContact}
                    disabled={archivePosting}
                    className="inline-flex items-center gap-1 rounded-lg border border-crm-danger/35 px-2.5 py-1.5 text-xs font-medium text-crm-danger hover:bg-crm-danger/15"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    {archivePosting ? "…" : "Archive"}
                  </button>
                )}
                {isAdmin && isArchived && (
                  <button
                    type="button"
                    onClick={handleRestoreContact}
                    disabled={restorePosting}
                    className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-2.5 py-1.5 text-xs font-medium text-emerald-800 hover:bg-crm-success/10"
                  >
                    <ArchiveRestore className="h-3.5 w-3.5" />
                    {restorePosting ? "…" : "Restore"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Next step — rule-based, real data only */}
        <div className="rounded-crm-lg border border-crm-accent/25 bg-crm-surface p-4 shadow-crm md:flex md:items-start md:justify-between md:gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-crm-accent">Next step</p>
            <p className="mt-1 text-base font-semibold text-crm-text">{nextStep.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-crm-muted">{nextStep.detail}</p>
          </div>
          {nextStep.actionLabel && nextStep.action !== "none" && (
            <button
              type="button"
              onClick={() => {
                if (nextStep.action === "add_phone") setAddingPhone(true);
                if (nextStep.action === "scroll_tasks") scrollToTasks();
                if (nextStep.action === "scroll_notes") scrollToNoteComposer();
              }}
              className="mt-3 inline-flex shrink-0 items-center gap-1 rounded-lg bg-crm-accent px-3 py-2 text-sm font-medium text-white hover:brightness-110 md:mt-0"
            >
              {nextStep.actionLabel}
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>

        {/* Quick facts */}
        <div className="rounded-crm-lg border border-crm-border bg-crm-surface p-4 shadow-crm">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-crm-muted">Quick facts</h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs font-medium text-crm-muted/80">Phones</dt>
              <dd className="mt-0.5 font-medium text-crm-text">
                {contact.phones.length ? `${contact.phones.length} on file` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-crm-muted/80">Emails</dt>
              <dd className="mt-0.5 font-medium text-crm-text">
                {contact.emails.length ? `${contact.emails.length} on file` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-crm-muted/80">Stage</dt>
              <dd className="mt-0.5 font-medium text-crm-text">{stageLabel(stage)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-crm-muted/80">Owner</dt>
              <dd className="mt-0.5 font-medium text-crm-text">
                {contact.assignedTo
                  ? contact.assignedTo.displayName ||
                    [contact.assignedTo.firstName, contact.assignedTo.lastName].filter(Boolean).join(" ") ||
                    contact.assignedTo.email
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-crm-muted/80">Last activity</dt>
              <dd className="mt-0.5 font-medium text-crm-text">
                {contact.lastActivityAt ? formatDate(contact.lastActivityAt) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-crm-muted/80">SMS</dt>
              <dd className="mt-0.5 font-medium text-crm-text">
                {contact.doNotSms ? "Opt-out (do not send)" : "Allowed"}
              </dd>
            </div>
          </dl>
        </div>
      {editing && !isArchived && (
        <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
          <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>Edit Contact</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelStyle}>Display Name *</label>
              <input value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} style={inputStyle} placeholder="Full name or company name" />
            </div>
            <div>
              <label style={labelStyle}>First Name</label>
              <input value={editFirstName} onChange={(e) => setEditFirstName(e.target.value)} style={inputStyle} placeholder="First" />
            </div>
            <div>
              <label style={labelStyle}>Last Name</label>
              <input value={editLastName} onChange={(e) => setEditLastName(e.target.value)} style={inputStyle} placeholder="Last" />
            </div>
            <div>
              <label style={labelStyle}>Company</label>
              <input value={editCompany} onChange={(e) => setEditCompany(e.target.value)} style={inputStyle} placeholder="Company name" />
            </div>
            <div>
              <label style={labelStyle}>Title</label>
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={inputStyle} placeholder="Job title" />
            </div>
          </div>
        </div>
      )}

      {saveError && (
        <p style={{ color: "#ef4444", fontSize: "0.875rem", margin: "0 0 0.5rem" }}>{saveError}</p>
      )}

      {/* ── Two-column body ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)] lg:items-start">

        {/* ── Left column: CRM details ───────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>

          {/* CRM fields */}
          <div className="panel rounded-crm-lg border border-crm-border/60 shadow-crm" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>
              Outreach rules &amp; signal
            </h3>

            <div>
              <label style={labelStyle}>Stage</label>
              {editing ? (
                <select
                  value={editStage}
                  onChange={(e) => setEditStage(e.target.value as CrmStage)}
                  style={inputStyle}
                >
                  {STAGE_OPTIONS.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              ) : (
                <span style={{
                  display: "inline-block",
                  padding: "0.2rem 0.6rem",
                  borderRadius: "0.25rem",
                  fontSize: "0.8125rem",
                  fontWeight: 600,
                  background: stageColor(stage) + "22",
                  color: stageColor(stage),
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}>
                  {stageLabel(stage)}
                </span>
              )}
            </div>

            <div>
              <label style={labelStyle}>Do Not Call</label>
              {editing ? (
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editDoNotCall}
                    onChange={(e) => setEditDoNotCall(e.target.checked)}
                  />
                  <span style={{ fontSize: "0.875rem" }}>Do Not Call</span>
                </label>
              ) : (
                <span style={{ fontSize: "0.875rem", color: contact.doNotCall ? "#ef4444" : "var(--text-dim)" }}>
                  {contact.doNotCall ? "Yes" : "No"}
                </span>
              )}
            </div>

            <div>
              <label style={labelStyle}>Do Not SMS</label>
              {editing ? (
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editDoNotSms}
                    onChange={(e) => setEditDoNotSms(e.target.checked)}
                  />
                  <span style={{ fontSize: "0.875rem" }}>Do Not SMS</span>
                </label>
              ) : (
                <span style={{ fontSize: "0.875rem", color: contact.doNotSms ? "#ef4444" : "var(--text-dim)" }}>
                  {contact.doNotSms ? "Yes" : "No"}
                </span>
              )}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem 1.5rem", fontSize: "0.8125rem", color: "var(--text-dim)", paddingTop: "0.375rem", borderTop: "1px solid var(--border)" }}>
              <span style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                <Clock size={12} /> Added {formatDate(contact.createdAt)}
              </span>
              {contact.lastActivityAt && (
                <span style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                  <User size={12} /> Last activity {formatDate(contact.lastActivityAt)}
                </span>
              )}
              {contact.lastDisposition && (
                <span style={{ display: "flex", alignItems: "center", gap: "0.3rem", color: "#0ea5e9" }}>
                  <CheckCheck size={12} />
                  Last disposition: <strong style={{ fontWeight: 600 }}>{contact.lastDisposition}</strong>
                  {contact.lastDispositionAt && (
                    <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>
                      &nbsp;· {formatDate(contact.lastDispositionAt)}
                    </span>
                  )}
                </span>
              )}
              {lastSmsIn && (
                <span style={{ display: "flex", alignItems: "center", gap: "0.3rem", color: "#7c3aed" }}>
                  <MessageSquareDot size={12} />
                  Last SMS in: {formatTimeAgo(lastSmsIn.createdAt)}
                </span>
              )}
            </div>
          </div>

          {/* ── Open tasks panel ──────────────────────────────────────────── */}
          <div ref={tasksPanelRef} className="panel rounded-crm-lg border border-crm-border/60 shadow-crm" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>
                Open Tasks {tasks.length > 0 && <span style={{ fontWeight: 400, color: "var(--accent)" }}>({tasks.length})</span>}
              </h3>
              {!isArchived && (
                <button
                  onClick={() => setAddingTask((v) => !v)}
                  title="Add follow-up"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", padding: "0.125rem", display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.8125rem", fontWeight: 600 }}
                >
                  <Plus size={13} /> Add
                </button>
              )}
            </div>

            {/* Inline add form */}
            {!isArchived && addingTask && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
                <input
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  placeholder="Follow-up title…"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateTask(); if (e.key === "Escape") setAddingTask(false); }}
                  style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                />
                {/* Date presets */}
                <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                  {[
                    { label: "Today", days: 0 },
                    { label: "Tomorrow", days: 1 },
                    { label: "Next week", days: 7 },
                  ].map(({ label, days }) => {
                    const d = new Date();
                    d.setDate(d.getDate() + days);
                    const val = d.toISOString().slice(0, 10);
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => setNewTaskDueAt(val)}
                        style={{
                          padding: "0.2rem 0.5rem",
                          borderRadius: "0.25rem",
                          border: `1px solid ${newTaskDueAt === val ? "var(--accent)" : "var(--border)"}`,
                          background: newTaskDueAt === val ? "var(--accent)" : "var(--surface-hover)",
                          color: newTaskDueAt === val ? "#fff" : "var(--text-dim)",
                          fontSize: "0.75rem",
                          cursor: "pointer",
                          display: "flex", alignItems: "center", gap: "0.2rem",
                        }}
                      >
                        <Calendar size={10} /> {label}
                      </button>
                    );
                  })}
                  <input
                    type="date"
                    value={newTaskDueAt}
                    onChange={(e) => setNewTaskDueAt(e.target.value)}
                    style={{ ...inputStyle, width: "auto", fontSize: "0.75rem", padding: "0.2rem 0.4rem" }}
                    title="Custom date"
                  />
                </div>
                <div style={{ display: "flex", gap: "0.375rem" }}>
                  <button
                    onClick={handleCreateTask}
                    disabled={newTaskPosting || !newTaskTitle.trim()}
                    style={{ padding: "0.4rem 0.75rem", borderRadius: "0.3rem", border: "none", cursor: "pointer", background: "var(--accent)", color: "#fff", fontSize: "0.8125rem", fontWeight: 600, opacity: !newTaskTitle.trim() ? 0.5 : 1 }}
                  >
                    {newTaskPosting ? "…" : "Add"}
                  </button>
                  <button
                    onClick={() => { setAddingTask(false); setNewTaskDueAt(""); setNewTaskTitle(""); }}
                    style={{ padding: "0.4rem 0.75rem", borderRadius: "0.3rem", border: "1px solid var(--border)", cursor: "pointer", background: "var(--surface-hover)", color: "var(--text-dim)", fontSize: "0.8125rem" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Task list */}
            {tasksLoading ? (
              <LoadingSkeleton rows={2} />
            ) : tasks.length === 0 && !addingTask ? (
              <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim)" }}>No open tasks.</p>
            ) : (
              tasks.map((task) => {
                const isDue = task.dueAt && new Date(task.dueAt) < new Date();
                return (
                  <div key={task.id} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", paddingTop: "0.375rem" }}>
                    {!isArchived ? (
                      <button
                        onClick={() => handleCompleteTask(task.id)}
                        title="Mark done"
                        style={{ background: "none", border: "none", cursor: "pointer", padding: "0.1rem", color: "var(--text-dim)", flexShrink: 0, marginTop: "0.1rem" }}
                      >
                        <Circle size={14} />
                      </button>
                    ) : (
                      <span style={{ width: 14, flexShrink: 0, marginTop: "0.1rem" }} aria-hidden />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "0.875rem", fontWeight: 500 }}>{task.title}</div>
                      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.15rem", alignItems: "center" }}>
                        <span style={{ fontSize: "0.7rem", fontWeight: 700, padding: "0.1rem 0.35rem", borderRadius: "0.2rem", background: TASK_PRIORITY_COLOR[task.priority] + "22", color: TASK_PRIORITY_COLOR[task.priority], textTransform: "uppercase" }}>
                          {task.priority}
                        </span>
                        {task.dueAt && (
                          <span style={{ fontSize: "0.75rem", color: isDue ? "#ef4444" : "var(--text-dim)", display: "flex", alignItems: "center", gap: "0.2rem" }}>
                            <Clock size={10} />
                            {new Date(task.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                            {isDue && " · overdue"}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Scratch notes (Contact.notes — single text field) */}
          <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>Scratch Notes</h3>
            {editing && !isArchived ? (
              <textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                rows={4}
                placeholder="Quick scratch pad for this contact…"
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
              />
            ) : (
              <p style={{ margin: 0, fontSize: "0.875rem", color: contact.notes ? "var(--text)" : "var(--text-dim)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                {contact.notes || "No scratch notes."}
              </p>
            )}
          </div>

          {/* All phones & emails */}
          <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>Contact Info</h3>

            {contact.phones.length === 0 && contact.emails.length === 0 && !addingPhone && !addingEmail && (
              <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--text-dim)" }}>No contact info yet.</p>
            )}

            {/* Phones */}
            {contact.phones.map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Phone size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "0.875rem", fontWeight: p.isPrimary ? 600 : 400 }}>{p.numberRaw}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", textTransform: "capitalize" }}>
                    {p.type.toLowerCase()}{p.isPrimary ? " · primary" : ""}
                  </div>
                </div>
                {!isArchived && (
                  <button
                    onClick={() => handleRemovePhone(p.id)}
                    title="Remove phone"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: "0.1rem", lineHeight: 1, flexShrink: 0 }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}

            {/* Add phone inline form */}
            {!isArchived && (addingPhone ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem", paddingTop: "0.25rem" }}>
                <div style={{ display: "flex", gap: "0.375rem" }}>
                  <input
                    autoFocus
                    value={newPhoneRaw}
                    onChange={(e) => setNewPhoneRaw(e.target.value)}
                    placeholder="Phone number"
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddPhone(); if (e.key === "Escape") { setAddingPhone(false); setNewPhoneRaw(""); } }}
                    style={{ ...inputStyle, flex: 1, fontSize: "0.8125rem" }}
                  />
                  <select
                    value={newPhoneType}
                    onChange={(e) => setNewPhoneType(e.target.value as typeof newPhoneType)}
                    style={{ ...inputStyle, width: "auto", fontSize: "0.8125rem" }}
                  >
                    <option value="MOBILE">Mobile</option>
                    <option value="OFFICE">Office</option>
                    <option value="HOME">Home</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div style={{ display: "flex", gap: "0.375rem" }}>
                  <button
                    onClick={handleAddPhone}
                    disabled={newPhonePosting || !newPhoneRaw.trim()}
                    style={{ padding: "0.3rem 0.625rem", borderRadius: "0.3rem", border: "none", cursor: "pointer", background: "var(--accent)", color: "#fff", fontSize: "0.75rem", fontWeight: 600 }}
                  >
                    {newPhonePosting ? "…" : "Add"}
                  </button>
                  <button
                    onClick={() => { setAddingPhone(false); setNewPhoneRaw(""); }}
                    style={{ padding: "0.3rem 0.625rem", borderRadius: "0.3rem", border: "1px solid var(--border)", cursor: "pointer", background: "var(--surface-hover)", color: "var(--text-dim)", fontSize: "0.75rem" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingPhone(true)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: "0.8125rem", fontWeight: 600, padding: 0, textAlign: "left", display: "flex", alignItems: "center", gap: "0.25rem" }}
              >
                <Plus size={12} /> Add phone
              </button>
            ))}

            {/* Divider */}
            <div style={{ borderTop: "1px solid var(--border)", margin: "0.25rem 0" }} />

            {/* Emails */}
            {contact.emails.map((e) => (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Mail size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "0.875rem", fontWeight: e.isPrimary ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.email}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", textTransform: "capitalize" }}>
                    {e.type.toLowerCase()}{e.isPrimary ? " · primary" : ""}
                  </div>
                </div>
                {!isArchived && (
                  <button
                    onClick={() => handleRemoveEmail(e.id)}
                    title="Remove email"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: "0.1rem", lineHeight: 1, flexShrink: 0 }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}

            {/* Add email inline form */}
            {!isArchived && (addingEmail ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem", paddingTop: "0.25rem" }}>
                <div style={{ display: "flex", gap: "0.375rem" }}>
                  <input
                    autoFocus
                    type="email"
                    value={newEmailAddress}
                    onChange={(e) => setNewEmailAddress(e.target.value)}
                    placeholder="Email address"
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddEmail(); if (e.key === "Escape") { setAddingEmail(false); setNewEmailAddress(""); } }}
                    style={{ ...inputStyle, flex: 1, fontSize: "0.8125rem" }}
                  />
                  <select
                    value={newEmailType}
                    onChange={(e) => setNewEmailType(e.target.value as typeof newEmailType)}
                    style={{ ...inputStyle, width: "auto", fontSize: "0.8125rem" }}
                  >
                    <option value="WORK">Work</option>
                    <option value="PERSONAL">Personal</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div style={{ display: "flex", gap: "0.375rem" }}>
                  <button
                    onClick={handleAddEmail}
                    disabled={newEmailPosting || !newEmailAddress.trim()}
                    style={{ padding: "0.3rem 0.625rem", borderRadius: "0.3rem", border: "none", cursor: "pointer", background: "var(--accent)", color: "#fff", fontSize: "0.75rem", fontWeight: 600 }}
                  >
                    {newEmailPosting ? "…" : "Add"}
                  </button>
                  <button
                    onClick={() => { setAddingEmail(false); setNewEmailAddress(""); }}
                    style={{ padding: "0.3rem 0.625rem", borderRadius: "0.3rem", border: "1px solid var(--border)", cursor: "pointer", background: "var(--surface-hover)", color: "var(--text-dim)", fontSize: "0.75rem" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingEmail(true)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: "0.8125rem", fontWeight: 600, padding: 0, textAlign: "left", display: "flex", alignItems: "center", gap: "0.25rem" }}
              >
                <Plus size={12} /> Add email
              </button>
            ))}
          </div>
          {/* ── SMS conversation panel — history + composer ─────────────────── */}
          {contact.phones.length > 0 && (
            <div
              ref={smsPanelRef}
              className="panel rounded-crm-lg border border-crm-border bg-crm-bg/40 shadow-crm"
              style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}
            >

              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
                <MessageSquareDot size={13} style={{ color: "#0891b2" }} />
                <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>
                  SMS
                </h3>
                {smsEvents.length > 0 && (
                  <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", fontWeight: 400 }}>
                    · {smsEvents.length} message{smsEvents.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {/* Message history — newest first, max 25 */}
              {timelineLoading ? (
                <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim)" }}>Loading…</p>
              ) : smsEvents.length === 0 ? (
                <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim)" }}>No messages yet.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxHeight: "260px", overflowY: "auto" }}>
                  {smsEvents.map((ev) => {
                    const isSent = ev.type === "SMS_SENT";
                    const m = ev.metadata as Record<string, unknown> | null;
                    const phone = isSent
                      ? (typeof m?.to === "string" ? m.to : null)
                      : (typeof m?.from === "string" ? m.from : null);
                    return (
                      <div key={ev.id} style={{ display: "flex", flexDirection: "column", alignItems: isSent ? "flex-end" : "flex-start" }}>
                        <div style={{
                          maxWidth: "88%",
                          padding: "0.375rem 0.625rem",
                          borderRadius: isSent ? "0.75rem 0.75rem 0.25rem 0.75rem" : "0.75rem 0.75rem 0.75rem 0.25rem",
                          background: isSent ? "#e0f2fe" : "#f3e8ff",
                          color: isSent ? "#0c4a6e" : "#3b0764",
                          fontSize: "0.8125rem",
                          lineHeight: 1.5,
                          wordBreak: "break-word",
                        }}>
                          {ev.body || <em style={{ opacity: 0.6 }}>(no body)</em>}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", marginTop: "0.1rem" }}>
                          {phone && (
                            <span style={{ fontSize: "0.6875rem", color: "var(--text-dim)", fontFamily: "monospace" }}>
                              {phone}
                            </span>
                          )}
                          <span style={{ fontSize: "0.6875rem", color: "var(--text-dim)" }}>
                            {formatDateTime(ev.createdAt)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Composer or doNotSms notice */}
              {contact.doNotSms ? (
                <div style={{ padding: "0.4rem 0.625rem", borderRadius: "0.375rem", background: "#fef2f2", border: "1px solid #fca5a5", fontSize: "0.8125rem", color: "#991b1b", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <MessageSquareDot size={12} />
                  SMS disabled — contact has opted out
                </div>
              ) : isArchived ? (
                <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim)" }}>
                  SMS sending is disabled while this contact is archived.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
                  {contact.phones.length > 1 && (
                    <select
                      value={smsPhone}
                      onChange={(e) => setSmsPhone(e.target.value)}
                      style={{ ...inputStyle, fontSize: "0.8125rem" }}
                    >
                      <option value="">Primary: {contact.phones[0].numberRaw}</option>
                      {contact.phones.map((p) => (
                        <option key={p.id} value={p.numberRaw}>
                          {p.numberRaw} ({p.type.toLowerCase()}{p.isPrimary ? " · primary" : ""})
                        </option>
                      ))}
                    </select>
                  )}
                  <div style={{ display: "flex", gap: "0.375rem", alignItems: "flex-end" }}>
                    <textarea
                      value={smsMessage}
                      onChange={(e) => setSmsMessage(e.target.value)}
                      rows={2}
                      placeholder="Reply…"
                      maxLength={1600}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          handleSendSms();
                        }
                      }}
                      style={{ ...inputStyle, resize: "none", lineHeight: 1.5, fontSize: "0.8125rem", flex: 1 }}
                    />
                    <button
                      onClick={handleSendSms}
                      disabled={smsSending || !smsMessage.trim()}
                      title="Send SMS (⌘↵)"
                      style={{ padding: "0.5rem 0.625rem", borderRadius: "0.375rem", border: "none", cursor: "pointer", background: "#0891b2", color: "#fff", opacity: smsSending || !smsMessage.trim() ? 0.6 : 1, flexShrink: 0 }}
                    >
                      <Send size={14} />
                    </button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
                      {smsMessage.length > 0 ? `${smsMessage.length}/1600` : "⌘↵ to send"}
                    </span>
                    {smsSuccess && (
                      <span style={{ fontSize: "0.8125rem", color: "#059669", fontWeight: 600 }}>✓ Sent</span>
                    )}
                  </div>
                  {smsError && (
                    <p style={{ margin: 0, fontSize: "0.8125rem", color: "#ef4444" }}>{smsError}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Possible duplicates panel — shown when the API finds matches */}
          {duplicates.length > 0 && !isArchived && (
            <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.625rem", borderLeft: "3px solid #f59e0b" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
                <AlertTriangle size={13} style={{ color: "#d97706" }} />
                <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, color: "#92400e" }}>
                  Possible Duplicates ({duplicates.length})
                </h3>
              </div>
              <p style={{ margin: 0, fontSize: "0.75rem", color: "#92400e" }}>
                These contacts share phone, email, or name with this record.
              </p>
              {duplicates.map((dup) => (
                <div key={dup.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 0", borderTop: "1px solid var(--border)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "0.875rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {dup.displayName}
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
                      {[dup.company, dup.primaryPhone].filter(Boolean).join(" · ")}
                    </div>
                    <div style={{ fontSize: "0.6875rem", color: "#d97706", marginTop: "0.1rem" }}>
                      Match: {dup.matchReasons.join(", ")}
                    </div>
                  </div>
                  <a
                    href={`/crm/contacts/${dup.id}`}
                    style={{ ...btnSmall, textDecoration: "none", fontSize: "0.75rem" }}
                  >
                    View
                  </a>
                  {isAdmin && (
                    <button
                      onClick={() => { setMergeTarget(dup); setMergeError(null); }}
                      style={{ ...btnSmall, color: "#b45309", borderColor: "#fde68a", background: "#fffbeb", fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "0.2rem" }}
                    >
                      <GitMerge size={11} /> Merge
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Right column: Timeline + Notes ───────────────────────────────────── */}
        <div className="panel rounded-crm-lg border border-crm-border/60 shadow-crm" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div ref={noteComposerRef}>
            <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>
              Activity &amp; notes
            </h3>
          {isArchived ? (
            <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim)", lineHeight: 1.5 }}>
              Notes cannot be added while this contact is archived. Timeline below is read-only.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {/* Inline note edit mode */}
            {editingNoteLinkedId ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <textarea
                  value={editingNoteText}
                  onChange={(e) => setEditingNoteText(e.target.value)}
                  rows={3}
                  style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
                  autoFocus
                />
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    onClick={handleSaveEditedNote}
                    disabled={editingNoteSaving || !editingNoteText.trim()}
                    style={{ ...btnSmall, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)", fontWeight: 600 }}
                  >
                    {editingNoteSaving ? "Saving…" : "Save Edit"}
                  </button>
                  <button
                    onClick={() => { setEditingNoteLinkedId(null); setEditingNoteText(""); }}
                    style={btnSmall}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              /* Normal compose mode */
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <textarea
                  ref={noteTextareaRef}
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  rows={2}
                  placeholder="Write a note…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handlePostNote();
                    }
                  }}
                  style={{ ...inputStyle, resize: "none", lineHeight: 1.5 }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  {noteError && <span style={{ fontSize: "0.75rem", color: "#ef4444" }}>{noteError}</span>}
                  {!noteError && <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>⌘↵ to post</span>}
                  <button
                    onClick={handlePostNote}
                    disabled={notePosting || !noteText.trim()}
                    style={{ ...btnSmall, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)", fontWeight: 600, opacity: !noteText.trim() ? 0.5 : 1 }}
                  >
                    {notePosting ? "Posting…" : "Add Note"}
                  </button>
                </div>
              </div>
            )}
          </div>
          )}

          </div>

          {/* ── Timeline feed ───────────────────────────────────────────────── */}
          <div className="mt-4 border-t border-crm-border/60 pt-4">
            {timelineLoading ? (
              <LoadingSkeleton rows={4} />
            ) : timeline.length === 0 ? (
              <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim)", padding: "0.5rem 0" }}>
                No activity yet. Add a note above to get started.
              </p>
            ) : (
              timeline.map((event) => {
                const isInlineEdit = editingNoteLinkedId === event.linkedId;
                return (
                  <TimelineItem
                    key={event.id}
                    event={isInlineEdit ? { ...event, body: editingNoteText } : event}
                    currentUserId={appUser?.id}
                    onEditNote={handleEditNote}
                    onDeleteNote={handleDeleteNote}
                    allowNoteMutations={!isArchived}
                  />
                );
              })
            )}

          </div>
        </div>
      </div>
      </div>

      {/* ── Merge confirmation modal ──────────────────────────────────────────── */}
      {mergeTarget && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 10000,
            display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setMergeTarget(null); }}
        >
          <div style={{
            background: "var(--surface, #fff)", borderRadius: "0.75rem",
            padding: "1.5rem", maxWidth: 420, width: "100%",
            boxShadow: "0 8px 32px rgba(0,0,0,0.22)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
              <GitMerge size={18} style={{ color: "#7c3aed" }} />
              <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>Merge Contact</h3>
            </div>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "var(--text)" }}>
              Merge <strong>{mergeTarget.displayName}</strong> into <strong>{contact?.displayName}</strong>?
            </p>
            <div style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: "0.5rem", padding: "0.625rem 0.875rem", marginBottom: "1rem" }}>
              <p style={{ margin: 0, fontSize: "0.8125rem", color: "#92400e" }}>
                <strong>This cannot be undone.</strong> All activity, tasks, notes, and campaign memberships from <em>{mergeTarget.displayName}</em> will be moved to this contact. <em>{mergeTarget.displayName}</em> will be archived.
              </p>
            </div>
            {mergeError && (
              <p style={{ margin: "0 0 0.75rem", fontSize: "0.8125rem", color: "#ef4444" }}>{mergeError}</p>
            )}
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <button
                onClick={() => { setMergeTarget(null); setMergeError(null); }}
                disabled={merging}
                style={{ ...btnSmall, padding: "0.4375rem 0.875rem" }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleMerge(mergeTarget.id)}
                disabled={merging}
                style={{ padding: "0.4375rem 0.875rem", borderRadius: "0.375rem", border: "none", cursor: "pointer", background: "#7c3aed", color: "#fff", fontSize: "0.875rem", fontWeight: 700 }}
              >
                {merging ? "Merging…" : "Confirm Merge"}
              </button>
            </div>
          </div>
        </div>
      )}
    </CRMPageShell>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Phone, Mail, Clock, User, MessageSquare,
  GitCommitHorizontal, UserPlus, Pencil, Trash2,
  CheckSquare, Circle, Plus, PhoneIncoming, PhoneOutgoing, Mic,
  ClipboardList, CheckCheck, GitMerge, AlertTriangle, Calendar,
} from "lucide-react";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
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
  | "ASSIGNED_TO_USER";

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
  const sz = 13;
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
  return <Clock size={sz} style={{ color: "var(--text-dim)" }} />;
}

interface TimelineItemProps {
  event: TimelineEvent;
  currentUserId: string | undefined;
  onEditNote: (linkedId: string, currentBody: string) => void;
  onDeleteNote: (linkedId: string) => void;
}

function TimelineItem({ event, currentUserId, onEditNote, onDeleteNote }: TimelineItemProps) {
  const isNote = event.type === "NOTE_ADDED";
  const isDeleted = event.body === "(deleted)";

  return (
    <div style={{ display: "flex", gap: "0.625rem", padding: "0.625rem 0", borderBottom: "1px solid var(--border)" }}>
      {/* Icon column */}
      <div style={{ paddingTop: "0.1rem", flexShrink: 0, width: 20, display: "flex", justifyContent: "center" }}>
        <TimelineIcon type={event.type} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem" }}>
          <span style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--text)" }}>
            {event.title}
          </span>
          <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", flexShrink: 0 }}>
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
                <a
                  href={`/api/voice/recording/${encodeURIComponent(event.linkedId)}/stream`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "0.25rem",
                    fontSize: "0.6875rem", fontWeight: 600, padding: "0.125rem 0.375rem",
                    borderRadius: 4, background: "#ede9fe", color: "#5b21b6",
                    textDecoration: "none",
                  }}
                >
                  <Mic size={10} />
                  Recording
                </a>
              )}
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
          {isNote && !isDeleted && event.linkedId && event.createdBy?.id === currentUserId && (
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
  const { backendJwtRole, user: appUser } = useAppContext();

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

  return (
    <div className="stack compact-stack">
      {/* ── Back link ──────────────────────────────────────────────────────── */}
      <button
        onClick={() => router.push("/crm/contacts")}
        style={{ display: "flex", alignItems: "center", gap: "0.375rem", background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: "0.875rem", padding: 0, width: "fit-content" }}
      >
        <ArrowLeft size={14} /> Back to Contacts
      </button>

      {/* ── Profile header ─────────────────────────────────────────────────── */}
      <div
        className="panel"
        style={{ padding: "1.5rem", display: "flex", alignItems: "flex-start", gap: "1.25rem", flexWrap: "wrap" }}
      >
        <div style={{
          width: 56, height: 56, borderRadius: "50%",
          background: stageColor(stage), color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "1.125rem", fontWeight: 700, flexShrink: 0,
        }}>
          {initials(contact.displayName)}
        </div>

        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700 }}>
              {contact.displayName}
            </h1>
            <span style={{
              padding: "0.2rem 0.6rem",
              borderRadius: "0.25rem",
              fontSize: "0.75rem",
              fontWeight: 600,
              background: stageColor(stage) + "22",
              color: stageColor(stage),
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}>
              {stageLabel(stage)}
            </span>
            {contact.doNotCall && (
              <span style={{ fontSize: "0.75rem", color: "#ef4444", fontWeight: 600 }}>✕ DNC</span>
            )}
          </div>

          {(contact.title || contact.company) && (
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.9rem", color: "var(--text-dim)" }}>
              {[contact.title, contact.company].filter(Boolean).join(" · ")}
            </p>
          )}

          {contact.assignedTo && (
            <p style={{ margin: "0.375rem 0 0", fontSize: "0.8125rem", color: "var(--text-dim)", display: "flex", alignItems: "center", gap: "0.3rem" }}>
              <User size={12} />
              {contact.assignedTo.displayName ||
                [contact.assignedTo.firstName, contact.assignedTo.lastName].filter(Boolean).join(" ") ||
                contact.assignedTo.email}
            </p>
          )}
        </div>

        {/* Edit / Save actions */}
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              style={{ ...btnSmall, color: "var(--text)" }}
            >
              Edit
            </button>
          ) : (
            <>
              <button
                onClick={() => { setEditing(false); setSaveError(null); }}
                style={btnSmall}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{ ...btnSmall, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)", fontWeight: 600 }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Inline edit panel for identity fields ──────────────────────────────── */}
      {editing && (
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "1rem", alignItems: "start" }}>

        {/* ── Left column: CRM details ───────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>

          {/* CRM fields */}
          <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>CRM Details</h3>

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
            </div>
          </div>

          {/* ── Open tasks panel ──────────────────────────────────────────── */}
          <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>
                Open Tasks {tasks.length > 0 && <span style={{ fontWeight: 400, color: "var(--accent)" }}>({tasks.length})</span>}
              </h3>
              <button
                onClick={() => setAddingTask((v) => !v)}
                title="Add follow-up"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", padding: "0.125rem", display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.8125rem", fontWeight: 600 }}
              >
                <Plus size={13} /> Add
              </button>
            </div>

            {/* Inline add form */}
            {addingTask && (
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
                    <button
                      onClick={() => handleCompleteTask(task.id)}
                      title="Mark done"
                      style={{ background: "none", border: "none", cursor: "pointer", padding: "0.1rem", color: "var(--text-dim)", flexShrink: 0, marginTop: "0.1rem" }}
                    >
                      <Circle size={14} />
                    </button>
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
            {editing ? (
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
                <button
                  onClick={() => handleRemovePhone(p.id)}
                  title="Remove phone"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: "0.1rem", lineHeight: 1, flexShrink: 0 }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}

            {/* Add phone inline form */}
            {addingPhone ? (
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
            )}

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
                <button
                  onClick={() => handleRemoveEmail(e.id)}
                  title="Remove email"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: "0.1rem", lineHeight: 1, flexShrink: 0 }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}

            {/* Add email inline form */}
            {addingEmail ? (
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
            )}
          </div>
          {/* Possible duplicates panel — shown when the API finds matches */}
          {duplicates.length > 0 && (
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
        <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>
            Activity &amp; Notes
          </h3>

          {/* ── Quick note composer ─────────────────────────────────────────── */}
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

          {/* ── Timeline feed ───────────────────────────────────────────────── */}
          <div style={{ marginTop: "0.25rem" }}>
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
                  />
                );
              })
            )}

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
    </div>
  );
}

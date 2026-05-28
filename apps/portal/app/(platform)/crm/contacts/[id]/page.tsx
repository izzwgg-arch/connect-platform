"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft, Phone, Mail, Clock, User, MessageSquareDot, Trash2,
  Circle, Plus, CheckCheck, GitMerge, AlertTriangle, Calendar,
  ChevronRight, Star, MoreHorizontal, ChevronDown, Zap,
  TrendingUp, MessageSquare, FileText, ClipboardList, CheckSquare,
} from "lucide-react";
import {
  CRMPageShell,
  crm,
  ContactContextBar,
  LiveWorkspaceNotePanel,
  LiveWrapUpBar,
  ContactTimeline,
  ContactSmsPanel,
  type CrmContactDetail,
  type CrmStage,
  type CrmTask,
  type DuplicateContact,
  type QueueContextMember,
  type TimelineEvent,
  STAGE_OPTIONS,
  TASK_PRIORITY_COLOR,
  formatDate,
  formatTimeAgo,
  stageColor,
  stageLabel,
  cn,
} from "../../../../../components/crm";
import { DISPOSITION_OPTIONS, type Checklist, type LiveContact, type ScriptSummary } from "../../../../../components/crm/live";
import { LiveWorkspaceScriptPanel } from "../../../../../components/crm/live/LiveWorkspaceScriptPanel";
import { LiveWorkspaceChecklistPanel } from "../../../../../components/crm/live/LiveWorkspaceChecklistPanel";
import { CrmEmailComposeDrawer } from "../../../../../components/crm/email/CrmEmailComposeDrawer";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { apiGet, apiPatch, apiPost, apiDelete } from "../../../../../services/apiClient";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { useSipPhone } from "../../../../../hooks/useSipPhone";
import type { QueueMember } from "../../../../../components/crm/queue/queueTypes";
import { initials, ownerLabel } from "../../../../../components/crm/contact/contactFormatters";
import { CRMRingMetric } from "../../../../../components/crm/charts";

// ── Shared form styles ────────────────────────────────────────────────────────

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

type ContactTab = "timeline" | "script" | "checklist" | "sms" | "notes" | "tasks" | "email";

export default function CrmContactDetailPage() {
  return (
    <Suspense fallback={<ContactPageFallback />}>
      <CrmContactDetailInner />
    </Suspense>
  );
}

function ContactPageFallback() {
  return <div className="py-24 text-center text-sm text-crm-muted">Loading contact…</div>;
}

function CrmContactDetailInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { backendJwtRole, user: appUser, can } = useAppContext();
  const phone = useSipPhone();
  const sipReady = phone.regState === "registered";

  const returnTo = searchParams.get("returnTo");
  const urlMemberId = searchParams.get("memberId");
  const urlCampaignId = searchParams.get("campaignId");

  const [queueMember, setQueueMember] = useState<QueueContextMember | null>(null);
  const [campaignName, setCampaignName] = useState<string | null>(null);

  const canLiveWorkspace = can("can_view_crm_live_call");

  const isAdmin =
    backendJwtRole === "ADMIN" ||
    backendJwtRole === "TENANT_ADMIN" ||
    backendJwtRole === "SUPER_ADMIN";

  // ── Contact state ──────────────────────────────────────────────────────────
  const [contact, setContact] = useState<CrmContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Compose email state
  const [composeOpen, setComposeOpen] = useState(false);

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

  // Script/checklist workspace
  const [scriptSummaries, setScriptSummaries] = useState<ScriptSummary[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);

  // ── Contact tab navigation ─────────────────────────────────────────────────
  const [contactTab, setContactTab] = useState<ContactTab>("timeline");
  const workspacePanelRef = useRef<HTMLDivElement>(null);

  // Actions dropdown
  const [actionsOpen, setActionsOpen] = useState(false);

  // Note composer
  const [noteText, setNoteText] = useState("");
  const [notePosting, setNotePosting] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);
  const noteComposerRef = useRef<HTMLDivElement>(null);
  const smsPanelRef = useRef<HTMLDivElement>(null);
  const tasksPanelRef = useRef<HTMLDivElement>(null);
  const [noteSavedAt, setNoteSavedAt] = useState<Date | null>(null);

  // Live outcome workflow state
  const [disposition, setDisposition] = useState("");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [followUpOption, setFollowUpOption] = useState<"" | "today" | "tomorrow" | "nextweek" | "custom">("");
  const [followUpCustom, setFollowUpCustom] = useState("");
  const [nextStage, setNextStage] = useState<CrmStage | "">("");
  const [savingOutcome, setSavingOutcome] = useState(false);
  const [outcomeSaved, setOutcomeSaved] = useState(false);
  const [outcomeError, setOutcomeError] = useState("");
  const saveOutcomeRef = useRef<() => Promise<void>>(async () => {});

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

  // Caller-ID workflow
  const [callerIdSelected, setCallerIdSelected] = useState<string | null>(null);
  const [callerIdChecked, setCallerIdChecked] = useState(false);
  const [callerIdLoading, setCallerIdLoading] = useState(false);

  useEffect(() => {
    saveOutcomeRef.current = saveOutcome;
  });

  useEffect(() => {
    function onAnyKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
      if (tgt.getAttribute("contenteditable") === "true") return;
      if (!savingOutcome && !disabledOutcome()) {
        if (e.key >= "1" && e.key <= "6") {
          const idx = parseInt(e.key, 10) - 1;
          const d = (DISPOSITION_OPTIONS as readonly string[])[idx];
          if (d) {
            e.preventDefault();
            setDisposition(d);
            return;
          }
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        if (!savingOutcome && disposition) {
          e.preventDefault();
          void saveOutcomeRef.current();
        }
      }
    }
    window.addEventListener("keydown", onAnyKey);
    return () => window.removeEventListener("keydown", onAnyKey);
  }, [disposition, savingOutcome]);

  // Close actions dropdown when clicking outside
  useEffect(() => {
    if (!actionsOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-actions-dropdown]")) setActionsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [actionsOpen]);

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
      // Non-fatal
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
      // Non-fatal
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

  const loadWorkspaceGuides = useCallback(async () => {
    const [scriptsRes, checklistRes] = await Promise.allSettled([
      apiGet<{ scripts: ScriptSummary[] }>("/crm/scripts"),
      apiGet<{ checklists: Checklist[] }>("/crm/checklists"),
    ]);
    if (scriptsRes.status === "fulfilled") setScriptSummaries(scriptsRes.value.scripts ?? []);
    if (checklistRes.status === "fulfilled") setChecklists(checklistRes.value.checklists ?? []);
  }, []);

  useEffect(() => {
    loadContact();
    loadTimeline();
    loadTasks();
    loadDuplicates();
    void loadWorkspaceGuides();
  }, [loadContact, loadTimeline, loadTasks, loadDuplicates, loadWorkspaceGuides]);

  // Draft note autosave
  useEffect(() => {
    if (!id || noteText) return;
    try {
      const v = localStorage.getItem(`crm:live:note:${id}`);
      if (v) setNoteText(v);
    } catch {}
  }, [id]);
  useEffect(() => {
    if (!id) return;
    try {
      if (noteText) localStorage.setItem(`crm:live:note:${id}`, noteText);
      else localStorage.removeItem(`crm:live:note:${id}`);
    } catch {}
  }, [id, noteText]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ queue: QueueMember[] }>("/crm/queue?filter=all&limit=200");
        if (cancelled) return;
        const match =
          (urlMemberId ? data.queue.find((m) => m.id === urlMemberId) : null) ??
          data.queue.find((m) => m.contactId === id) ??
          null;
        if (match) {
          setQueueMember({
            id: match.id,
            contactId: match.contactId,
            status: match.status,
            attemptCount: match.attemptCount,
            callbackAt: match.callbackAt,
            callbackNote: match.callbackNote,
            campaign: match.campaign,
          });
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => { cancelled = true; };
  }, [id, urlMemberId]);

  useEffect(() => {
    const cid = urlCampaignId ?? queueMember?.campaign?.id;
    if (!cid) { setCampaignName(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ campaign: { name: string } }>(`/crm/campaigns/${cid}`);
        if (!cancelled) setCampaignName(data.campaign?.name ?? null);
      } catch {
        if (!cancelled) setCampaignName(queueMember?.campaign?.name ?? null);
      }
    })();
    return () => { cancelled = true; };
  }, [urlCampaignId, queueMember?.campaign?.id, queueMember?.campaign?.name]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!editDisplayName.trim()) { setSaveError("Display name is required"); return; }
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
      await apiPost("/crm/contacts/merge", { keepContactId: id, mergeContactId: dupId });
      setMergeTarget(null);
      setDuplicates([]);
      await loadContact();
      loadTimeline();
    } catch (e: any) {
      setMergeError(e?.message || "Merge failed");
    } finally {
      setMerging(false);
    }
  };

  const handleArchiveContact = async () => {
    if (!window.confirm("Archive this contact? They will be removed from active CRM lists and search. Timeline, tasks, and campaign history are preserved.")) return;
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
      setNoteSavedAt(new Date());
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
      await apiPatch(`/crm/contacts/${id}/notes/${editingNoteLinkedId}`, { body: editingNoteText.trim() });
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
      await apiPost(`/crm/contacts/${id}/tasks`, { title: newTaskTitle.trim(), dueAt: newTaskDueAt || undefined });
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

  // ── Memos ──────────────────────────────────────────────────────────────────

  const nextStep = useMemo((): {
    title: string;
    detail: string;
    actionLabel?: string;
    action: "none" | "add_phone" | "scroll_tasks" | "scroll_notes";
  } => {
    if (!contact) return { title: "Loading…", detail: "", action: "none" };
    const archived = !!(contact.archivedAt != null || contact.active === false);
    if (archived) {
      return { title: "Archived — read-only", detail: "This record is out of active CRM rotation. Review the timeline below; restore from the banner when you need to edit or message again.", action: "none" };
    }
    if (contact.phones.length === 0) {
      return { title: "Add a phone number", detail: "Voice and SMS both need a number on file. Add one under Contact info.", actionLabel: "Add phone", action: "add_phone" };
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
        return { title: late ? "Overdue follow-up" : "Open task", detail: `${t.title}${t.dueAt ? ` · Due ${formatDate(t.dueAt)}` : ""}`, actionLabel: "View tasks", action: "scroll_tasks" };
      }
    }
    if (contact.doNotSms) {
      return { title: "SMS opted out", detail: "This contact cannot receive SMS. Use voice or email, and log updates in the timeline.", actionLabel: "Add note", action: "scroll_notes" };
    }
    return { title: "Keep the record current", detail: "Review recent activity, add a note, or schedule a follow-up so the next touch is intentional.", actionLabel: "Add note", action: "scroll_notes" };
  }, [contact, tasks]);

  const workspaceHref = useMemo(() => {
    if (!contact) return "/crm/live-call";
    const params = new URLSearchParams({ contactId: contact.id });
    const cId = queueMember?.campaign?.id ?? urlCampaignId;
    const mId = queueMember?.id ?? urlMemberId;
    if (cId) params.set("campaignId", cId);
    if (mId) params.set("memberId", mId);
    if (returnTo) params.set("returnTo", returnTo);
    return `/crm/live-call?${params}`;
  }, [contact, queueMember, urlCampaignId, urlMemberId, returnTo]);

  // ── Derived signals ────────────────────────────────────────────────────────

  const lastTimelineEvent = timeline[0] ?? null;
  const lastInteractionAt = lastTimelineEvent?.createdAt ?? contact?.lastActivityAt ?? null;
  const weekAgo = Date.now() - 7 * 86400000;
  const thirtyDaysAgo = Date.now() - 30 * 86400000;
  const recentActivityCount = timeline.filter((e) => new Date(e.createdAt).getTime() >= weekAgo).length;
  const thirtyDayActivityCount = timeline.filter((e) => new Date(e.createdAt).getTime() >= thirtyDaysAgo).length;
  const overdueTasks = tasks.filter((t) => t.dueAt && new Date(t.dueAt) < new Date()).length;
  const lastComm = timeline.find((e) => e.type.startsWith("CDR_") || e.type.startsWith("SMS_"));
  const daysSinceComm = lastComm ? Math.floor((Date.now() - new Date(lastComm.createdAt).getTime()) / 86400000) : null;
  const callbackUrgent = queueMember?.callbackAt ? new Date(queueMember.callbackAt) < new Date() : false;

  // Computed relationship score (0-100)
  const leadScore = useMemo(() => {
    let score = 40;
    const callCount = timeline.filter((e) => e.type.startsWith("CDR_")).length;
    const smsCount = timeline.filter((e) => e.type.startsWith("SMS_")).length;
    const answeredCount = timeline.filter(
      (e) => e.type === "CDR_INBOUND" || (e.type === "CDR_OUTBOUND" && (e.metadata as any)?.disposition === "answered")
    ).length;
    score += Math.min(25, recentActivityCount * 5);
    score += Math.min(15, answeredCount * 5);
    score += Math.min(10, smsCount * 2);
    if (contact?.doNotCall) score -= 15;
    if (overdueTasks > 0) score -= 5;
    return Math.max(10, Math.min(100, Math.round(score)));
  }, [timeline, contact, recentActivityCount, overdueTasks]);

  const leadScoreLabel = leadScore >= 70 ? "High" : leadScore >= 45 ? "Medium" : "Low";

  const engagementLabel = recentActivityCount >= 4 ? "High" : recentActivityCount >= 2 ? "Medium" : "Low";
  const responsivenessLabel = (() => {
    const answered = timeline.filter((e) => e.type === "CDR_INBOUND" || (e.type === "CDR_OUTBOUND" && (e.metadata as any)?.disposition === "answered")).length;
    const totalCalls = timeline.filter((e) => e.type.startsWith("CDR_")).length;
    if (totalCalls === 0) return "No data";
    const rate = answered / totalCalls;
    if (rate >= 0.6) return "Very Good";
    if (rate >= 0.35) return "Good";
    return "Low";
  })();
  const trendLabel = recentActivityCount > 0 ? "Improving" : daysSinceComm != null && daysSinceComm > 14 ? "Declining" : "Stable";

  // ── Render helpers ─────────────────────────────────────────────────────────

  if (loading) {
    return <div style={{ padding: "2rem" }}><LoadingSkeleton rows={8} /></div>;
  }

  if (error || !contact) {
    return (
      <div style={{ padding: "2rem" }}>
        <button onClick={() => router.push("/crm/contacts")} style={{ display: "flex", alignItems: "center", gap: "0.375rem", background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: "0.875rem", marginBottom: "1rem", padding: 0 }}>
          <ArrowLeft size={14} /> Back to Contacts
        </button>
        <p style={{ color: "#ef4444", fontSize: "0.875rem" }}>{error || "Contact not found"}</p>
      </div>
    );
  }

  const stage = contact.crmStage ?? "LEAD";
  const isArchived = !!(contact.archivedAt != null || contact.active === false);

  const smsEvents = timeline
    .filter((e) => e.type === "SMS_SENT" || e.type === "SMS_RECEIVED")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 25);

  const primaryPhoneRow = contact.phones.find((p) => p.isPrimary) ?? contact.phones[0] ?? null;
  const primaryEmailRow = contact.emails.find((e) => e.isPrimary) ?? contact.emails[0] ?? null;
  const primaryPhone = primaryPhoneRow?.numberRaw ?? null;
  const primaryEmail = primaryEmailRow?.email ?? null;
  const owner = ownerLabel(contact.assignedTo) ?? "Unassigned";
  const lastTouch = lastInteractionAt ? formatTimeAgo(lastInteractionAt) : "No activity";

  const sipNotice = sipReady || !primaryPhone
    ? null
    : (phone.regState === "connecting" || phone.regState === "registering")
      ? "Phone connecting — call will dial once ready"
      : "Phone not registered — open the dialer to reconnect";

  const handleCall = async () => {
    const num = primaryPhone;
    if (!num) return;
    if (!callerIdChecked) {
      setCallerIdLoading(true);
      try {
        const res = await apiPost<{ callerId: string | null }>(`/crm/calls/originate`, { destination: num, contactId: id });
        setCallerIdSelected(res.callerId ?? null);
      } catch {
        setCallerIdSelected(null);
      } finally {
        setCallerIdChecked(true);
        setCallerIdLoading(false);
      }
    }
    window.dispatchEvent(new CustomEvent("crm:dial", { detail: { target: num } }));
  };

  const handleBack = () => {
    if (returnTo) router.push(returnTo);
    else router.push("/crm/contacts");
  };

  function disabledOutcome() {
    return !id || !!(contact?.archivedAt != null || contact?.active === false);
  }

  async function saveOutcome() {
    if (disabledOutcome() || !disposition) return;
    setSavingOutcome(true);
    setOutcomeError("");
    let followUpAt: string | null = null;
    if (followUpOption === "today") { const d = new Date(); d.setHours(17, 0, 0, 0); followUpAt = d.toISOString(); }
    else if (followUpOption === "tomorrow") { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); followUpAt = d.toISOString(); }
    else if (followUpOption === "nextweek") { const d = new Date(); const day = d.getDay(); const daysToMonday = day === 0 ? 1 : 8 - day; d.setDate(d.getDate() + daysToMonday); d.setHours(9, 0, 0, 0); followUpAt = d.toISOString(); }
    else if (followUpOption === "custom" && followUpCustom) { followUpAt = new Date(followUpCustom).toISOString(); }
    try {
      await apiPost(`/crm/contacts/${id}/disposition`, {
        disposition,
        note: outcomeNote.trim() || undefined,
        followUpAt: followUpAt ?? undefined,
        nextStage: nextStage || undefined,
      });
      setOutcomeSaved(true);
      setOutcomeNote("");
      setFollowUpOption("");
      setFollowUpCustom("");
      await loadContact();
      await loadTasks();
      await loadTimeline();
      setTimeout(() => setOutcomeSaved(false), 4000);
    } catch {
      setOutcomeError("Save failed — please try again.");
    } finally {
      setSavingOutcome(false);
    }
  }

  const runNextStepAction = () => {
    if (nextStep.action === "add_phone") setAddingPhone(true);
    if (nextStep.action === "scroll_tasks") { setContactTab("tasks"); tasksPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
    if (nextStep.action === "scroll_notes") { setContactTab("notes"); setTimeout(() => noteTextareaRef.current?.focus(), 300); }
  };

  const focusTab = (tab: ContactTab) => {
    setContactTab(tab);
    workspacePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const TABS: Array<{ id: ContactTab; label: string }> = [
    { id: "timeline", label: "Timeline" },
    { id: "script", label: "Script" },
    { id: "checklist", label: "Checklist" },
    { id: "email", label: "Email" },
    { id: "sms", label: "SMS" },
    { id: "notes", label: "Notes" },
    { id: "tasks", label: "Tasks" },
  ];

  return (
    <>
      <CRMPageShell innerClassName={crm.pageInnerContact}>
        <div className="flex flex-col gap-0 min-h-0">

          {/* ── Back nav ────────────────────────────────────────────────────── */}
          <ContactContextBar
            returnTo={returnTo}
            queueMember={queueMember}
            campaignName={campaignName}
            onBack={handleBack}
          />

          {/* ── Archived banner ─────────────────────────────────────────────── */}
          {isArchived && (
            <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-crm-warning/40 bg-crm-warning/8 px-4 py-2.5">
              <p className="text-sm text-crm-warning">This contact is archived — read only.</p>
              {isAdmin && (
                <button
                  type="button"
                  onClick={handleRestoreContact}
                  disabled={restorePosting}
                  className={cn(crm.btnSecondary, "text-xs py-1")}
                >
                  {restorePosting ? "Restoring…" : "Restore"}
                </button>
              )}
            </div>
          )}

          {/* ── Compact contact header ───────────────────────────────────────── */}
          <div className="relative border-b border-crm-border/50 pb-3 pt-1.5">
            <div className="flex items-start gap-3.5">
              {/* Avatar */}
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white shadow-sm"
                style={{ background: `linear-gradient(135deg, ${stageColor(stage)}, #6366f1)` }}
              >
                {initials(contact.displayName)}
              </div>

              {/* Name + contact details */}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h1 className="text-lg font-bold tracking-tight text-crm-text sm:text-xl">
                    {contact.displayName}
                  </h1>
                  <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide"
                    style={{ background: stageColor(stage) + "22", color: stageColor(stage) }}
                  >
                    {stageLabel(stage)}
                  </span>
                  {contact.doNotCall && (
                    <span className="rounded-full border border-crm-danger/40 bg-crm-danger/10 px-2 py-0.5 text-xs font-bold text-crm-danger">DNC</span>
                  )}
                  {contact.doNotSms && (
                    <span className="rounded-full border border-crm-warning/40 bg-crm-warning/10 px-2 py-0.5 text-xs font-bold text-crm-warning">No SMS</span>
                  )}
                  {isArchived && (
                    <span className="rounded-full border border-crm-border bg-crm-surface-2 px-2 py-0.5 text-xs font-medium text-crm-muted">Archived</span>
                  )}
                </div>

                {(contact.company || contact.title) && (
                  <p className="mt-0.5 text-sm text-crm-muted">
                    {[contact.title, contact.company].filter(Boolean).join(" · ")}
                  </p>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  {primaryEmail && (
                    <span className="flex items-center gap-1.5 text-crm-muted">
                      <Mail className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate max-w-[200px]">{primaryEmail}</span>
                    </span>
                  )}
                  {primaryPhone && (
                    <span className="flex items-center gap-1.5 tabular-nums text-crm-muted">
                      <Phone className="h-3.5 w-3.5 shrink-0" />
                      {primaryPhone}
                    </span>
                  )}
                </div>

                {/* Meta row — separator-joined */}
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-crm-muted">
                  <span className={cn(
                    "font-semibold",
                    leadScore >= 70 ? "text-emerald-500" : leadScore >= 45 ? "text-amber-500" : "text-crm-muted"
                  )}>
                    {leadScore} {leadScoreLabel}
                  </span>
                  <span className="select-none text-crm-border">·</span>
                  <span>{lastTouch}</span>
                  <span className="select-none text-crm-border">·</span>
                  <span className="flex items-center gap-1"><User className="h-3 w-3 shrink-0" />{owner}</span>
                  {campaignName && (
                    <>
                      <span className="select-none text-crm-border">·</span>
                      <span>{campaignName}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Right side: Actions + overflow */}
              <div className="flex shrink-0 items-center gap-2" data-actions-dropdown>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setActionsOpen((v) => !v)}
                    className={cn(crm.btnSecondary, "gap-1.5")}
                  >
                    Actions
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  {actionsOpen && (
                    <div className="absolute right-0 top-full z-50 mt-1.5 w-48 overflow-hidden rounded-xl border border-crm-border bg-crm-surface shadow-[0_8px_32px_-8px_rgba(0,0,0,0.5)]">
                      {!isArchived && (
                        <>
                          <button
                            type="button"
                            onClick={() => { setActionsOpen(false); setEditing(true); }}
                            className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-crm-text hover:bg-crm-surface-2/60"
                          >
                            Edit Contact
                          </button>
                          <button
                            type="button"
                            onClick={() => { setActionsOpen(false); setComposeOpen(true); }}
                            disabled={!primaryEmailRow}
                            className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-crm-text hover:bg-crm-surface-2/60 disabled:opacity-40"
                          >
                            Send Email
                          </button>
                          {canLiveWorkspace && (
                            <Link
                              href={workspaceHref}
                              onClick={() => setActionsOpen(false)}
                              className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-crm-text hover:bg-crm-surface-2/60"
                            >
                              Open Live Workspace
                            </Link>
                          )}
                          <div className="mx-3 my-1 border-t border-crm-border/60" />
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => { setActionsOpen(false); void handleArchiveContact(); }}
                              disabled={archivePosting}
                              className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-crm-danger hover:bg-crm-danger/8"
                            >
                              {archivePosting ? "Archiving…" : "Archive Contact"}
                            </button>
                          )}
                        </>
                      )}
                      {isArchived && isAdmin && (
                        <button
                          type="button"
                          onClick={() => { setActionsOpen(false); void handleRestoreContact(); }}
                          disabled={restorePosting}
                          className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-crm-text hover:bg-crm-surface-2/60"
                        >
                          {restorePosting ? "Restoring…" : "Restore Contact"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <button type="button" className={cn(crm.btnGhost, "px-2 py-2")}>
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </div>
            </div>

            {sipNotice && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-crm-warning/35 bg-crm-warning/8 px-3 py-2 text-xs text-crm-warning">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {sipNotice}
              </div>
            )}
          </div>

          {/* ── Edit contact modal ───────────────────────────────────────────── */}
          {editing && !isArchived && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
              onClick={(e) => { if (e.target === e.currentTarget) setEditing(false); }}
            >
              <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-crm-border bg-crm-surface shadow-[0_24px_64px_-16px_rgba(0,0,0,0.6)]">
                <div className="flex items-center justify-between border-b border-crm-border/60 px-6 py-4">
                  <h3 className="text-base font-bold text-crm-text">Edit Contact</h3>
                  <button type="button" onClick={() => setEditing(false)} className="text-crm-muted hover:text-crm-text">✕</button>
                </div>
                <div className="p-6">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
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
                    <div className="col-span-2">
                      <label style={labelStyle}>Stage</label>
                      <select value={editStage} onChange={(e) => setEditStage(e.target.value as CrmStage)} style={inputStyle}>
                        {STAGE_OPTIONS.map((s) => (<option key={s.value} value={s.value}>{s.label}</option>))}
                      </select>
                    </div>
                    <div className="col-span-2 flex gap-6">
                      <label className="flex items-center gap-2 cursor-pointer text-sm">
                        <input type="checkbox" checked={editDoNotCall} onChange={(e) => setEditDoNotCall(e.target.checked)} />
                        Do Not Call
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer text-sm">
                        <input type="checkbox" checked={editDoNotSms} onChange={(e) => setEditDoNotSms(e.target.checked)} />
                        Do Not SMS
                      </label>
                    </div>
                    <div className="col-span-2">
                      <label style={labelStyle}>Notes</label>
                      <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }} placeholder="Scratch notes…" />
                    </div>
                  </div>
                  {saveError && <p className="mt-2 text-sm text-crm-danger">{saveError}</p>}
                </div>
                <div className="flex justify-end gap-2 border-t border-crm-border/60 px-6 py-4">
                  <button type="button" onClick={() => setEditing(false)} disabled={saving} className={crm.btnSecondary}>Cancel</button>
                  <button type="button" onClick={() => void handleSave()} disabled={saving} className={crm.btnPrimary}>
                    {saving ? "Saving…" : "Save Changes"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Horizontal tab navigation — pill segmented control ───────────── */}
          <div className="mt-3 overflow-x-auto pb-0.5">
            <div className="inline-flex items-center gap-0.5 rounded-xl bg-crm-surface-2/70 p-1 shadow-[inset_0_1px_3px_rgba(0,0,0,0.08)]">
              {TABS.map(({ id: tabId, label }) => (
                <button
                  key={tabId}
                  type="button"
                  onClick={() => focusTab(tabId)}
                  className={cn(
                    "whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all duration-150",
                    contactTab === tabId
                      ? "bg-crm-surface text-crm-text shadow-sm ring-1 ring-crm-border/30"
                      : "text-crm-muted hover:text-crm-text",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Main 3-column body ───────────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-4 pt-4 lg:grid-cols-[210px_1fr] xl:grid-cols-[210px_1fr_288px] xl:items-start">

            {/* ── LEFT COLUMN — Communication launcher ─────────────────────── */}
            <div className="order-3 flex flex-col gap-3 lg:order-1">

              {/* Communicate section */}
              <div className="overflow-hidden rounded-xl border border-crm-border/60 bg-crm-surface">
                <p className="px-4 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-crm-muted/70">Communicate</p>
                <div className="flex flex-col pb-1">
                  <CommAction
                    icon={<Phone className="h-4 w-4" />}
                    iconBg="bg-emerald-500/10 text-emerald-500"
                    label="Call"
                    onClick={() => void handleCall()}
                    disabled={!primaryPhone || isArchived}
                  />
                  <CommAction
                    icon={<MessageSquareDot className="h-4 w-4" />}
                    iconBg="bg-sky-500/10 text-sky-400"
                    label="SMS"
                    onClick={() => focusTab("sms")}
                    disabled={isArchived || contact.doNotSms || contact.phones.length === 0}
                    active={contactTab === "sms"}
                  />
                  <CommAction
                    icon={
                      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
                        <path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.37 5.07L2 22l5.08-1.34A9.93 9.93 0 0 0 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2Zm5.07 14.14c-.22.61-1.27 1.17-1.74 1.22-.46.05-1 .07-1.62-.1-.37-.1-.85-.24-1.47-.5-2.59-1.12-4.28-3.73-4.41-3.9-.13-.18-1.07-1.43-1.07-2.72 0-1.3.68-1.94 .92-2.21.24-.26.52-.33.7-.33.17 0 .35 0 .5.01.16.01.38-.06.6.46.22.52.74 1.8.81 1.93.07.14.11.3.02.48-.09.18-.13.3-.26.46l-.38.44c-.13.13-.26.27-.11.53.15.26.66 1.09 1.42 1.77.98.88 1.8 1.15 2.06 1.28.26.13.41.11.56-.07.15-.18.64-.74.81-1 .17-.26.34-.22.58-.13.24.09 1.52.72 1.78.85.26.13.43.2.5.31.07.11.07.64-.15 1.25Z" />
                      </svg>
                    }
                    iconBg="bg-green-500/10 text-green-500"
                    label="WhatsApp"
                    disabled
                    disabledHint="Not enabled"
                  />
                  <CommAction
                    icon={<Mail className="h-4 w-4" />}
                    iconBg="bg-violet-500/10 text-violet-400"
                    label="Email"
                    onClick={() => setComposeOpen(true)}
                    disabled={isArchived || !primaryEmailRow}
                  />
                  <CommAction
                    icon={<Calendar className="h-4 w-4" />}
                    iconBg="bg-amber-500/10 text-amber-400"
                    label="Add Task"
                    onClick={() => { setAddingTask(true); focusTab("tasks"); }}
                    disabled={isArchived}
                  />
                  <CommAction
                    icon={<MessageSquare className="h-4 w-4" />}
                    iconBg="bg-crm-accent/10 text-crm-accent"
                    label="Add Note"
                    onClick={() => { focusTab("notes"); setTimeout(() => noteTextareaRef.current?.focus(), 100); }}
                    disabled={isArchived}
                    active={contactTab === "notes"}
                  />
                </div>
              </div>

              {/* Quick Disposition — keyboard-chip style */}
              {!isArchived && (
                <div className="overflow-hidden rounded-xl border border-crm-border/60 bg-crm-surface">
                  <div className="flex items-center justify-between px-4 pt-3 pb-2">
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-crm-muted/70">Disposition</p>
                    {disposition && (
                      <button
                        type="button"
                        onClick={() => setDisposition("")}
                        className="text-[10px] text-crm-muted hover:text-crm-text"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1 px-3 pb-3">
                    {DISPOSITION_OPTIONS.map((d, i) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setDisposition(d === disposition ? "" : d)}
                        className={cn(
                          "flex items-center gap-1.5 rounded-lg border px-2 py-2 text-left text-xs font-medium transition-all duration-100",
                          disposition === d
                            ? "border-crm-accent/70 bg-crm-accent/10 text-crm-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                            : "border-crm-border/60 text-crm-muted hover:border-crm-border hover:text-crm-text",
                        )}
                      >
                        <span className={cn(
                          "flex h-4 min-w-[1rem] items-center justify-center rounded text-[9px] font-bold tabular-nums",
                          disposition === d
                            ? "bg-crm-accent/20 text-crm-accent"
                            : "bg-crm-surface-2 text-crm-muted/60",
                        )}>
                          {i + 1}
                        </span>
                        <span className="truncate leading-tight">{d}</span>
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-crm-border/40 px-3 py-3">
                    <input
                      value={outcomeNote}
                      onChange={(e) => setOutcomeNote(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && disposition && !savingOutcome) void saveOutcomeRef.current(); }}
                      placeholder="Outcome note…"
                      className={crm.input}
                    />
                    <button
                      type="button"
                      onClick={() => void saveOutcomeRef.current()}
                      disabled={!disposition || savingOutcome || disabledOutcome()}
                      className={cn(crm.btnPrimary, "mt-2 w-full justify-between")}
                    >
                      <span>{savingOutcome ? "Saving…" : "Save"}</span>
                      <kbd className="rounded border border-white/25 bg-white/10 px-1.5 py-0.5 text-[10px] font-mono">↵</kbd>
                    </button>
                    {outcomeSaved && (
                      <p className="mt-1.5 flex items-center gap-1 text-xs text-crm-success"><CheckCheck className="h-3 w-3" /> Saved</p>
                    )}
                    {outcomeError && <p className="mt-1 text-xs text-crm-danger">{outcomeError}</p>}
                  </div>
                </div>
              )}
            </div>

            {/* ── CENTER COLUMN — Tab content ──────────────────────────────── */}
            <div className="order-1 flex min-w-0 flex-col gap-4 lg:order-2" ref={workspacePanelRef}>

              {/* Timeline tab */}
              {contactTab === "timeline" && (
                <ContactTimeline
                  events={timeline}
                  loading={timelineLoading}
                  currentUserId={appUser?.id}
                  editingNoteLinkedId={editingNoteLinkedId}
                  editingNoteText={editingNoteText}
                  allowNoteMutations={!isArchived}
                  onEditNote={handleEditNote}
                  onDeleteNote={handleDeleteNote}
                  isArchived={isArchived}
                  onStartOutreach={() => { focusTab("notes"); setTimeout(() => noteTextareaRef.current?.focus(), 300); }}
                />
              )}

              {/* Script tab */}
              {contactTab === "script" && (
                <LiveWorkspaceScriptPanel
                  scriptSummaries={scriptSummaries}
                  defaultScriptId={null}
                />
              )}

              {/* Checklist tab */}
              {contactTab === "checklist" && (
                <LiveWorkspaceChecklistPanel
                  checklists={checklists}
                  contactId={contact.id}
                  linkedId={null}
                  defaultChecklistId={null}
                  onSaved={() => void loadTimeline()}
                />
              )}

              {/* SMS tab */}
              {contactTab === "sms" && (
                <div className="overflow-hidden rounded-xl border border-crm-border/70 bg-crm-surface shadow-crm">
                  <div className="border-b border-crm-border/60 px-4 py-3">
                    <h3 className="text-sm font-semibold text-crm-text">SMS Thread</h3>
                  </div>
                  <ContactSmsPanel
                    ref={smsPanelRef}
                    phones={contact.phones}
                    smsEvents={smsEvents}
                    timelineLoading={timelineLoading}
                    isArchived={isArchived}
                    doNotSms={contact.doNotSms}
                    smsPhone={smsPhone}
                    setSmsPhone={setSmsPhone}
                    smsMessage={smsMessage}
                    setSmsMessage={setSmsMessage}
                    smsSending={smsSending}
                    smsError={smsError}
                    smsSuccess={smsSuccess}
                    onSend={handleSendSms}
                  />
                </div>
              )}

              {/* Email tab */}
              {contactTab === "email" && (
                <div className="overflow-hidden rounded-xl border border-crm-border/70 bg-crm-surface shadow-crm">
                  <div className="border-b border-crm-border/60 px-4 py-3">
                    <h3 className="text-sm font-semibold text-crm-text">Email</h3>
                  </div>
                  <div className="p-6 text-center">
                    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-violet-500/12 text-violet-400">
                      <Mail className="h-5 w-5" />
                    </div>
                    <p className="text-sm font-medium text-crm-text">Compose an email to {contact.displayName}</p>
                    <p className="mt-1 text-xs text-crm-muted">Sent emails are recorded in the timeline automatically.</p>
                    <button
                      type="button"
                      onClick={() => setComposeOpen(true)}
                      disabled={!primaryEmailRow || isArchived}
                      className={cn(crm.btnPrimary, "mt-4")}
                    >
                      <Mail className="h-4 w-4" />
                      Compose Email
                    </button>
                    {!primaryEmailRow && (
                      <p className="mt-2 text-xs text-crm-warning">No email address on file — add one via Actions → Edit Contact.</p>
                    )}
                  </div>
                </div>
              )}

              {/* Notes tab */}
              {contactTab === "notes" && (
                <div className="flex flex-col gap-4">
                  <div ref={noteComposerRef} className="overflow-hidden rounded-xl border border-crm-border/70 bg-crm-surface shadow-crm">
                    <div className="border-b border-crm-border/60 px-4 py-3">
                      <h3 className="text-sm font-semibold text-crm-text">Add Note</h3>
                    </div>
                    <div className="p-4">
                      <LiveWorkspaceNotePanel
                        ref={noteTextareaRef}
                        noteBody={noteText}
                        setNoteBody={setNoteText}
                        savingNote={notePosting}
                        noteSavedAt={noteSavedAt}
                        onSave={handlePostNote}
                        disabled={isArchived}
                      />
                      {noteError && <p className="mt-1 text-xs text-crm-danger">{noteError}</p>}
                    </div>
                  </div>
                  {/* Scratch notes */}
                  {contact.notes && (
                    <div className="overflow-hidden rounded-xl border border-crm-border/70 bg-crm-surface shadow-crm">
                      <div className="border-b border-crm-border/60 px-4 py-3">
                        <h3 className="text-sm font-semibold text-crm-text">Scratch Notes</h3>
                      </div>
                      <div className="p-4">
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-crm-text">{contact.notes}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tasks tab */}
              {contactTab === "tasks" && (
                <div ref={tasksPanelRef} className="overflow-hidden rounded-xl border border-crm-border/70 bg-crm-surface shadow-crm">
                  <div className="flex items-center justify-between border-b border-crm-border/60 px-4 py-3">
                    <h3 className="text-sm font-semibold text-crm-text">
                      Open Tasks
                      {tasks.length > 0 && <span className="ml-2 rounded-full border border-crm-border bg-crm-surface-2 px-2 py-0.5 text-[11px] font-medium text-crm-muted">{tasks.length}</span>}
                    </h3>
                    {!isArchived && (
                      <button
                        type="button"
                        onClick={() => setAddingTask((v) => !v)}
                        className={cn(crm.btnGhost, "text-xs py-1 px-2")}
                      >
                        <Plus className="h-3.5 w-3.5" /> Add
                      </button>
                    )}
                  </div>
                  <div className="p-4">
                    {/* Add task form */}
                    {!isArchived && addingTask && (
                      <div className="mb-4 flex flex-col gap-2 rounded-xl border border-crm-border/70 bg-crm-surface-2/40 p-3">
                        <input
                          value={newTaskTitle}
                          onChange={(e) => setNewTaskTitle(e.target.value)}
                          placeholder="Follow-up title…"
                          autoFocus
                          onKeyDown={(e) => { if (e.key === "Enter") void handleCreateTask(); if (e.key === "Escape") setAddingTask(false); }}
                          className={crm.input}
                        />
                        <div className="flex flex-wrap gap-1.5">
                          {[{ label: "Today", days: 0 }, { label: "Tomorrow", days: 1 }, { label: "Next week", days: 7 }].map(({ label, days }) => {
                            const d = new Date();
                            d.setDate(d.getDate() + days);
                            const val = d.toISOString().slice(0, 10);
                            return (
                              <button
                                key={label}
                                type="button"
                                onClick={() => setNewTaskDueAt(val)}
                                className={cn(
                                  "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                                  newTaskDueAt === val
                                    ? "border-crm-accent bg-crm-accent/15 text-crm-accent"
                                    : "border-crm-border text-crm-muted hover:border-crm-accent/40"
                                )}
                              >
                                <Calendar className="mr-1 inline h-2.5 w-2.5" />{label}
                              </button>
                            );
                          })}
                          <input
                            type="date"
                            value={newTaskDueAt}
                            onChange={(e) => setNewTaskDueAt(e.target.value)}
                            className={cn(crm.input, "w-auto py-0.5 text-xs")}
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void handleCreateTask()}
                            disabled={newTaskPosting || !newTaskTitle.trim()}
                            className={crm.btnPrimary}
                          >
                            {newTaskPosting ? "…" : "Add Task"}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setAddingTask(false); setNewTaskDueAt(""); setNewTaskTitle(""); }}
                            className={crm.btnSecondary}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {tasksLoading ? (
                      <LoadingSkeleton rows={2} />
                    ) : tasks.length === 0 && !addingTask ? (
                      <p className="text-sm text-crm-muted">No open tasks.</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {tasks.map((task) => {
                          const isDue = task.dueAt && new Date(task.dueAt) < new Date();
                          return (
                            <div key={task.id} className="flex items-center gap-3 rounded-xl border border-crm-border/60 bg-crm-surface-2/30 px-3 py-2.5 transition-colors hover:bg-crm-surface-2/50">
                              {!isArchived ? (
                                <button
                                  type="button"
                                  onClick={() => void handleCompleteTask(task.id)}
                                  title="Mark done"
                                  className="shrink-0 text-crm-muted hover:text-crm-success"
                                >
                                  <Circle className="h-4 w-4" />
                                </button>
                              ) : <span className="w-4 shrink-0" />}
                              <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-sm text-crm-text">{task.title}</span>
                                <div className="mt-0.5 flex items-center gap-2">
                                  <span style={{ fontSize: "0.7rem", fontWeight: 700, padding: "0.1rem 0.35rem", borderRadius: "0.2rem", background: TASK_PRIORITY_COLOR[task.priority] + "22", color: TASK_PRIORITY_COLOR[task.priority], textTransform: "uppercase" }}>
                                    {task.priority}
                                  </span>
                                  {task.dueAt && (
                                    <span className={cn("flex items-center gap-1 text-xs", isDue ? "text-crm-danger" : "text-crm-muted")}>
                                      <Clock className="h-2.5 w-2.5" />
                                      {(() => {
                                        const d = new Date(task.dueAt as any);
                                        return isNaN(d.getTime()) ? String(task.dueAt).slice(0, 10) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                                      })()}
                                      {isDue && " · overdue"}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

            </div>

            {/* ── RIGHT COLUMN — Intelligence rail ────────────────────────── */}
            <div className="order-2 flex flex-col gap-3 xl:order-3 xl:sticky xl:top-20 xl:self-start">

              {/* ── Card 1: Relationship Health + Next Best Action (merged) ── */}
              <div className="overflow-hidden rounded-xl border border-crm-border/50 bg-crm-surface">
                {/* Health ring + metrics */}
                <div className="px-4 pt-3 pb-1">
                  <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.18em] text-crm-muted/70">Relationship Health</p>
                  <CRMRingMetric
                    value={leadScore}
                    max={100}
                    label={`${leadScore} ${leadScoreLabel}`}
                    sublabel={`Last 30 days · ${thirtyDayActivityCount} interactions`}
                    color={leadScore >= 70 ? "#22c55e" : leadScore >= 45 ? "#f59e0b" : "var(--crm-muted)"}
                    size={72}
                    stroke={6}
                  />
                  <div className="mt-3 flex flex-col gap-0.5">
                    <RailMetricRow label="Engagement" value={engagementLabel} positive={engagementLabel === "High"} />
                    <RailMetricRow label="Responsiveness" value={responsivenessLabel} positive={responsivenessLabel === "Very Good" || responsivenessLabel === "Good"} />
                    <RailMetricRow
                      label="Trend"
                      value={trendLabel}
                      positive={trendLabel === "Improving"}
                      icon={trendLabel === "Improving" ? <TrendingUp className="h-3 w-3" /> : undefined}
                    />
                  </div>
                </div>
                {/* Divider */}
                <div className="mx-4 my-2.5 border-t border-crm-border/40" />
                {/* Next Best Action */}
                <div className="flex items-start justify-between gap-2 px-4 pb-4">
                  <div className="min-w-0 flex-1">
                    <p className="mb-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-crm-accent/70">Next Action</p>
                    <p className="text-sm font-semibold text-crm-text">{nextStep.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-crm-muted">{nextStep.detail}</p>
                  </div>
                  {nextStep.action !== "none" && (
                    <button
                      type="button"
                      onClick={runNextStepAction}
                      className="mt-4 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-crm-accent/30 bg-crm-accent/8 text-crm-accent transition-colors hover:bg-crm-accent/15"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* ── Card 2: Open Tasks ── */}
              <div className="overflow-hidden rounded-xl border border-crm-border/50 bg-crm-surface">
                <div className="flex items-center justify-between px-4 pt-3 pb-1">
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-crm-muted/70">
                    Tasks{tasks.length > 0 && <span className="ml-1.5 font-normal text-crm-accent">{tasks.length}</span>}
                  </p>
                  {!isArchived && (
                    <button
                      type="button"
                      onClick={() => { setAddingTask(true); focusTab("tasks"); }}
                      className="flex items-center gap-1 text-xs font-medium text-crm-accent transition-colors hover:opacity-80"
                    >
                      <Plus className="h-3 w-3" /> Add
                    </button>
                  )}
                </div>
                <div className="px-3 pb-3 pt-1">
                  {tasksLoading ? (
                    <LoadingSkeleton rows={2} />
                  ) : tasks.length === 0 ? (
                    <p className="px-1 text-xs text-crm-muted">No open tasks.</p>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {tasks.slice(0, 4).map((task) => {
                        const isDue = task.dueAt && new Date(task.dueAt) < new Date();
                        return (
                          <div key={task.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-crm-surface-2/50">
                            {!isArchived ? (
                              <button
                                type="button"
                                onClick={() => void handleCompleteTask(task.id)}
                                className="h-3.5 w-3.5 shrink-0 rounded-sm border border-crm-border/80 transition-colors hover:border-crm-success hover:bg-crm-success/10"
                              />
                            ) : <span className="h-3.5 w-3.5 shrink-0" />}
                            <span className="flex-1 truncate text-xs text-crm-text">{task.title}</span>
                            {task.dueAt && (
                              <span className={cn("shrink-0 text-[10px]", isDue ? "font-medium text-crm-danger" : "text-crm-muted/70")}>
                                {(() => {
                                  const d = new Date(task.dueAt as any);
                                  return isNaN(d.getTime()) ? String(task.dueAt).slice(0, 10) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                                })()}
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {tasks.length > 4 && (
                        <button
                          type="button"
                          onClick={() => focusTab("tasks")}
                          className="mt-0.5 px-2 text-xs font-medium text-crm-accent hover:opacity-80"
                        >
                          +{tasks.length - 4} more
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* ── Card 3: Contact Info + Tags (merged) ── */}
              <div className="overflow-hidden rounded-xl border border-crm-border/50 bg-crm-surface">
                {/* Contact Info */}
                <div className="flex items-center justify-between px-4 pt-3 pb-1">
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-crm-muted/70">Contact</p>
                  {!isArchived && (
                    <button
                      type="button"
                      onClick={() => setEditing(true)}
                      className="text-xs font-medium text-crm-accent hover:opacity-80"
                    >
                      Edit
                    </button>
                  )}
                </div>
                <div className="flex flex-col pt-1">
                  {contact.emails.length === 0 && contact.phones.length === 0 ? (
                    <p className="px-4 pb-2 text-xs text-crm-muted">No contact info on file.</p>
                  ) : null}
                  {contact.emails.map((e) => (
                    <div key={e.id} className="group flex items-center gap-2.5 px-4 py-2 transition-colors hover:bg-crm-surface-2/30">
                      <Mail className="h-3.5 w-3.5 shrink-0 text-crm-muted/60" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-crm-text">{e.email}</div>
                        <div className="text-[10px] capitalize text-crm-muted/60">{e.type.toLowerCase()}{e.isPrimary ? " · Primary" : ""}</div>
                      </div>
                      {!isArchived && (
                        <button
                          type="button"
                          onClick={() => void handleRemoveEmail(e.id)}
                          className="shrink-0 text-crm-muted/40 opacity-0 transition-opacity group-hover:opacity-100 hover:text-crm-danger"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                  {!isArchived && !addingEmail && (
                    <button
                      type="button"
                      onClick={() => setAddingEmail(true)}
                      className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-crm-accent/80 transition-colors hover:text-crm-accent"
                    >
                      <Plus className="h-3 w-3" /> Add email
                    </button>
                  )}
                  {!isArchived && addingEmail && (
                    <div className="flex flex-col gap-2 px-3 py-2">
                      <div className="flex gap-2">
                        <input autoFocus type="email" value={newEmailAddress} onChange={(e) => setNewEmailAddress(e.target.value)} placeholder="Email address" onKeyDown={(e) => { if (e.key === "Enter") void handleAddEmail(); if (e.key === "Escape") { setAddingEmail(false); setNewEmailAddress(""); } }} style={{ ...inputStyle, flex: 1, fontSize: "0.8125rem" }} />
                        <select value={newEmailType} onChange={(e) => setNewEmailType(e.target.value as typeof newEmailType)} style={{ ...inputStyle, width: "auto", fontSize: "0.8125rem" }}>
                          <option value="WORK">Work</option>
                          <option value="PERSONAL">Personal</option>
                          <option value="OTHER">Other</option>
                        </select>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => void handleAddEmail()} disabled={newEmailPosting || !newEmailAddress.trim()} style={{ padding: "0.3rem 0.625rem", borderRadius: "0.3rem", border: "none", cursor: "pointer", background: "var(--accent)", color: "#fff", fontSize: "0.75rem", fontWeight: 600 }}>
                          {newEmailPosting ? "…" : "Add"}
                        </button>
                        <button onClick={() => { setAddingEmail(false); setNewEmailAddress(""); }} style={{ padding: "0.3rem 0.625rem", borderRadius: "0.3rem", border: "1px solid var(--border)", cursor: "pointer", background: "var(--surface-hover)", color: "var(--text-dim)", fontSize: "0.75rem" }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {contact.phones.map((p) => (
                    <div key={p.id} className="group flex items-center gap-2.5 px-4 py-2 transition-colors hover:bg-crm-surface-2/30">
                      <Phone className="h-3.5 w-3.5 shrink-0 text-crm-muted/60" />
                      <div className="min-w-0 flex-1">
                        <div className="tabular-nums text-xs font-medium text-crm-text">{p.numberRaw}</div>
                        <div className="text-[10px] capitalize text-crm-muted/60">{p.type.toLowerCase()}{p.isPrimary ? " · Primary" : ""}</div>
                      </div>
                      {!isArchived && (
                        <button
                          type="button"
                          onClick={() => void handleRemovePhone(p.id)}
                          className="shrink-0 text-crm-muted/40 opacity-0 transition-opacity group-hover:opacity-100 hover:text-crm-danger"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                  {!isArchived && !addingPhone && (
                    <button
                      type="button"
                      onClick={() => setAddingPhone(true)}
                      className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-crm-accent/80 transition-colors hover:text-crm-accent"
                    >
                      <Plus className="h-3 w-3" /> Add phone
                    </button>
                  )}
                  {!isArchived && addingPhone && (
                    <div className="flex flex-col gap-2 px-3 py-2">
                      <div className="flex gap-2">
                        <input autoFocus value={newPhoneRaw} onChange={(e) => setNewPhoneRaw(e.target.value)} placeholder="Phone number" onKeyDown={(e) => { if (e.key === "Enter") void handleAddPhone(); if (e.key === "Escape") { setAddingPhone(false); setNewPhoneRaw(""); } }} style={{ ...inputStyle, flex: 1, fontSize: "0.8125rem" }} />
                        <select value={newPhoneType} onChange={(e) => setNewPhoneType(e.target.value as typeof newPhoneType)} style={{ ...inputStyle, width: "auto", fontSize: "0.8125rem" }}>
                          <option value="MOBILE">Mobile</option>
                          <option value="OFFICE">Office</option>
                          <option value="HOME">Home</option>
                          <option value="OTHER">Other</option>
                        </select>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => void handleAddPhone()} disabled={newPhonePosting || !newPhoneRaw.trim()} style={{ padding: "0.3rem 0.625rem", borderRadius: "0.3rem", border: "none", cursor: "pointer", background: "var(--accent)", color: "#fff", fontSize: "0.75rem", fontWeight: 600 }}>
                          {newPhonePosting ? "…" : "Add"}
                        </button>
                        <button onClick={() => { setAddingPhone(false); setNewPhoneRaw(""); }} style={{ padding: "0.3rem 0.625rem", borderRadius: "0.3rem", border: "1px solid var(--border)", cursor: "pointer", background: "var(--surface-hover)", color: "var(--text-dim)", fontSize: "0.75rem" }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Tags (merged into same card with divider) */}
                {(contact.tags ?? []).length > 0 && (
                  <>
                    <div className="mx-4 my-1 border-t border-crm-border/40" />
                    <div className="flex flex-wrap gap-1 px-4 py-3">
                      {(contact.tags ?? []).map((tag) => (
                        <span
                          key={tag.id}
                          className="rounded-full border border-crm-border/50 bg-crm-surface-2/60 px-2 py-0.5 text-[11px] font-medium text-crm-muted"
                          style={tag.color ? { borderColor: tag.color + "44", color: tag.color, background: tag.color + "0e" } : {}}
                        >
                          {tag.name}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Possible duplicates — shown when detected */}
              {duplicates.length > 0 && !isArchived && (
                <div className="overflow-hidden rounded-xl border border-amber-500/40 bg-amber-500/5 shadow-crm">
                  <div className="flex items-center gap-2 border-b border-amber-500/30 px-4 py-3">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    <p className="text-[11px] font-bold uppercase tracking-wide text-amber-600">Possible Duplicates ({duplicates.length})</p>
                  </div>
                  <div className="flex flex-col divide-y divide-amber-500/20">
                    {duplicates.map((dup) => (
                      <div key={dup.id} className="flex items-center gap-2 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-crm-text">{dup.displayName}</p>
                          <p className="text-[10px] text-crm-muted">{dup.matchReasons.join(", ")}</p>
                        </div>
                        <a href={`/crm/contacts/${dup.id}`} style={{ ...btnSmall, textDecoration: "none", fontSize: "0.7rem" }}>View</a>
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => { setMergeTarget(dup); setMergeError(null); }}
                            className="flex items-center gap-1 rounded border border-amber-400/50 bg-amber-50 px-2 py-0.5 text-[0.7rem] font-medium text-amber-700 hover:bg-amber-100"
                          >
                            <GitMerge className="h-2.5 w-2.5" /> Merge
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </CRMPageShell>

      {/* ── Merge confirmation modal ──────────────────────────────────────────── */}
      {mergeTarget && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setMergeTarget(null); }}
        >
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-crm-border bg-crm-surface shadow-[0_24px_64px_-16px_rgba(0,0,0,0.6)]">
            <div className="flex items-center gap-2 border-b border-crm-border/60 px-6 py-4">
              <GitMerge className="h-4 w-4 text-violet-400" />
              <h3 className="text-base font-bold text-crm-text">Merge Contact</h3>
            </div>
            <div className="p-6">
              <p className="text-sm text-crm-text">
                Merge <strong>{mergeTarget.displayName}</strong> into <strong>{contact?.displayName}</strong>?
              </p>
              <div className="mt-3 rounded-xl border border-amber-400/40 bg-amber-500/8 p-3">
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  <strong>This cannot be undone.</strong> All activity, tasks, notes, and campaign memberships from <em>{mergeTarget.displayName}</em> will be moved here. <em>{mergeTarget.displayName}</em> will be archived.
                </p>
              </div>
              {mergeError && <p className="mt-3 text-sm text-crm-danger">{mergeError}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-crm-border/60 px-6 py-4">
              <button
                type="button"
                onClick={() => { setMergeTarget(null); setMergeError(null); }}
                disabled={merging}
                className={crm.btnSecondary}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleMerge(mergeTarget.id)}
                disabled={merging}
                className={cn(crm.btnPrimary, "bg-violet-600 hover:brightness-110")}
              >
                {merging ? "Merging…" : "Confirm Merge"}
              </button>
            </div>
          </div>
        </div>
      )}

      <LiveWrapUpBar
        visible={Boolean(contact)}
        canSave={Boolean(disposition) && !savingOutcome && !isArchived}
        saving={savingOutcome}
        isPowerMode={false}
        onSave={() => void saveOutcomeRef.current()}
      />

      {contact && (
        <CrmEmailComposeDrawer
          open={composeOpen}
          onClose={() => setComposeOpen(false)}
          contactId={contact.id}
          contactName={contact.displayName}
          contactEmail={(contact.emails.find((e) => e.isPrimary) ?? contact.emails[0])?.email ?? null}
          mergeFields={{
            firstName: contact.firstName ?? null,
            lastName: contact.lastName ?? null,
            displayName: contact.displayName,
            company: contact.company ?? null,
            email: (contact.emails.find((e) => e.isPrimary) ?? contact.emails[0])?.email ?? null,
          }}
          onSent={() => { void loadTimeline(); }}
        />
      )}
    </>
  );
}

// ── Small UI helpers ──────────────────────────────────────────────────────────


function CommAction({
  icon,
  iconBg,
  label,
  onClick,
  disabled,
  disabledHint,
  active,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  disabledHint?: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabledHint}
      className={cn(
        "group relative flex w-full items-center gap-3 py-2.5 pr-4 text-left transition-all duration-150",
        active
          ? "bg-crm-accent/[0.06] pl-[calc(1rem-2px)] border-l-2 border-crm-accent/60"
          : "pl-4",
        disabled
          ? "cursor-not-allowed opacity-40"
          : active
            ? "hover:bg-crm-accent/[0.09]"
            : "hover:bg-crm-surface-2/50 hover:-translate-y-px",
      )}
    >
      <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-transform duration-150", iconBg, !disabled && "group-hover:scale-110")}>
        {icon}
      </span>
      <span className={cn(
        "flex-1 text-sm font-medium transition-colors duration-150",
        active ? "text-crm-accent" : disabled ? "text-crm-muted" : "text-crm-text",
      )}>
        {label}
      </span>
      {!disabled && (
        <ChevronRight className={cn(
          "h-3.5 w-3.5 transition-all duration-150",
          active ? "text-crm-accent/60" : "text-crm-border group-hover:translate-x-0.5 group-hover:text-crm-muted",
        )} />
      )}
    </button>
  );
}

function RailMetricRow({
  label,
  value,
  positive,
  icon,
}: {
  label: string;
  value: string;
  positive?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[11px] text-crm-muted/80">{label}</span>
      <span className={cn(
        "flex items-center gap-1 text-[11px] font-semibold tabular-nums",
        positive ? "text-emerald-500" : "text-crm-muted",
      )}>
        {icon}
        {value}
      </span>
    </div>
  );
}

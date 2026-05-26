"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft, Phone, Mail, Clock, User, MessageSquareDot, Trash2,
  Circle, Plus, CheckCheck, GitMerge, AlertTriangle, Calendar,
  ChevronRight, Headphones, Mic, Pause, Hash, Forward, Radio, PhoneOff, Sparkles,
} from "lucide-react";
import {
  CRMPageShell,
  CRMCard,
  crm,
  ContactContextBar,
  LiveWorkspaceActionBar,
  LiveWorkspaceContactHeader,
  LiveCallStatusBanner,
  LiveWorkspaceScriptPanel,
  LiveWorkspaceChecklistPanel,
  LiveWorkspaceNotePanel,
  LiveWorkspaceOutcomePanel,
  LiveWrapUpBar,
  ContactTimeline,
  ContactSmsPanel,
  ContactRelationshipHealth,
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
import { CrmEmailComposeDrawer } from "../../../../../components/crm/email/CrmEmailComposeDrawer";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { apiGet, apiPatch, apiPost, apiDelete } from "../../../../../services/apiClient";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { useSipPhone } from "../../../../../hooks/useSipPhone";
import type { QueueMember } from "../../../../../components/crm/queue/queueTypes";

// ── Shared form styles (edit panels) ─────────────────────────────────────────

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

  const headerSentinelRef = useRef<HTMLDivElement>(null);
  const [stickyVisible, setStickyVisible] = useState(false);
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

  // Script/checklist workspace state reuses existing CRM live-workspace APIs.
  const [scriptSummaries, setScriptSummaries] = useState<ScriptSummary[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [workspaceTab, setWorkspaceTab] = useState<"live" | "script" | "checklist" | "notes">("live");
  const [communicationTab, setCommunicationTab] = useState<"call" | "sms" | "whatsapp" | "email">("call");
  const workspacePanelRef = useRef<HTMLDivElement>(null);

  // Note composer
  const [noteText, setNoteText] = useState("");
  const [notePosting, setNotePosting] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);
  const noteComposerRef = useRef<HTMLDivElement>(null);
  const smsPanelRef = useRef<HTMLDivElement>(null);
  const tasksPanelRef = useRef<HTMLDivElement>(null);
  const outcomePanelRef = useRef<HTMLDivElement>(null);
  const [noteSavedAt, setNoteSavedAt] = useState<Date | null>(null);

  // Live outcome workflow state (unified with live-call workspace)
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

  // Caller-ID workflow (must be declared before any early return — Rules of Hooks)
  const [callerIdSelected, setCallerIdSelected] = useState<string | null>(null);
  const [callerIdChecked, setCallerIdChecked] = useState(false);
  const [callerIdLoading, setCallerIdLoading] = useState(false);

  // Outcome save ref + keyboard shortcuts — hoisted before any early return
  // so React sees a consistent hook order on every render.
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

  // Draft note autosave keyed by contact id (shared UX with live workspace)
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
    return () => {
      cancelled = true;
    };
  }, [id, urlMemberId]);

  useEffect(() => {
    const cid = urlCampaignId ?? queueMember?.campaign?.id;
    if (!cid) {
      setCampaignName(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ campaign: { name: string } }>(`/crm/campaigns/${cid}`);
        if (!cancelled) setCampaignName(data.campaign?.name ?? null);
      } catch {
        if (!cancelled) setCampaignName(queueMember?.campaign?.name ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [urlCampaignId, queueMember?.campaign?.id, queueMember?.campaign?.name]);

  useEffect(() => {
    const el = headerSentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setStickyVisible(!entry.isIntersecting),
      { root: null, threshold: 0, rootMargin: "-64px 0px 0px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [contact?.id]);

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

  // ── Memos (must come before all early returns — Rules of Hooks) ───────────

  const nextStep = useMemo((): {
    title: string;
    detail: string;
    actionLabel?: string;
    action: "none" | "add_phone" | "scroll_tasks" | "scroll_notes";
  } => {
    if (!contact) return { title: "Loading…", detail: "", action: "none" };
    const archived = !!(contact.archivedAt != null || contact.active === false);
    if (archived) {
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

  const focusWorkspace = (tab: typeof workspaceTab, communication?: typeof communicationTab) => {
    setWorkspaceTab(tab);
    if (communication) setCommunicationTab(communication);
    workspacePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const primaryPhone = primaryPhoneRow?.numberRaw ?? null;
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
        const res = await apiPost<{ callerId: string | null }>(`/crm/calls/originate`, {
          destination: num,
          contactId: id,
        });
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
    if (followUpOption === "today") {
      const d = new Date();
      d.setHours(17, 0, 0, 0);
      followUpAt = d.toISOString();
    } else if (followUpOption === "tomorrow") {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      followUpAt = d.toISOString();
    } else if (followUpOption === "nextweek") {
      const d = new Date();
      const day = d.getDay();
      const daysToMonday = day === 0 ? 1 : 8 - day;
      d.setDate(d.getDate() + daysToMonday);
      d.setHours(9, 0, 0, 0);
      followUpAt = d.toISOString();
    } else if (followUpOption === "custom" && followUpCustom) {
      followUpAt = new Date(followUpCustom).toISOString();
    }

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

  const lastTimelineEvent = timeline[0] ?? null;
  const lastInteractionLabel =
    lastTimelineEvent?.title ?? contact.lastDisposition ?? null;
  const lastInteractionAt =
    lastTimelineEvent?.createdAt ?? contact.lastActivityAt ?? null;

  const weekAgo = Date.now() - 7 * 86400000;
  const recentActivityCount = timeline.filter(
    (e) => new Date(e.createdAt).getTime() >= weekAgo,
  ).length;
  const overdueTasks = tasks.filter(
    (t) => t.dueAt && new Date(t.dueAt) < new Date(),
  ).length;
  const lastComm = timeline.find(
    (e) => e.type.startsWith("CDR_") || e.type.startsWith("SMS_"),
  );
  const daysSinceComm = lastComm
    ? Math.floor((Date.now() - new Date(lastComm.createdAt).getTime()) / 86400000)
    : null;
  const callbackUrgent = queueMember?.callbackAt
    ? new Date(queueMember.callbackAt) < new Date()
    : false;

  const runNextStepAction = () => {
    if (nextStep.action === "add_phone") setAddingPhone(true);
    if (nextStep.action === "scroll_tasks") scrollToTasks();
    if (nextStep.action === "scroll_notes") scrollToNoteComposer();
  };

  return (<>
    <CRMPageShell innerClassName={crm.pageInnerContact}>
      <div className="space-y-4">
        <ContactContextBar
          returnTo={returnTo}
          queueMember={queueMember}
          campaignName={campaignName}
          onBack={handleBack}
        />

        {contact && (
          <>
            <LiveWorkspaceContactHeader
              contact={contact as unknown as LiveContact}
              isArchived={isArchived}
              callerIdChecked={callerIdChecked}
              callerIdSelected={callerIdSelected}
              callerIdLoading={callerIdLoading}
              sipNotice={sipNotice}
              onCall={() => void handleCall()}
              profileHref={`/crm/contacts/${contact.id}`}
              campaignName={campaignName}
              queueLabel={null}
            />
            <div className="flex justify-end gap-2">
              {!isArchived ? (
                <>
                  <button
                    type="button"
                    className={crm.btnPrimary}
                    onClick={() => setComposeOpen(true)}
                    title={primaryEmailRow ? "Send email" : "Add an email address to send"}
                  >
                    <Mail className="h-4 w-4" />
                    Send Email
                  </button>
                  <button type="button" className={crm.btnSecondary} onClick={() => setEditing(true)}>
                    Edit contact
                  </button>
                  <button
                    type="button"
                    className={crm.btnSecondary}
                    onClick={handleArchiveContact}
                    disabled={archivePosting}
                    title="Archive contact"
                  >
                    {archivePosting ? "Archiving…" : "Archive"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={crm.btnSecondary}
                  onClick={handleRestoreContact}
                  disabled={restorePosting}
                  title="Restore contact"
                >
                  {restorePosting ? "Restoring…" : "Restore"}
                </button>
              )}
            </div>
          </>
        )}

        <div ref={headerSentinelRef} className="h-px w-full" aria-hidden />

        {contact && (
          <LiveWorkspaceActionBar
            contactName={contact.displayName}
            isArchived={isArchived}
            canCall={!!primaryPhoneRow && sipReady}
            canSms={!contact.doNotSms && contact.phones.length > 0}
            canEmail={!!primaryEmailRow}
            hasDisposition={!!disposition}
            queueBackHref={returnTo && returnTo.startsWith("/crm/queue") ? returnTo : null}
            powerDialHref={canLiveWorkspace ? workspaceHref : null}
            onCall={() => void handleCall()}
            onSms={() => focusWorkspace("live", "sms")}
            onEmail={() => setComposeOpen(true)}
            onNote={() => focusWorkspace("notes")}
            onTask={() => {
              setAddingTask(true);
              scrollToTasks();
            }}
            onDisposition={() => focusWorkspace("live", "call")}
          />
        )}

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
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] xl:items-start">

        <div className="flex min-w-0 flex-col gap-4 order-2 xl:order-1" ref={workspacePanelRef}>
          <CRMCard padding="lg" className="overflow-hidden border-crm-border/70">
            <div className="mb-4 flex flex-col gap-3 border-b border-crm-border/60 pb-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-crm-accent">Live workspace</p>
                <h3 className="mt-1 text-xl font-bold tracking-tight text-crm-text">Communication cockpit</h3>
              </div>
              <div className="flex gap-1 overflow-x-auto rounded-2xl border border-crm-border/70 bg-crm-surface-2/55 p-1">
                {([
                  ["live", "Live Workspace"],
                  ["script", "Script"],
                  ["checklist", "Checklist"],
                  ["notes", "Notes"],
                ] as const).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setWorkspaceTab(tab)}
                    className={cn(
                      "whitespace-nowrap rounded-xl px-3 py-2 text-xs font-bold transition-colors",
                      workspaceTab === tab
                        ? "bg-crm-accent text-white shadow-sm"
                        : "text-crm-muted hover:bg-crm-surface hover:text-crm-text",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {workspaceTab === "live" ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                <div className="flex min-w-0 flex-col gap-3">
                  <LiveCallStatusBanner linkedId={null} fromNumber={null} />
                  <div className="rounded-2xl border border-crm-border/70 bg-crm-surface-2/45 p-3">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-500">
                          <Headphones className="h-4 w-4" />
                        </span>
                        <div>
                          <p className="text-sm font-bold text-crm-text">Call controls</p>
                          <p className="text-xs text-crm-muted">{phone.callState === "idle" ? "Ready to dial" : phone.callState}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleCall()}
                        disabled={!primaryPhone || isArchived}
                        className={cn(crm.btnPrimary, "px-3 py-2")}
                      >
                        <Phone className="h-4 w-4" />
                        Call now
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                      <button type="button" disabled={phone.callState === "idle"} onClick={() => phone.setMute(!phone.muted)} className={cn(crm.btnGhost, "flex-col gap-1 py-3 text-xs")}>
                        <Mic className="h-4 w-4" />
                        {phone.muted ? "Unmute" : "Mute"}
                      </button>
                      <button type="button" disabled={phone.callState === "idle"} onClick={phone.toggleHold} className={cn(crm.btnGhost, "flex-col gap-1 py-3 text-xs")}>
                        <Pause className="h-4 w-4" />
                        {phone.onHold ? "Resume" : "Hold"}
                      </button>
                      <button type="button" disabled className={cn(crm.btnGhost, "flex-col gap-1 py-3 text-xs")} title="Dialpad UI is not available in this workspace yet">
                        <Hash className="h-4 w-4" />
                        Keypad
                      </button>
                      <button type="button" disabled className={cn(crm.btnGhost, "flex-col gap-1 py-3 text-xs")} title="Transfer UI is not available in this workspace yet">
                        <Forward className="h-4 w-4" />
                        Transfer
                      </button>
                      <button type="button" disabled className={cn(crm.btnGhost, "flex-col gap-1 py-3 text-xs")} title="Recording control is not wired here">
                        <Radio className="h-4 w-4" />
                        Record
                      </button>
                    </div>
                    <button type="button" disabled={phone.callState === "idle"} onClick={phone.hangup} className={cn(crm.btnDanger, "mt-2 w-full justify-center")}>
                      <PhoneOff className="h-4 w-4" />
                      End call
                    </button>
                  </div>

                  <div className="rounded-2xl border border-crm-border/70 bg-crm-surface p-3">
                    <div className="mb-3 flex flex-wrap gap-1">
                      {([
                        ["call", "Call"],
                        ["sms", "SMS"],
                        ["whatsapp", "WhatsApp"],
                        ["email", "Email"],
                      ] as const).map(([tab, label]) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setCommunicationTab(tab)}
                          className={cn(
                            "rounded-full border px-3 py-1.5 text-xs font-bold",
                            communicationTab === tab
                              ? "border-crm-accent bg-crm-accent text-white"
                              : "border-crm-border bg-crm-surface-2 text-crm-muted hover:text-crm-text",
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {communicationTab === "call" ? (
                      <p className="text-sm leading-relaxed text-crm-muted">
                        Use the call controls above, then log disposition and notes without leaving this workspace.
                      </p>
                    ) : communicationTab === "sms" ? (
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
                    ) : communicationTab === "whatsapp" ? (
                      <div className="rounded-2xl border border-dashed border-crm-border/80 bg-crm-surface-2/45 p-4 text-sm text-crm-muted">
                        WhatsApp contact actions are not wired in this workspace yet. Use SMS or Email for this contact.
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-crm-border/70 bg-violet-500/8 p-4">
                        <p className="text-sm font-semibold text-crm-text">Email composer</p>
                        <p className="mt-1 text-sm text-crm-muted">
                          Opens the existing CRM email compose drawer and records sent mail in the timeline.
                        </p>
                        <button type="button" onClick={() => setComposeOpen(true)} disabled={!primaryEmailRow || isArchived} className={cn(crm.btnPrimary, "mt-3")}>
                          <Mail className="h-4 w-4" />
                          Compose email
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex min-w-0 flex-col gap-3">
                  <div ref={noteComposerRef}>
                    <LiveWorkspaceNotePanel
                      ref={noteTextareaRef}
                      noteBody={noteText}
                      setNoteBody={setNoteText}
                      savingNote={notePosting}
                      noteSavedAt={noteSavedAt}
                      onSave={handlePostNote}
                      disabled={isArchived}
                    />
                    {noteError ? (
                      <p className="mt-1 text-xs text-crm-danger">{noteError}</p>
                    ) : null}
                  </div>
                  <div ref={outcomePanelRef}>
                    <LiveWorkspaceOutcomePanel
                      id="contact-outcome"
                      contact={contact as unknown as LiveContact}
                      disposition={disposition}
                      setDisposition={setDisposition}
                      outcomeNote={outcomeNote}
                      setOutcomeNote={setOutcomeNote}
                      followUpOption={followUpOption}
                      setFollowUpOption={setFollowUpOption}
                      followUpCustom={followUpCustom}
                      setFollowUpCustom={setFollowUpCustom}
                      nextStage={nextStage}
                      setNextStage={setNextStage}
                      savingOutcome={savingOutcome}
                      outcomeSaved={outcomeSaved}
                      outcomeError={outcomeError}
                      isPowerMode={false}
                      onSave={() => void saveOutcomeRef.current()}
                      disabled={disabledOutcome()}
                    />
                  </div>
                </div>
              </div>
            ) : workspaceTab === "script" ? (
              <LiveWorkspaceScriptPanel
                scriptSummaries={scriptSummaries}
                defaultScriptId={null}
              />
            ) : workspaceTab === "checklist" ? (
              <LiveWorkspaceChecklistPanel
                checklists={checklists}
                contactId={contact.id}
                linkedId={null}
                defaultChecklistId={null}
                onSaved={() => void loadTimeline()}
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <div ref={noteComposerRef}>
                  <LiveWorkspaceNotePanel
                    ref={noteTextareaRef}
                    noteBody={noteText}
                    setNoteBody={setNoteText}
                    savingNote={notePosting}
                    noteSavedAt={noteSavedAt}
                    onSave={handlePostNote}
                    disabled={isArchived}
                  />
                  {noteError ? (
                    <p className="mt-1 text-xs text-crm-danger">{noteError}</p>
                  ) : null}
                </div>
                <div className="rounded-2xl border border-crm-border/70 bg-crm-surface-2/45 p-4">
                  <h3 className="text-sm font-bold uppercase tracking-wide text-crm-muted">Scratch notes</h3>
                  {editing && !isArchived ? (
                    <textarea
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      rows={8}
                      placeholder="Quick scratch pad for this contact…"
                      style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
                    />
                  ) : (
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-crm-text">
                      {contact.notes || "No scratch notes."}
                    </p>
                  )}
                </div>
              </div>
            )}
          </CRMCard>

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
            onStartOutreach={scrollToNoteComposer}
          />
        </div>

        <div className="flex flex-col gap-4 order-1 xl:order-2 xl:sticky xl:top-20 xl:self-start">
          <CRMCard padding="md" className="border-crm-accent/25 bg-crm-accent/5">
            <p className="text-xs font-bold uppercase tracking-wide text-crm-accent">Next step</p>
            <p className="mt-1 text-base font-semibold text-crm-text">{nextStep.title}</p>
            <p className="mt-1 text-sm text-crm-muted">{nextStep.detail}</p>
            {nextStep.actionLabel && nextStep.action !== "none" && (
              <button type="button" onClick={runNextStepAction} className={cn(crm.btnPrimary, "mt-3 w-full justify-center")}>
                {nextStep.actionLabel}
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </CRMCard>
          <ContactRelationshipHealth
            timeline={timeline}
            openTasks={tasks}
            overdueTasks={overdueTasks}
            lastTouchAt={contact.lastActivityAt ?? null}
            daysSinceComm={daysSinceComm}
            callbackUrgent={callbackUrgent}
            recentActivityCount={recentActivityCount}
          />
          <CRMCard padding="md" className="border-crm-border/70">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-crm-muted">Activity summary</p>
                <p className="mt-1 text-sm font-semibold text-crm-text">{lastInteractionLabel ?? "No interactions yet"}</p>
              </div>
              <Sparkles className="h-4 w-4 text-crm-accent" />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-crm-border/70 bg-crm-surface-2/50 p-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Last touch</p>
                <p className="mt-1 truncate text-xs font-semibold text-crm-text">
                  {lastInteractionAt ? formatTimeAgo(lastInteractionAt) : "None"}
                </p>
              </div>
              <div className="rounded-xl border border-crm-border/70 bg-crm-surface-2/50 p-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Recent events</p>
                <p className="mt-1 text-xs font-semibold text-crm-text">{recentActivityCount} in 7d</p>
              </div>
              <div className="rounded-xl border border-crm-border/70 bg-crm-surface-2/50 p-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Callbacks</p>
                <p className={cn("mt-1 text-xs font-semibold", callbackUrgent ? "text-crm-danger" : "text-crm-text")}>
                  {callbackUrgent ? "Overdue" : queueMember?.callbackAt ? formatDate(queueMember.callbackAt) : "None due"}
                </p>
              </div>
              <div className="rounded-xl border border-crm-border/70 bg-crm-surface-2/50 p-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Open tasks</p>
                <p className="mt-1 text-xs font-semibold text-crm-text">{tasks.length}</p>
              </div>
            </div>
          </CRMCard>
        <div className="flex flex-col gap-4">

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
                            {(() => {
                              const d = new Date(task.dueAt as any);
                              return isNaN(d.getTime())
                                ? String(task.dueAt).slice(0, 10)
                                : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                            })()}
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
    {contact ? (
      <div className="fixed inset-x-0 bottom-12 z-40 pointer-events-none px-3 sm:px-6">
        <div className="pointer-events-auto mx-auto flex w-full max-w-3xl items-center gap-1 overflow-x-auto rounded-2xl border border-crm-border/70 bg-crm-bg/90 p-1.5 shadow-[0_-18px_44px_-34px_rgba(15,23,42,0.9)] backdrop-blur-xl">
          <button type="button" disabled className="min-w-[5.5rem] rounded-xl px-3 py-2 text-xs font-bold text-crm-muted" title="Dialpad UI is not available in this workspace yet">Dialpad</button>
          <button type="button" onClick={() => focusWorkspace("live", "sms")} disabled={isArchived || contact.doNotSms || contact.phones.length === 0} className="min-w-[5.5rem] rounded-xl px-3 py-2 text-xs font-bold text-crm-text hover:bg-crm-surface-2">SMS</button>
          <button type="button" disabled className="min-w-[6.25rem] rounded-xl px-3 py-2 text-xs font-bold text-crm-muted" title="WhatsApp contact actions are not wired yet">WhatsApp</button>
          <button type="button" onClick={() => setComposeOpen(true)} disabled={isArchived || !primaryEmailRow} className="min-w-[5.5rem] rounded-xl px-3 py-2 text-xs font-bold text-crm-text hover:bg-crm-surface-2">Email</button>
          <button type="button" onClick={() => focusWorkspace("notes")} disabled={isArchived} className="min-w-[5.5rem] rounded-xl px-3 py-2 text-xs font-bold text-crm-text hover:bg-crm-surface-2">Notes</button>
          <button type="button" disabled className="min-w-[7rem] rounded-xl px-3 py-2 text-xs font-bold text-crm-muted" title="AI summary shortcut is not wired here">AI summary</button>
        </div>
      </div>
    ) : null}
    <LiveWrapUpBar
      visible={Boolean(contact)}
      canSave={Boolean(disposition) && !savingOutcome && !isArchived}
      saving={savingOutcome}
      isPowerMode={false}
      onSave={() => void saveOutcomeRef.current()}
    />
    {contact ? (
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
    ) : null}
    </>
  );
}

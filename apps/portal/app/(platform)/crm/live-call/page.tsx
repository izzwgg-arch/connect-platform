"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Phone, Mail, PhoneIncoming, CheckSquare, Circle,
  MessageSquare, Clock, UserPlus, GitCommitHorizontal,
  PhoneOutgoing, Mic, Plus, AlertCircle, FileText, ClipboardList,
  ChevronDown, CheckCircle2, Square, CalendarClock, CheckCheck,
  GitMerge, User,
} from "lucide-react";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { CrmRecordingPlayer } from "../../../../components/CrmRecordingPlayer";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";
import { useTelephony } from "../../../../contexts/TelephonyContext";
import { useSipPhone } from "../../../../hooks/useSipPhone";

// ── Types ─────────────────────────────────────────────────────────────────────

type CrmStage = "LEAD" | "CONTACTED" | "QUALIFIED" | "CUSTOMER" | "CLOSED_LOST";

type ContactSummary = {
  id: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  crmStage?: CrmStage | null;
  doNotCall?: boolean;
  primaryPhone?: { numberRaw: string } | null;
  primaryEmail?: { email: string } | null;
};

type Task = {
  id: string;
  title: string;
  body?: string | null;
  dueAt?: string | null;
  priority: string;
  status: string;
};

type TimelineEventType =
  | "CONTACT_CREATED" | "STAGE_CHANGED" | "NOTE_ADDED" | "NOTE_EDITED"
  | "TASK_CREATED" | "TASK_COMPLETED" | "TASK_CANCELED"
  | "CDR_INBOUND" | "CDR_OUTBOUND" | "CHECKLIST_COMPLETED" | "DISPOSITION_SET"
  | "CONTACT_MERGED" | "ASSIGNED_TO_USER";

type TimelineEvent = {
  id: string;
  /** Widened to string so unknown future event types render gracefully via Clock icon fallback */
  type: TimelineEventType | string;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  linkedId?: string | null;
  createdAt: string;
  createdBy?: { id: string; displayName: string } | null;
};

type ScriptSummary = {
  id: string;
  name: string;
  isActive: boolean;
};

type Script = ScriptSummary & { body: string };

type ChecklistItem = {
  id: string;
  label: string;
  required: boolean;
  sortOrder: number;
};

type Checklist = {
  id: string;
  name: string;
  isActive: boolean;
  items: ChecklistItem[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = {
  LEAD: "Lead", CONTACTED: "Contacted", QUALIFIED: "Qualified",
  CUSTOMER: "Customer", CLOSED_LOST: "Closed",
};
const STAGE_COLORS: Record<string, { bg: string; text: string }> = {
  LEAD:        { bg: "#fef3c7", text: "#92400e" },
  CONTACTED:   { bg: "#dbeafe", text: "#1e40af" },
  QUALIFIED:   { bg: "#d1fae5", text: "#065f46" },
  CUSTOMER:    { bg: "#ede9fe", text: "#5b21b6" },
  CLOSED_LOST: { bg: "#fee2e2", text: "#991b1b" },
};

const STATE_LABEL: Record<string, string> = {
  ringing: "Ringing", dialing: "Dialing", up: "Active", held: "On Hold",
  hungup: "Ended", unknown: "Live Call",
};
const STATE_BG: Record<string, string> = {
  ringing: "#fff7ed", dialing: "#eff6ff", up: "#f0fdf4",
  held: "#f5f3ff", hungup: "#f3f4f6", unknown: "#f0fdf4",
};
const STATE_BORDER: Record<string, string> = {
  ringing: "#fed7aa", dialing: "#bfdbfe", up: "#d1fae5",
  held: "#ddd6fe", hungup: "#e5e7eb", unknown: "#d1fae5",
};
const STATE_TEXT: Record<string, string> = {
  ringing: "#c2410c", dialing: "#1e40af", up: "#065f46",
  held: "#5b21b6", hungup: "#6b7280", unknown: "#065f46",
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function TimelineIcon({ type }: { type: string }) {
  const sz = 13;
  if (type === "NOTE_ADDED" || type === "NOTE_EDITED") return <MessageSquare size={sz} style={{ color: "#6366f1" }} />;
  if (type === "STAGE_CHANGED") return <GitCommitHorizontal size={sz} style={{ color: "#10b981" }} />;
  if (type === "CONTACT_CREATED") return <UserPlus size={sz} style={{ color: "#3b82f6" }} />;
  if (type === "CDR_INBOUND") return <PhoneIncoming size={sz} style={{ color: "#10b981" }} />;
  if (type === "CDR_OUTBOUND") return <PhoneOutgoing size={sz} style={{ color: "#3b82f6" }} />;
  if (type === "TASK_CREATED" || type === "TASK_COMPLETED" || type === "TASK_CANCELED") return <CheckSquare size={sz} style={{ color: "#f59e0b" }} />;
  if (type === "CHECKLIST_COMPLETED") return <ClipboardList size={sz} style={{ color: "#8b5cf6" }} />;
  if (type === "DISPOSITION_SET") return <CheckCheck size={sz} style={{ color: "#0ea5e9" }} />;
  if (type === "CONTACT_MERGED") return <GitMerge size={sz} style={{ color: "#8b5cf6" }} />;
  if (type === "ASSIGNED_TO_USER") return <User size={sz} style={{ color: "#0ea5e9" }} />;
  return <Clock size={sz} style={{ color: "#9ca3af" }} />;
}

// ── Live Call Banner ──────────────────────────────────────────────────────────

function LiveCallBanner({ linkedId, fromNumber }: { linkedId: string | null; fromNumber: string | null }) {
  const { calls } = useTelephony();
  const [elapsed, setElapsed] = useState(0);

  // Try to match call by linkedId, fall back to any active call
  const activeCall = linkedId
    ? (Array.from(calls.values()).find((c) => c.linkedId === linkedId) ?? null)
    : (Array.from(calls.values()).find((c) => c.state !== "hungup") ?? null);

  useEffect(() => {
    if (!activeCall?.answeredAt) { setElapsed(0); return; }
    const startMs = new Date(activeCall.answeredAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - startMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [activeCall?.answeredAt]);

  const state = activeCall?.state ?? "unknown";
  const direction = activeCall?.direction ?? (fromNumber ? "inbound" : null);
  const phone = activeCall?.from ?? fromNumber ?? "";

  if (!activeCall && !fromNumber && !linkedId) return null;

  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: "0.625rem",
        padding: "0.5rem 1rem", borderRadius: 8,
        background: STATE_BG[state] ?? "#f0fdf4",
        border: `1px solid ${STATE_BORDER[state] ?? "#d1fae5"}`,
        fontSize: "0.8125rem", fontWeight: 600,
        color: STATE_TEXT[state] ?? "#065f46",
      }}
    >
      {direction === "inbound"
        ? <PhoneIncoming size={14} />
        : direction === "outbound"
          ? <PhoneOutgoing size={14} />
          : <Phone size={14} />}
      <span>{STATE_LABEL[state] ?? "Live Call"}</span>
      {phone && (
        <span style={{ fontFamily: "monospace", fontWeight: 400, fontSize: "0.75rem" }}>
          {phone}
        </span>
      )}
      {activeCall?.answeredAt && elapsed > 0 && (
        <span style={{ fontFamily: "monospace", fontSize: "0.75rem", fontWeight: 700, marginLeft: "auto" }}>
          {formatDuration(elapsed)}
        </span>
      )}
    </div>
  );
}

// ── Script Selector ───────────────────────────────────────────────────────────

function ScriptPanel({ scriptSummaries, defaultScriptId }: { scriptSummaries: ScriptSummary[]; defaultScriptId?: string | null }) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [script, setScript] = useState<Script | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);
  const didPrefill = useRef(false);

  async function loadScript(id: string) {
    if (!id) { setScript(null); return; }
    setLoading(true);
    try {
      const res = await apiGet<{ script: Script }>(`/crm/scripts/${id}`);
      setScript(res.script);
    } catch {
      setScript(null);
    } finally {
      setLoading(false);
    }
  }

  function handleSelect(id: string) {
    setSelectedId(id);
    loadScript(id);
  }

  // Prefill from campaign when scripts are loaded and a default is provided
  useEffect(() => {
    if (didPrefill.current) return;
    if (!defaultScriptId) return;
    if (scriptSummaries.length === 0) return;
    const match = scriptSummaries.find((s) => s.id === defaultScriptId);
    if (match) {
      didPrefill.current = true;
      handleSelect(defaultScriptId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultScriptId, scriptSummaries]);

  return (
    <div className="panel" style={{ padding: "1.25rem" }}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", userSelect: "none" }}
        onClick={() => setOpen((v) => !v)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <FileText size={15} style={{ color: "#6366f1" }} />
          <h3 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 600 }}>Call Script</h3>
        </div>
        <ChevronDown size={15} style={{ color: "#9ca3af", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </div>

      {open && (
        <div style={{ marginTop: "0.875rem" }}>
          {scriptSummaries.length === 0 ? (
            <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim, #9ca3af)" }}>
              No active scripts. Create one in{" "}
              <a href="/crm/scripts" style={{ color: "var(--accent, #6366f1)" }}>Scripts</a>.
            </p>
          ) : (
            <select
              value={selectedId}
              onChange={(e) => handleSelect(e.target.value)}
              style={{
                width: "100%", padding: "0.4375rem 0.625rem", borderRadius: 6,
                border: "1px solid var(--border, #e5e7eb)",
                background: "var(--input-bg, #fff)", fontSize: "0.875rem",
                color: selectedId ? "var(--text, #111)" : "var(--text-dim, #9ca3af)",
                cursor: "pointer",
              }}
            >
              <option value="">— Select a script —</option>
              {scriptSummaries.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          )}

          {loading && (
            <div style={{ marginTop: "0.75rem", padding: "0.75rem", borderRadius: 6, background: "#f9fafb", fontSize: "0.8125rem", color: "#9ca3af" }}>
              Loading…
            </div>
          )}

          {!loading && script && (
            <pre style={{
              marginTop: "0.75rem", padding: "1rem", borderRadius: 6,
              background: "var(--surface-hover, #f9fafb)",
              border: "1px solid var(--border, #e5e7eb)",
              fontSize: "0.875rem", lineHeight: 1.65,
              whiteSpace: "pre-wrap", wordBreak: "break-word",
              color: "var(--text, #111)", fontFamily: "inherit",
              maxHeight: 320, overflowY: "auto",
            }}>
              {script.body}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Checklist Panel ───────────────────────────────────────────────────────────

function ChecklistPanel({
  checklists,
  contactId,
  linkedId,
  onSaved,
  defaultChecklistId,
}: {
  checklists: Checklist[];
  contactId: string;
  linkedId: string | null;
  onSaved: () => void;
  defaultChecklistId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [open, setOpen] = useState(true);
  const didPrefill = useRef(false);

  function handleSelectChecklist(id: string) {
    setSelectedId(id);
    const found = checklists.find((c) => c.id === id) ?? null;
    setChecklist(found);
    if (found) {
      const initial: Record<string, boolean> = {};
      found.items.forEach((item) => { initial[item.id] = false; });
      setAnswers(initial);
    } else {
      setAnswers({});
    }
    setSavedMsg("");
  }

  // Prefill from campaign default when checklists are loaded
  useEffect(() => {
    if (didPrefill.current) return;
    if (!defaultChecklistId) return;
    if (checklists.length === 0) return;
    const match = checklists.find((c) => c.id === defaultChecklistId);
    if (match) {
      didPrefill.current = true;
      handleSelectChecklist(defaultChecklistId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultChecklistId, checklists]);

  function toggleItem(itemId: string) {
    setAnswers((prev) => ({ ...prev, [itemId]: !prev[itemId] }));
  }

  async function saveResponse() {
    if (!checklist || !contactId) return;
    setSaving(true);
    try {
      await apiPost(`/crm/checklists/${checklist.id}/respond`, {
        contactId,
        linkedId: linkedId ?? undefined,
        answers,
      });
      setSavedMsg("Saved");
      onSaved();
      setTimeout(() => setSavedMsg(""), 3000);
    } catch {
      setSavedMsg("Save failed");
    } finally {
      setSaving(false);
    }
  }

  const requiredItems = checklist?.items.filter((i) => i.required) ?? [];
  const allRequiredChecked = requiredItems.every((i) => answers[i.id]);
  const checkedCount = Object.values(answers).filter(Boolean).length;
  const totalCount = checklist?.items.length ?? 0;

  return (
    <div className="panel" style={{ padding: "1.25rem" }}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", userSelect: "none" }}
        onClick={() => setOpen((v) => !v)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <ClipboardList size={15} style={{ color: "#8b5cf6" }} />
          <h3 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 600 }}>Checklist</h3>
          {checklist && totalCount > 0 && (
            <span style={{
              fontSize: "0.6875rem", fontWeight: 700, padding: "0.125rem 0.5rem",
              borderRadius: 20, background: allRequiredChecked ? "#d1fae5" : "#fef3c7",
              color: allRequiredChecked ? "#065f46" : "#92400e",
            }}>
              {checkedCount}/{totalCount}
            </span>
          )}
        </div>
        <ChevronDown size={15} style={{ color: "#9ca3af", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </div>

      {open && (
        <div style={{ marginTop: "0.875rem" }}>
          {checklists.length === 0 ? (
            <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim, #9ca3af)" }}>
              No active checklists. Create one in{" "}
              <a href="/crm/checklists" style={{ color: "var(--accent, #6366f1)" }}>Checklists</a>.
            </p>
          ) : (
            <select
              value={selectedId}
              onChange={(e) => handleSelectChecklist(e.target.value)}
              style={{
                width: "100%", padding: "0.4375rem 0.625rem", borderRadius: 6,
                border: "1px solid var(--border, #e5e7eb)",
                background: "var(--input-bg, #fff)", fontSize: "0.875rem",
                color: selectedId ? "var(--text, #111)" : "var(--text-dim, #9ca3af)",
                cursor: "pointer",
              }}
            >
              <option value="">— Select a checklist —</option>
              {checklists.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}

          {checklist && (
            <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.375rem" }}>
              {checklist.items.map((item) => {
                const checked = !!answers[item.id];
                return (
                  <div
                    key={item.id}
                    onClick={() => toggleItem(item.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: "0.625rem",
                      padding: "0.5rem 0.625rem", borderRadius: 6, cursor: "pointer",
                      background: checked ? "#f0fdf4" : "var(--surface-hover, #f9fafb)",
                      border: `1px solid ${checked ? "#d1fae5" : "var(--border, #e5e7eb)"}`,
                      userSelect: "none",
                    }}
                  >
                    {checked
                      ? <CheckCircle2 size={15} style={{ color: "#10b981", flexShrink: 0 }} />
                      : <Square size={15} style={{ color: "#9ca3af", flexShrink: 0 }} />}
                    <span style={{
                      fontSize: "0.8125rem", flex: 1,
                      textDecoration: checked ? "line-through" : "none",
                      color: checked ? "var(--text-dim, #6b7280)" : "var(--text, #111)",
                    }}>
                      {item.label}
                    </span>
                    {item.required && !checked && (
                      <span style={{ fontSize: "0.6875rem", fontWeight: 700, background: "#fef3c7", color: "#92400e", borderRadius: 4, padding: "0.1rem 0.3rem", flexShrink: 0 }}>
                        Required
                      </span>
                    )}
                  </div>
                );
              })}

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "0.75rem" }}>
                {savedMsg && (
                  <span style={{ fontSize: "0.75rem", color: savedMsg === "Save failed" ? "#ef4444" : "#10b981" }}>
                    {savedMsg}
                  </span>
                )}
                {!savedMsg && !allRequiredChecked && requiredItems.length > 0 && (
                  <span style={{ fontSize: "0.6875rem", color: "#d97706" }}>
                    {requiredItems.filter((i) => !answers[i.id]).length} required item(s) unchecked
                  </span>
                )}
                {!savedMsg && allRequiredChecked && (
                  <span style={{ fontSize: "0.6875rem", color: "#10b981" }}>All required items done</span>
                )}
                <button
                  onClick={saveResponse}
                  disabled={saving}
                  style={{
                    marginLeft: "auto", padding: "0.4375rem 0.875rem", borderRadius: 6,
                    background: "var(--accent, #6366f1)", color: "#fff",
                    border: "none", cursor: saving ? "not-allowed" : "pointer",
                    fontWeight: 600, fontSize: "0.8125rem",
                    opacity: saving ? 0.5 : 1,
                  }}
                >
                  {saving ? "Saving…" : "Save Response"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function LiveCallWorkspacePage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const contactId = searchParams.get("contactId");
  const linkedId = searchParams.get("linkedId");
  const fromNumber = searchParams.get("from");
  const campaignId = searchParams.get("campaignId");
  const memberId = searchParams.get("memberId");
  const returnTo = searchParams.get("returnTo");
  // Power Dialer mode: opened from /crm/queue?mode=power — adjusts back nav and Save button
  const isPowerMode = searchParams.get("mode") === "power" && Boolean(memberId);
  const queueBackHref =
    returnTo && returnTo.startsWith("/crm/queue")
      ? returnTo
      : memberId
        ? isPowerMode
          ? "/crm/queue?mode=power"
          : "/crm/queue"
        : null;

  const [contact, setContact] = useState<ContactSummary | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Scripts + checklists (loaded once)
  const [scriptSummaries, setScriptSummaries] = useState<ScriptSummary[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);

  // SIP registration state — used to show a friendly notice if phone is offline
  const phone = useSipPhone();

  // Local presence caller ID selection
  const [callerIdSelected, setCallerIdSelected] = useState<string | null>(null);
  const [callerIdChecked, setCallerIdChecked] = useState(false);
  const [callerIdLoading, setCallerIdLoading] = useState(false);

  // Campaign prefill (when opened from campaign/queue)
  const [campaignScriptId, setCampaignScriptId] = useState<string | null>(null);
  const [campaignChecklistId, setCampaignChecklistId] = useState<string | null>(null);
  const [campaignName, setCampaignName] = useState<string | null>(null);

  // Quick note
  const [noteBody, setNoteBody] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [noteSavedAt, setNoteSavedAt] = useState<Date | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Timeline expand/collapse
  const [timelineExpanded, setTimelineExpanded] = useState(false);

  // Outcome panel
  const [disposition, setDisposition] = useState<string>("");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [followUpOption, setFollowUpOption] = useState<"" | "today" | "tomorrow" | "nextweek" | "custom">("");
  const [followUpCustom, setFollowUpCustom] = useState("");
  const [nextStage, setNextStage] = useState<CrmStage | "">("");
  const [savingOutcome, setSavingOutcome] = useState(false);
  const [outcomeSaved, setOutcomeSaved] = useState(false);
  const [outcomeError, setOutcomeError] = useState("");

  async function refreshAll() {
    if (!contactId) return;
    try {
      const [contactRes, tasksRes, timelineRes] = await Promise.all([
        apiGet<{ contact: ContactSummary }>(`/crm/contacts/${contactId}`),
        apiGet<{ tasks: Task[] }>(`/crm/contacts/${contactId}/tasks?status=open&limit=10`),
        apiGet<{ events: TimelineEvent[] }>(`/crm/contacts/${contactId}/timeline?limit=8`),
      ]);
      setContact(contactRes.contact ?? (contactRes as unknown as ContactSummary));
      setTasks(tasksRes.tasks ?? []);
      setTimeline(timelineRes.events ?? []);
    } catch {
      // Non-critical
    }
  }

  async function refreshTimeline() {
    if (!contactId) return;
    try {
      const res = await apiGet<{ events: TimelineEvent[] }>(`/crm/contacts/${contactId}/timeline?limit=8`);
      setTimeline(res.events ?? []);
    } catch {
      // Non-critical; ignore
    }
  }

  useEffect(() => {
    if (!contactId) { setLoading(false); return; }
    setLoading(true);

    const fetches: Promise<unknown>[] = [
      apiGet<{ contact: ContactSummary }>(`/crm/contacts/${contactId}`),
      apiGet<{ tasks: Task[] }>(`/crm/contacts/${contactId}/tasks?status=open&limit=10`),
      apiGet<{ events: TimelineEvent[] }>(`/crm/contacts/${contactId}/timeline?limit=8`),
      apiGet<{ scripts: ScriptSummary[] }>("/crm/scripts"),
      apiGet<{ checklists: Checklist[] }>("/crm/checklists"),
    ];

    if (campaignId) {
      fetches.push(apiGet<{ campaign: { name: string; scriptId: string | null; checklistId: string | null } }>(`/crm/campaigns/${campaignId}`).catch(() => null));
    }

    Promise.all(fetches)
      .then((results) => {
        const [contactRes, tasksRes, timelineRes, scriptsRes, checklistsRes, campaignRes] = results as [
          { contact: ContactSummary },
          { tasks: Task[] },
          { events: TimelineEvent[] },
          { scripts: ScriptSummary[] },
          { checklists: Checklist[] },
          { campaign: { name: string; scriptId: string | null; checklistId: string | null } } | null | undefined,
        ];
        setContact(contactRes.contact ?? (contactRes as unknown as ContactSummary));
        setTasks(tasksRes.tasks ?? []);
        setTimeline(timelineRes.events ?? []);
        setScriptSummaries(scriptsRes.scripts ?? []);
        setChecklists(checklistsRes.checklists ?? []);
        if (campaignRes?.campaign) {
          setCampaignName(campaignRes.campaign.name);
          setCampaignScriptId(campaignRes.campaign.scriptId);
          setCampaignChecklistId(campaignRes.campaign.checklistId);
        }
      })
      .catch((err: unknown) => {
        setError(String((err as Error)?.message ?? "Failed to load contact"));
      })
      .finally(() => setLoading(false));
  // campaignId is intentionally excluded — it doesn't change after page load
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  // Power mode keyboard shortcut: O = save outcome (when not typing)
  // Uses a ref to always capture latest saveOutcome without stale closure
  const saveOutcomeRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!isPowerMode) return;
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
      if (tgt.getAttribute("contenteditable") === "true") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "o" || e.key === "O") && !savingOutcome && disposition) {
        e.preventDefault();
        void saveOutcomeRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPowerMode, disposition, savingOutcome]);

  async function saveNote() {
    if (!contactId || !noteBody.trim()) return;
    setSavingNote(true);
    try {
      await apiPost(`/crm/contacts/${contactId}/notes`, { body: noteBody.trim() });
      setNoteBody("");
      setNoteSavedAt(new Date());
      await refreshTimeline();
    } catch {
      // Silent — user can retry
    } finally {
      setSavingNote(false);
    }
  }

  async function saveOutcome() {
    if (!contactId || !disposition) return;
    setSavingOutcome(true);
    setOutcomeError("");

    let followUpAt: string | null = null;
    if (followUpOption === "today") {
      const d = new Date(); d.setHours(17, 0, 0, 0);
      followUpAt = d.toISOString();
    } else if (followUpOption === "tomorrow") {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
      followUpAt = d.toISOString();
    } else if (followUpOption === "nextweek") {
      const d = new Date();
      const day = d.getDay(); // 0=Sun
      const daysToMonday = day === 0 ? 1 : 8 - day;
      d.setDate(d.getDate() + daysToMonday); d.setHours(9, 0, 0, 0);
      followUpAt = d.toISOString();
    } else if (followUpOption === "custom" && followUpCustom) {
      followUpAt = new Date(followUpCustom).toISOString();
    }

    try {
      await apiPost(`/crm/contacts/${contactId}/disposition`, {
        disposition,
        note: outcomeNote.trim() || undefined,
        linkedId: linkedId ?? undefined,
        followUpAt: followUpAt ?? undefined,
        nextStage: nextStage || undefined,
        // Pass memberId so the endpoint can set callbackAt on the campaign member
        // when disposition is CALLBACK and followUpAt is provided
        memberId: memberId ?? undefined,
      });
      setOutcomeSaved(true);
      setOutcomeNote("");
      setFollowUpOption("");
      setFollowUpCustom("");
      // Refresh all data so contact header, tasks, timeline all update
      await refreshAll();

      // Update campaign member status + increment attempt count (non-blocking)
      if (memberId) {
        const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;
        apiPatch(`/crm/queue/${memberId}`, { action: "outcome", disposition }, token).catch(() => {});
      }

      // Power mode: brief "Saved" flash then return to queue so agent advances to next lead
      if (isPowerMode && memberId) {
        await new Promise<void>((resolve) => setTimeout(resolve, 900));
        router.push(queueBackHref ?? "/crm/queue?mode=power");
        return;
      }

      setTimeout(() => setOutcomeSaved(false), 4000);
    } catch {
      setOutcomeError("Save failed — please try again.");
    } finally {
      setSavingOutcome(false);
    }
  }

  // Keep ref in sync so keyboard shortcut always calls latest version
  useEffect(() => { saveOutcomeRef.current = saveOutcome; });

  const stageColors = contact?.crmStage ? STAGE_COLORS[contact.crmStage] : null;

  if (!contactId) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" }}>
        <AlertCircle size={32} style={{ color: "#9ca3af", marginBottom: "1rem" }} />
        <p style={{ color: "#6b7280" }}>No contact specified. Open this workspace from an incoming call screen pop.</p>
        <button
          onClick={() => router.push("/crm/contacts")}
          style={{
            marginTop: "1rem", padding: "0.5rem 1.25rem", borderRadius: 6,
            background: "var(--accent, #6366f1)", color: "#fff", border: "none",
            cursor: "pointer", fontWeight: 600, fontSize: "0.875rem",
          }}
        >
          Go to Contacts
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "1.5rem 1.25rem" }}>
      {/* Back nav + live call banner */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1.25rem" }}>
        <button
          onClick={() => {
            if (queueBackHref) router.push(queueBackHref);
            else router.back();
          }}
          style={{
            display: "flex", alignItems: "center", gap: "0.375rem",
            background: "none", border: "none", cursor: "pointer",
            color: "var(--text-dim, #6b7280)", fontSize: "0.875rem", padding: 0,
          }}
        >
          <ArrowLeft size={16} />
          {memberId ? "Return to queue" : "Back"}
        </button>
        {memberId && queueBackHref ? (
          <button
            type="button"
            onClick={() => router.push(queueBackHref)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.375rem",
              background: "var(--crm-surface-2, #1e293b)",
              border: "1px solid var(--crm-border, #334155)",
              borderRadius: 6,
              cursor: "pointer",
              color: "var(--text, #e2e8f0)",
              fontSize: "0.8125rem",
              padding: "0.35rem 0.65rem",
              fontWeight: 600,
            }}
          >
            Next in queue
          </button>
        ) : null}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.375rem" }}>
          {campaignId && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span style={{ fontSize: "0.75rem", background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", borderRadius: "0.375rem", padding: "0.125rem 0.5rem", fontWeight: 600 }}>
                {campaignName ? `Campaign: ${campaignName}` : "Campaign Queue"}
              </span>
            </div>
          )}
          {(linkedId || fromNumber) && (
            <LiveCallBanner linkedId={linkedId} fromNumber={fromNumber} />
          )}
        </div>
      </div>

      {loading && <LoadingSkeleton />}

      {error && (
        <div style={{ padding: "1rem", background: "#fee2e2", borderRadius: 8, color: "#991b1b", fontSize: "0.875rem" }}>
          {error}
        </div>
      )}

      {!loading && !error && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: "1.25rem", alignItems: "start" }}>
          {/* Left column */}
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {/* Contact card */}
            {contact && (
              <div className="panel" style={{ padding: "1.25rem" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.5rem" }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: "1.1875rem", fontWeight: 700 }}>
                      {contact.displayName}
                    </h2>
                    {contact.company && (
                      <p style={{ margin: "0.125rem 0 0", fontSize: "0.875rem", color: "var(--text-dim, #6b7280)" }}>
                        {contact.company}{contact.title ? ` · ${contact.title}` : ""}
                      </p>
                    )}
                    <div style={{ marginTop: "0.5rem", display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
                      {contact.crmStage && stageColors && (
                        <span style={{
                          fontSize: "0.6875rem", fontWeight: 600, padding: "0.125rem 0.5rem",
                          borderRadius: 20, background: stageColors.bg, color: stageColors.text,
                        }}>
                          {STAGE_LABELS[contact.crmStage] ?? contact.crmStage}
                        </span>
                      )}
                      {contact.doNotCall && (
                        <span style={{
                          fontSize: "0.6875rem", fontWeight: 600, padding: "0.125rem 0.5rem",
                          borderRadius: 20, background: "#fee2e2", color: "#991b1b",
                        }}>
                          DNC
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => router.push(`/crm/contacts/${contact.id}`)}
                    style={{
                      padding: "0.375rem 0.875rem", borderRadius: 6,
                      background: "var(--accent, #6366f1)", color: "#fff",
                      border: "none", cursor: "pointer", fontSize: "0.8125rem", fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    Full Profile
                  </button>
                </div>

                <div style={{ marginTop: "0.875rem", display: "flex", flexWrap: "wrap", gap: "1rem" }}>
                  {contact.primaryPhone && (
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.8125rem" }}>
                        <Phone size={13} style={{ color: "var(--text-dim, #9ca3af)" }} />
                        <span>{contact.primaryPhone.numberRaw}</span>
                      </div>
                      {/* Click-to-call with local presence */}
                      <button
                        onClick={async () => {
                          if (!callerIdChecked && contact.primaryPhone?.numberRaw) {
                            setCallerIdLoading(true);
                            try {
                              const res = await apiPost<{
                                callerId: string | null;
                                destination: string;
                                selectedFromPool: boolean;
                                localPresenceEnabled: boolean;
                              }>("/crm/calls/originate", {
                                destination: contact.primaryPhone.numberRaw,
                                contactId: contactId ?? undefined,
                                memberId: memberId ?? undefined,
                                campaignId: campaignId ?? undefined,
                              });
                              setCallerIdSelected(res.callerId);
                            } catch {
                              setCallerIdSelected(null);
                            } finally {
                              setCallerIdChecked(true);
                              setCallerIdLoading(false);
                            }
                          }
                          // Actually dial via the SIP phone — browser-side
                          if (contact.primaryPhone?.numberRaw) {
                            window.dispatchEvent(new CustomEvent("crm:dial", {
                              detail: { target: contact.primaryPhone.numberRaw }
                            }));
                          }
                        }}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: "0.375rem",
                          padding: "0.25rem 0.625rem", fontSize: "0.8125rem",
                          background: "#2563eb", color: "#fff", border: "none",
                          borderRadius: "0.5rem", cursor: "pointer", fontWeight: 600,
                        }}
                      >
                        <Phone size={12} />
                        {callerIdLoading ? "Selecting…" : "Call"}
                      </button>
                      {callerIdChecked && (
                        <span style={{ fontSize: "0.75rem", color: callerIdSelected ? "#059669" : "var(--text-dim, #9ca3af)" }}>
                          {callerIdSelected
                            ? `Local presence: ${callerIdSelected}`
                            : "Default caller ID"}
                        </span>
                      )}
                    </div>
                  )}
                  {/* SIP not ready — inform agent without blocking the UI */}
                  {phone.regState !== "registered" && contact?.primaryPhone && (
                    <div style={{
                      display: "flex", alignItems: "center", gap: "0.375rem",
                      fontSize: "0.75rem", color: "#d97706",
                      background: "#fffbeb", border: "1px solid #fde68a",
                      borderRadius: "0.375rem", padding: "0.25rem 0.625rem",
                      marginTop: "0.25rem",
                    }}>
                      <AlertCircle size={12} />
                      {phone.regState === "connecting" || phone.regState === "registering"
                        ? "Phone connecting — call will dial once ready"
                        : "Phone not registered — open the dialer to reconnect"}
                    </div>
                  )}
                  {contact.primaryEmail && (
                    <div style={{ display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.8125rem" }}>
                      <Mail size={13} style={{ color: "var(--text-dim, #9ca3af)" }} />
                      <span>{contact.primaryEmail.email}</span>
                    </div>
                  )}
                </div>
              </div>
            )}


            {/* Call Script panel */}
            <ScriptPanel scriptSummaries={scriptSummaries} defaultScriptId={campaignScriptId} />

            {/* Checklist panel */}
            {contactId && (
              <ChecklistPanel
                checklists={checklists}
                contactId={contactId}
                linkedId={linkedId}
                onSaved={refreshTimeline}
                defaultChecklistId={campaignChecklistId}
              />
            )}

            {/* Quick note composer */}
            <div className="panel" style={{ padding: "1.25rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.9375rem", fontWeight: 600 }}>
                Call Note
              </h3>
              <textarea
                ref={noteRef}
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                placeholder="Type your call note here…"
                rows={4}
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "0.625rem 0.75rem", borderRadius: 6,
                  border: "1px solid var(--border, #e5e7eb)",
                  background: "var(--input-bg, #fff)",
                  fontSize: "0.875rem", resize: "vertical",
                  color: "var(--text, #111)",
                }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.5rem" }}>
                {noteSavedAt ? (
                  <span style={{ fontSize: "0.75rem", color: "#10b981" }}>
                    Saved at {noteSavedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                ) : <span />}
                <button
                  onClick={saveNote}
                  disabled={!noteBody.trim() || savingNote}
                  style={{
                    padding: "0.4375rem 1rem", borderRadius: 6,
                    background: "var(--accent, #6366f1)", color: "#fff",
                    border: "none", cursor: noteBody.trim() && !savingNote ? "pointer" : "not-allowed",
                    opacity: !noteBody.trim() || savingNote ? 0.5 : 1,
                    fontWeight: 600, fontSize: "0.8125rem",
                  }}
                >
                  {savingNote ? "Saving…" : "Save Note"}
                </button>
              </div>
            </div>

            {/* Call Outcome — disposition + note + follow-up + stage + save */}
            <div className="panel" style={{ padding: "1.25rem" }}>
              <h3 style={{ margin: "0 0 1rem", fontSize: "0.9375rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <CalendarClock size={16} style={{ color: "#0ea5e9" }} />
                Call Outcome
              </h3>

              {/* Disposition buttons */}
              <div style={{ marginBottom: "1rem" }}>
                <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-dim, #6b7280)", marginBottom: "0.375rem" }}>Disposition *</div>
                <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
                  {["Answered", "No Answer", "Voicemail", "Callback", "Not Interested", "Closed"].map((d) => (
                    <button
                      key={d}
                      onClick={() => setDisposition(d)}
                      style={{
                        padding: "0.3125rem 0.75rem", borderRadius: 20, fontSize: "0.8125rem",
                        border: `1px solid ${disposition === d ? "transparent" : "var(--border, #e5e7eb)"}`,
                        background: disposition === d ? "var(--accent, #6366f1)" : "transparent",
                        color: disposition === d ? "#fff" : "var(--text, #111)",
                        cursor: "pointer", fontWeight: disposition === d ? 600 : 400,
                        transition: "all 0.1s",
                      }}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              {/* Next stage selector */}
              <div style={{ marginBottom: "1rem" }}>
                <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-dim, #6b7280)", marginBottom: "0.375rem" }}>
                  Advance Stage <span style={{ fontWeight: 400 }}>(optional)</span>
                </div>
                <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
                  {(["", "LEAD", "CONTACTED", "QUALIFIED", "CUSTOMER", "CLOSED_LOST"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setNextStage(s as CrmStage | "")}
                      style={{
                        padding: "0.25rem 0.625rem", borderRadius: 20, fontSize: "0.75rem",
                        border: `1px solid ${nextStage === s ? "transparent" : "var(--border, #e5e7eb)"}`,
                        background: nextStage === s ? "#0ea5e9" : "transparent",
                        color: nextStage === s ? "#fff" : "var(--text-dim, #6b7280)",
                        cursor: "pointer", fontWeight: nextStage === s ? 600 : 400,
                      }}
                    >
                      {s === "" ? "No change" : STAGE_LABELS[s] ?? s}
                    </button>
                  ))}
                </div>
                {nextStage && contact?.crmStage && nextStage !== contact.crmStage && (
                  <div style={{ fontSize: "0.6875rem", color: "#0ea5e9", marginTop: "0.25rem" }}>
                    Stage will change: {STAGE_LABELS[contact.crmStage] ?? contact.crmStage} → {STAGE_LABELS[nextStage] ?? nextStage}
                  </div>
                )}
              </div>

              {/* Outcome note */}
              <div style={{ marginBottom: "1rem" }}>
                <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-dim, #6b7280)", marginBottom: "0.375rem" }}>
                  Note <span style={{ fontWeight: 400 }}>(optional)</span>
                </div>
                <textarea
                  value={outcomeNote}
                  onChange={(e) => setOutcomeNote(e.target.value)}
                  placeholder="Add a call outcome note…"
                  rows={3}
                  style={{
                    width: "100%", boxSizing: "border-box",
                    padding: "0.5rem 0.625rem", borderRadius: 6,
                    border: "1px solid var(--border, #e5e7eb)",
                    background: "var(--input-bg, #fff)",
                    fontSize: "0.8125rem", resize: "vertical", color: "var(--text, #111)",
                  }}
                />
              </div>

              {/* Follow-up picker */}
              <div style={{ marginBottom: "1rem" }}>
                <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-dim, #6b7280)", marginBottom: "0.375rem", display: "flex", alignItems: "center", gap: "0.375rem" }}>
                  <CalendarClock size={12} />
                  Follow-up <span style={{ fontWeight: 400 }}>(optional)</span>
                </div>
                <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
                  {(["today", "tomorrow", "nextweek", "custom"] as const).map((opt) => (
                    <button
                      key={opt}
                      onClick={() => setFollowUpOption(followUpOption === opt ? "" : opt)}
                      style={{
                        padding: "0.25rem 0.625rem", borderRadius: 20, fontSize: "0.75rem",
                        border: `1px solid ${followUpOption === opt ? "transparent" : "var(--border, #e5e7eb)"}`,
                        background: followUpOption === opt ? "#f59e0b" : "transparent",
                        color: followUpOption === opt ? "#fff" : "var(--text-dim, #6b7280)",
                        cursor: "pointer", fontWeight: followUpOption === opt ? 600 : 400,
                      }}
                    >
                      {opt === "today" ? "Today" : opt === "tomorrow" ? "Tomorrow" : opt === "nextweek" ? "Next Week" : "Custom"}
                    </button>
                  ))}
                </div>
                {followUpOption === "custom" && (
                  <input
                    type="datetime-local"
                    value={followUpCustom}
                    onChange={(e) => setFollowUpCustom(e.target.value)}
                    style={{
                      marginTop: "0.5rem", padding: "0.375rem 0.625rem", borderRadius: 6,
                      border: "1px solid var(--border, #e5e7eb)", fontSize: "0.8125rem",
                      background: "var(--input-bg, #fff)", color: "var(--text, #111)",
                    }}
                  />
                )}
              </div>

              {/* Save button + status */}
              {outcomeError && (
                <div style={{ fontSize: "0.75rem", color: "#ef4444", marginBottom: "0.5rem" }}>{outcomeError}</div>
              )}
              {outcomeSaved && (
                <div style={{ display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.8125rem", color: "#10b981", marginBottom: "0.5rem", fontWeight: 600 }}>
                  <CheckCheck size={15} />
                  Outcome saved — contact, tasks and timeline updated.
                </div>
              )}
              <button
                onClick={() => void saveOutcome()}
                disabled={!disposition || savingOutcome}
                style={{
                  width: "100%", padding: "0.625rem 1rem", borderRadius: 6,
                  background: disposition ? "var(--accent, #6366f1)" : "#e5e7eb",
                  color: disposition ? "#fff" : "#9ca3af",
                  border: "none", cursor: disposition && !savingOutcome ? "pointer" : "not-allowed",
                  fontWeight: 700, fontSize: "0.9375rem",
                  transition: "background 0.1s",
                }}
              >
                {savingOutcome
                  ? "Saving…"
                  : isPowerMode
                    ? "Save Outcome & Next Lead →"
                    : "Save Outcome"}
              </button>
              {!disposition && (
                <div style={{ fontSize: "0.6875rem", color: "var(--text-dim, #9ca3af)", textAlign: "center", marginTop: "0.375rem" }}>
                  Select a disposition to enable save{isPowerMode ? " — then advances to next lead" : ""}
                </div>
              )}
              {isPowerMode && !savingOutcome && (
                <div style={{ fontSize: "0.6875rem", color: "var(--text-dim, #9ca3af)", textAlign: "center", marginTop: "0.25rem" }}>
                  Keyboard: <kbd style={{ padding: "0.0625rem 0.375rem", background: "#f3f4f6", borderRadius: 3, fontFamily: "monospace" }}>O</kbd> to save outcome
                </div>
              )}
            </div>
          </div>

          {/* Right column */}
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {/* Open tasks */}
            <div className="panel" style={{ padding: "1.25rem" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
                <h3 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 600 }}>Open Tasks</h3>
                {tasks.length > 0 && (
                  <span style={{
                    fontSize: "0.6875rem", fontWeight: 700, padding: "0.125rem 0.5rem",
                    borderRadius: 20, background: "#fef3c7", color: "#92400e",
                  }}>
                    {tasks.length}
                  </span>
                )}
              </div>

              {tasks.length === 0 && (
                <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim, #9ca3af)" }}>
                  No open tasks.
                </p>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    style={{
                      padding: "0.5rem 0.625rem", borderRadius: 6,
                      background: "var(--surface-hover, #f9fafb)",
                      border: "1px solid var(--border, #e5e7eb)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: "0.375rem" }}>
                      <Circle size={12} style={{ color: "#f59e0b", marginTop: "0.125rem", flexShrink: 0 }} />
                      <span style={{ fontSize: "0.8125rem", fontWeight: 500 }}>{task.title}</span>
                    </div>
                    {task.dueAt && (
                      <div style={{ fontSize: "0.75rem", color: "#d97706", marginTop: "0.125rem", paddingLeft: "1.125rem" }}>
                        Due {new Date(task.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {contactId && (
                <button
                  onClick={() => router.push(`/crm/contacts/${contactId}#tasks`)}
                  style={{
                    marginTop: "0.75rem", width: "100%", padding: "0.375rem",
                    borderRadius: 6, background: "transparent",
                    border: "1px dashed var(--border, #e5e7eb)",
                    color: "var(--text-dim, #6b7280)", cursor: "pointer",
                    fontSize: "0.75rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.25rem",
                  }}
                >
                  <Plus size={12} />
                  Add Task
                </button>
              )}
            </div>

            {/* Recent timeline */}
            {(() => {
              const COMPACT_LIMIT = 5;
              const visibleEvents = timelineExpanded ? timeline : timeline.slice(0, COMPACT_LIMIT);
              const hiddenCount = timeline.length - COMPACT_LIMIT;
              return (
                <div className="panel" style={{ padding: "1.25rem" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
                    <h3 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 600 }}>Recent Activity</h3>
                    {timeline.length > 0 && (
                      <span style={{
                        fontSize: "0.6875rem", fontWeight: 700, padding: "0.125rem 0.5rem",
                        borderRadius: 20, background: "#f3f4f6", color: "#6b7280",
                      }}>
                        {timeline.length}
                      </span>
                    )}
                  </div>

                  {timeline.length === 0 && (
                    <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim, #9ca3af)" }}>
                      No CRM activity yet.
                    </p>
                  )}

                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {visibleEvents.map((event) => {
                      const m = (event.metadata ?? {}) as Record<string, unknown>;
                      const isCdr = event.type === "CDR_INBOUND" || event.type === "CDR_OUTBOUND";
                      const talkSec = isCdr && typeof m.talkSec === "number" ? m.talkSec : 0;
                      const cdrDisp = isCdr && typeof m.disposition === "string" ? m.disposition : null;
                      const hasRecording = isCdr && Boolean(m.recordingAvailable) && event.linkedId;
                      const isAssignment = event.type === "ASSIGNED_TO_USER";

                      return (
                        <div
                          key={event.id}
                          style={{ display: "flex", gap: "0.5rem", padding: "0.5rem 0", borderBottom: "1px solid var(--border, #e5e7eb)" }}
                        >
                          <div style={{ paddingTop: "0.1rem", flexShrink: 0, width: 18, display: "flex", justifyContent: "center" }}>
                            <TimelineIcon type={event.type} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.25rem" }}>
                              <span style={{ fontSize: "0.78125rem", fontWeight: 600, color: "var(--text)" }}>{event.title}</span>
                              <span style={{ fontSize: "0.6875rem", color: "var(--text-dim)", flexShrink: 0 }}>
                                {formatDateTime(event.createdAt)}
                              </span>
                            </div>

                            {/* Note / body text — single-line truncated */}
                            {event.body && event.body !== "(deleted)" && (
                              <p style={{ margin: "0.125rem 0 0", fontSize: "0.75rem", color: "var(--text-dim)", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {event.body}
                              </p>
                            )}

                            {/* CDR compact metadata: disposition badge + duration + recording */}
                            {isCdr && (
                              <div style={{ marginTop: "0.125rem", display: "flex", alignItems: "center", gap: "0.375rem", flexWrap: "wrap" }}>
                                {cdrDisp && (
                                  <span style={{
                                    fontSize: "0.625rem", fontWeight: 700,
                                    padding: "0.0625rem 0.3rem", borderRadius: 3,
                                    background: cdrDisp === "answered" ? "#d1fae5" : "#fee2e2",
                                    color: cdrDisp === "answered" ? "#065f46" : "#991b1b",
                                  }}>
                                    {cdrDisp}
                                  </span>
                                )}
                                {talkSec > 0 && (
                                  <span style={{ fontSize: "0.6875rem", color: "var(--text-dim)" }}>
                                    {Math.floor(talkSec / 60)}m {talkSec % 60}s
                                  </span>
                                )}
                                {hasRecording && event.linkedId && (
                                  <CrmRecordingPlayer linkedId={event.linkedId} compact />
                                )}
                              </div>
                            )}

                            {/* Assignment from → to names */}
                            {isAssignment && (typeof m.fromName === "string" || typeof m.toName === "string") && (
                              <div style={{ marginTop: "0.125rem", display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.6875rem", color: "var(--text-dim)" }}>
                                <span>{String(m.fromName ?? "—")}</span>
                                <span>→</span>
                                <span style={{ color: "#0ea5e9", fontWeight: 600 }}>{String(m.toName ?? "—")}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Expand / collapse toggle */}
                  {timeline.length > COMPACT_LIMIT && (
                    <button
                      onClick={() => setTimelineExpanded((v) => !v)}
                      style={{
                        marginTop: "0.5rem", width: "100%", padding: "0.3125rem",
                        borderRadius: 6, background: "transparent",
                        border: "1px dashed var(--border, #e5e7eb)",
                        color: "var(--text-dim, #6b7280)", cursor: "pointer",
                        fontSize: "0.75rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.25rem",
                      }}
                    >
                      <ChevronDown
                        size={12}
                        style={{ transform: timelineExpanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                      />
                      {timelineExpanded ? "Show less" : `Show ${hiddenCount} more`}
                    </button>
                  )}

                  {/* Full profile link */}
                  {contactId && timeline.length > 0 && (
                    <button
                      onClick={() => router.push(`/crm/contacts/${contactId}`)}
                      style={{
                        marginTop: "0.5rem", width: "100%", padding: "0.3125rem",
                        borderRadius: 6, background: "transparent",
                        border: "1px solid var(--border, #e5e7eb)",
                        color: "var(--text-dim, #6b7280)", cursor: "pointer", fontSize: "0.75rem",
                      }}
                    >
                      Full Timeline →
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

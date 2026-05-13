"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CheckSquare, Circle, AlertCircle, Clock, Plus, Check,
} from "lucide-react";
import { PageHeader } from "../../../../components/PageHeader";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";

// ── Types ─────────────────────────────────────────────────────────────────────

type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
type TaskStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELED";

type TaskContact = { id: string; displayName: string; company?: string | null };
type TaskUser = { id: string; displayName: string };

type CrmTask = {
  id: string;
  contactId: string;
  title: string;
  body?: string | null;
  dueAt?: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  completedAt?: string | null;
  createdAt: string;
  assignedTo?: TaskUser | null;
  contact?: TaskContact;
};

type TasksResponse = { rows: CrmTask[]; total: number; page: number; limit: number };

// ── Config ────────────────────────────────────────────────────────────────────

const PRIORITY_COLOR: Record<TaskPriority, string> = {
  LOW: "#6b7280",
  MEDIUM: "#3b82f6",
  HIGH: "#f59e0b",
  URGENT: "#ef4444",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

type Tab = "mine" | "today" | "overdue" | "all";

const TABS: { id: Tab; label: string }[] = [
  { id: "mine", label: "My Open" },
  { id: "today", label: "Due Today" },
  { id: "overdue", label: "Overdue" },
  { id: "all", label: "All" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDue(dueAt: string | null | undefined): { label: string; color: string } | null {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);

  if (d < today) return { label: `Overdue · ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, color: "#ef4444" };
  if (d < tomorrow) return { label: "Due today", color: "#f59e0b" };
  return { label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), color: "var(--text-dim)" };
}

function tabToQuery(tab: Tab): Record<string, string> {
  if (tab === "mine") return { assignedTo: "me", status: "open" };
  if (tab === "today") return { status: "open", due: "today" };
  if (tab === "overdue") return { status: "open", due: "overdue" };
  return {};
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: "0.4375rem 0.625rem",
  border: "1px solid var(--border)",
  borderRadius: "0.375rem",
  background: "var(--surface-hover)",
  color: "var(--text)",
  fontSize: "0.875rem",
};

const btnBase: React.CSSProperties = {
  padding: "0.4375rem 1rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--border)",
  cursor: "pointer",
  fontSize: "0.875rem",
  fontWeight: 600,
  background: "var(--surface-hover)",
  color: "var(--text)",
};

// ── Quick-create form ─────────────────────────────────────────────────────────

function QuickCreateForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("MEDIUM");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Contact autocomplete
  type ContactOption = { id: string; displayName: string };
  const [contactOptions, setContactOptions] = useState<ContactOption[]>([]);
  const [selectedContact, setSelectedContact] = useState<ContactOption | null>(null);
  const [searching, setSearching] = useState(false);

  const searchContacts = useCallback(async (q: string) => {
    if (q.length < 2) { setContactOptions([]); return; }
    setSearching(true);
    try {
      const data = await apiGet<{ rows: ContactOption[] }>(`/crm/contacts?q=${encodeURIComponent(q)}&limit=8`);
      setContactOptions(data.rows ?? []);
    } catch { setContactOptions([]); }
    finally { setSearching(false); }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchContacts(contactSearch), 300);
    return () => clearTimeout(t);
  }, [contactSearch, searchContacts]);

  const handleSubmit = async () => {
    if (!selectedContact || !title.trim()) return;
    setPosting(true);
    setError(null);
    try {
      await apiPost(`/crm/contacts/${selectedContact.id}/tasks`, {
        title: title.trim(),
        dueAt: dueAt || undefined,
        priority,
      });
      setTitle(""); setDueAt(""); setContactSearch(""); setSelectedContact(null);
      setOpen(false);
      onCreated();
    } catch (e: any) {
      setError(e?.message || "Failed to create task");
    } finally { setPosting(false); }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ ...btnBase, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)", display: "flex", alignItems: "center", gap: "0.375rem" }}
      >
        <Plus size={14} /> New Task
      </button>
    );
  }

  return (
    <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "0.875rem", fontWeight: 700 }}>New Task</span>
        <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: "1rem", lineHeight: 1 }}>×</button>
      </div>

      {/* Contact search */}
      <div style={{ position: "relative" }}>
        {selectedContact ? (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4375rem 0.625rem", border: "1px solid var(--border)", borderRadius: "0.375rem", background: "var(--surface-hover)", fontSize: "0.875rem" }}>
            <span style={{ flex: 1 }}>{selectedContact.displayName}</span>
            <button onClick={() => { setSelectedContact(null); setContactSearch(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: "1rem", lineHeight: 1 }}>×</button>
          </div>
        ) : (
          <>
            <input
              value={contactSearch}
              onChange={(e) => setContactSearch(e.target.value)}
              placeholder="Search contact…"
              style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
            />
            {contactOptions.length > 0 && (
              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "0.375rem", zIndex: 20, maxHeight: 200, overflowY: "auto" }}>
                {contactOptions.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => { setSelectedContact(c); setContactSearch(c.displayName); setContactOptions([]); }}
                    style={{ padding: "0.5rem 0.75rem", cursor: "pointer", fontSize: "0.875rem" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    {c.displayName}
                  </div>
                ))}
              </div>
            )}
            {searching && <span style={{ position: "absolute", right: "0.5rem", top: "50%", transform: "translateY(-50%)", fontSize: "0.75rem", color: "var(--text-dim)" }}>…</span>}
          </>
        )}
      </div>

      {/* Title */}
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title…"
        style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
        onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
      />

      {/* Due + priority row */}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          type="date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        />
        <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} style={inputStyle}>
          <option value="LOW">Low</option>
          <option value="MEDIUM">Medium</option>
          <option value="HIGH">High</option>
          <option value="URGENT">Urgent</option>
        </select>
      </div>

      {error && <p style={{ margin: 0, fontSize: "0.75rem", color: "#ef4444" }}>{error}</p>}

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          onClick={handleSubmit}
          disabled={posting || !selectedContact || !title.trim()}
          style={{ ...btnBase, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)", opacity: (!selectedContact || !title.trim()) ? 0.5 : 1 }}
        >
          {posting ? "Creating…" : "Create Task"}
        </button>
        <button onClick={() => setOpen(false)} style={btnBase}>Cancel</button>
      </div>
    </div>
  );
}

// ── Task row ──────────────────────────────────────────────────────────────────

function TaskRow({ task, onComplete }: { task: CrmTask; onComplete: (t: CrmTask) => Promise<void> }) {
  const [completing, setCompleting] = useState(false);
  const due = formatDue(task.dueAt);
  const isDone = task.status === "DONE" || task.status === "CANCELED";

  const handleComplete = async () => {
    if (isDone) return;
    setCompleting(true);
    try { await onComplete(task); } finally { setCompleting(false); }
  };

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem", padding: "0.75rem 0", borderBottom: "1px solid var(--border)" }}>
      {/* Done toggle */}
      <button
        onClick={handleComplete}
        disabled={completing || isDone}
        title={isDone ? "Completed" : "Mark done"}
        style={{ background: "none", border: "none", cursor: isDone ? "default" : "pointer", padding: "0.125rem", flexShrink: 0, color: isDone ? "#10b981" : "var(--text-dim)", marginTop: "0.1rem" }}
      >
        {isDone ? <CheckSquare size={16} /> : completing ? <Circle size={16} style={{ opacity: 0.4 }} /> : <Circle size={16} />}
      </button>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.875rem", fontWeight: 600, textDecoration: isDone ? "line-through" : "none", color: isDone ? "var(--text-dim)" : "var(--text)", flex: 1 }}>
            {task.title}
          </span>
          {/* Priority badge */}
          <span style={{ fontSize: "0.7rem", fontWeight: 700, padding: "0.1rem 0.4rem", borderRadius: "0.25rem", background: PRIORITY_COLOR[task.priority] + "22", color: PRIORITY_COLOR[task.priority], textTransform: "uppercase", letterSpacing: "0.04em", flexShrink: 0 }}>
            {PRIORITY_LABEL[task.priority]}
          </span>
        </div>

        <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.25rem", flexWrap: "wrap", alignItems: "center" }}>
          {/* Contact link */}
          {task.contact && (
            <Link href={`/crm/contacts/${task.contactId}`} style={{ fontSize: "0.8125rem", color: "var(--accent)", textDecoration: "none" }}>
              {task.contact.displayName}
            </Link>
          )}
          {/* Due date */}
          {due && (
            <span style={{ display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.75rem", color: due.color }}>
              <Clock size={11} /> {due.label}
            </span>
          )}
          {/* Assigned to */}
          {task.assignedTo && (
            <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
              → {task.assignedTo.displayName}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CrmTasksPage() {
  const [activeTab, setActiveTab] = useState<Tab>("mine");
  const [tasks, setTasks] = useState<CrmTask[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (tab: Tab) => {
    setLoading(true);
    try {
      const params = new URLSearchParams(tabToQuery(tab));
      params.set("limit", "100");
      const data = await apiGet<TasksResponse>(`/crm/tasks?${params}`);
      setTasks(data.rows);
      setTotal(data.total);
    } catch {
      setTasks([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(activeTab); }, [activeTab, load]);

  const handleComplete = async (task: CrmTask) => {
    await apiPatch(`/crm/contacts/${task.contactId}/tasks/${task.id}`, { status: "DONE" });
    // Remove from current view (or reload)
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    setTotal((n) => Math.max(0, n - 1));
  };

  const openTasks = tasks.filter((t) => t.status === "OPEN" || t.status === "IN_PROGRESS");
  const doneTasks = tasks.filter((t) => t.status === "DONE" || t.status === "CANCELED");

  return (
    <div className="stack compact-stack">
      <PageHeader
        title="Tasks"
        subtitle="Follow-ups, reminders, and action items across all your contacts."
      />

      {/* Quick create */}
      <QuickCreateForm onCreated={() => load(activeTab)} />

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "2px solid var(--border)" }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "0.5rem 1.125rem",
              fontSize: "0.875rem",
              fontWeight: activeTab === tab.id ? 700 : 400,
              background: "none",
              border: "none",
              cursor: "pointer",
              color: activeTab === tab.id ? "var(--accent)" : "var(--text-dim)",
              borderBottom: activeTab === tab.id ? "2px solid var(--accent)" : "2px solid transparent",
              marginBottom: "-2px",
            }}
          >
            {tab.label}
          </button>
        ))}
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", fontSize: "0.75rem", color: "var(--text-dim)", paddingRight: "0.25rem" }}>
          {loading ? "…" : `${total} task${total !== 1 ? "s" : ""}`}
        </span>
      </div>

      {/* Task list */}
      <div className="panel" style={{ padding: "0.75rem 1.25rem" }}>
        {loading ? (
          <LoadingSkeleton rows={5} />
        ) : tasks.length === 0 ? (
          <div style={{ padding: "2rem 0", textAlign: "center" }}>
            <Check size={32} style={{ color: "#10b981", margin: "0 auto 0.5rem", display: "block" }} />
            <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--text-dim)" }}>
              {activeTab === "mine" ? "No open tasks assigned to you." :
               activeTab === "today" ? "Nothing due today." :
               activeTab === "overdue" ? "No overdue tasks. You're all caught up!" :
               "No tasks yet."}
            </p>
          </div>
        ) : (
          <>
            {openTasks.map((task) => (
              <TaskRow key={task.id} task={task} onComplete={handleComplete} />
            ))}
            {/* Completed tasks shown in "All" tab at the bottom */}
            {activeTab === "all" && doneTasks.length > 0 && (
              <>
                <div style={{ padding: "0.75rem 0 0.25rem", fontSize: "0.75rem", fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Completed / Canceled
                </div>
                {doneTasks.map((task) => (
                  <TaskRow key={task.id} task={task} onComplete={handleComplete} />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* Overdue banner */}
      {!loading && activeTab === "mine" && tasks.some((t) => t.dueAt && new Date(t.dueAt) < new Date()) && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.75rem 1rem", background: "#ef444415", borderRadius: "0.5rem", border: "1px solid #ef444430", fontSize: "0.8125rem", color: "#ef4444" }}>
          <AlertCircle size={14} />
          You have overdue tasks. Switch to the <strong style={{ margin: "0 0.25rem" }}>Overdue</strong> tab to review them.
        </div>
      )}
    </div>
  );
}

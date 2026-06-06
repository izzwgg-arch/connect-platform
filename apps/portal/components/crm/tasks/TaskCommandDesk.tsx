"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckSquare, Plus } from "lucide-react";
import { CRMPageHeader } from "../CRMPageHeader";
import {
  CRMWorkspaceShell,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceToolbar,
  CRMWorkspaceBody,
  CRMWorkspaceMain,
  CRMWorkspaceScrollRegion,
  CRMWorkspaceRightRail,
} from "../CRMWorkspaceShell";
import { apiDelete, apiGet, apiPatch } from "../../../services/apiClient";
import { TaskKpiStrip, TaskTabRow } from "./TaskKpiStrip";
import type { TaskStats, TaskTab } from "./TaskKpiStrip";
import { TaskFeed } from "./TaskFeed";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { TaskEmptyState } from "./TaskEmptyState";
import type { CrmTask, TaskPriority, TaskStatus } from "./TaskCard";
import { crm } from "../crmClasses";
import { cn } from "../cn";

// ── Types ─────────────────────────────────────────────────────────────────────

type TasksResponse = { rows: CrmTask[]; total: number; page: number; limit: number };

type TaskPanelMode = "summary" | "create" | "detail";

type TaskUpdatePayload = {
  title?: string;
  body?: string | null;
  dueAt?: string | null;
  priority?: TaskPriority;
  status?: TaskStatus;
};

const DEV_TASK_PREVIEW_COUNT = 22;

const DEV_TASK_ROWS: CrmTask[] = [
  {
    id: "dev-task-side-panel-qa",
    contactId: "dev-contact-side-panel",
    title: "Side Panel QA Task",
    body: "Confirm task rows open in the side panel and the main list stays visible.",
    dueAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    priority: "HIGH",
    status: "OPEN",
    createdAt: "2026-06-05T18:40:00.000Z",
    updatedAt: "2026-06-05T19:20:00.000Z",
    assignedTo: { id: "dev-user", displayName: "Local Dev" },
    createdBy: { id: "dev-user", displayName: "Local Dev" },
    contact: { id: "dev-contact-side-panel", displayName: "Side Panel QA Contact", company: "Connect QA" },
  },
  {
    id: "dev-task-live-call",
    contactId: "dev-contact-live-call",
    title: "Live Call Follow-up",
    body: "Send the recap and schedule the next outreach step.",
    dueAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
    priority: "MEDIUM",
    status: "OPEN",
    createdAt: "2026-06-05T17:55:00.000Z",
    updatedAt: "2026-06-05T18:10:00.000Z",
    assignedTo: { id: "dev-user", displayName: "Local Dev" },
    createdBy: { id: "dev-user", displayName: "Local Dev" },
    contact: { id: "dev-contact-live-call", displayName: "Morgan Fields", company: "Bluebird Capital" },
  },
  {
    id: "dev-task-underwriting",
    contactId: "dev-contact-underwriting",
    title: "Collect underwriting documents",
    body: "Ask for recent statements and owner ID before the funding review.",
    dueAt: new Date(Date.now() + 26 * 60 * 60_000).toISOString(),
    priority: "URGENT",
    status: "IN_PROGRESS",
    createdAt: "2026-06-05T16:15:00.000Z",
    updatedAt: "2026-06-05T17:30:00.000Z",
    assignedTo: { id: "dev-user", displayName: "Local Dev" },
    createdBy: { id: "dev-user", displayName: "Local Dev" },
    contact: { id: "dev-contact-underwriting", displayName: "Riley Chen", company: "Northstar Retail" },
  },
  {
    id: "dev-task-completed",
    contactId: "dev-contact-completed",
    title: "Send intro email",
    body: "Intro email and next-step summary sent.",
    dueAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    priority: "LOW",
    status: "DONE",
    completedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    createdAt: "2026-06-05T15:05:00.000Z",
    updatedAt: "2026-06-05T18:00:00.000Z",
    assignedTo: { id: "dev-user", displayName: "Local Dev" },
    createdBy: { id: "dev-user", displayName: "Local Dev" },
    completedBy: { id: "dev-user", displayName: "Local Dev" },
    contact: { id: "dev-contact-completed", displayName: "Alex Rivera", company: "Bright Path" },
  },
];

function isDevPreviewTask(task: CrmTask | null | undefined) {
  return Boolean(task?.id.startsWith("dev-task-"));
}

function cloneDevTask(task: CrmTask, index: number): CrmTask {
  const cloneNumber = index + 1;
  const dueOffset = (cloneNumber % 9) * 2 * 60 * 60_000;
  return {
    ...task,
    id: `${task.id}-preview-${cloneNumber}`,
    contactId: `${task.contactId}-preview-${cloneNumber}`,
    title: `${task.title} ${cloneNumber}`,
    dueAt:
      cloneNumber % 5 === 0
        ? null
        : new Date(Date.now() + dueOffset - (cloneNumber % 4 === 0 ? 30 * 60 * 60_000 : 0)).toISOString(),
    createdAt: new Date(new Date(task.createdAt).getTime() - cloneNumber * 11 * 60_000).toISOString(),
    updatedAt: new Date(new Date(task.updatedAt ?? task.createdAt).getTime() - cloneNumber * 7 * 60_000).toISOString(),
    contact: task.contact
      ? {
          ...task.contact,
          id: `${task.contact.id}-preview-${cloneNumber}`,
          displayName: `${task.contact.displayName} ${cloneNumber}`,
        }
      : undefined,
  };
}

function expandTasksForDevPreview(rows: CrmTask[]) {
  if (process.env.NODE_ENV !== "development") return rows;
  const source =
    rows.length === 0 || rows.length < DEV_TASK_PREVIEW_COUNT
      ? [...DEV_TASK_ROWS, ...rows]
      : rows;
  if (source.length >= DEV_TASK_PREVIEW_COUNT) return sortForTaskList(source);
  const clonesNeeded = DEV_TASK_PREVIEW_COUNT - source.length;
  const clones = Array.from({ length: clonesNeeded }, (_, index) =>
    cloneDevTask(source[index % source.length], index)
  );
  return sortForTaskList([...source, ...clones]);
}

// ── Tab query helpers ─────────────────────────────────────────────────────────

function tabToQuery(tab: TaskTab, assignedToMe: boolean): Record<string, string> {
  const query: Record<string, string> = {};
  if (assignedToMe) query.assignedTo = "me";
  if (tab === "today") return { ...query, status: "open", due: "today" };
  if (tab === "overdue") return { ...query, status: "open", due: "overdue" };
  if (tab === "completed") return { ...query, status: "DONE" };
  return { ...query, status: "all" };
}

async function getTaskTotal(params: Record<string, string>) {
  const search = new URLSearchParams(params);
  search.set("limit", "1");
  const data = await apiGet<TasksResponse>(`/crm/tasks?${search}`);
  return data.total;
}

function sortForTaskList(rows: CrmTask[]) {
  return [...rows].sort((a, b) => {
    const aDone = a.status === "DONE" || a.status === "CANCELED";
    const bDone = b.status === "DONE" || b.status === "CANCELED";
    if (aDone !== bDone) return aDone ? 1 : -1;
    const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    return aDue - bDue || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

// ── TaskCommandDesk ───────────────────────────────────────────────────────────

export function TaskCommandDesk({ initialTab }: { initialTab?: TaskTab }) {
  const [activeTab, setActiveTab] = useState<TaskTab>(initialTab ?? "all");
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [tasks, setTasks] = useState<CrmTask[]>([]);
  const [upcomingTasks, setUpcomingTasks] = useState<CrmTask[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<CrmTask | null>(null);
  const [panelMode, setPanelMode] = useState<TaskPanelMode>("summary");
  const [savedMsg, setSavedMsg] = useState("");
  const sourceTasks = useMemo(() => expandTasksForDevPreview(tasks), [tasks]);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const [data, scheduled, allTasks, completed] = await Promise.all([
        apiGet<TaskStats>("/crm/tasks/stats"),
        getTaskTotal({ status: "open", due: "upcoming" }),
        getTaskTotal({ status: "all" }),
        getTaskTotal({ status: "DONE" }),
      ]);
      setStats({ ...data, scheduled, allTasks, completed });
    } catch {
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const loadTasks = useCallback(async (tab: TaskTab, assigned: boolean) => {
    setLoading(true);
    try {
      const params = new URLSearchParams(tabToQuery(tab, assigned));
      params.set("limit", "100");
      const data = await apiGet<TasksResponse>(`/crm/tasks?${params}`);
      setTasks(sortForTaskList(data.rows));
      setTotal(data.total);
    } catch {
      setTasks([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadUpcomingTasks = useCallback(async () => {
    try {
      const params = new URLSearchParams({ status: "open", due: "upcoming", limit: "6" });
      const data = await apiGet<TasksResponse>(`/crm/tasks?${params}`);
      setUpcomingTasks(data.rows);
    } catch {
      setUpcomingTasks([]);
    }
  }, []);

  useEffect(() => {
    const dueParam = new URLSearchParams(window.location.search).get("due");
    if (dueParam === "today") setActiveTab("today");
    else if (dueParam === "overdue") setActiveTab("overdue");
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadUpcomingTasks(); }, [loadUpcomingTasks]);
  useEffect(() => { loadTasks(activeTab, assignedToMe); }, [activeTab, assignedToMe, loadTasks]);

  const triggerAdd = useCallback(() => {
    setPanelMode("create");
    setSelectedTask(null);
  }, []);

  // Keyboard shortcut: N = new task
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
      if (tgt.getAttribute("contenteditable") === "true") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        triggerAdd();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [triggerAdd]);

  const handleComplete = async (task: CrmTask) => {
    if (isDevPreviewTask(task)) {
      const updated: CrmTask = {
        ...task,
        status: "DONE",
        completedAt: new Date().toISOString(),
      };
      setSelectedTask((current) => (current?.id === task.id ? updated : current));
      setSavedMsg("Completed");
      window.setTimeout(() => setSavedMsg(""), 2500);
      return;
    }
    const updated = await apiPatch<CrmTask>(`/crm/contacts/${task.contactId}/tasks/${task.id}`, { status: "DONE" });
    setSelectedTask((current) => (current?.id === task.id ? updated : current));
    if (activeTab === "completed" || activeTab === "all") {
      await loadTasks(activeTab, assignedToMe);
    } else {
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      setTotal((n) => Math.max(0, n - 1));
    }
    loadStats();
    loadUpcomingTasks();
  };

  const handleCreated = (task: CrmTask) => {
    setSelectedTask(task);
    setPanelMode("detail");
    setSavedMsg("Created");
    window.setTimeout(() => setSavedMsg(""), 2500);
    void loadTasks(activeTab, assignedToMe);
    void loadStats();
    void loadUpcomingTasks();
  };

  const handleSelectTask = (task: CrmTask) => {
    setSelectedTask(task);
    setPanelMode("detail");
  };

  const handleSaveTask = async (task: CrmTask, payload: TaskUpdatePayload) => {
    if (isDevPreviewTask(task)) {
      const updated: CrmTask = {
        ...task,
        ...payload,
        updatedAt: new Date().toISOString(),
      };
      setSelectedTask(updated);
      setSavedMsg("Saved");
      window.setTimeout(() => setSavedMsg(""), 2500);
      return updated;
    }
    const updated = await apiPatch<CrmTask>(
      `/crm/contacts/${task.contactId}/tasks/${task.id}`,
      payload
    );
    const merged = {
      ...updated,
      contact: updated.contact ?? task.contact,
    };
    setSelectedTask(merged);
    setSavedMsg("Saved");
    window.setTimeout(() => setSavedMsg(""), 2500);
    void loadTasks(activeTab, assignedToMe);
    void loadStats();
    void loadUpcomingTasks();
    return merged;
  };

  const handleDeleteTask = async (task: CrmTask) => {
    if (!window.confirm(`Delete "${task.title}"? This removes the task.`)) return;
    if (!isDevPreviewTask(task)) {
      await apiDelete(`/crm/contacts/${task.contactId}/tasks/${task.id}`);
      void loadTasks(activeTab, assignedToMe);
      void loadStats();
      void loadUpcomingTasks();
    }
    setSelectedTask(null);
    setPanelMode("summary");
    setSavedMsg("Deleted");
    window.setTimeout(() => setSavedMsg(""), 2500);
  };

  const handleTabChange = (tab: TaskTab) => {
    setActiveTab(tab);
  };

  const isEmpty = !loading && sourceTasks.length === 0;

  return (
    <CRMWorkspaceShell>
      <CRMWorkspaceChrome>
        <CRMWorkspaceHeader>
          <CRMPageHeader
            compact
            icon={<CheckSquare className="h-5 w-5" />}
            title="Tasks"
            subtitle="Follow-ups, callbacks, and action items across your contacts."
            className={cn("tasks-page-header", crm.contactsHeaderPanel)}
            actions={
              <div className="contacts-hero-actions flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={triggerAdd}
                  className="tasks-primary-action"
                >
                  <Plus className="h-4 w-4" />
                  New Task
                </button>
              </div>
            }
          />
        </CRMWorkspaceHeader>

        <CRMWorkspaceToolbar className="flex flex-col gap-3">
          <TaskKpiStrip
            stats={stats}
            loading={statsLoading}
            activeTab={activeTab}
            onTabChange={handleTabChange}
          />
          <TaskTabRow
            activeTab={activeTab}
            onTabChange={handleTabChange}
            stats={stats}
            total={total}
            loading={loading}
            assignedToMe={assignedToMe}
            onAssignedToMeChange={setAssignedToMe}
          />
        </CRMWorkspaceToolbar>
      </CRMWorkspaceChrome>

      <CRMWorkspaceBody split>
        <CRMWorkspaceMain className="crm-queue-main-workspace">
          <CRMWorkspaceScrollRegion className="crm-queue-center-workspace">
            {isEmpty ? (
              <TaskEmptyState
                tab={activeTab}
                stats={stats}
                onAddTask={triggerAdd}
              />
            ) : (
              <TaskFeed
                tasks={sourceTasks}
                loading={loading}
                activeTab={activeTab}
                onComplete={handleComplete}
                selectedTaskId={selectedTask?.id ?? null}
                onSelect={handleSelectTask}
              />
            )}
          </CRMWorkspaceScrollRegion>
        </CRMWorkspaceMain>

        <CRMWorkspaceRightRail className="crm-queue-right-rail crm-queue-detail-rail flex flex-col min-h-0">
          <TaskDetailPanel
            task={panelMode === "detail" ? selectedTask : null}
            tasks={sourceTasks}
            mode={panelMode}
            stats={stats}
            statsLoading={statsLoading}
            upcomingTasks={upcomingTasks}
            savedMsg={savedMsg}
            onNewTask={triggerAdd}
            onCancelCreate={() => setPanelMode(selectedTask ? "detail" : "summary")}
            onCreated={handleCreated}
            onSave={handleSaveTask}
            onComplete={handleComplete}
            onDelete={handleDeleteTask}
            onSelectTask={handleSelectTask}
          />
        </CRMWorkspaceRightRail>
      </CRMWorkspaceBody>
    </CRMWorkspaceShell>
  );
}

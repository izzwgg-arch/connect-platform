"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { apiGet, apiPatch } from "../../../services/apiClient";
import { TaskKpiStrip, TaskTabRow } from "./TaskKpiStrip";
import type { TaskStats, TaskTab } from "./TaskKpiStrip";
import { TaskFeed } from "./TaskFeed";
import { TaskSidebar } from "./TaskSidebar";
import { TaskQuickAdd } from "./TaskQuickAdd";
import { TaskEmptyState } from "./TaskEmptyState";
import type { CrmTask } from "./TaskCard";

// ── Types ─────────────────────────────────────────────────────────────────────

type TasksResponse = { rows: CrmTask[]; total: number; page: number; limit: number };

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
  const [forceOpenAdd, setForceOpenAdd] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);

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
    setForceOpenAdd(true);
    setTimeout(() => addRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
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
    await apiPatch(`/crm/contacts/${task.contactId}/tasks/${task.id}`, { status: "DONE" });
    if (activeTab === "completed" || activeTab === "all") {
      await loadTasks(activeTab, assignedToMe);
    } else {
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      setTotal((n) => Math.max(0, n - 1));
    }
    loadStats();
    loadUpcomingTasks();
  };

  const handleCreated = () => {
    loadTasks(activeTab, assignedToMe);
    loadStats();
    loadUpcomingTasks();
  };

  const handleTabChange = (tab: TaskTab) => {
    setActiveTab(tab);
  };

  const isEmpty = !loading && tasks.length === 0;

  return (
    <CRMWorkspaceShell>
      <CRMWorkspaceChrome>
        <CRMWorkspaceHeader>
          <CRMPageHeader
            icon={<CheckSquare className="h-5 w-5" />}
            title="Tasks"
            subtitle="Follow-ups, callbacks, and action items across your contacts."
            className="tasks-page-header"
            actions={
              <button
                type="button"
                onClick={triggerAdd}
                className="tasks-primary-action"
              >
                <Plus className="h-4 w-4" />
                New Task
              </button>
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
          <div ref={addRef}>
            <TaskQuickAdd
              onCreated={handleCreated}
              forceOpen={forceOpenAdd}
              onForceOpenConsumed={() => setForceOpenAdd(false)}
            />
          </div>
        </CRMWorkspaceToolbar>
      </CRMWorkspaceChrome>

      <CRMWorkspaceBody split>
        <CRMWorkspaceMain>
          <CRMWorkspaceScrollRegion>
            {isEmpty ? (
              <TaskEmptyState
                tab={activeTab}
                stats={stats}
                onAddTask={triggerAdd}
              />
            ) : (
              <TaskFeed
                tasks={tasks}
                loading={loading}
                activeTab={activeTab}
                onComplete={handleComplete}
              />
            )}
          </CRMWorkspaceScrollRegion>
        </CRMWorkspaceMain>

        <CRMWorkspaceRightRail>
          <TaskSidebar
            stats={stats}
            statsLoading={statsLoading}
            upcomingTasks={upcomingTasks}
            onCreateTask={triggerAdd}
          />
        </CRMWorkspaceRightRail>
      </CRMWorkspaceBody>
    </CRMWorkspaceShell>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckSquare, Plus } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { CRMPageHeader } from "../CRMPageHeader";
import { apiGet, apiPatch } from "../../../services/apiClient";
import { TaskKpiStrip, TaskTabRow } from "./TaskKpiStrip";
import type { TaskStats } from "./TaskKpiStrip";
import { TaskFeed } from "./TaskFeed";
import { TaskSidebar } from "./TaskSidebar";
import { TaskQuickAdd } from "./TaskQuickAdd";
import { TaskEmptyState } from "./TaskEmptyState";
import type { CrmTask } from "./TaskCard";

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = "mine" | "today" | "overdue" | "all";

type TasksResponse = { rows: CrmTask[]; total: number; page: number; limit: number };

// ── Tab query helpers ─────────────────────────────────────────────────────────

function tabToQuery(tab: Tab): Record<string, string> {
  if (tab === "mine") return { assignedTo: "me", status: "open" };
  if (tab === "today") return { status: "open", due: "today" };
  if (tab === "overdue") return { status: "open", due: "overdue" };
  return {};
}

// ── TaskCommandDesk ───────────────────────────────────────────────────────────

export function TaskCommandDesk({ initialTab }: { initialTab?: Tab }) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? "mine");
  const [tasks, setTasks] = useState<CrmTask[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [forceOpenAdd, setForceOpenAdd] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const data = await apiGet<TaskStats>("/crm/tasks/stats");
      setStats(data);
    } catch {
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const loadTasks = useCallback(async (tab: Tab) => {
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

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadTasks(activeTab); }, [activeTab, loadTasks]);

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
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    setTotal((n) => Math.max(0, n - 1));
    // Refresh stats
    loadStats();
  };

  const handleCreated = () => {
    loadTasks(activeTab);
    loadStats();
  };

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
  };

  const isEmpty = !loading && tasks.length === 0;

  return (
    <div className={cn(crm.tasksWorkspace, crm.pageInnerTasks)}>
      {/* Command header */}
      <CRMPageHeader
        icon={<CheckSquare className="h-5 w-5" />}
        title="Tasks"
        subtitle="Follow-ups, callbacks, and action items across your contacts."
        actions={
          <button
            type="button"
            onClick={triggerAdd}
            className={crm.btnPrimary}
          >
            <Plus className="h-4 w-4" />
            New task
          </button>
        }
      />

      {/* KPI strip */}
      <TaskKpiStrip
        stats={stats}
        loading={statsLoading}
        activeTab={activeTab}
        onTabChange={handleTabChange}
      />

      {/* Main 2-column layout */}
      <div className={crm.tasksGrid}>
        {/* Feed column */}
        <div className={crm.tasksMainCol}>
          {/* Tab row */}
          <TaskTabRow
            activeTab={activeTab}
            onTabChange={handleTabChange}
            stats={stats}
            total={total}
            loading={loading}
          />

          {/* Quick add */}
          <div ref={addRef}>
            <TaskQuickAdd
              onCreated={handleCreated}
              forceOpen={forceOpenAdd}
              onForceOpenConsumed={() => setForceOpenAdd(false)}
            />
          </div>

          {/* Task feed or empty state */}
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
        </div>

        {/* Sidebar column */}
        <aside className={crm.tasksSideCol}>
          <TaskSidebar stats={stats} statsLoading={statsLoading} />
        </aside>
      </div>
    </div>
  );
}

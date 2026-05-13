"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BarChart3, RefreshCw, CheckCheck, PhoneCall, UserCheck,
  Users, AlertCircle, CalendarClock, Clock, Inbox,
  TrendingUp, Megaphone, ListOrdered, CheckSquare,
} from "lucide-react";
import { apiGet } from "../../../../services/apiClient";

// ── Shared types ──────────────────────────────────────────────────────────────

type DailyReport = {
  dispositionsToday: number;
  callsLinkedToday: number;
  contactsCreatedToday: number;
  tasksDueToday: number;
  overdueTasks: number;
  callbacksDueToday: number;
  overdueCallbacks: number;
  activeCampaigns: number;
  queueRemaining: number;
};

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  total: number;
  pending: number;
  contacted: number;
  callbacks: number;
  converted: number;
  dnc: number;
  conversionRate: number;
  totalAttempts: number;
  lastActivityAt: string;
};

type AgentRow = {
  userId: string;
  displayName: string;
  email: string;
  crmRole: string;
  assignedQueue: number;
  callbacksDueToday: number;
  dispositionsToday: number;
  convertedLast: number;
  openTasks: number;
  lookbackDays: number;
};

type FollowUpMember = {
  id: string;
  contactId: string;
  contactName: string;
  contactPhone: string | null;
  campaign: { id: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
  callbackAt: string | null;
  callbackNote: string | null;
  attemptCount: number;
};

type FollowUpTask = {
  id: string;
  contactId: string;
  contactName: string;
  contactPhone: string | null;
  title: string;
  dueAt: string | null;
  priority: string;
  assignedTo: { id: string; name: string } | null;
};

type FollowUpsReport = {
  callbacks: {
    overdue:     { count: number; rows: FollowUpMember[] };
    dueToday:    { count: number; rows: FollowUpMember[] };
    dueThisWeek: { count: number; rows: FollowUpMember[] };
  };
  tasks: {
    overdue:  { count: number; rows: FollowUpTask[] };
    dueToday: { count: number; rows: FollowUpTask[] };
  };
};

// ── Tabs ──────────────────────────────────────────────────────────────────────

type ReportTab = "daily" | "campaigns" | "agents" | "follow-ups";

function Tab({ id, label, icon, active, onClick }: {
  id: ReportTab; label: string; icon: React.ReactNode; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors ${
        active ? "bg-white shadow-sm text-blue-700 border border-blue-200" : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
      }`}
    >
      {icon}{label}
    </button>
  );
}

// ── Shared UI pieces ──────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base font-semibold text-gray-800 mb-3">{children}</h2>;
}

function EmptyRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="py-8 text-center text-sm text-gray-400 italic">
        <Inbox className="h-5 w-5 mx-auto mb-2 text-gray-300" />
        No data for this period
      </td>
    </tr>
  );
}

function StatCard({ label, value, note, icon, urgent, href }: {
  label: string; value: number | string; note?: string; icon: React.ReactNode; urgent?: boolean; href?: string;
}) {
  const inner = (
    <div className={`bg-white rounded-xl border p-4 flex flex-col gap-1 ${urgent && Number(value) > 0 ? "border-red-200 bg-red-50" : "border-gray-200"}`}>
      <div className="flex items-center justify-between">
        <span className={`text-xs font-semibold uppercase tracking-wider ${urgent && Number(value) > 0 ? "text-red-500" : "text-gray-500"}`}>{label}</span>
        <span className={urgent && Number(value) > 0 ? "text-red-400" : "text-gray-300"}>{icon}</span>
      </div>
      <div className={`text-3xl font-bold ${urgent && Number(value) > 0 ? "text-red-700" : "text-gray-900"}`}>{value}</div>
      {note && <div className="text-xs text-gray-400">{note}</div>}
    </div>
  );
  return href ? <Link href={href} className="block hover:no-underline">{inner}</Link> : inner;
}

// ── Date range selector ───────────────────────────────────────────────────────

function DayRangePicker({ value, onChange }: { value: number; onChange: (d: number) => void }) {
  return (
    <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg">
      {([1, 7, 30] as const).map((d) => (
        <button
          key={d}
          onClick={() => onChange(d)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            value === d ? "bg-white shadow-sm text-blue-700" : "text-gray-500 hover:text-gray-800"
          }`}
        >
          {d === 1 ? "Today" : `${d} days`}
        </button>
      ))}
    </div>
  );
}

// ── Campaign status badge ─────────────────────────────────────────────────────

function CampaignStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ACTIVE: "bg-green-100 text-green-700",
    PAUSED: "bg-yellow-100 text-yellow-700",
    COMPLETED: "bg-blue-100 text-blue-700",
    DRAFT: "bg-gray-100 text-gray-600",
    ARCHIVED: "bg-gray-100 text-gray-400",
  };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? "bg-gray-100 text-gray-600"}`}>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function MiniProgress({ value, max, color = "bg-blue-500" }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-10 text-right">{value}/{max}</span>
    </div>
  );
}

// ── Daily tab ─────────────────────────────────────────────────────────────────

function DailyTab({ token }: { token: string | undefined }) {
  const [data, setData] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<DailyReport>("/crm/reports/daily", token)
      .then(setData).catch(() => {}).finally(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>;
  if (!data) return <div className="py-16 text-center text-red-400 text-sm">Failed to load</div>;

  return (
    <div className="space-y-6">
      <div>
        <SectionHeader>Today at a Glance</SectionHeader>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <StatCard label="Dispositions" value={data.dispositionsToday} note="outcomes saved today" icon={<CheckCheck className="h-5 w-5" />} href="/crm/reports?tab=agents" />
          <StatCard label="Calls Linked" value={data.callsLinkedToday} note="CDR events tied to contacts" icon={<PhoneCall className="h-5 w-5" />} />
          <StatCard label="Contacts Added" value={data.contactsCreatedToday} note="CRM-enrolled today" icon={<UserCheck className="h-5 w-5" />} href="/crm/contacts" />
          <StatCard label="Active Campaigns" value={data.activeCampaigns} note="running now" icon={<Megaphone className="h-5 w-5" />} href="/crm/campaigns" />
          <StatCard label="Queue Remaining" value={data.queueRemaining} note="across active campaigns" icon={<ListOrdered className="h-5 w-5" />} href="/crm/queue" />
          <StatCard label="Tasks Due Today" value={data.tasksDueToday} note="assigned to anyone" icon={<CheckSquare className="h-5 w-5" />} href="/crm/reports?tab=follow-ups" />
          <StatCard label="Overdue Tasks" value={data.overdueTasks} note="need attention" icon={<AlertCircle className="h-5 w-5" />} urgent href="/crm/reports?tab=follow-ups" />
          <StatCard label="Callbacks Due" value={data.callbacksDueToday} note="today (incl. overdue)" icon={<CalendarClock className="h-5 w-5" />} urgent={data.overdueCallbacks > 0} href="/crm/reports?tab=follow-ups" />
        </div>
      </div>
    </div>
  );
}

// ── Campaigns tab ─────────────────────────────────────────────────────────────

function CampaignsTab({ token }: { token: string | undefined }) {
  const [data, setData] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const router = useRouter();

  const load = useCallback((sf: string) => {
    setLoading(true);
    apiGet<{ campaigns: CampaignRow[] }>(`/crm/reports/campaigns?status=${sf}`, token)
      .then((r) => setData(r.campaigns)).catch(() => {}).finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(statusFilter); }, [load, statusFilter]);

  function switchStatus(s: string) { setStatusFilter(s); load(s); }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <SectionHeader>Campaign Performance</SectionHeader>
        <div className="ml-auto flex gap-1 p-1 bg-gray-100 rounded-lg">
          {["all", "ACTIVE", "PAUSED", "COMPLETED"].map((s) => (
            <button key={s} onClick={() => switchStatus(s)} className={`px-3 py-1 text-xs font-medium rounded-md ${statusFilter === s ? "bg-white shadow-sm text-blue-700" : "text-gray-500 hover:text-gray-800"}`}>
              {s === "all" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="border-b bg-gray-50 text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3 font-medium">Campaign</th>
                <th className="px-4 py-3 font-medium text-center">Status</th>
                <th className="px-4 py-3 font-medium text-center">Total</th>
                <th className="px-4 py-3 font-medium text-center">Pending</th>
                <th className="px-4 py-3 font-medium text-center">Contacted</th>
                <th className="px-4 py-3 font-medium text-center">Callbacks</th>
                <th className="px-4 py-3 font-medium text-center">Converted</th>
                <th className="px-4 py-3 font-medium text-center">DNC/Skip</th>
                <th className="px-4 py-3 font-medium">Conversion</th>
                <th className="px-4 py-3 font-medium text-center">Attempts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.length === 0 ? <EmptyRow cols={10} /> : data.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => router.push(`/crm/campaigns/${c.id}`)}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{c.name}</p>
                    <p className="text-xs text-gray-400">
                      Last activity {new Date(c.lastActivityAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-center"><CampaignStatusBadge status={c.status} /></td>
                  <td className="px-4 py-3 text-center font-medium text-gray-700">{c.total}</td>
                  <td className="px-4 py-3 text-center text-gray-500">{c.pending}</td>
                  <td className="px-4 py-3 text-center text-purple-700">{c.contacted}</td>
                  <td className="px-4 py-3 text-center text-yellow-700">{c.callbacks}</td>
                  <td className="px-4 py-3 text-center text-green-700 font-semibold">{c.converted}</td>
                  <td className="px-4 py-3 text-center text-gray-400">{c.dnc}</td>
                  <td className="px-4 py-3 min-w-[120px]">
                    <div className="flex items-center gap-2">
                      <MiniProgress value={c.converted} max={c.total} color="bg-green-500" />
                      <span className="text-xs font-medium text-gray-700 shrink-0">{c.conversionRate}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center text-gray-500">{c.totalAttempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Agents tab ────────────────────────────────────────────────────────────────

function AgentsTab({ token }: { token: string | undefined }) {
  const [data, setData] = useState<AgentRow[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  const load = useCallback((d: number) => {
    setLoading(true);
    apiGet<{ agents: AgentRow[] }>(`/crm/reports/agents?days=${d}`, token)
      .then((r) => setData(r.agents)).catch(() => {}).finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(days); }, [load, days]);

  function switchDays(d: number) { setDays(d); load(d); }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <SectionHeader>Agent Activity</SectionHeader>
        <div className="ml-auto"><DayRangePicker value={days} onChange={switchDays} /></div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="border-b bg-gray-50 text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3 font-medium">Agent</th>
                <th className="px-4 py-3 font-medium text-center">Role</th>
                <th className="px-4 py-3 font-medium text-center">Queue</th>
                <th className="px-4 py-3 font-medium text-center">Callbacks Due</th>
                <th className="px-4 py-3 font-medium text-center">Dispositions Today</th>
                <th className="px-4 py-3 font-medium text-center">Converted ({days}d)</th>
                <th className="px-4 py-3 font-medium text-center">Open Tasks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.length === 0 ? <EmptyRow cols={7} /> : data.map((a) => (
                <tr key={a.userId} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{a.displayName}</p>
                    <p className="text-xs text-gray-400">{a.email}</p>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                      a.crmRole === "ADMIN" ? "bg-indigo-100 text-indigo-700" :
                      a.crmRole === "MANAGER" ? "bg-blue-100 text-blue-700" :
                      "bg-gray-100 text-gray-600"
                    }`}>{a.crmRole}</span>
                  </td>
                  <td className="px-4 py-3 text-center text-gray-700">{a.assignedQueue}</td>
                  <td className={`px-4 py-3 text-center font-medium ${a.callbacksDueToday > 0 ? "text-yellow-700" : "text-gray-400"}`}>
                    {a.callbacksDueToday > 0 ? a.callbacksDueToday : "—"}
                  </td>
                  <td className={`px-4 py-3 text-center font-semibold ${a.dispositionsToday > 0 ? "text-blue-700" : "text-gray-400"}`}>
                    {a.dispositionsToday > 0 ? a.dispositionsToday : "—"}
                  </td>
                  <td className={`px-4 py-3 text-center font-semibold ${a.convertedLast > 0 ? "text-green-700" : "text-gray-400"}`}>
                    {a.convertedLast > 0 ? a.convertedLast : "—"}
                  </td>
                  <td className={`px-4 py-3 text-center ${a.openTasks > 5 ? "text-orange-600 font-medium" : "text-gray-500"}`}>
                    {a.openTasks || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Follow-ups tab ────────────────────────────────────────────────────────────

function FollowUpsTab({ token }: { token: string | undefined }) {
  const [data, setData] = useState<FollowUpsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    apiGet<FollowUpsReport>("/crm/reports/follow-ups", token)
      .then(setData).catch(() => {}).finally(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>;
  if (!data)   return <div className="py-16 text-center text-red-400 text-sm">Failed to load</div>;

  function CallbackTable({ title, bucket, urgent }: { title: string; bucket: { count: number; rows: FollowUpMember[] }; urgent?: boolean }) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-2">
          <h3 className={`text-sm font-semibold ${urgent ? "text-red-700" : "text-gray-700"}`}>{title}</h3>
          {bucket.count > 0 && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${urgent ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}`}>
              {bucket.count}
            </span>
          )}
        </div>
        {bucket.count === 0 ? (
          <p className="text-sm text-gray-400 italic py-2">None</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="bg-gray-50 border-b text-xs text-gray-500 uppercase tracking-wider">
                  <th className="px-3 py-2 font-medium">Contact</th>
                  <th className="px-3 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2 font-medium">Callback Time</th>
                  <th className="px-3 py-2 font-medium">Note</th>
                  <th className="px-3 py-2 font-medium">Assigned</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {bucket.rows.map((m) => (
                  <tr key={m.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => router.push(`/crm/contacts/${m.contactId}`)}>
                    <td className="px-3 py-2">
                      <p className="font-medium text-gray-900">{m.contactName}</p>
                      {m.contactPhone && <p className="text-xs text-gray-400">{m.contactPhone}</p>}
                    </td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{m.campaign?.name ?? "—"}</td>
                    <td className={`px-3 py-2 text-xs font-medium ${urgent ? "text-red-700" : "text-yellow-700"}`}>
                      {m.callbackAt ? new Date(m.callbackAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500 italic max-w-[200px] truncate">{m.callbackNote ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{m.assignedTo?.name ?? "Unassigned"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  function TaskTable({ title, bucket, urgent }: { title: string; bucket: { count: number; rows: FollowUpTask[] }; urgent?: boolean }) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-2">
          <h3 className={`text-sm font-semibold ${urgent ? "text-red-700" : "text-gray-700"}`}>{title}</h3>
          {bucket.count > 0 && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${urgent ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700"}`}>
              {bucket.count}
            </span>
          )}
        </div>
        {bucket.count === 0 ? (
          <p className="text-sm text-gray-400 italic py-2">None</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="bg-gray-50 border-b text-xs text-gray-500 uppercase tracking-wider">
                  <th className="px-3 py-2 font-medium">Contact</th>
                  <th className="px-3 py-2 font-medium">Task</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                  <th className="px-3 py-2 font-medium">Priority</th>
                  <th className="px-3 py-2 font-medium">Assigned</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {bucket.rows.map((t) => (
                  <tr key={t.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => router.push(`/crm/contacts/${t.contactId}`)}>
                    <td className="px-3 py-2">
                      <p className="font-medium text-gray-900">{t.contactName}</p>
                      {t.contactPhone && <p className="text-xs text-gray-400">{t.contactPhone}</p>}
                    </td>
                    <td className="px-3 py-2 text-gray-700 max-w-[200px] truncate">{t.title}</td>
                    <td className={`px-3 py-2 text-xs font-medium ${urgent ? "text-red-700" : "text-orange-700"}`}>
                      {t.dueAt ? new Date(t.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                        t.priority === "URGENT" ? "bg-red-100 text-red-700" :
                        t.priority === "HIGH" ? "bg-orange-100 text-orange-700" :
                        "bg-gray-100 text-gray-600"
                      }`}>{t.priority}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">{t.assignedTo?.name ?? "Unassigned"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  const totalUrgent = data.callbacks.overdue.count + data.tasks.overdue.count;

  return (
    <div className="space-y-8">
      {totalUrgent > 0 && (
        <div className="flex items-center gap-3 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <strong>{totalUrgent} overdue item{totalUrgent !== 1 ? "s" : ""} need immediate attention.</strong>
        </div>
      )}

      <div>
        <SectionHeader>Callbacks</SectionHeader>
        <div className="space-y-6">
          <CallbackTable title="Overdue Callbacks" bucket={data.callbacks.overdue} urgent />
          <CallbackTable title="Due Today" bucket={data.callbacks.dueToday} />
          <CallbackTable title="Due This Week" bucket={data.callbacks.dueThisWeek} />
        </div>
      </div>

      <div>
        <SectionHeader>Tasks</SectionHeader>
        <div className="space-y-6">
          <TaskTable title="Overdue Tasks" bucket={data.tasks.overdue} urgent />
          <TaskTable title="Due Today" bucket={data.tasks.dueToday} />
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const [tab, setTab] = useState<ReportTab>("daily");
  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  // Support ?tab= in URL for deep-linking from dashboard stat cards
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    if (t === "daily" || t === "campaigns" || t === "agents" || t === "follow-ups") {
      setTab(t);
    }
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <BarChart3 className="h-6 w-6 text-blue-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">CRM Reports</h1>
            <p className="text-sm text-gray-500 mt-0.5">Activity, performance &amp; follow-up health across your team.</p>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 p-1 bg-gray-100 rounded-xl mb-6 overflow-x-auto w-fit">
          <Tab id="daily" label="Daily Summary" icon={<TrendingUp className="h-4 w-4" />} active={tab === "daily"} onClick={() => setTab("daily")} />
          <Tab id="campaigns" label="Campaigns" icon={<Megaphone className="h-4 w-4" />} active={tab === "campaigns"} onClick={() => setTab("campaigns")} />
          <Tab id="agents" label="Agents" icon={<Users className="h-4 w-4" />} active={tab === "agents"} onClick={() => setTab("agents")} />
          <Tab id="follow-ups" label="Follow-ups" icon={<Clock className="h-4 w-4" />} active={tab === "follow-ups"} onClick={() => setTab("follow-ups")} />
        </div>

        {/* Content */}
        {tab === "daily"     && <DailyTab token={token} />}
        {tab === "campaigns" && <CampaignsTab token={token} />}
        {tab === "agents"    && <AgentsTab token={token} />}
        {tab === "follow-ups" && <FollowUpsTab token={token} />}
      </div>
    </div>
  );
}

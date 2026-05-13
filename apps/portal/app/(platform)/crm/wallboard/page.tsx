"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  PhoneCall, Users, Megaphone, CalendarClock,
  AlertCircle, RefreshCw, Clock, ArrowRight, CheckCheck,
  PhoneIncoming, PhoneOutgoing, Phone, Inbox,
  TrendingUp, CheckSquare, LayoutGrid,
  Zap, ChevronRight, Tv, X, AlertTriangle,
} from "lucide-react";
import { apiGet } from "../../../../services/apiClient";
import { useTelephony } from "../../../../contexts/TelephonyContext";
import type { LiveCall } from "../../../../types/liveCall";

// ── Constants ──────────────────────────────────────────────────────────────────

const REFRESH_MS   = 60_000; // CRM report panels refresh every 60 s
const TICK_MS      = 10_000; // Live call duration display ticks every 10 s
const COUNTDOWN_S  = REFRESH_MS / 1000; // 60

// ── Types ─────────────────────────────────────────────────────────────────────

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
  /** SIP extension numbers owned by this user (e.g. ["101"]). Empty array = no extension assigned. */
  extensions: string[];
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
  title: string;
  dueAt: string | null;
  priority: string;
  assignedTo: { id: string; name: string } | null;
};

type FollowUpsReport = {
  callbacks: {
    overdue:  { count: number; rows: FollowUpMember[] };
    dueToday: { count: number; rows: FollowUpMember[] };
  };
  tasks: {
    overdue:  { count: number; rows: FollowUpTask[] };
    dueToday: { count: number; rows: FollowUpTask[] };
  };
};

type WallboardData = {
  daily:     DailyReport;
  campaigns: CampaignRow[];
  agents:    AgentRow[];
  followUps: FollowUpsReport;
};

// "needs-attention" = overdue callbacks and nothing done today (most urgent)
// "callbacks-due"   = callbacks due but some activity today
// "no-outcomes"     = has queue items but no dispositions logged today
// "active"          = has dispositions or conversions today
// "idle"            = no queue, no activity (new/unassigned agent)
type AgentStatusFlag = "needs-attention" | "callbacks-due" | "no-outcomes" | "active" | "idle";

// ── Helpers ───────────────────────────────────────────────────────────────────

function callDuration(startedAt: string, answeredAt: string | null): string {
  const base = answeredAt ?? startedAt;
  const secs = Math.max(0, Math.floor((Date.now() - new Date(base).getTime()) / 1000));
  if (secs < 60)   return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function relTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function callbackLabel(iso: string): { label: string; overdue: boolean } {
  const d = new Date(iso);
  const diff = d.getTime() - Date.now();
  if (diff < 0) return { label: `${Math.floor(Math.abs(diff) / 3600000)}h overdue`, overdue: true };
  if (diff < 3600000)  return { label: `in ${Math.floor(diff / 60000)}m`, overdue: false };
  if (diff < 86400000) return { label: `in ${Math.floor(diff / 3600000)}h`, overdue: false };
  return { label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), overdue: false };
}

function formatClock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatClockDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function agentStatus(a: AgentRow): AgentStatusFlag {
  if (a.callbacksDueToday > 0 && a.dispositionsToday === 0) return "needs-attention";
  if (a.callbacksDueToday > 0) return "callbacks-due";
  if (a.assignedQueue > 0 && a.dispositionsToday === 0) return "no-outcomes";
  if (a.dispositionsToday > 0 || a.convertedLast > 0) return "active";
  return "idle";
}

/**
 * Find the active call an agent is on, matched via their SIP extension number(s).
 * Checks call.extensions[], call.source_extension, and call.destination_extension.
 * Returns null when extensions list is empty (no extension assigned) or no match found.
 */
function findAgentCall(extensions: string[], calls: LiveCall[]): LiveCall | null {
  if (!extensions.length || !calls.length) return null;
  const extSet = new Set(extensions);
  for (const call of calls) {
    if (
      call.extensions.some((e) => extSet.has(e)) ||
      (call.source_extension      != null && extSet.has(call.source_extension))      ||
      (call.destination_extension != null && extSet.has(call.destination_extension))
    ) {
      return call;
    }
  }
  return null;
}

// ── Summary strip stat card ───────────────────────────────────────────────────

function StripStat({
  label, value, icon, urgent, href, tv,
}: {
  label: string; value: number | string; icon: React.ReactNode;
  urgent?: boolean; href?: string; tv?: boolean;
}) {
  const base = `flex flex-col items-center justify-center gap-1 rounded-xl flex-1 ${
    tv ? "p-5 min-w-[130px]" : "p-4 min-w-[110px]"
  } ${
    urgent && Number(value) > 0
      ? "bg-red-600/80 ring-2 ring-red-400"
      : tv ? "bg-white/10" : "bg-white/10"
  }`;
  const numCls = `font-bold tabular-nums ${tv ? "text-5xl" : "text-3xl"} ${
    urgent && Number(value) > 0 ? "text-red-100" : "text-white"
  }`;
  const lblCls = `font-medium text-center leading-tight ${tv ? "text-sm" : "text-xs"} ${
    urgent && Number(value) > 0 ? "text-red-200" : "text-white/70"
  }`;

  const inner = (
    <div className={base}>
      <div className={`mb-0.5 ${tv ? "text-white/50" : "text-white/60"}`}>{icon}</div>
      <div className={numCls}>{value}</div>
      <div className={lblCls}>{label}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="flex-1 min-w-[110px] hover:opacity-90 transition-opacity">
      {inner}
    </Link>
  ) : inner;
}

// ── Panel wrapper ─────────────────────────────────────────────────────────────

function Panel({
  title, icon, count, children, href, badge, badgeUrgent, tv,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
  href?: string;
  badge?: string;
  badgeUrgent?: boolean;
  tv?: boolean;
}) {
  const panelCls = tv
    ? "bg-gray-800 rounded-2xl border border-gray-700 shadow-lg flex flex-col overflow-hidden"
    : "bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col overflow-hidden";
  const headerCls = tv
    ? "flex items-center justify-between px-5 py-4 border-b border-gray-700 bg-gray-900/60"
    : "flex items-center justify-between px-5 py-3.5 border-b border-gray-100 bg-gray-50/60";
  const titleCls = tv
    ? "text-base font-bold text-gray-100 tracking-tight"
    : "text-sm font-bold text-gray-800 tracking-tight";
  const iconCls = tv ? "text-gray-400" : "text-gray-400";

  return (
    <div className={panelCls}>
      <div className={headerCls}>
        <div className="flex items-center gap-2.5">
          <span className={iconCls}>{icon}</span>
          <h2 className={titleCls}>{title}</h2>
          {count !== undefined && (
            <span className={`px-2 py-0.5 rounded-full font-bold ${
              tv ? "text-sm" : "text-xs"
            } ${
              badgeUrgent && count > 0
                ? "bg-red-100 text-red-700"
                : tv ? "bg-gray-700 text-gray-300" : "bg-gray-100 text-gray-500"
            }`}>
              {count}
            </span>
          )}
          {badge && (
            <span className={`px-2 py-0.5 rounded-full font-medium ${
              tv ? "text-sm" : "text-xs"
            } ${
              badgeUrgent
                ? "bg-red-100 text-red-700"
                : tv ? "bg-blue-900 text-blue-300" : "bg-blue-50 text-blue-600"
            }`}>
              {badge}
            </span>
          )}
        </div>
        {href && !tv && (
          <Link href={href} className="text-xs text-blue-600 hover:underline flex items-center gap-1 shrink-0">
            View all <ChevronRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}

// ── Agent status badge ────────────────────────────────────────────────────────

function AgentBadge({ flag, tv }: { flag: AgentStatusFlag; tv?: boolean }) {
  const sz = tv ? "text-xs px-2 py-1" : "text-xs px-1.5 py-0.5";
  if (flag === "needs-attention") {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full font-semibold bg-red-100 text-red-700 ${sz}`}>
        <AlertTriangle className="h-3 w-3" /> Needs attention
      </span>
    );
  }
  if (flag === "callbacks-due") {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full font-semibold bg-orange-100 text-orange-700 ${sz}`}>
        <CalendarClock className="h-3 w-3" /> Callbacks due
      </span>
    );
  }
  if (flag === "no-outcomes") {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full font-semibold bg-amber-100 text-amber-700 ${sz}`}>
        <Clock className="h-3 w-3" /> No outcomes today
      </span>
    );
  }
  return null;
}

// ── On-call badge ─────────────────────────────────────────────────────────────

function OnCallBadge({ call, tv }: { call: LiveCall; tv?: boolean }) {
  const sz      = tv ? "text-xs px-2.5 py-1.5" : "text-xs px-2 py-0.5";
  const iconSz  = tv ? "h-3.5 w-3.5" : "h-3 w-3";
  const dur     = callDuration(call.startedAt, call.answeredAt);
  const isIn    = call.direction === "inbound";
  const isOut   = call.direction === "outbound";
  const DirIcon = isIn  ? PhoneIncoming
                : isOut ? PhoneOutgoing
                        : Phone;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${sz} ${
      tv
        ? "bg-green-900/70 text-green-300 ring-1 ring-green-600"
        : "bg-green-100 text-green-800"
    }`}>
      <DirIcon className={`${iconSz} shrink-0`} />
      On call · {dur}
    </span>
  );
}

// ── Live Calls Panel ──────────────────────────────────────────────────────────

function LiveCallsPanel({ calls, isLive, tv }: { calls: LiveCall[]; isLive: boolean; tv?: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const callStateColor: Record<string, string> = tv
    ? {
        ringing: "bg-yellow-900/80 text-yellow-300",
        dialing: "bg-blue-900/80 text-blue-300",
        up:      "bg-green-900/80 text-green-300",
        held:    "bg-gray-700 text-gray-400",
        unknown: "bg-gray-700 text-gray-400",
      }
    : {
        ringing: "bg-yellow-100 text-yellow-800",
        dialing: "bg-blue-100 text-blue-700",
        up:      "bg-green-100 text-green-800",
        held:    "bg-gray-100 text-gray-600",
        unknown: "bg-gray-100 text-gray-500",
      };

  function DirectionIcon({ direction }: { direction: LiveCall["direction"] }) {
    if (direction === "inbound")  return <PhoneIncoming className={`${tv ? "h-4 w-4" : "h-3.5 w-3.5"} text-green-500`} />;
    if (direction === "outbound") return <PhoneOutgoing className={`${tv ? "h-4 w-4" : "h-3.5 w-3.5"} text-blue-400`} />;
    return <Phone className={`${tv ? "h-4 w-4" : "h-3.5 w-3.5"} text-gray-400`} />;
  }

  const emptyTextCls = tv ? "text-gray-500 text-base" : "text-gray-400 text-sm";
  const emptyIconCls = tv ? "h-10 w-10 mx-auto mb-3 text-gray-700" : "h-8 w-8 mx-auto mb-2 text-gray-200";
  const rowCls = tv ? "flex items-center gap-4 px-5 py-4 border-b border-gray-700/60" : "flex items-center gap-3 px-5 py-3 hover:bg-gray-50/60";
  const fromCls = tv ? "text-base font-semibold text-gray-100 truncate" : "text-sm font-medium text-gray-900 truncate";
  const toCls = tv ? "text-base text-gray-300 truncate" : "text-sm text-gray-600 truncate";
  const subCls = tv ? "text-sm text-gray-500 mt-0.5 flex items-center gap-2" : "flex items-center gap-2 mt-0.5 text-xs text-gray-400";
  const badgeCls = (state: string) =>
    `font-medium ${tv ? "text-sm px-3 py-1" : "text-xs px-2 py-0.5"} rounded-full ${callStateColor[state] ?? callStateColor.unknown}`;
  const durCls = tv ? "text-sm text-gray-400 tabular-nums" : "text-xs text-gray-400 tabular-nums";

  return (
    <Panel
      title="Active Calls"
      icon={<PhoneCall className={tv ? "h-5 w-5" : "h-4 w-4"} />}
      count={calls.length}
      badge={isLive ? "● LIVE" : "○ connecting"}
      tv={tv}
    >
      {calls.length === 0 ? (
        <div className={`py-12 text-center ${emptyTextCls}`}>
          <Phone className={emptyIconCls} />
          <p>No active calls right now</p>
          <p className={`mt-1 ${tv ? "text-sm text-gray-600" : "text-xs text-gray-300"}`}>
            New calls will appear here in real time
          </p>
        </div>
      ) : (
        <div className={tv ? "" : "divide-y divide-gray-100"}>
          {calls.map((c) => (
            <div key={c.id} className={rowCls}>
              <DirectionIcon direction={c.direction} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={fromCls}>
                    {c.fromName ? `${c.fromName} (${c.from ?? "?"})` : (c.from ?? "Unknown")}
                  </span>
                  <span className={tv ? "text-gray-600" : "text-gray-400 text-xs"}>→</span>
                  <span className={toCls}>{c.to ?? "?"}</span>
                </div>
                <div className={subCls}>
                  <span>{c.direction}</span>
                  {c.queueId && <span>· Queue: {c.queueId}</span>}
                  {c.trunk    && <span>· {c.trunk}</span>}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1.5 shrink-0">
                <span className={badgeCls(c.state)}>{c.state}</span>
                <span className={durCls}>
                  <Clock className={`${tv ? "h-3.5 w-3.5" : "h-3 w-3"} inline mr-0.5 align-text-bottom`} />
                  {callDuration(c.startedAt, c.answeredAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── Agent Activity Panel ──────────────────────────────────────────────────────

function AgentPanel({ agents, activeCalls, tv }: { agents: AgentRow[]; activeCalls: LiveCall[]; tv?: boolean }) {
  const thCls = tv
    ? "px-5 py-3 text-sm text-gray-400 uppercase tracking-wide font-semibold"
    : "px-3 py-2 text-xs text-gray-400 uppercase tracking-wide font-semibold";
  const tdNum = (active: boolean, color: string) =>
    `font-bold ${tv ? "text-base" : "text-sm"} ${active ? color : tv ? "text-gray-700" : "text-gray-300"}`;

  const emptyTextCls = tv ? "text-gray-500 text-base" : "text-gray-400 text-sm";
  const emptyIconCls = tv ? "h-10 w-10 mx-auto mb-3 text-gray-700" : "h-8 w-8 mx-auto mb-2 text-gray-200";

  return (
    <Panel
      title="Agent Activity"
      icon={<Users className={tv ? "h-5 w-5" : "h-4 w-4"} />}
      count={agents.length}
      href="/crm/reports"
      tv={tv}
    >
      {agents.length === 0 ? (
        <div className={`py-12 text-center ${emptyTextCls}`}>
          <Inbox className={emptyIconCls} />
          <p>No CRM agents configured</p>
          <p className={`mt-1 ${tv ? "text-sm text-gray-600" : "text-xs text-gray-300"}`}>
            Enable CRM access for users in CRM Settings
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className={`w-full ${tv ? "text-base" : "text-sm"}`}>
            <thead>
              <tr className={`text-left border-b ${tv ? "border-gray-700" : "border-gray-100"}`}>
                <th className={`${thCls} text-left`}>Agent</th>
                <th className={`${thCls} text-right`}>Dispositions</th>
                <th className={`${thCls} text-right`}>Queue</th>
                <th className={`${thCls} text-right`}>Callbacks</th>
                <th className={`${thCls} text-right`}>Tasks</th>
                <th className={`${thCls} text-right`}>Conv.</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${tv ? "divide-gray-700/60" : "divide-gray-50"}`}>
              {agents.map((a) => {
                const flag       = agentStatus(a);
                const activeCall = findAgentCall(a.extensions ?? [], activeCalls);
                return (
                  <tr key={a.userId} className={tv ? "hover:bg-gray-700/30" : "hover:bg-gray-50/60"}>
                    <td className={`px-5 ${tv ? "py-3.5" : "py-2.5"}`}>
                      <div className={`font-semibold truncate max-w-[160px] ${tv ? "text-gray-100" : "text-gray-900"}`}>
                        {a.displayName}
                      </div>
                      <div className={`uppercase ${tv ? "text-sm text-gray-500 mt-0.5" : "text-xs text-gray-400"}`}>
                        {a.crmRole}
                        {a.extensions.length > 0 && (
                          <span className={`ml-1.5 ${tv ? "text-gray-600" : "text-gray-300"}`}>
                            · ext {a.extensions.join(", ")}
                          </span>
                        )}
                      </div>
                      <div className="mt-1">
                        {/* On-call takes visual priority; suppress idle badges when on a call */}
                        {activeCall ? (
                          <OnCallBadge call={activeCall} tv={tv} />
                        ) : (
                          flag !== "active" && flag !== "idle" && (
                            <AgentBadge flag={flag} tv={tv} />
                          )
                        )}
                      </div>
                    </td>
                    <td className={`px-3 ${tv ? "py-3.5" : "py-2.5"} text-right`}>
                      <span className={tdNum(a.dispositionsToday > 0, tv ? "text-blue-400" : "text-blue-700")}>
                        {a.dispositionsToday}
                      </span>
                    </td>
                    <td className={`px-3 ${tv ? "py-3.5" : "py-2.5"} text-right`}>
                      <span className={a.assignedQueue > 0 ? (tv ? "text-gray-200" : "text-gray-700") : (tv ? "text-gray-700" : "text-gray-300")}>
                        {a.assignedQueue}
                      </span>
                    </td>
                    <td className={`px-3 ${tv ? "py-3.5" : "py-2.5"} text-right`}>
                      <span className={tdNum(a.callbacksDueToday > 0, tv ? "text-orange-400" : "text-orange-600")}>
                        {a.callbacksDueToday}
                      </span>
                    </td>
                    <td className={`px-3 ${tv ? "py-3.5" : "py-2.5"} text-right`}>
                      <span className={a.openTasks > 0 ? (tv ? "text-gray-300" : "text-gray-600") : (tv ? "text-gray-700" : "text-gray-300")}>
                        {a.openTasks}
                      </span>
                    </td>
                    <td className={`px-3 ${tv ? "py-3.5" : "py-2.5"} text-right`}>
                      <span className={tdNum(a.convertedLast > 0, tv ? "text-green-400" : "text-green-700")}>
                        {a.convertedLast}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ── Campaign Progress Panel ───────────────────────────────────────────────────

function CampaignPanel({ campaigns, tv }: { campaigns: CampaignRow[]; tv?: boolean }) {
  const active = campaigns.filter((c) => c.status === "ACTIVE");

  const emptyTextCls = tv ? "text-gray-500 text-base" : "text-gray-400 text-sm";
  const emptyIconCls = tv ? "h-10 w-10 mx-auto mb-3 text-gray-700" : "h-8 w-8 mx-auto mb-2 text-gray-200";

  return (
    <Panel
      title="Active Campaigns"
      icon={<Megaphone className={tv ? "h-5 w-5" : "h-4 w-4"} />}
      count={active.length}
      href="/crm/campaigns"
      tv={tv}
    >
      {active.length === 0 ? (
        <div className={`py-12 text-center ${emptyTextCls}`}>
          <Inbox className={emptyIconCls} />
          <p>No active campaigns</p>
          <p className={`mt-1 ${tv ? "text-sm text-gray-600" : "text-xs text-gray-300"}`}>
            Activate a campaign to track progress here
          </p>
        </div>
      ) : (
        <div className={`divide-y ${tv ? "divide-gray-700/60" : "divide-gray-100"}`}>
          {active.map((c) => {
            const done = c.contacted + c.converted + c.dnc;
            const pct  = c.total > 0 ? Math.round((done / c.total) * 100) : 0;
            const nameCls = tv
              ? "text-base font-bold text-gray-100 hover:text-blue-300 truncate"
              : "text-sm font-semibold text-gray-900 hover:text-blue-600 truncate";
            const barH    = tv ? "h-3" : "h-2";
            const statCls = tv ? "text-sm text-gray-400 flex-wrap" : "text-xs text-gray-500 flex-wrap";
            return (
              <div key={c.id} className={`px-5 ${tv ? "py-5" : "py-3.5"} hover:${tv ? "bg-gray-700/20" : "bg-gray-50/60"}`}>
                <div className="flex items-center justify-between gap-3 mb-2.5">
                  <Link href={`/crm/campaigns/${c.id}`} className={nameCls}>{c.name}</Link>
                  <div className="flex items-center gap-2 shrink-0">
                    {c.conversionRate > 0 && (
                      <span className={`font-bold bg-green-900/50 text-green-400 rounded ${tv ? "text-sm px-2 py-1" : "text-xs px-1.5 py-0.5"}`}>
                        {c.conversionRate}%
                      </span>
                    )}
                    <span className={tv ? "text-sm text-gray-500" : "text-xs text-gray-400"}>{pct}% done</span>
                  </div>
                </div>
                <div className={`w-full ${barH} bg-${tv ? "gray-700" : "gray-100"} rounded-full overflow-hidden mb-2.5`}>
                  <div className="flex h-full">
                    <div style={{ width: `${c.total > 0 ? (c.contacted / c.total) * 100 : 0}%` }} className="bg-purple-500" />
                    <div style={{ width: `${c.total > 0 ? (c.callbacks / c.total) * 100 : 0}%` }} className="bg-yellow-400" />
                    <div style={{ width: `${c.total > 0 ? (c.converted / c.total) * 100 : 0}%` }} className="bg-green-500" />
                    <div style={{ width: `${c.total > 0 ? (c.dnc / c.total) * 100 : 0}%` }} className={tv ? "bg-gray-600" : "bg-gray-300"} />
                  </div>
                </div>
                <div className={`flex gap-3 ${statCls}`}>
                  <span><span className={`font-semibold ${tv ? "text-gray-200" : "text-gray-700"}`}>{c.pending}</span> pending</span>
                  <span><span className="font-semibold text-purple-400">{c.contacted}</span> contacted</span>
                  <span><span className="font-semibold text-yellow-400">{c.callbacks}</span> callbacks</span>
                  <span><span className="font-semibold text-green-400">{c.converted}</span> converted</span>
                  {c.dnc > 0 && <span><span className={`font-semibold ${tv ? "text-gray-600" : "text-gray-400"}`}>{c.dnc}</span> DNC/skip</span>}
                  <span className={tv ? "text-gray-600" : "text-gray-400"}>· {c.total} total</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ── Follow-Up Urgency Panel ───────────────────────────────────────────────────

function FollowUpsPanel({ data, tv }: { data: FollowUpsReport; tv?: boolean }) {
  const overdueCallbacks = data.callbacks.overdue;
  const dueCallbacks     = data.callbacks.dueToday;
  const overdueTasks     = data.tasks.overdue;
  const dueTasks         = data.tasks.dueToday;
  const totalUrgent      = overdueCallbacks.count + overdueTasks.count;

  const urgent: Array<{ key: string; label: string; sub: string; href: string; isOverdue: boolean }> = [
    ...overdueCallbacks.rows.slice(0, 5).map((m) => ({
      key: `cb-ov-${m.id}`,
      label: m.contactName,
      sub: m.campaign?.name
        ? `Callback · ${m.campaign.name}${m.callbackAt ? " · " + callbackLabel(m.callbackAt).label : ""}`
        : `Callback${m.callbackAt ? " · " + callbackLabel(m.callbackAt).label : ""}`,
      href: `/crm/contacts/${m.contactId}`,
      isOverdue: true,
    })),
    ...overdueTasks.rows.slice(0, 5).map((t) => ({
      key: `task-ov-${t.id}`,
      label: t.contactName,
      sub: `Task: ${t.title}${t.assignedTo ? " · " + t.assignedTo.name : ""}`,
      href: `/crm/contacts/${t.contactId}`,
      isOverdue: true,
    })),
    ...dueCallbacks.rows.slice(0, 3).map((m) => ({
      key: `cb-today-${m.id}`,
      label: m.contactName,
      sub: `Callback due today · ${m.campaign?.name ?? ""}`,
      href: `/crm/contacts/${m.contactId}`,
      isOverdue: false,
    })),
    ...dueTasks.rows.slice(0, 3).map((t) => ({
      key: `task-today-${t.id}`,
      label: t.contactName,
      sub: `Task due today: ${t.title}`,
      href: `/crm/contacts/${t.contactId}`,
      isOverdue: false,
    })),
  ].slice(0, 10);

  const tileCls = (isUrgent: boolean) =>
    `rounded-lg text-center p-${tv ? "4" : "2.5"} hover:opacity-90 transition-opacity ${
      isUrgent
        ? "bg-red-900/60 border border-red-700"
        : tv ? "bg-gray-900/60 border border-gray-700" : "bg-white border border-gray-100"
    }`;
  const tileNumCls = (isUrgent: boolean) =>
    `font-bold ${tv ? "text-3xl" : "text-xl"} ${isUrgent ? "text-red-300" : tv ? "text-gray-200" : "text-gray-800"}`;
  const tileLblCls = (isUrgent: boolean) =>
    `mt-0.5 ${tv ? "text-sm" : "text-xs"} ${isUrgent ? "text-red-400" : tv ? "text-gray-500" : "text-gray-500"}`;

  return (
    <Panel
      title="Follow-Up Urgency"
      icon={<CalendarClock className={tv ? "h-5 w-5" : "h-4 w-4"} />}
      count={totalUrgent}
      badgeUrgent={totalUrgent > 0}
      href="/crm/reports"
      tv={tv}
    >
      {/* Summary count tiles */}
      <div className={`grid grid-cols-2 gap-2 px-5 py-3 border-b ${tv ? "border-gray-700 bg-gray-900/40" : "border-gray-100 bg-gray-50/40"}`}>
        {[
          { label: "Overdue Callbacks", value: overdueCallbacks.count, isUrgent: overdueCallbacks.count > 0, href: "/crm/queue?mode=power&filter=overdue" },
          { label: "Due Today (CB)",    value: dueCallbacks.count,     isUrgent: false,                    href: "/crm/queue?mode=power&filter=due" },
          { label: "Overdue Tasks",     value: overdueTasks.count,     isUrgent: overdueTasks.count > 0,   href: "/crm/tasks" },
          { label: "Tasks Due Today",   value: dueTasks.count,         isUrgent: false,                    href: "/crm/tasks" },
        ].map(({ label, value, isUrgent, href }) => (
          <Link key={label} href={href} className={tileCls(isUrgent)}>
            <div className={tileNumCls(isUrgent)}>{value}</div>
            <div className={tileLblCls(isUrgent)}>{label}</div>
          </Link>
        ))}
      </div>

      {/* Actionable rows */}
      {urgent.length === 0 ? (
        <div className={`py-10 text-center ${tv ? "text-gray-500 text-base" : "text-gray-400 text-sm"}`}>
          <CheckCheck className={`mx-auto mb-2 text-green-500 ${tv ? "h-10 w-10" : "h-7 w-7"}`} />
          <p className="font-medium">All caught up!</p>
          <p className={`mt-1 ${tv ? "text-sm text-gray-600" : "text-xs text-gray-300"}`}>No overdue callbacks or tasks</p>
        </div>
      ) : (
        <div className={`divide-y ${tv ? "divide-gray-700/60" : "divide-gray-50"}`}>
          {urgent.map((item) => (
            <Link key={item.key} href={item.href} className={`flex items-center gap-3 px-5 ${tv ? "py-3.5" : "py-2.5"} hover:${tv ? "bg-gray-700/30" : "bg-gray-50/70"} group`}>
              <span className={`rounded-full shrink-0 ${item.isOverdue ? "bg-red-500" : "bg-yellow-400"} ${tv ? "w-2.5 h-2.5" : "w-2 h-2"}`} />
              <div className="flex-1 min-w-0">
                <div className={`font-semibold truncate group-hover:text-blue-400 ${tv ? "text-base text-gray-100" : "text-sm text-gray-900"}`}>
                  {item.label}
                </div>
                <div className={`truncate ${tv ? "text-sm text-gray-500" : "text-xs text-gray-400"}`}>{item.sub}</div>
              </div>
              <ArrowRight className={`shrink-0 ${tv ? "h-4 w-4 text-gray-600 group-hover:text-blue-400" : "h-3.5 w-3.5 text-gray-300 group-hover:text-blue-400"}`} />
            </Link>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── Main wallboard page ───────────────────────────────────────────────────────

export default function WallboardPage() {
  const telephony   = useTelephony();
  const activeCalls = telephony.activeCalls;
  const isLive      = telephony.isLive;

  const [data, setData]           = useState<WallboardData | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState(COUNTDOWN_S);
  const [tvMode, setTvMode]       = useState(false);
  const [clockTime, setClockTime] = useState<Date>(() => new Date());

  const refreshTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  // Read ?tv=1 from URL on mount (avoids Suspense requirement for useSearchParams)
  useEffect(() => {
    if (typeof window !== "undefined") {
      setTvMode(new URLSearchParams(window.location.search).get("tv") === "1");
    }
  }, []);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [daily, campaignData, agentData, followUpData] = await Promise.all([
        apiGet<DailyReport>("/crm/reports/daily", token),
        apiGet<{ campaigns: CampaignRow[] }>("/crm/reports/campaigns?status=ACTIVE", token),
        apiGet<{ agents: AgentRow[] }>("/crm/reports/agents", token),
        apiGet<FollowUpsReport>("/crm/reports/follow-ups", token),
      ]);
      setData({
        daily,
        campaigns: campaignData.campaigns ?? [],
        agents:    agentData.agents ?? [],
        followUps: followUpData,
      });
      setLastRefresh(new Date());
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Failed to load wallboard data");
    }
    setLoading(false);
  }, [token]);

  // Initial load
  useEffect(() => { void loadAll(); }, [loadAll]);

  // 60-second auto-refresh — cleaned up on unmount
  useEffect(() => {
    refreshTimerRef.current = setInterval(() => { void loadAll(); }, REFRESH_MS);
    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [loadAll]);

  // Reset countdown whenever data refreshes (manual or auto)
  useEffect(() => {
    setCountdown(COUNTDOWN_S);
  }, [lastRefresh]);

  // 1-second countdown tick — cleaned up on unmount
  useEffect(() => {
    countdownTimerRef.current = setInterval(() => {
      setCountdown((n) => Math.max(0, n - 1));
    }, 1000);
    return () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, []);

  // Clock tick (TV mode only) — 10s interval, cleaned up on unmount or TV exit
  useEffect(() => {
    if (!tvMode) return;
    clockTimerRef.current = setInterval(() => setClockTime(new Date()), 10_000);
    return () => {
      if (clockTimerRef.current) {
        clearInterval(clockTimerRef.current);
        clockTimerRef.current = null;
      }
    };
  }, [tvMode]);

  // Manual refresh: fires loadAll and reschedules the 60s interval
  const handleManualRefresh = useCallback(() => {
    setLoading(true);
    void loadAll();
    // Reset the auto-refresh interval so it starts from 60s again after manual trigger
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
    }
    refreshTimerRef.current = setInterval(() => { void loadAll(); }, REFRESH_MS);
  }, [loadAll]);

  // TV mode toggle: update URL param without full navigation
  const toggleTvMode = useCallback(() => {
    const url = new URL(window.location.href);
    if (tvMode) {
      url.searchParams.delete("tv");
    } else {
      url.searchParams.set("tv", "1");
    }
    window.history.replaceState(null, "", url.toString());
    setTvMode((v) => !v);
  }, [tvMode]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading && !data) {
    const bg = tvMode ? "bg-gray-900" : "bg-gray-50";
    const textCls = tvMode ? "text-gray-400" : "text-gray-400";
    const iconCls = tvMode ? "text-gray-700" : "text-gray-200";
    return (
      <div className={`min-h-screen ${bg} flex items-center justify-center ${tvMode ? "fixed inset-0 z-50" : ""}`}>
        <div className={`text-center ${textCls}`}>
          <LayoutGrid className={`h-12 w-12 mx-auto mb-3 ${iconCls} animate-pulse`} />
          <p className="text-sm">Loading wallboard…</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className={`min-h-screen ${tvMode ? "bg-gray-900 fixed inset-0 z-50" : "bg-gray-50"} flex items-center justify-center`}>
        <div className="text-center text-red-500 text-sm max-w-sm">
          <AlertCircle className="h-10 w-10 mx-auto mb-3 text-red-300" />
          <p className="font-semibold mb-2">Failed to load wallboard</p>
          <p className="text-gray-500 mb-4">{error}</p>
          <button
            onClick={handleManualRefresh}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  const { daily, campaigns, agents, followUps } = data!;
  const totalUrgent = followUps.callbacks.overdue.count + followUps.tasks.overdue.count;

  // Countdown display: show seconds or "refreshing…"
  const countdownLabel = loading
    ? "Refreshing…"
    : countdown === 0
    ? "Refreshing soon…"
    : `Refreshes in ${countdown}s`;

  // ── TV Mode render ─────────────────────────────────────────────────────────

  if (tvMode) {
    return (
      <div className="fixed inset-0 z-50 bg-gray-900 text-white overflow-auto">

        {/* TV header */}
        <div className="bg-gray-950 border-b border-gray-800 px-6 py-4">
          <div className="max-w-[1600px] mx-auto flex items-center justify-between">
            {/* Left: title + status */}
            <div className="flex items-center gap-4">
              <LayoutGrid className="h-7 w-7 text-blue-400" />
              <h1 className="text-2xl font-bold text-white">Live Wallboard</h1>
              <span className={`inline-flex items-center gap-2 text-sm px-3 py-1 rounded-full font-semibold ${
                isLive ? "bg-green-900/60 text-green-300" : "bg-yellow-900/60 text-yellow-300"
              }`}>
                <span className={`w-2 h-2 rounded-full ${isLive ? "bg-green-400 animate-pulse" : "bg-yellow-400"}`} />
                {isLive ? "WS Live" : "Connecting…"}
              </span>
            </div>

            {/* Center: clock */}
            <div className="text-center">
              <div className="text-5xl font-bold tabular-nums text-white tracking-tight">
                {formatClock(clockTime)}
              </div>
              <div className="text-sm text-gray-500 mt-0.5">{formatClockDate(clockTime)}</div>
            </div>

            {/* Right: refresh info + exit */}
            <div className="flex items-center gap-4 text-sm text-gray-400">
              <div className="text-right">
                {lastRefresh && (
                  <div>Updated {relTime(lastRefresh.toISOString())}</div>
                )}
                <div className={countdown <= 10 ? "text-amber-400 font-semibold" : "text-gray-500"}>
                  {countdownLabel}
                </div>
              </div>
              <button
                onClick={handleManualRefresh}
                disabled={loading}
                className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
              <button
                onClick={toggleTvMode}
                className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-gray-300"
                title="Exit TV mode"
              >
                <X className="h-4 w-4" />
                Exit TV
              </button>
            </div>
          </div>
        </div>

        {/* TV summary strip */}
        <div className="bg-gray-800/60 border-b border-gray-800 px-6 py-4">
          <div className="max-w-[1600px] mx-auto flex gap-3 overflow-x-auto">
            <StripStat label="Active Calls" value={activeCalls.length} icon={<PhoneCall className="h-6 w-6" />} tv />
            <StripStat label="Queue Remaining" value={daily.queueRemaining} icon={<Zap className="h-6 w-6" />} href="/crm/queue" tv />
            <StripStat label="Overdue Callbacks" value={daily.overdueCallbacks} icon={<AlertCircle className="h-6 w-6" />} urgent href="/crm/queue?mode=power&filter=overdue" tv />
            <StripStat label="Due Today (CB)" value={daily.callbacksDueToday} icon={<CalendarClock className="h-6 w-6" />} href="/crm/queue?mode=power&filter=due" tv />
            <StripStat label="Dispositions Today" value={daily.dispositionsToday} icon={<TrendingUp className="h-6 w-6" />} tv />
            <StripStat label="Contacts Created" value={daily.contactsCreatedToday} icon={<Users className="h-6 w-6" />} tv />
            <StripStat label="Active Campaigns" value={daily.activeCampaigns} icon={<Megaphone className="h-6 w-6" />} tv />
            <StripStat label="Overdue Tasks" value={daily.overdueTasks} icon={<CheckSquare className="h-6 w-6" />} urgent href="/crm/tasks" tv />
          </div>
        </div>

        {/* TV panel grid */}
        <div className="max-w-[1600px] mx-auto px-6 py-6">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <LiveCallsPanel calls={activeCalls} isLive={isLive} tv />
            <AgentPanel agents={agents} activeCalls={activeCalls} tv />
            <CampaignPanel campaigns={campaigns} tv />
            <FollowUpsPanel data={followUps} tv />
          </div>
          <p className="text-center text-sm text-gray-700 mt-6">
            CRM data refreshes every {REFRESH_MS / 1000}s · Live calls via WebSocket · Read-only view
          </p>
        </div>
      </div>
    );
  }

  // ── Normal mode render ─────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">

      {/* Summary strip */}
      <div className="bg-gradient-to-r from-blue-800 to-blue-700 text-white">
        <div className="max-w-[1400px] mx-auto px-4 py-4">

          {/* Title row */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <LayoutGrid className="h-6 w-6 text-blue-200" />
              <h1 className="text-xl font-bold">Live Wallboard</h1>
              <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-semibold ${
                isLive ? "bg-green-500/20 text-green-200" : "bg-yellow-500/20 text-yellow-200"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isLive ? "bg-green-400 animate-pulse" : "bg-yellow-400"}`} />
                {isLive ? "WS Live" : "Connecting…"}
              </span>
              {totalUrgent > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-semibold bg-red-500/30 text-red-200">
                  <AlertTriangle className="h-3 w-3" />
                  {totalUrgent} urgent
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-sm text-blue-200">
              <span className={`text-xs ${countdown <= 10 ? "text-amber-300 font-semibold" : "text-blue-300"}`}>
                {countdownLabel}
              </span>
              {lastRefresh && (
                <span className="text-blue-300 text-xs">· Updated {relTime(lastRefresh.toISOString())}</span>
              )}
              <button
                onClick={handleManualRefresh}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
              <button
                onClick={toggleTvMode}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-sm font-medium transition-colors"
                title="Enter TV mode"
              >
                <Tv className="h-3.5 w-3.5" />
                TV Mode
              </button>
            </div>
          </div>

          {/* Stat strip */}
          <div className="flex gap-3 overflow-x-auto pb-1">
            <StripStat label="Active Calls" value={activeCalls.length} icon={<PhoneCall className="h-5 w-5" />} />
            <StripStat label="Queue Remaining" value={daily.queueRemaining} icon={<Zap className="h-5 w-5" />} href="/crm/queue" />
            <StripStat label="Overdue Callbacks" value={daily.overdueCallbacks} icon={<AlertCircle className="h-5 w-5" />} urgent href="/crm/queue?mode=power&filter=overdue" />
            <StripStat label="Due Today (CB)" value={daily.callbacksDueToday} icon={<CalendarClock className="h-5 w-5" />} href="/crm/queue?mode=power&filter=due" />
            <StripStat label="Dispositions Today" value={daily.dispositionsToday} icon={<TrendingUp className="h-5 w-5" />} />
            <StripStat label="Contacts Created" value={daily.contactsCreatedToday} icon={<Users className="h-5 w-5" />} href="/crm/contacts" />
            <StripStat label="Active Campaigns" value={daily.activeCampaigns} icon={<Megaphone className="h-5 w-5" />} href="/crm/campaigns" />
            <StripStat label="Overdue Tasks" value={daily.overdueTasks} icon={<CheckSquare className="h-5 w-5" />} urgent href="/crm/tasks" />
          </div>
        </div>
      </div>

      {/* Panel grid */}
      <div className="max-w-[1400px] mx-auto px-4 py-6">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <LiveCallsPanel calls={activeCalls} isLive={isLive} />
          <AgentPanel agents={agents} activeCalls={activeCalls} />
          <CampaignPanel campaigns={campaigns} />
          <FollowUpsPanel data={followUps} />
        </div>
        <p className="text-center text-xs text-gray-400 mt-6">
          CRM data refreshes every {REFRESH_MS / 1000}s · Live calls update via WebSocket · Read-only view
        </p>
      </div>

    </div>
  );
}

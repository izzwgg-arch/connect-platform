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
import { crm } from "../../../../components/crm/crmClasses";
import { CRMRingMetric } from "../../../../components/crm/charts/CRMRingMetric";

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

// ── WallboardKpiTile — TV-ready big metric card ────────────────────────────────

function WallboardKpiTile({
  label, value, icon, tone = "neutral", href, tv,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  tone?: "neutral" | "warn" | "danger" | "positive";
  href?: string;
  tv?: boolean;
}) {
  const isActive = Number(value) > 0;

  const borderCls =
    tone === "danger" && isActive ? "border-crm-danger/45"
    : tone === "warn"  && isActive ? "border-crm-warning/35"
    : tone === "positive"          ? "border-crm-success/30"
    : "border-crm-border";

  const valueCls =
    tone === "danger" && isActive ? "text-crm-danger"
    : tone === "warn"  && isActive ? "text-crm-warning"
    : tone === "positive"          ? "text-crm-success"
    : "text-crm-text";

  const iconCls =
    tone === "danger" && isActive ? "text-crm-danger/60"
    : tone === "warn"  && isActive ? "text-crm-warning/60"
    : tone === "positive"          ? "text-crm-success/60"
    : "text-crm-muted";

  const tile = (
    <div className={`rounded-crm-lg border ${borderCls} bg-crm-surface flex flex-col items-center justify-center gap-1 px-3 ${
      tv ? "py-5 min-h-[120px]" : "py-4 min-h-[88px]"
    } ${href ? "transition-colors hover:bg-crm-surface-2/40 hover:border-crm-accent/30" : ""}`}>
      <div className={`${iconCls} mb-0.5`}>{icon}</div>
      <div className={`font-bold tabular-nums leading-none ${tv ? "text-5xl" : "text-3xl"} ${valueCls}`}>
        {value}
      </div>
      <div className={`${tv ? "text-sm" : "text-[11px]"} font-medium text-center leading-tight text-crm-muted`}>
        {label}
      </div>
    </div>
  );

  return href ? <Link href={href} className="block">{tile}</Link> : tile;
}

// ── WallboardPanel — dark panel wrapper using CRM tokens ───────────────────────

function WallboardPanel({
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
  return (
    <div className="rounded-crm-lg border border-crm-border bg-crm-surface shadow-crm flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-crm-border bg-crm-surface-2/30">
        <div className="flex items-center gap-2.5">
          <span className="text-crm-muted">{icon}</span>
          <h2 className={`font-bold text-crm-text tracking-tight ${tv ? "text-base" : "text-sm"}`}>{title}</h2>
          {count !== undefined && (
            <span className={`px-2 py-0.5 rounded-full font-bold border ${tv ? "text-sm" : "text-xs"} ${
              badgeUrgent && count > 0
                ? "bg-crm-danger/12 text-crm-danger border-crm-danger/30"
                : "bg-crm-surface-2 text-crm-muted border-crm-border"
            }`}>
              {count}
            </span>
          )}
          {badge && (
            <span className={`px-2 py-0.5 rounded-full font-medium border ${tv ? "text-sm" : "text-xs"} ${
              badgeUrgent
                ? "bg-crm-danger/12 text-crm-danger border-crm-danger/30"
                : "bg-crm-accent/12 text-crm-accent border-crm-accent/25"
            }`}>
              {badge}
            </span>
          )}
        </div>
        {href && !tv && (
          <Link href={href} className="text-xs text-crm-muted hover:text-crm-accent flex items-center gap-1 shrink-0 transition-colors">
            View all <ChevronRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}

// ── AgentBadge ────────────────────────────────────────────────────────────────

function AgentBadge({ flag, tv }: { flag: AgentStatusFlag; tv?: boolean }) {
  const sz = tv ? "text-xs px-2 py-1" : "text-xs px-1.5 py-0.5";
  if (flag === "needs-attention") {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full font-semibold border bg-crm-danger/15 text-crm-danger border-crm-danger/30 ${sz}`}>
        <AlertTriangle className="h-3 w-3 shrink-0" /> Needs attention
      </span>
    );
  }
  if (flag === "callbacks-due") {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full font-semibold border bg-crm-warning/15 text-crm-warning border-crm-warning/25 ${sz}`}>
        <CalendarClock className="h-3 w-3 shrink-0" /> Callbacks due
      </span>
    );
  }
  if (flag === "no-outcomes") {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full font-semibold border bg-amber-500/12 text-amber-400 border-amber-500/25 ${sz}`}>
        <Clock className="h-3 w-3 shrink-0" /> No outcomes today
      </span>
    );
  }
  return null;
}

// ── OnCallBadge ───────────────────────────────────────────────────────────────

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
    <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold border bg-crm-success/15 text-crm-success border-crm-success/25 ${sz}`}>
      <DirIcon className={`${iconSz} shrink-0`} />
      On call · {dur}
    </span>
  );
}

// ── LiveCallsPanel ────────────────────────────────────────────────────────────

function LiveCallsPanel({ calls, isLive, tv }: { calls: LiveCall[]; isLive: boolean; tv?: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const callStateCls: Record<string, string> = {
    ringing: "bg-crm-warning/15 text-crm-warning border border-crm-warning/30",
    dialing: "bg-crm-accent/15 text-crm-accent border border-crm-accent/30",
    up:      "bg-crm-success/15 text-crm-success border border-crm-success/30",
    held:    "bg-crm-surface-2 text-crm-muted border border-crm-border",
    unknown: "bg-crm-surface-2 text-crm-muted border border-crm-border",
  };

  function DirectionIcon({ direction }: { direction: LiveCall["direction"] }) {
    if (direction === "inbound")  return <PhoneIncoming className={`${tv ? "h-4 w-4" : "h-3.5 w-3.5"} text-crm-success`} />;
    if (direction === "outbound") return <PhoneOutgoing  className={`${tv ? "h-4 w-4" : "h-3.5 w-3.5"} text-crm-accent`} />;
    return <Phone className={`${tv ? "h-4 w-4" : "h-3.5 w-3.5"} text-crm-muted`} />;
  }

  const rowCls = tv
    ? "flex items-center gap-4 px-5 py-4 border-b border-crm-border/50 last:border-0"
    : "flex items-center gap-3 px-5 py-3 border-b border-crm-border/40 last:border-0 hover:bg-crm-surface-2/20 transition-colors";

  return (
    <WallboardPanel
      title="Active Calls"
      icon={<PhoneCall className={tv ? "h-5 w-5" : "h-4 w-4"} />}
      count={calls.length}
      badge={isLive ? "● LIVE" : "○ connecting"}
      tv={tv}
    >
      {calls.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 text-center px-6">
          <Phone className={`mb-3 text-crm-border ${tv ? "h-10 w-10" : "h-8 w-8"}`} />
          <p className={`font-medium text-crm-text ${tv ? "text-base" : "text-sm"}`}>No active calls right now</p>
          <p className={`mt-1 text-crm-muted ${tv ? "text-sm" : "text-xs"}`}>New calls will appear here in real time</p>
        </div>
      ) : (
        <div>
          {calls.map((c) => (
            <div key={c.id} className={rowCls}>
              <DirectionIcon direction={c.direction} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`font-semibold text-crm-text truncate ${tv ? "text-base" : "text-sm"}`}>
                    {c.fromName ? `${c.fromName} (${c.from ?? "?"})` : (c.from ?? "Unknown")}
                  </span>
                  <span className="text-crm-border text-xs">→</span>
                  <span className={`text-crm-muted truncate ${tv ? "text-base" : "text-sm"}`}>{c.to ?? "?"}</span>
                </div>
                <div className={`flex items-center gap-2 mt-0.5 text-crm-muted ${tv ? "text-sm" : "text-xs"}`}>
                  <span>{c.direction}</span>
                  {c.queueId && <span>· Queue: {c.queueId}</span>}
                  {c.trunk    && <span>· {c.trunk}</span>}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1.5 shrink-0">
                <span className={`font-medium rounded-crm ${tv ? "text-sm px-3 py-1" : "text-xs px-2 py-0.5"} ${callStateCls[c.state] ?? callStateCls.unknown}`}>
                  {c.state}
                </span>
                <span className={`text-crm-muted tabular-nums ${tv ? "text-sm" : "text-xs"}`}>
                  <Clock className={`${tv ? "h-3.5 w-3.5" : "h-3 w-3"} inline mr-0.5 align-text-bottom`} />
                  {callDuration(c.startedAt, c.answeredAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </WallboardPanel>
  );
}

// ── AgentActivityPanel — visual leaderboard with bars ─────────────────────────

function AgentActivityPanel({ agents, activeCalls, tv }: { agents: AgentRow[]; activeCalls: LiveCall[]; tv?: boolean }) {
  const maxDisp = Math.max(1, ...agents.map((a) => a.dispositionsToday));

  return (
    <WallboardPanel
      title="Agent Activity"
      icon={<Users className={tv ? "h-5 w-5" : "h-4 w-4"} />}
      count={agents.length}
      href="/crm/reports"
      tv={tv}
    >
      {agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 text-center px-6">
          <Inbox className={`mb-3 text-crm-border ${tv ? "h-10 w-10" : "h-8 w-8"}`} />
          <p className={`font-medium text-crm-muted ${tv ? "text-base" : "text-sm"}`}>No CRM agents configured</p>
          <p className={`mt-1 text-crm-muted/60 ${tv ? "text-sm" : "text-xs"}`}>Enable CRM access for users in CRM Settings</p>
        </div>
      ) : (
        <div className="divide-y divide-crm-border/40">
          {agents.map((a) => {
            const flag       = agentStatus(a);
            const activeCall = findAgentCall(a.extensions ?? [], activeCalls);
            const dispPct    = maxDisp > 0 ? Math.min(100, (a.dispositionsToday / maxDisp) * 100) : 0;
            const cbPct      = Math.min(100, a.callbacksDueToday * 10);
            const qPct       = Math.min(100, a.assignedQueue * 5);

            return (
              <div
                key={a.userId}
                className={`flex items-start gap-4 px-5 ${tv ? "py-4" : "py-3"} hover:bg-crm-surface-2/20 transition-colors`}
              >
                {/* Agent identity */}
                <div className={`shrink-0 ${tv ? "w-[200px]" : "w-[148px]"}`}>
                  <div className={`font-semibold text-crm-text truncate ${tv ? "text-base" : "text-sm"}`}>
                    {a.displayName}
                  </div>
                  <div className="text-[11px] text-crm-muted uppercase tracking-wide mt-0.5">
                    {a.crmRole}
                    {a.extensions.length > 0 && (
                      <span className="ml-1 text-crm-muted/50">· ext {a.extensions.join(", ")}</span>
                    )}
                  </div>
                  <div className="mt-1">
                    {activeCall ? (
                      <OnCallBadge call={activeCall} tv={tv} />
                    ) : (
                      flag !== "active" && flag !== "idle" && <AgentBadge flag={flag} tv={tv} />
                    )}
                  </div>
                </div>

                {/* Activity bars (visual leaderboard) */}
                <div className="flex-1 flex flex-col gap-1.5 justify-center min-w-0 pt-0.5">
                  {/* Dispositions — always shown */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-medium text-crm-muted shrink-0 w-14 text-right">Disp</span>
                    <div className="flex-1 h-1.5 rounded-full bg-crm-surface-2 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-crm-accent transition-[width] duration-500 ease-out"
                        style={{ width: `${dispPct}%` }}
                      />
                    </div>
                    <span className={`text-xs font-bold tabular-nums shrink-0 w-5 text-right ${a.dispositionsToday > 0 ? "text-crm-accent" : "text-crm-muted/40"}`}>
                      {a.dispositionsToday}
                    </span>
                  </div>

                  {/* Callbacks due — shown only when > 0 */}
                  {a.callbacksDueToday > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-medium text-crm-warning/80 shrink-0 w-14 text-right">CB Due</span>
                      <div className="flex-1 h-1.5 rounded-full bg-crm-surface-2 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-crm-warning transition-[width] duration-500 ease-out"
                          style={{ width: `${cbPct}%` }}
                        />
                      </div>
                      <span className="text-xs font-bold tabular-nums text-crm-warning shrink-0 w-5 text-right">
                        {a.callbacksDueToday}
                      </span>
                    </div>
                  )}

                  {/* Queue — shown only when > 0 */}
                  {a.assignedQueue > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-medium text-crm-muted shrink-0 w-14 text-right">Queue</span>
                      <div className="flex-1 h-1.5 rounded-full bg-crm-surface-2 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-crm-muted/30 transition-[width] duration-500 ease-out"
                          style={{ width: `${qPct}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-crm-muted/50 shrink-0 w-5 text-right">
                        {a.assignedQueue}
                      </span>
                    </div>
                  )}
                </div>

                {/* Conversions — shown only when > 0 */}
                {a.convertedLast > 0 && (
                  <div className="shrink-0 text-center pt-0.5">
                    <div className={`font-bold tabular-nums text-crm-success ${tv ? "text-lg" : "text-sm"}`}>
                      {a.convertedLast}
                    </div>
                    <div className="text-[10px] text-crm-muted">conv.</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </WallboardPanel>
  );
}

// ── CampaignProgressPanel ─────────────────────────────────────────────────────

function CampaignProgressPanel({ campaigns, tv }: { campaigns: CampaignRow[]; tv?: boolean }) {
  const active = campaigns.filter((c) => c.status === "ACTIVE");

  return (
    <WallboardPanel
      title="Active Campaigns"
      icon={<Megaphone className={tv ? "h-5 w-5" : "h-4 w-4"} />}
      count={active.length}
      href="/crm/campaigns"
      tv={tv}
    >
      {active.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 text-center px-6">
          <Inbox className={`mb-3 text-crm-border ${tv ? "h-10 w-10" : "h-8 w-8"}`} />
          <p className={`font-medium text-crm-muted ${tv ? "text-base" : "text-sm"}`}>No active campaigns</p>
          <p className={`mt-1 text-crm-muted/60 ${tv ? "text-sm" : "text-xs"}`}>Activate a campaign to track progress here</p>
        </div>
      ) : (
        <div className="divide-y divide-crm-border/40">
          {active.map((c) => {
            const done = c.contacted + c.converted + c.dnc;
            const pct  = c.total > 0 ? Math.round((done / c.total) * 100) : 0;
            return (
              <div key={c.id} className={`px-5 ${tv ? "py-5" : "py-4"} hover:bg-crm-surface-2/20 transition-colors`}>
                <div className="flex items-center justify-between gap-3 mb-2.5">
                  <Link
                    href={`/crm/campaigns/${c.id}`}
                    className={`font-bold text-crm-text hover:text-crm-accent truncate transition-colors ${tv ? "text-base" : "text-sm"}`}
                  >
                    {c.name}
                  </Link>
                  <div className="flex items-center gap-2 shrink-0">
                    {c.conversionRate > 0 && (
                      <span className={`font-bold rounded-crm border bg-crm-success/15 text-crm-success border-crm-success/25 ${tv ? "text-sm px-2 py-1" : "text-xs px-1.5 py-0.5"}`}>
                        {c.conversionRate}%
                      </span>
                    )}
                    <span className={`text-crm-muted tabular-nums ${tv ? "text-sm" : "text-xs"}`}>{pct}% done</span>
                  </div>
                </div>
                {/* Segmented progress bar */}
                <div className={`w-full ${tv ? "h-2.5" : "h-2"} bg-crm-surface-2 rounded-full overflow-hidden mb-2.5`}>
                  <div className="flex h-full">
                    <div style={{ width: `${c.total > 0 ? (c.contacted / c.total) * 100 : 0}%` }} className="bg-purple-500 transition-[width] duration-300" />
                    <div style={{ width: `${c.total > 0 ? (c.callbacks / c.total) * 100 : 0}%` }} className="bg-amber-400 transition-[width] duration-300" />
                    <div style={{ width: `${c.total > 0 ? (c.converted / c.total) * 100 : 0}%` }} className="bg-crm-success transition-[width] duration-300" />
                    <div style={{ width: `${c.total > 0 ? (c.dnc / c.total) * 100 : 0}%` }} className="bg-crm-border/60 transition-[width] duration-300" />
                  </div>
                </div>
                <div className={`flex flex-wrap gap-3 ${tv ? "text-sm" : "text-xs"} text-crm-muted`}>
                  <span><span className="font-semibold text-crm-text">{c.pending}</span> pending</span>
                  <span><span className="font-semibold text-purple-400">{c.contacted}</span> contacted</span>
                  <span><span className="font-semibold text-amber-400">{c.callbacks}</span> callbacks</span>
                  <span><span className="font-semibold text-crm-success">{c.converted}</span> converted</span>
                  {c.dnc > 0 && <span><span className="font-semibold text-crm-muted">{c.dnc}</span> DNC</span>}
                  <span className="text-crm-muted/50">· {c.total} total</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </WallboardPanel>
  );
}

// ── FollowUpUrgencyPanel ───────────────────────────────────────────────────────

function FollowUpUrgencyPanel({ data, tv }: { data: FollowUpsReport; tv?: boolean }) {
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

  return (
    <WallboardPanel
      title="Follow-Up Urgency"
      icon={<CalendarClock className={tv ? "h-5 w-5" : "h-4 w-4"} />}
      count={totalUrgent}
      badgeUrgent={totalUrgent > 0}
      href="/crm/reports"
      tv={tv}
    >
      {/* Pressure rings OR all-clear banner */}
      {totalUrgent > 0 ? (
        <div className={`flex items-center gap-6 px-5 ${tv ? "py-5" : "py-4"} border-b border-crm-border bg-crm-surface-2/20`}>
          <CRMRingMetric
            value={overdueCallbacks.count}
            max={Math.max(1, overdueCallbacks.count + dueCallbacks.count)}
            label="Overdue Callbacks"
            sublabel={`${dueCallbacks.count} due today`}
            color="var(--crm-danger)"
            size={tv ? 88 : 72}
          />
          <CRMRingMetric
            value={overdueTasks.count}
            max={Math.max(1, overdueTasks.count + dueTasks.count)}
            label="Overdue Tasks"
            sublabel={`${dueTasks.count} due today`}
            color="var(--crm-warning)"
            size={tv ? 88 : 72}
          />
        </div>
      ) : (
        <div className={`flex items-center gap-2 px-5 ${tv ? "py-4" : "py-3"} border-b border-crm-border bg-crm-success/8`}>
          <CheckCheck className={`text-crm-success shrink-0 ${tv ? "h-5 w-5" : "h-4 w-4"}`} />
          <span className={`font-medium text-crm-success ${tv ? "text-sm" : "text-xs"}`}>
            All caught up — no overdue callbacks or tasks
          </span>
        </div>
      )}

      {/* Summary count tiles */}
      <div className="grid grid-cols-2 gap-2 px-5 py-3 border-b border-crm-border bg-crm-surface-2/20">
        {[
          { label: "Overdue Callbacks", value: overdueCallbacks.count, isDanger: overdueCallbacks.count > 0, href: "/crm/queue?mode=power&filter=overdue" },
          { label: "Due Today (CB)",    value: dueCallbacks.count,     isDanger: false,                     href: "/crm/queue?mode=power&filter=due" },
          { label: "Overdue Tasks",     value: overdueTasks.count,     isDanger: overdueTasks.count > 0,    href: "/crm/tasks" },
          { label: "Tasks Due Today",   value: dueTasks.count,         isDanger: false,                     href: "/crm/tasks" },
        ].map(({ label, value, isDanger, href }) => (
          <Link
            key={label}
            href={href}
            className={`rounded-crm border text-center hover:opacity-90 transition-opacity ${tv ? "p-4" : "p-2.5"} ${
              isDanger
                ? "border-crm-danger/30 bg-crm-danger/10"
                : "border-crm-border bg-crm-surface-2/50"
            }`}
          >
            <div className={`font-bold tabular-nums ${tv ? "text-3xl" : "text-xl"} ${isDanger ? "text-crm-danger" : "text-crm-text"}`}>
              {value}
            </div>
            <div className={`mt-0.5 ${tv ? "text-sm" : "text-xs"} ${isDanger ? "text-crm-danger/70" : "text-crm-muted"}`}>
              {label}
            </div>
          </Link>
        ))}
      </div>

      {/* Actionable rows */}
      {urgent.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <CheckCheck className={`mb-2 text-crm-success ${tv ? "h-10 w-10" : "h-7 w-7"}`} />
          <p className={`font-medium text-crm-text ${tv ? "text-base" : "text-sm"}`}>All caught up!</p>
          <p className={`mt-1 text-crm-muted ${tv ? "text-sm" : "text-xs"}`}>No overdue callbacks or tasks</p>
        </div>
      ) : (
        <div className="divide-y divide-crm-border/40">
          {urgent.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className={`flex items-center gap-3 px-5 ${tv ? "py-3.5" : "py-2.5"} hover:bg-crm-surface-2/20 group transition-colors`}
            >
              <span className={`rounded-full shrink-0 ${item.isOverdue ? "bg-crm-danger" : "bg-amber-400"} ${tv ? "w-2.5 h-2.5" : "w-2 h-2"}`} />
              <div className="flex-1 min-w-0">
                <div className={`font-semibold text-crm-text group-hover:text-crm-accent truncate transition-colors ${tv ? "text-base" : "text-sm"}`}>
                  {item.label}
                </div>
                <div className={`text-crm-muted truncate ${tv ? "text-sm" : "text-xs"}`}>{item.sub}</div>
              </div>
              <ArrowRight className={`shrink-0 text-crm-muted/50 group-hover:text-crm-accent transition-colors ${tv ? "h-4 w-4" : "h-3.5 w-3.5"}`} />
            </Link>
          ))}
        </div>
      )}
    </WallboardPanel>
  );
}

// ── Main wallboard page ───────────────────────────────────────────────────────

export default function WallboardPage() {
  const telephony   = useTelephony();
  const activeCalls = telephony.activeCalls;
  const isLive      = telephony.isLive;

  const [data, setData]               = useState<WallboardData | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [countdown, setCountdown]     = useState(COUNTDOWN_S);
  const [tvMode, setTvMode]           = useState(false);
  const [clockTime, setClockTime]     = useState<Date>(() => new Date());

  const refreshTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
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

  // ── Loading state ────────────────────────────────────────────────────────────

  if (loading && !data) {
    return (
      <div
        className={`${crm.wallboardWorkspace} min-h-screen flex items-center justify-center ${tvMode ? "fixed inset-0 z-50" : ""}`}
        style={{ background: "var(--crm-bg, var(--bg-soft, #101923))" }}
      >
        <div className="text-center text-crm-muted">
          <LayoutGrid className="h-12 w-12 mx-auto mb-3 text-crm-border animate-pulse" />
          <p className="text-sm">Loading wallboard…</p>
        </div>
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────────

  if (error && !data) {
    return (
      <div
        className={`${crm.wallboardWorkspace} min-h-screen flex items-center justify-center ${tvMode ? "fixed inset-0 z-50" : ""}`}
        style={{ background: "var(--crm-bg, var(--bg-soft, #101923))" }}
      >
        <div className="text-center max-w-sm px-4">
          <AlertCircle className="h-10 w-10 mx-auto mb-3 text-crm-danger" />
          <p className="font-semibold mb-2 text-crm-danger">Failed to load wallboard</p>
          <p className="text-crm-muted text-sm mb-4">{error}</p>
          <button onClick={handleManualRefresh} className={crm.btnPrimary}>
            Try Again
          </button>
        </div>
      </div>
    );
  }

  const { daily, campaigns, agents, followUps } = data!;
  const totalUrgent = followUps.callbacks.overdue.count + followUps.tasks.overdue.count;

  // Countdown display
  const countdownLabel = loading
    ? "Refreshing…"
    : countdown === 0
    ? "Refreshing soon…"
    : `Refreshes in ${countdown}s`;

  // ── Shared UI elements ───────────────────────────────────────────────────────

  const LiveBadge = (
    <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-semibold border shrink-0 ${
      isLive
        ? "bg-crm-success/12 text-crm-success border-crm-success/25"
        : "bg-crm-warning/12 text-crm-warning border-crm-warning/25"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isLive ? "bg-crm-success animate-pulse" : "bg-crm-warning"}`} />
      {isLive ? "WS Live" : "Connecting…"}
    </span>
  );

  const UrgentBadge = totalUrgent > 0 ? (
    <span className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-semibold border bg-crm-danger/12 text-crm-danger border-crm-danger/25 shrink-0">
      <AlertTriangle className="h-3 w-3" />
      {totalUrgent} urgent
    </span>
  ) : null;

  // KPI strip shared between normal and TV
  const KpiStrip = ({ isTv }: { isTv: boolean }) => (
    <div className="grid grid-cols-4 sm:grid-cols-8 gap-3">
      <WallboardKpiTile label="Active Calls"       value={activeCalls.length}         icon={<PhoneCall     className={isTv ? "h-6 w-6" : "h-5 w-5"} />} tv={isTv} />
      <WallboardKpiTile label="Queue Remaining"    value={daily.queueRemaining}        icon={<Zap           className={isTv ? "h-6 w-6" : "h-5 w-5"} />} href="/crm/queue" tv={isTv} />
      <WallboardKpiTile label="Overdue Callbacks"  value={daily.overdueCallbacks}      icon={<AlertCircle   className={isTv ? "h-6 w-6" : "h-5 w-5"} />} tone="danger" href="/crm/queue?mode=power&filter=overdue" tv={isTv} />
      <WallboardKpiTile label="Due Today (CB)"     value={daily.callbacksDueToday}     icon={<CalendarClock className={isTv ? "h-6 w-6" : "h-5 w-5"} />} tone="warn" href="/crm/queue?mode=power&filter=due" tv={isTv} />
      <WallboardKpiTile label="Dispositions Today" value={daily.dispositionsToday}     icon={<TrendingUp    className={isTv ? "h-6 w-6" : "h-5 w-5"} />} tone="positive" tv={isTv} />
      <WallboardKpiTile label="Contacts Created"   value={daily.contactsCreatedToday}  icon={<Users         className={isTv ? "h-6 w-6" : "h-5 w-5"} />} href="/crm/contacts" tv={isTv} />
      <WallboardKpiTile label="Active Campaigns"   value={daily.activeCampaigns}       icon={<Megaphone     className={isTv ? "h-6 w-6" : "h-5 w-5"} />} href="/crm/campaigns" tv={isTv} />
      <WallboardKpiTile label="Overdue Tasks"      value={daily.overdueTasks}          icon={<CheckSquare   className={isTv ? "h-6 w-6" : "h-5 w-5"} />} tone="danger" href="/crm/tasks" tv={isTv} />
    </div>
  );

  // Panel grid shared between normal and TV
  const PanelGrid = ({ isTv }: { isTv: boolean }) => (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <LiveCallsPanel     calls={activeCalls} isLive={isLive} tv={isTv} />
      <AgentActivityPanel agents={agents} activeCalls={activeCalls} tv={isTv} />
      <CampaignProgressPanel campaigns={campaigns} tv={isTv} />
      <FollowUpUrgencyPanel  data={followUps} tv={isTv} />
    </div>
  );

  // ── TV Mode render ─────────────────────────────────────────────────────────
  // TV mode is a fixed-overlay (position:fixed inset-0 z-50) per Rule 77.
  // It does NOT modify AppShell, PlatformLayout, or any shared layout provider.

  if (tvMode) {
    return (
      <div
        className={`fixed inset-0 z-50 overflow-auto ${crm.wallboardWorkspace}`}
        style={{ background: "var(--crm-bg, var(--bg-soft, #101923))" }}
      >
        {/* TV Header */}
        <div className="border-b border-crm-border bg-crm-surface">
          <div className="max-w-[1600px] mx-auto px-6 py-4 grid grid-cols-3 items-center gap-4">
            {/* Left: title + badges */}
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-9 w-9 items-center justify-center rounded-crm bg-crm-accent/15 text-crm-accent shrink-0">
                <LayoutGrid className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="text-xl font-bold text-crm-text">Live Wallboard</h1>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {LiveBadge}
                  {UrgentBadge}
                </div>
              </div>
            </div>

            {/* Center: large clock */}
            <div className="text-center">
              <div className="text-5xl font-bold tabular-nums text-crm-text tracking-tight">
                {formatClock(clockTime)}
              </div>
              <div className="text-sm text-crm-muted mt-0.5">{formatClockDate(clockTime)}</div>
            </div>

            {/* Right: refresh info + controls */}
            <div className="flex items-center justify-end gap-3">
              <div className="text-right text-sm text-crm-muted">
                {lastRefresh && <div>Updated {relTime(lastRefresh.toISOString())}</div>}
                <div className={countdown <= 10 ? "text-crm-warning font-semibold" : "text-crm-muted"}>
                  {countdownLabel}
                </div>
              </div>
              <button
                onClick={handleManualRefresh}
                disabled={loading}
                className={`${crm.btnSecondary} disabled:opacity-50`}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
              <button onClick={toggleTvMode} className={crm.btnGhost} title="Exit TV mode">
                <X className="h-4 w-4" />
                Exit TV
              </button>
            </div>
          </div>
        </div>

        {/* TV KPI strip */}
        <div className="border-b border-crm-border bg-crm-surface-2/20">
          <div className="max-w-[1600px] mx-auto px-6 py-5">
            <KpiStrip isTv />
          </div>
        </div>

        {/* TV panel grid */}
        <div className="max-w-[1600px] mx-auto px-6 py-6">
          <PanelGrid isTv />
          <p className="text-center text-sm text-crm-muted/30 mt-6">
            CRM data refreshes every {REFRESH_MS / 1000}s · Live calls via WebSocket · Read-only view
          </p>
        </div>
      </div>
    );
  }

  // ── Normal mode render ─────────────────────────────────────────────────────

  return (
    <div
      className={`min-h-screen ${crm.wallboardWorkspace}`}
      style={{ background: "var(--crm-bg, var(--bg-soft, #101923))" }}
    >
      {/* Sticky header */}
      <div className="sticky top-0 z-10 border-b border-crm-border bg-crm-surface/95 backdrop-blur-sm">
        <div className="max-w-[1600px] mx-auto px-5 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-crm bg-crm-accent/15 text-crm-accent shrink-0">
              <LayoutGrid className="h-4 w-4" />
            </div>
            <h1 className="text-lg font-bold text-crm-text truncate">Live Wallboard</h1>
            {LiveBadge}
            {UrgentBadge}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="text-right text-xs hidden sm:block mr-1">
              {lastRefresh && (
                <div className="text-crm-muted">Updated {relTime(lastRefresh.toISOString())}</div>
              )}
              <div className={countdown <= 10 ? "text-crm-warning font-semibold" : "text-crm-muted"}>
                {countdownLabel}
              </div>
            </div>
            <button
              onClick={handleManualRefresh}
              disabled={loading}
              className={`${crm.btnGhost} disabled:opacity-50`}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <button onClick={toggleTvMode} className={crm.btnSecondary}>
              <Tv className="h-4 w-4" />
              <span className="hidden sm:inline">TV Mode</span>
            </button>
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="border-b border-crm-border bg-crm-surface-2/20">
        <div className="max-w-[1600px] mx-auto px-5 py-5">
          <KpiStrip isTv={false} />
        </div>
      </div>

      {/* Panel grid */}
      <div className="max-w-[1600px] mx-auto px-5 py-6">
        <PanelGrid isTv={false} />
        <p className="text-center text-xs text-crm-muted/30 mt-6">
          CRM data refreshes every {REFRESH_MS / 1000}s · Live calls update via WebSocket · Read-only view
        </p>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  PhoneCall, Users, Megaphone, CalendarClock,
  AlertCircle, RefreshCw, Clock, ArrowRight, CheckCheck,
  PhoneIncoming, PhoneOutgoing, Phone, Inbox,
  TrendingUp, CheckSquare, LayoutGrid,
  Zap, ChevronRight, Tv, X, AlertTriangle,
  Settings, Maximize2, Activity, Headphones, Target,
  BarChart3, Keyboard, ListChecks, Copy, Sparkles,
  CircleDot, ShieldCheck,
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
      <span className={`inline-flex items-center gap-1 rounded-full font-semibold border bg-crm-warning/12 text-crm-warning border-crm-warning/25 ${sz}`}>
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
                    <div style={{ width: `${c.total > 0 ? (c.contacted / c.total) * 100 : 0}%` }} className="bg-crm-accent/70 transition-[width] duration-300" />
                    <div style={{ width: `${c.total > 0 ? (c.callbacks / c.total) * 100 : 0}%` }} className="bg-crm-warning transition-[width] duration-300" />
                    <div style={{ width: `${c.total > 0 ? (c.converted / c.total) * 100 : 0}%` }} className="bg-crm-success transition-[width] duration-300" />
                    <div style={{ width: `${c.total > 0 ? (c.dnc / c.total) * 100 : 0}%` }} className="bg-crm-border/60 transition-[width] duration-300" />
                  </div>
                </div>
                <div className={`flex flex-wrap gap-3 ${tv ? "text-sm" : "text-xs"} text-crm-muted`}>
                  <span><span className="font-semibold text-crm-text">{c.pending}</span> pending</span>
                  <span><span className="font-semibold text-crm-accent">{c.contacted}</span> contacted</span>
                  <span><span className="font-semibold text-crm-warning">{c.callbacks}</span> callbacks</span>
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

type WallboardMetric = {
  label: string;
  value: string | number;
  sub: string;
  icon: React.ReactNode;
  tone: "blue" | "green" | "purple" | "teal" | "orange" | "pink" | "indigo";
  href?: string;
  spark?: number[];
};

const toneClasses: Record<WallboardMetric["tone"], { icon: string; line: string; bg: string }> = {
  blue: { icon: "bg-sky-50 text-sky-600 ring-sky-100", line: "stroke-sky-500", bg: "from-sky-50/80" },
  green: { icon: "bg-emerald-50 text-emerald-600 ring-emerald-100", line: "stroke-emerald-500", bg: "from-emerald-50/80" },
  purple: { icon: "bg-purple-50 text-purple-600 ring-purple-100", line: "stroke-purple-500", bg: "from-purple-50/80" },
  teal: { icon: "bg-teal-50 text-teal-600 ring-teal-100", line: "stroke-teal-500", bg: "from-teal-50/80" },
  orange: { icon: "bg-orange-50 text-orange-600 ring-orange-100", line: "stroke-orange-500", bg: "from-orange-50/80" },
  pink: { icon: "bg-fuchsia-50 text-fuchsia-600 ring-fuchsia-100", line: "stroke-fuchsia-500", bg: "from-fuchsia-50/80" },
  indigo: { icon: "bg-indigo-50 text-indigo-600 ring-indigo-100", line: "stroke-indigo-500", bg: "from-indigo-50/80" },
};

function formatPercentValue(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(value * 10) / 10}%`;
}

function formatAverageTalkTime(calls: LiveCall[]): string {
  const answered = calls.filter((call) => call.answeredAt);
  if (answered.length === 0) return "0:00";
  const totalSeconds = answered.reduce((sum, call) => sum + Math.max(0, Math.floor((Date.now() - new Date(call.answeredAt ?? call.startedAt).getTime()) / 1000)), 0);
  const avg = Math.floor(totalSeconds / answered.length);
  const minutes = Math.floor(avg / 60);
  const seconds = avg % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "A";
}

function miniSeries(seed: number, length = 7): number[] {
  const base = Math.max(1, seed);
  return Array.from({ length }, (_, index) => Math.max(1, Math.round(base * (0.48 + index * 0.08 + ((index % 3) * 0.07)))));
}

function Sparkline({ values, tone = "blue", tall = false }: { values: number[]; tone?: WallboardMetric["tone"]; tall?: boolean }) {
  const max = Math.max(1, ...values);
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * 100;
    const y = 34 - (Math.max(0, value) / max) * 26;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg viewBox="0 0 100 38" className={tall ? "h-12 w-24" : "h-9 w-20"} aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={toneClasses[tone].line}
      />
    </svg>
  );
}

function WallboardCard({
  title,
  icon,
  action,
  children,
  className = "",
}: {
  title: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-[1.35rem] border border-crm-border bg-crm-surface shadow-crm ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-crm-border/70 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-50 text-crm-accent ring-1 ring-slate-100">
            {icon}
          </span>
          <h2 className="text-sm font-bold tracking-tight text-crm-text">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function MockupKpiCard({ metric }: { metric: WallboardMetric }) {
  const tone = toneClasses[metric.tone];
  const content = (
    <div className={`group relative min-h-[7.4rem] overflow-hidden rounded-[1.25rem] border border-crm-border bg-gradient-to-br ${tone.bg} via-white to-white p-4 shadow-crm transition-all hover:-translate-y-0.5 hover:shadow-[0_16px_36px_-20px_rgba(15,23,42,0.35)]`}>
      <div className="flex items-start justify-between gap-2">
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ring-1 ${tone.icon}`}>
          {metric.icon}
        </span>
        <Sparkline values={metric.spark ?? miniSeries(Number(metric.value) || 1)} tone={metric.tone} />
      </div>
      <div className="mt-3">
        <p className="text-[11px] font-semibold text-crm-muted">{metric.label}</p>
        <div className="mt-1 flex items-end justify-between gap-3">
          <span className="text-[1.65rem] font-bold leading-none tracking-tight text-crm-text tabular-nums">{metric.value}</span>
          <span className="text-[10px] font-semibold text-emerald-600">{metric.sub}</span>
        </div>
      </div>
    </div>
  );

  return metric.href ? <Link href={metric.href} className="block no-underline">{content}</Link> : content;
}

function TeamPerformanceCard({ agents, activeCalls }: { agents: AgentRow[]; activeCalls: LiveCall[] }) {
  const rows = agents.slice(0, 6);
  const maxAnswered = Math.max(1, ...rows.map((agent) => agent.dispositionsToday));

  return (
    <WallboardCard
      title="Team Performance"
      icon={<Users className="h-4 w-4" />}
      action={<Link href="/crm/reports" className="text-xs font-semibold text-crm-accent hover:underline">View all agents</Link>}
      className="h-full overflow-hidden"
    >
      <div className="hidden grid-cols-[minmax(10rem,1.4fr)_0.8fr_0.55fr_0.65fr_0.8fr_0.8fr_4rem] gap-3 border-b border-crm-border/60 px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-crm-muted lg:grid">
        <span>Agent</span>
        <span>Status</span>
        <span>Calls</span>
        <span>Answered</span>
        <span>Conv. Rate</span>
        <span>Avg. Talk Time</span>
        <span />
      </div>
      <div className="divide-y divide-crm-border/55">
        {rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-crm-muted">No CRM agents configured yet.</div>
        ) : rows.map((agent, index) => {
          const activeCall = findAgentCall(agent.extensions ?? [], activeCalls);
          const flag = agentStatus(agent);
          const conversion = agent.dispositionsToday > 0 ? (agent.convertedLast / agent.dispositionsToday) * 100 : 0;
          const statusLabel = activeCall ? "On Call" : flag === "idle" ? "Available" : flag === "active" ? "Available" : flag === "needs-attention" ? "On Break" : "Follow-up";
          const statusClass = activeCall
            ? "bg-sky-50 text-sky-700 border-sky-100"
            : statusLabel === "Available"
              ? "bg-emerald-50 text-emerald-700 border-emerald-100"
              : "bg-amber-50 text-amber-700 border-amber-100";

          return (
            <div key={agent.userId} className="grid gap-3 px-4 py-3 text-sm lg:grid-cols-[minmax(10rem,1.4fr)_0.8fr_0.55fr_0.65fr_0.8fr_0.8fr_4rem] lg:items-center">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-100 to-slate-50 text-xs font-bold text-slate-600 ring-1 ring-slate-200">
                  {initials(agent.displayName)}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-crm-text">{agent.displayName}</p>
                  <p className="truncate text-[11px] text-crm-muted">{agent.extensions.length ? `Ext ${agent.extensions.join(", ")}` : agent.crmRole}</p>
                </div>
              </div>
              <span className={`w-fit rounded-full border px-2 py-1 text-[11px] font-semibold ${statusClass}`}>{statusLabel}</span>
              <span className="font-semibold tabular-nums text-crm-text">{agent.assignedQueue + agent.dispositionsToday}</span>
              <span className="font-semibold tabular-nums text-crm-text">{agent.dispositionsToday}</span>
              <span className="font-semibold tabular-nums text-crm-text">{formatPercentValue(conversion)}</span>
              <span className="font-semibold tabular-nums text-crm-text">{activeCall ? callDuration(activeCall.startedAt, activeCall.answeredAt) : "—"}</span>
              <Sparkline values={miniSeries(agent.dispositionsToday + index + 1, 6)} tone="green" />
            </div>
          );
        })}
      </div>
    </WallboardCard>
  );
}

function LiveActivityFeedCard({
  activeCalls,
  data,
  isLive,
}: {
  activeCalls: LiveCall[];
  data: WallboardData;
  isLive: boolean;
}) {
  const rows = [
    ...activeCalls.slice(0, 3).map((call) => ({
      key: `call-${call.id}`,
      icon: <PhoneCall className="h-4 w-4" />,
      iconClass: "bg-emerald-50 text-emerald-600 ring-emerald-100",
      title: call.state === "up" ? "Call connected" : call.state === "ringing" ? "Incoming call ringing" : "Call activity",
      sub: `${call.fromName || call.from || "Unknown caller"} ${call.to ? `to ${call.to}` : ""}`,
      time: relTime(call.startedAt),
    })),
    ...data.followUps.callbacks.dueToday.rows.slice(0, 2).map((item) => ({
      key: `cb-${item.id}`,
      icon: <CalendarClock className="h-4 w-4" />,
      iconClass: "bg-orange-50 text-orange-600 ring-orange-100",
      title: "Callback due",
      sub: `${item.contactName}${item.campaign?.name ? ` · ${item.campaign.name}` : ""}`,
      time: item.callbackAt ? callbackLabel(item.callbackAt).label : "today",
    })),
    ...data.campaigns.slice(0, 2).map((campaign) => ({
      key: `camp-${campaign.id}`,
      icon: <Megaphone className="h-4 w-4" />,
      iconClass: "bg-sky-50 text-sky-600 ring-sky-100",
      title: "Campaign active",
      sub: `${campaign.name} · ${campaign.totalAttempts} attempts`,
      time: campaign.lastActivityAt ? relTime(campaign.lastActivityAt) : "today",
    })),
  ].slice(0, 6);

  return (
    <WallboardCard
      title="Live Activity Feed"
      icon={<Activity className="h-4 w-4" />}
      action={<span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600"><span className={`h-1.5 w-1.5 rounded-full ${isLive ? "animate-pulse bg-emerald-500" : "bg-amber-500"}`} />Live</span>}
      className="h-full overflow-hidden"
    >
      <div className="divide-y divide-crm-border/55">
        {rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-crm-muted">Live activity will appear here as calls and campaigns move.</div>
        ) : rows.map((row) => (
          <div key={row.key} className="flex items-center gap-3 px-4 py-3">
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ${row.iconClass}`}>{row.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-crm-text">{row.title}</p>
              <p className="truncate text-xs text-crm-muted">{row.sub}</p>
            </div>
            <span className="shrink-0 text-[11px] font-medium text-crm-muted">{row.time}</span>
          </div>
        ))}
      </div>
    </WallboardCard>
  );
}

function LiveCallsWorkspaceCard({ calls, isLive }: { calls: LiveCall[]; isLive: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <WallboardCard
      title="Live Calls"
      icon={<Headphones className="h-4 w-4" />}
      action={<span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${isLive ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{calls.length}</span>}
      className="overflow-hidden"
    >
      <div className="divide-y divide-crm-border/55">
        {calls.length === 0 ? (
          <div className="flex items-center justify-center gap-3 px-5 py-8 text-sm text-crm-muted">
            <Phone className="h-5 w-5 text-crm-muted/60" />
            No active calls right now. New calls appear here in real time.
          </div>
        ) : calls.slice(0, 5).map((call) => {
          const isAnswered = call.state === "up" || !!call.answeredAt;
          const status = call.state === "dialing" ? "Dialing" : isAnswered ? (call.direction === "outbound" ? "Speaking" : "Listening") : call.state;
          const sentiment = isAnswered ? "AI ready" : "Monitoring";
          return (
            <div key={call.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)_0.6fr_auto] sm:items-center">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100">
                  {call.direction === "outbound" ? <PhoneOutgoing className="h-4 w-4" /> : <PhoneIncoming className="h-4 w-4" />}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-crm-text">{call.fromName || call.from || "Unknown caller"}</p>
                  <p className="truncate text-xs text-crm-muted">{call.from || "No caller ID"} → {call.to || "Unknown destination"}</p>
                </div>
              </div>
              <div className="min-w-0 text-xs text-crm-muted">
                <span className="font-semibold text-crm-text">{call.extensions.length ? `Ext ${call.extensions.join(", ")}` : call.connectedLine || "Agent pending"}</span>
                {call.queueId ? <span className="block truncate">Queue {call.queueId}</span> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-emerald-100 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700">{status}</span>
                <span className="rounded-full border border-sky-100 bg-sky-50 px-2 py-1 text-[11px] font-semibold text-sky-700">{sentiment}</span>
              </div>
              <div className="flex items-center justify-between gap-3 sm:justify-end">
                <span className="font-semibold tabular-nums text-crm-text">{callDuration(call.startedAt, call.answeredAt)}</span>
                <Link href="/crm/live-call" className="text-xs font-semibold text-crm-accent hover:underline">Go to workspace</Link>
              </div>
            </div>
          );
        })}
      </div>
    </WallboardCard>
  );
}

function CallOutcomesCard({ daily }: { daily: DailyReport }) {
  const answered = daily.callsLinkedToday;
  const other = Math.max(0, daily.dispositionsToday - answered);
  const outcomes = [
    { label: "Answered", value: answered, color: "bg-emerald-500" },
    { label: "Voicemail", value: 0, color: "bg-sky-500" },
    { label: "No Answer", value: 0, color: "bg-violet-500" },
    { label: "Wrong Number", value: 0, color: "bg-orange-500" },
    { label: "Other", value: other, color: "bg-slate-400" },
  ];
  const total = Math.max(1, outcomes.reduce((sum, row) => sum + row.value, 0));
  let offset = 25;
  const gradientStops = outcomes.map((row) => {
    const width = (row.value / total) * 100;
    const start = offset;
    const end = offset + width;
    offset = end;
    const color = row.color.includes("emerald") ? "#10b981" : row.color.includes("sky") ? "#0ea5e9" : row.color.includes("violet") ? "#8b5cf6" : row.color.includes("orange") ? "#f97316" : "#94a3b8";
    return `${color} ${start}% ${end}%`;
  }).join(", ");

  return (
    <WallboardCard title="Call Outcomes Today" icon={<CircleDot className="h-4 w-4" />} className="overflow-hidden">
      <div className="flex items-center gap-5 px-4 py-5">
        <div className="relative grid h-32 w-32 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(${gradientStops || "#e2e8f0 0% 100%"})` }}>
          <div className="grid h-20 w-20 place-items-center rounded-full bg-white shadow-inner">
            <div className="text-center">
              <p className="text-2xl font-bold leading-none text-crm-text tabular-nums">{daily.dispositionsToday}</p>
              <p className="mt-1 text-[10px] font-semibold text-crm-muted">Total Calls</p>
            </div>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          {outcomes.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3 text-xs">
              <span className="flex items-center gap-2 text-crm-muted"><span className={`h-2 w-2 rounded-full ${row.color}`} />{row.label}</span>
              <span className="font-semibold tabular-nums text-crm-text">{row.value}</span>
            </div>
          ))}
        </div>
      </div>
    </WallboardCard>
  );
}

function CallsOverTimeCard({ total, answered }: { total: number; answered: number }) {
  const totalSeries = miniSeries(total, 7);
  const answeredSeries = miniSeries(answered, 7);
  return (
    <WallboardCard
      title="Calls Over Time"
      icon={<BarChart3 className="h-4 w-4" />}
      action={<span className="rounded-full bg-slate-50 px-2 py-1 text-[10px] font-bold text-crm-muted">Today</span>}
      className="overflow-hidden"
    >
      <div className="px-4 py-5">
        <div className="mb-3 flex items-center gap-4 text-[11px] font-semibold text-crm-muted">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-500" />Total Calls</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" />Answered Calls</span>
        </div>
        <div className="rounded-2xl bg-gradient-to-b from-slate-50 to-white p-3 ring-1 ring-slate-100">
          <svg viewBox="0 0 320 150" className="h-36 w-full" aria-label="Calls over time chart">
            {[0, 1, 2, 3].map((line) => <line key={line} x1="0" x2="320" y1={20 + line * 34} y2={20 + line * 34} stroke="#e2e8f0" strokeWidth="1" />)}
            <polyline points={totalSeries.map((value, index) => `${index * 53},${130 - (value / Math.max(1, ...totalSeries)) * 105}`).join(" ")} fill="none" stroke="#0ea5e9" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
            <polyline points={answeredSeries.map((value, index) => `${index * 53},${130 - (value / Math.max(1, ...totalSeries)) * 105}`).join(" ")} fill="none" stroke="#10b981" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
    </WallboardCard>
  );
}

function TopCampaignsTodayCard({ campaigns }: { campaigns: CampaignRow[] }) {
  const rows = [...campaigns].sort((a, b) => b.totalAttempts - a.totalAttempts).slice(0, 4);
  return (
    <WallboardCard
      title="Top Campaigns Today"
      icon={<Target className="h-4 w-4" />}
      action={<Link href="/crm/campaigns" className="text-xs font-semibold text-crm-accent hover:underline">View all</Link>}
      className="overflow-hidden"
    >
      <div className="divide-y divide-crm-border/55">
        {rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-crm-muted">No active campaign activity yet.</div>
        ) : rows.map((campaign, index) => (
          <Link key={campaign.id} href={`/crm/campaigns/${campaign.id}`} className="flex items-center gap-3 px-4 py-3 no-underline hover:bg-slate-50/80">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-xs font-bold text-emerald-700 ring-1 ring-emerald-100">{index + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-crm-text">{campaign.name}</p>
              <p className="text-xs text-crm-muted">{campaign.totalAttempts} calls</p>
            </div>
            <span className="text-sm font-bold tabular-nums text-crm-text">{formatPercentValue(campaign.conversionRate)}</span>
          </Link>
        ))}
      </div>
    </WallboardCard>
  );
}

function WallboardRightRail({ data, activeCalls }: { data: WallboardData; activeCalls: LiveCall[] }) {
  const topCampaign = [...data.campaigns].sort((a, b) => b.conversionRate - a.conversionRate)[0];
  return (
    <aside className="flex flex-col gap-4">
      <WallboardCard title="Instructions" icon={<Sparkles className="h-4 w-4" />}>
        <div className="space-y-3 px-4 py-4 text-xs leading-relaxed text-crm-muted">
          <p>Use this wallboard to monitor live CRM performance and keep your team aligned.</p>
          {[
            "Monitor live activity across calls, agents, and campaign status in real time.",
            "Optimize performance by spotting queue pressure and follow-up risk.",
            "Take action by jumping into Live Call Workspace or campaign views.",
          ].map((item, index) => (
            <div key={item} className="flex gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-50 text-[10px] font-bold text-sky-700">{index + 1}</span>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </WallboardCard>
      <WallboardCard title="Quick Actions" icon={<Zap className="h-4 w-4" />}>
        <div className="grid gap-2 px-4 py-4">
          <Link href="/crm/live-call" className="flex items-center justify-between rounded-xl border border-crm-border bg-slate-50 px-3 py-2 text-sm font-semibold text-crm-text no-underline hover:bg-white">
            Open Live Call Workspace <ArrowRight className="h-4 w-4 text-crm-accent" />
          </Link>
          <Link href="/crm/campaigns" className="flex items-center justify-between rounded-xl border border-crm-border bg-slate-50 px-3 py-2 text-sm font-semibold text-crm-text no-underline hover:bg-white">
            Review Campaigns <ArrowRight className="h-4 w-4 text-crm-accent" />
          </Link>
          <Link href="/crm/reports" className="flex items-center justify-between rounded-xl border border-crm-border bg-slate-50 px-3 py-2 text-sm font-semibold text-crm-text no-underline hover:bg-white">
            View Reports <ArrowRight className="h-4 w-4 text-crm-accent" />
          </Link>
        </div>
      </WallboardCard>
      <WallboardCard title="Wallboard Insights" icon={<ShieldCheck className="h-4 w-4" />}>
        <div className="space-y-3 px-4 py-4 text-sm">
          <div className="rounded-xl bg-emerald-50 px-3 py-2 text-emerald-800 ring-1 ring-emerald-100">
            <span className="font-bold">{activeCalls.length}</span> live calls currently visible.
          </div>
          {topCampaign ? (
            <div className="rounded-xl bg-sky-50 px-3 py-2 text-sky-800 ring-1 ring-sky-100">
              Top conversion: <span className="font-bold">{topCampaign.name}</span> at {formatPercentValue(topCampaign.conversionRate)}.
            </div>
          ) : (
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-crm-muted ring-1 ring-slate-100">Campaign insights appear after activity starts.</div>
          )}
        </div>
      </WallboardCard>
    </aside>
  );
}

function BottomShortcutStrip() {
  const shortcuts = [
    { icon: <Keyboard className="h-4 w-4" />, title: "Press N", body: "Create new checklist anytime", href: "/crm/checklists" },
    { icon: <ListChecks className="h-4 w-4" />, title: "Checklist mode", body: "Use guided flows in Live Call", href: "/crm/live-call" },
    { icon: <Copy className="h-4 w-4" />, title: "Copy steps", body: "Reuse proven language", href: "/crm/checklists" },
    { icon: <PhoneCall className="h-4 w-4" />, title: "Go live", body: "Open Live Call Workspace", href: "/crm/live-call" },
  ];

  return (
    <div className="grid gap-2 rounded-[1.35rem] border border-crm-border bg-crm-surface p-2 shadow-crm sm:grid-cols-2 lg:grid-cols-4">
      {shortcuts.map((shortcut) => (
        <Link key={shortcut.title} href={shortcut.href} className="flex items-center gap-3 rounded-2xl px-3 py-3 no-underline transition-colors hover:bg-slate-50">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-crm-accent ring-1 ring-slate-100">{shortcut.icon}</span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-crm-text">{shortcut.title}</span>
            <span className="block truncate text-[11px] text-crm-muted">{shortcut.body}</span>
          </span>
        </Link>
      ))}
    </div>
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
              <span className={`rounded-full shrink-0 ${item.isOverdue ? "bg-crm-danger" : "bg-crm-warning"} ${tv ? "w-2.5 h-2.5" : "w-2 h-2"}`} />
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
  const [lightWallboard, setLightWallboard] = useState(true);

  const refreshTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  // Read ?tv=1 from URL on mount (avoids Suspense requirement for useSearchParams)
  useEffect(() => {
    if (typeof window !== "undefined") {
      setTvMode(new URLSearchParams(window.location.search).get("tv") === "1");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const readTheme = () => {
      const theme = document.documentElement.dataset.theme || localStorage.getItem("cc-theme") || "light";
      setLightWallboard(theme !== "dark");
    };
    readTheme();
    const observer = new MutationObserver(readTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener("storage", readTheme);
    return () => {
      observer.disconnect();
      window.removeEventListener("storage", readTheme);
    };
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

  const handleFullscreen = useCallback(() => {
    if (typeof document === "undefined") return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    void document.documentElement.requestFullscreen?.();
  }, []);

  // ── Loading state ────────────────────────────────────────────────────────────

  if (loading && !data) {
    return (
      <div
        className={`${crm.wallboardWorkspace} min-h-screen flex items-center justify-center ${tvMode ? "fixed inset-0 z-50" : ""}`}
        style={{ background: "var(--crm-bg)" }}
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
        style={{ background: "var(--crm-bg)" }}
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
        style={{ background: "var(--crm-bg)" }}
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

  if (!lightWallboard) {
    return (
      <div
        className={`min-h-screen ${crm.wallboardWorkspace}`}
        style={{ background: "var(--crm-bg)" }}
      >
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

        <div className="border-b border-crm-border bg-crm-surface-2/20">
          <div className="max-w-[1600px] mx-auto px-5 py-5">
            <KpiStrip isTv={false} />
          </div>
        </div>

        <div className="max-w-[1600px] mx-auto px-5 py-6">
          <PanelGrid isTv={false} />
          <p className="text-center text-xs text-crm-muted/30 mt-6">
            CRM data refreshes every {REFRESH_MS / 1000}s · Live calls update via WebSocket · Read-only view
          </p>
        </div>
      </div>
    );
  }

  const callsInQueue = telephony.queueList.reduce((sum, queue) => sum + queue.callerCount, 0) || daily.queueRemaining;
  const availableAgentsFromQueues = telephony.queueList.reduce(
    (sum, queue) => sum + queue.members.filter((member) => !member.paused && member.status === "idle").length,
    0,
  );
  const availableAgents = availableAgentsFromQueues || agents.filter((agent) => !findAgentCall(agent.extensions ?? [], activeCalls)).length;
  const campaignAttempts = campaigns.reduce((sum, campaign) => sum + campaign.totalAttempts, 0);
  const campaignConverted = campaigns.reduce((sum, campaign) => sum + campaign.converted, 0);
  const conversionRate = campaignAttempts > 0 ? (campaignConverted / campaignAttempts) * 100 : 0;
  const totalCallsToday = Math.max(daily.dispositionsToday, daily.callsLinkedToday + activeCalls.length);
  const kpiMetrics: WallboardMetric[] = [
    {
      label: "Active Calls",
      value: activeCalls.length,
      sub: isLive ? "Live now" : "Connecting",
      icon: <PhoneCall className="h-4 w-4" />,
      tone: "blue",
      spark: miniSeries(activeCalls.length + 2),
    },
    {
      label: "Available Agents",
      value: availableAgents,
      sub: "Ready to connect",
      icon: <Users className="h-4 w-4" />,
      tone: "green",
      spark: miniSeries(availableAgents + 2),
    },
    {
      label: "Calls in Queue",
      value: callsInQueue,
      sub: callsInQueue > 0 ? "Waiting" : "Clear",
      icon: <Clock className="h-4 w-4" />,
      tone: "purple",
      href: "/crm/queue",
      spark: miniSeries(callsInQueue + 2),
    },
    {
      label: "Answered Today",
      value: daily.callsLinkedToday,
      sub: `${daily.contactsCreatedToday} contacts`,
      icon: <CheckCheck className="h-4 w-4" />,
      tone: "teal",
      spark: miniSeries(daily.callsLinkedToday + 2),
    },
    {
      label: "Total Calls Today",
      value: totalCallsToday,
      sub: `${daily.dispositionsToday} outcomes`,
      icon: <PhoneIncoming className="h-4 w-4" />,
      tone: "orange",
      spark: miniSeries(totalCallsToday + 2),
    },
    {
      label: "Avg. Talk Time",
      value: formatAverageTalkTime(activeCalls),
      sub: "Active calls",
      icon: <Headphones className="h-4 w-4" />,
      tone: "pink",
      spark: miniSeries(activeCalls.reduce((sum, call) => sum + call.durationSec, 0) + 2),
    },
    {
      label: "Conversion Rate",
      value: formatPercentValue(conversionRate),
      sub: `${campaignConverted} wins`,
      icon: <TrendingUp className="h-4 w-4" />,
      tone: "indigo",
      spark: miniSeries(Math.round(conversionRate) + 2),
    },
  ];

  return (
    <div
      className={`min-h-screen ${crm.wallboardWorkspace} crm-wallboard-shell`}
      style={{ background: "var(--crm-bg)" }}
    >
      <div className="mx-auto flex w-full max-w-[1720px] flex-col gap-4 px-3 py-4 sm:px-5 lg:px-6 xl:px-7">
        <header className="rounded-[1.6rem] border border-crm-border bg-crm-surface px-4 py-4 shadow-crm sm:px-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-sky-50 text-sky-600 ring-1 ring-sky-100">
                <Users className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-2xl font-bold tracking-tight text-crm-text">Live Wallboard</h1>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
                    <span className={`h-1.5 w-1.5 rounded-full ${isLive ? "animate-pulse bg-emerald-500" : "bg-amber-500"}`} />
                    {isLive ? "Live" : "Connecting"}
                  </span>
                  {UrgentBadge}
                </div>
                <p className="mt-1 text-sm text-crm-muted">Real-time overview of your team&apos;s performance</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              <div className="mr-1 text-xs text-crm-muted">
                {lastRefresh ? <div className="font-semibold text-crm-text">Updated {relTime(lastRefresh.toISOString())}</div> : null}
                <div className={countdown <= 10 ? "font-semibold text-crm-warning" : ""}>Auto-refresh in {countdown}s</div>
              </div>
              <button onClick={handleManualRefresh} disabled={loading} className={`${crm.btnGhost} disabled:opacity-50`}>
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                <span className="hidden sm:inline">Refresh</span>
              </button>
              <button onClick={toggleTvMode} className={crm.btnSecondary}>
                <Tv className="h-4 w-4" />
                <span className="hidden sm:inline">TV Mode</span>
              </button>
              <button onClick={handleFullscreen} className={crm.btnSecondary}>
                <Maximize2 className="h-4 w-4" />
                <span className="hidden sm:inline">Fullscreen</span>
              </button>
              <Link href="/crm/settings" className={crm.btnGhost}>
                <Settings className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {kpiMetrics.map((metric) => <MockupKpiCard key={metric.label} metric={metric} />)}
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_21rem] 2xl:grid-cols-[minmax(0,1fr)_22rem]">
          <main className="flex min-w-0 flex-col gap-4">
            <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.2fr)_minmax(24rem,0.8fr)]">
              <TeamPerformanceCard agents={agents} activeCalls={activeCalls} />
              <LiveActivityFeedCard activeCalls={activeCalls} data={data!} isLive={isLive} />
            </div>

            <LiveCallsWorkspaceCard calls={activeCalls} isLive={isLive} />

            <div className="grid gap-4 lg:grid-cols-3">
              <CallOutcomesCard daily={daily} />
              <CallsOverTimeCard total={totalCallsToday} answered={daily.callsLinkedToday} />
              <TopCampaignsTodayCard campaigns={campaigns} />
            </div>
          </main>

          <WallboardRightRail data={data!} activeCalls={activeCalls} />
        </div>

        <BottomShortcutStrip />
      </div>
    </div>
  );
}

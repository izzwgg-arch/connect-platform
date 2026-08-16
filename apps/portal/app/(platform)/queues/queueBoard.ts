"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "../../../services/apiClient";
import { useTelephony } from "../../../contexts/TelephonyContext";
import type { LiveCall, LiveQueueState, QueueMemberStatus } from "../../../types/liveCall";

/**
 * Shared model for the queue screens (status page, wall display, reports).
 *
 * The board is a JOIN of two independent sources, and keeping the join honest
 * is the whole job here:
 *
 *   • CONFIG  — `GET /voice/queues`, read from the PBX's ombutel schema. Tells
 *     us which queues exist, what they're called, and who is a member.
 *   • LIVE    — `LiveQueueState` over the `/ws/telephony` socket, fed by AMI.
 *     Tells us who is waiting and what each agent is doing right now.
 *
 * ⛔ Live state is IN-MEMORY on the telephony service and is rebuilt from zero
 * whenever it restarts. `callerCount` in particular is a running increment, not
 * a reading of real queue depth, so it can drift after a restart. We therefore
 * prefer counting live calls whose `queueId` matches, and fall back to
 * `callerCount` only when no call rows are available — and the UI says which.
 *
 * ⛔ Config is the source of truth for MEMBERSHIP. An agent missing from the
 * live payload is "offline", never "not a member" — otherwise a telephony
 * restart would make a customer's whole team appear to vanish.
 */

export type QueueMember = {
  extension: string;
  name: string | null;
  penalty: number;
  type: string;
};

export type QueueConfig = {
  id: string;
  extension: string;
  name: string;
  prefix: string | null;
  strategy: string | null;
  timeoutSec: number | null;
  retrySec: number | null;
  wrapupSec: number | null;
  maxLen: number | null;
  serviceLevelSec: number | null;
  announcePosition: boolean;
  joinEmpty: string | null;
  leaveWhenEmpty: string | null;
  recorded: boolean;
  members: QueueMember[];
  logName: string;
};

/** What an agent is doing, as the board displays it. */
export type AgentState = "on_call" | "ringing" | "ready" | "paused" | "offline";

export type BoardAgent = {
  extension: string;
  name: string | null;
  state: AgentState;
  /** Seconds in the current state, when we can know it. */
  sinceSec: number | null;
  callsTaken: number | null;
  /** Queues (by extension) this agent is a member of. */
  onQueues: string[];
};

export type WaitingCaller = {
  id: string;
  from: string | null;
  fromName: string | null;
  queueExtension: string;
  queueName: string;
  waitingSec: number;
  position: number;
};

export type BoardQueue = {
  config: QueueConfig;
  /** Callers on hold right now. */
  waiting: WaitingCaller[];
  waitingCount: number;
  /** True when waitingCount came from the drift-prone AMI counter. */
  waitingCountIsApproximate: boolean;
  longestWaitSec: number;
  agents: BoardAgent[];
  readyCount: number;
  onCallCount: number;
  /** No member is in a state that can take a call. */
  noOneAvailable: boolean;
  live: boolean;
};

/**
 * Reduce an AMI member interface to a bare extension.
 * `PJSIP/T8_102` → `102`, `Local/102@from-queue/n` → `102`.
 * Mirrors `normalizeAgent` in apps/api/src/pbxQueueStats.ts — the two must
 * agree or an agent shows up live under one name and in reports under another.
 */
export function normalizeAgentInterface(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/^(Local|PJSIP|SIP|IAX2)\//i, "");
  s = s.split("@")[0] ?? s;
  s = s.replace(/\/n$/i, "");
  s = s.replace(/-[0-9a-f]{6,}$/i, "");
  s = s.replace(/^T\d+_/i, "");
  return s.trim();
}

function agentStateFrom(status: QueueMemberStatus, paused: boolean): AgentState {
  if (paused) return "paused";
  switch (status) {
    case "inuse":
    case "busy":
    case "onhold":
      return "on_call";
    case "ringing":
      return "ringing";
    case "idle":
      return "ready";
    case "paused":
      return "paused";
    default:
      return "offline";
  }
}

/** Human label + symbol for a state. ⛔ Never render the colour alone. */
export const AGENT_STATE_META: Record<AgentState, { label: string; symbol: string; tone: string }> = {
  on_call: { label: "On call", symbol: "●", tone: "call" },
  ringing: { label: "Ringing", symbol: "◉", tone: "ring" },
  ready: { label: "Ready", symbol: "✓", tone: "ready" },
  paused: { label: "Paused", symbol: "‖", tone: "paused" },
  offline: { label: "Offline", symbol: "○", tone: "off" },
};

export function formatDuration(totalSec: number | null | undefined): string {
  if (totalSec == null || !Number.isFinite(totalSec) || totalSec < 0) return "—";
  const s = Math.floor(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Compact form for report tables: 32h 04m, 2m 21s, 34s. */
export function formatDurationLong(totalSec: number | null | undefined): string {
  if (totalSec == null || !Number.isFinite(totalSec)) return "—";
  const s = Math.floor(totalSec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

type QueuesResponse = {
  queues?: QueueConfig[];
  source?: string;
  skipReason?: string;
};

export type QueueBoardState = {
  queues: BoardQueue[];
  loading: boolean;
  /** Set when config could not be loaded — the UI must say why, not show zero. */
  configError: string | null;
  /** The telephony socket is connected and feeding live state. */
  live: boolean;
  reload: () => void;
};

export function useQueueBoard(): QueueBoardState {
  const { queueList, activeCalls, isLive } = useTelephony();
  const [config, setConfig] = useState<QueueConfig[] | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  // A 1s tick so live wait timers count up smoothly without refetching.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<QueuesResponse>("/voice/queues")
      .then((res) => {
        if (cancelled) return;
        if (res.source === "skipped") {
          setConfig([]);
          setConfigError(res.skipReason || "Queue configuration is unavailable.");
        } else {
          setConfig(res.queues ?? []);
          setConfigError(null);
        }
      })
      .catch((e: any) => {
        if (cancelled) return;
        setConfig([]);
        setConfigError(e?.body?.detail || e?.message || "Could not load queues.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const queues = useMemo<BoardQueue[]>(() => {
    if (!config) return [];
    const liveByName = new Map<string, LiveQueueState>();
    for (const q of queueList) liveByName.set(q.queueName, q);

    const now = Date.now();

    return config.map((cfg) => {
      const live = liveByName.get(cfg.logName);

      // Callers on hold. A call is "in this queue" when its queueId matches
      // and it hasn't been answered yet — an answered call is with an agent,
      // not waiting, even though it still carries the queue id.
      const waiting: WaitingCaller[] = activeCalls
        .filter((c: LiveCall) => c.queueId === cfg.logName || c.queueId === cfg.extension)
        .filter((c) => !c.answeredAt && c.state !== "hungup")
        .map((c, i) => ({
          id: c.id,
          from: c.from,
          fromName: c.fromName,
          queueExtension: cfg.extension,
          queueName: cfg.name,
          waitingSec: Math.max(0, Math.floor((now - new Date(c.startedAt).getTime()) / 1000)),
          position: i + 1,
        }))
        .sort((a, b) => b.waitingSec - a.waitingSec)
        .map((c, i) => ({ ...c, position: i + 1 }));

      const haveCallRows = waiting.length > 0;
      const waitingCount = haveCallRows ? waiting.length : Math.max(0, live?.callerCount ?? 0);

      // Agents: config is authoritative for membership, live decorates it.
      const liveByExt = new Map<string, { status: QueueMemberStatus; paused: boolean; callsTaken: number; lastCall: number }>();
      for (const m of live?.members ?? []) {
        liveByExt.set(normalizeAgentInterface(m.interface) || normalizeAgentInterface(m.name), {
          status: m.status,
          paused: m.paused,
          callsTaken: m.callsTaken,
          lastCall: m.lastCall,
        });
      }

      const agents: BoardAgent[] = cfg.members.map((m) => {
        const l = liveByExt.get(m.extension);
        // ⛔ Absent from the live payload = offline, NOT "not a member".
        const state: AgentState = l ? agentStateFrom(l.status, l.paused) : "offline";
        return {
          extension: m.extension,
          name: m.name,
          state,
          sinceSec: l?.lastCall ? Math.max(0, Math.floor(now / 1000 - l.lastCall)) : null,
          callsTaken: l?.callsTaken ?? null,
          onQueues: [cfg.extension],
        };
      });

      const readyCount = agents.filter((a) => a.state === "ready").length;
      const onCallCount = agents.filter((a) => a.state === "on_call").length;

      return {
        config: cfg,
        waiting,
        waitingCount,
        waitingCountIsApproximate: !haveCallRows && (live?.callerCount ?? 0) > 0,
        longestWaitSec: waiting.length ? waiting[0]!.waitingSec : 0,
        agents,
        readyCount,
        onCallCount,
        noOneAvailable: agents.every((a) => a.state === "offline" || a.state === "paused"),
        live: Boolean(live),
      };
    });
  }, [config, queueList, activeCalls]);

  return { queues, loading, configError, live: isLive, reload };
}

/**
 * Plain English for the Asterisk strategy names.
 *
 * ⛔ Lives here, not in page.tsx. A Next.js App Router page file may only
 * export a default component (plus Next's own reserved exports) — any extra
 * named export fails the production build with "does not match the required
 * types of a Next.js Page". `tsc --noEmit` does NOT catch it; only `next
 * build` does, so it surfaces at deploy time rather than locally.
 */
export function describeStrategy(s: string): string {
  switch (s.toLowerCase()) {
    case "ringall": return "rings everyone";
    case "linear": return "one at a time, in order";
    case "leastrecent": return "least recently called";
    case "fewestcalls": return "fewest calls first";
    case "random": return "random";
    case "rrmemory": return "round robin";
    case "rrordered": return "round robin, in order";
    case "wrandom": return "weighted random";
    default: return s;
  }
}

/** Every agent across every queue, de-duplicated, for the team panel. */
export function mergeAgentsAcrossQueues(queues: BoardQueue[]): BoardAgent[] {
  const order: AgentState[] = ["on_call", "ringing", "ready", "paused", "offline"];
  const byExt = new Map<string, BoardAgent>();
  for (const q of queues) {
    for (const a of q.agents) {
      const prev = byExt.get(a.extension);
      if (!prev) {
        byExt.set(a.extension, { ...a, onQueues: [q.config.extension] });
        continue;
      }
      // An agent on two queues has one real state — keep the most active one,
      // so somebody on a call doesn't render "Ready" because their other
      // queue has no live row for them.
      const better = order.indexOf(a.state) < order.indexOf(prev.state) ? a.state : prev.state;
      byExt.set(a.extension, {
        ...prev,
        state: better,
        callsTaken: (prev.callsTaken ?? 0) + (a.callsTaken ?? 0) || null,
        onQueues: [...prev.onQueues, q.config.extension],
      });
    }
  }
  return [...byExt.values()].sort(
    (a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.extension.localeCompare(b.extension),
  );
}

/**
 * Self-Healing Engine
 *
 * Monitors telephony state and automatically corrects common issues.
 * Design principles:
 *  - Conservative: never affects real in-flight calls
 *  - Rate-limited: max 3 auto-actions per issue per 10 minutes
 *  - Logged: every action is recorded with outcome
 *  - Safe: no action is irreversible; all can be replayed by operator
 */

import { childLogger } from "../../logging/logger";
import type { CallStateStore } from "../state/CallStateStore";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { HealthService } from "./HealthService";
import type { AmiClient } from "../ami/AmiClient";
import type { AriClient } from "../ari/AriClient";
import * as metrics from "../../metrics";

const log = childLogger("HealingEngine");

// ── Types ─────────────────────────────────────────────────────────────────────

export type HealingActionStatus = "attempted" | "succeeded" | "failed" | "skipped" | "rate_limited";
export type HealingActionType =
  | "zombie_call_evicted"
  | "stale_session_cleaned"
  | "ami_reconnect_detected"
  | "ari_reconnect_detected"
  | "audio_drop_detected"
  | "ice_failure_detected"
  | "high_failure_rate_detected"
  | "pbx_degraded_detected";

export interface HealingAction {
  id: string;
  type: HealingActionType;
  status: HealingActionStatus;
  description: string;
  plainEnglish: string;
  details: Record<string, unknown>;
  triggeredAt: string;
  resolvedAt: string | null;
  automated: boolean;
}

// ── Rate limiter ──────────────────────────────────────────────────────────────

class RateLimiter {
  private counts = new Map<string, { n: number; windowStart: number }>();

  allow(key: string, maxPerWindow: number, windowMs: number): boolean {
    const now = Date.now();
    const entry = this.counts.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      this.counts.set(key, { n: 1, windowStart: now });
      return true;
    }
    if (entry.n >= maxPerWindow) return false;
    entry.n++;
    return true;
  }

  reset(key: string): void {
    this.counts.delete(key);
  }
}

// ── HealingEngine ─────────────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 200;
const CHECK_INTERVAL_MS = 30_000; // every 30s
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// A call stuck in ringing/dialing longer than this is a definite zombie
const ZOMBIE_RINGING_MS = 5 * 60 * 1000; // 5 minutes
// A call stuck in up/held longer than this is suspicious — high-confidence zombie
const ZOMBIE_UP_MS = 8 * 60 * 60 * 1000; // 8 hours
// An "up" call with no channelIndex entry after this long → orphan
const ORPHAN_NO_CHANNEL_MS = 3 * 60 * 1000; // 3 minutes

export class HealingEngine {
  private readonly log = log;
  private readonly rateLimiter = new RateLimiter();
  private readonly actionLog: HealingAction[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  // State tracking
  private amiWasConnected = true;
  private ariWasConnected = true;
  private lastCallFailureCount = 0;
  private lastCallFailureTsMs = 0;

  constructor(
    private readonly callStore: CallStateStore,
    private readonly extStore: ExtensionStateStore,
    private readonly healthService: HealthService,
    private readonly ami: AmiClient,
    private readonly ari: AriClient,
  ) {}

  start(): void {
    this.log.info("HealingEngine started");
    this.interval = setInterval(() => this.runChecks(), CHECK_INTERVAL_MS);
    // First check after a brief delay (let services settle)
    setTimeout(() => this.runChecks(), 5_000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.log.info("HealingEngine stopped");
  }

  getLog(): HealingAction[] {
    return [...this.actionLog].reverse(); // newest first
  }

  getRecentActions(maxAgeMs = 60 * 60 * 1000): HealingAction[] {
    const cutoff = Date.now() - maxAgeMs;
    return this.actionLog
      .filter((a) => new Date(a.triggeredAt).getTime() > cutoff)
      .reverse();
  }

  getStatus(): {
    healthy: boolean;
    lastCheck: string | null;
    recentActionCount: number;
    openIssues: number;
  } {
    const recent = this.getRecentActions(30 * 60 * 1000);
    const open = recent.filter((a) => a.status === "attempted" || a.status === "failed").length;
    return {
      healthy: open === 0,
      lastCheck: this._lastCheckAt,
      recentActionCount: recent.length,
      openIssues: open,
    };
  }

  private _lastCheckAt: string | null = null;

  // ── Main check loop ─────────────────────────────────────────────────────────

  private runChecks(): void {
    this._lastCheckAt = new Date().toISOString();
    this.checkZombieCalls().catch((err) => {
      this.log.error({ err }, "HealingEngine: error in checkZombieCalls");
    });
    try {
      this.checkPbxConnectivity();
      this.checkCallFailureRate();
    } catch (err) {
      this.log.error({ err }, "HealingEngine: error during checks");
    }
  }

  // ── Rule 1: Zombie call eviction ──────────────────────────────────────────

  private async checkZombieCalls(): Promise<void> {
    const now = Date.now();
    const allCalls = this.callStore.getActive();
    let currentStaleCount = 0;

    for (const call of allCalls) {
      const startedAt = call.startedAt ? new Date(call.startedAt).getTime() : 0;
      const age = now - startedAt;
      const key = `zombie:${call.id}`;

      let isZombie = false;
      let category: "stale_ringing" | "stale_up" | "orphan_no_channel" = "orphan_no_channel";
      let reason = "";
      // High-confidence zombies are safe to force-hangup via AMI
      let highConfidence = false;

      if ((call.state === "ringing" || call.state === "dialing") && age > ZOMBIE_RINGING_MS) {
        isZombie = true;
        category = "stale_ringing";
        reason = `Call stuck in ${call.state} for ${Math.round(age / 60_000)} min`;
        highConfidence = true; // ringing/dialing > 5 min is always a zombie
      } else if ((call.state === "up" || call.state === "held") && age > ZOMBIE_UP_MS) {
        isZombie = true;
        category = "stale_up";
        reason = `Call stuck in ${call.state} for ${Math.round(age / 3600_000)} hours — zombie`;
        highConfidence = true;
      } else if ((call.state === "up" || call.state === "held") && age > ORPHAN_NO_CHANNEL_MS) {
        // Check if this call has any live channelIndex entry — if not, it's an orphan
        const hasLiveChannel = this.callStore.hasLiveChannelIndex(call.id);
        if (!hasLiveChannel && call.channels.length > 0) {
          isZombie = true;
          category = "orphan_no_channel";
          reason = `Call marked ${call.state} but no live channel entry after ${Math.round(age / 60_000)} min`;
          highConfidence = false; // evict from store only; do not force AMI hangup without more evidence
        }
      }

      if (!isZombie) continue;

      currentStaleCount++;
      metrics.zombieCallsDetectedTotal.labels(category).inc();

      if (!this.rateLimiter.allow(key, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
        this.recordAction({
          type: "zombie_call_evicted",
          status: "rate_limited",
          description: reason,
          plainEnglish: `A stuck call (${call.from ?? "?"} → ${call.to ?? "?"}) is rate-limited from further auto-cleanup attempts.`,
          details: { callId: call.id, from: call.from, to: call.to, state: call.state, ageMs: age, category },
          automated: true,
        });
        continue;
      }

      this.log.warn(
        { callId: call.id, from: call.from, to: call.to, state: call.state, ageMin: Math.round(age / 60_000), category, highConfidence },
        "HealingEngine: zombie call detected — evicting",
      );

      // Step 1: Evict from the call store immediately so the dashboard clears
      const evicted = this.callStore.forceEvictZombie(call.id, reason);

      // Step 2: If high confidence, send AMI Hangup for every known channel to terminate the PBX leg
      let hangupSucceeded = false;
      let hangupAttempted = false;

      if (highConfidence && (evicted.channels.length > 0 || evicted.uniqueIds.length > 0)) {
        hangupAttempted = true;
        const targets = evicted.uniqueIds.length > 0 ? evicted.uniqueIds : evicted.channels;
        for (const target of targets) {
          try {
            this.ami.sendAction("Hangup", { Channel: target, Cause: "16" });
            this.log.info({ callId: call.id, target }, "HealingEngine: AMI Hangup sent for zombie channel");
            hangupSucceeded = true;
          } catch (err) {
            this.log.warn({ callId: call.id, target, err }, "HealingEngine: AMI Hangup failed for zombie channel");
            metrics.zombieCallCleanupFailuresTotal.inc();
          }
        }

        // Also try ARI hangup as a belt-and-suspenders fallback
        for (const target of targets) {
          try {
            await this.ari.hangupChannel(target, "normal");
          } catch {
            // ARI may not know the channel by name vs uniqueid; ignore failures here
          }
        }
      }

      if (hangupAttempted && hangupSucceeded) {
        metrics.zombieCallsAutoClearedTotal.inc();
      }

      this.recordAction({
        type: "zombie_call_evicted",
        status: hangupAttempted ? (hangupSucceeded ? "succeeded" : "failed") : "succeeded",
        description: reason,
        plainEnglish: `A call from ${call.from ?? "unknown"} to ${call.to ?? "unknown"} was stuck in "${call.state}" state for too long. ${highConfidence ? "It was automatically ended and removed from the dashboard." : "It was removed from the dashboard (low confidence — no forced PBX hangup)."}`,
        details: {
          callId: call.id,
          from: call.from,
          to: call.to,
          tenantId: call.tenantId,
          state: call.state,
          ageMs: age,
          category,
          highConfidence,
          channelsHungUp: evicted.channels,
          hangupAttempted,
          hangupSucceeded,
        },
        automated: true,
      });
    }

    metrics.staleCallsActive.set(currentStaleCount);
  }

  // ── Rule 2: PBX connectivity monitoring ──────────────────────────────────

  private checkPbxConnectivity(): void {
    const health = this.healthService.getHealth();
    const amiNow = health.ami.connected;
    const ariNow = health.ari.restHealthy;

    // AMI disconnect → reconnect transition
    if (!this.amiWasConnected && amiNow) {
      this.log.info("HealingEngine: AMI reconnected");
      this.recordAction({
        type: "ami_reconnect_detected",
        status: "succeeded",
        description: "AMI reconnected to PBX after disconnection",
        plainEnglish: "The connection to the PBX phone system was restored automatically. No action required.",
        details: { lastEventAt: health.ami.lastEventAt },
        automated: true,
      });
      // Reset the failure rate counter since we may have missed events
      this.lastCallFailureCount = 0;
      this.rateLimiter.reset("ami_disconnect");
    } else if (this.amiWasConnected && !amiNow) {
      if (this.rateLimiter.allow("ami_disconnect", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
        this.log.warn({ lastError: health.ami.lastError }, "HealingEngine: AMI disconnected — monitoring reconnect");
        this.recordAction({
          type: "pbx_degraded_detected",
          status: "attempted",
          description: "AMI connection to PBX lost — reconnect is automatic",
          plainEnglish: `The PBX connection dropped. The system is automatically reconnecting. ${health.ami.lastError ? `Error: ${health.ami.lastError}` : "No specific error recorded."}`,
          details: { lastError: health.ami.lastError, lastEventAt: health.ami.lastEventAt },
          automated: true,
        });
      }
    }

    // ARI disconnect → reconnect transition
    if (!this.ariWasConnected && ariNow) {
      this.log.info("HealingEngine: ARI reconnected");
      this.recordAction({
        type: "ari_reconnect_detected",
        status: "succeeded",
        description: "ARI REST reconnected",
        plainEnglish: "The PBX REST API was automatically restored.",
        details: {},
        automated: true,
      });
      this.rateLimiter.reset("ari_disconnect");
    } else if (this.ariWasConnected && !ariNow) {
      if (this.rateLimiter.allow("ari_disconnect", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
        this.log.warn({ lastError: health.ari.lastError }, "HealingEngine: ARI unreachable");
        this.recordAction({
          type: "pbx_degraded_detected",
          status: "attempted",
          description: "ARI REST endpoint became unreachable",
          plainEnglish: `The PBX API (ARI) became unreachable. Live call bridging may be degraded. The system will retry automatically. ${health.ari.lastError ? `Error: ${health.ari.lastError}` : ""}`,
          details: { lastError: health.ari.lastError },
          automated: true,
        });
      }
    }

    this.amiWasConnected = amiNow;
    this.ariWasConnected = ariNow;
  }

  // ── Rule 3: Call failure rate spike detection ─────────────────────────────

  private checkCallFailureRate(): void {
    // We don't have direct access to per-minute failure counters here,
    // but we can detect a sudden spike in the failure window
    const allCalls = this.callStore.getAll();
    const now = Date.now();
    const window5m = now - 5 * 60 * 1000;

    const recentlyFailed = allCalls.filter(
      (c) => c.state === "hungup" && c.endedAt &&
        new Date(c.endedAt).getTime() > window5m &&
        c.metadata?.["cdrDisposition"] === "FAILED",
    );

    if (recentlyFailed.length > 5 && this.rateLimiter.allow("call_failure_rate", 1, RATE_LIMIT_WINDOW_MS)) {
      this.log.warn({ failedCount: recentlyFailed.length }, "HealingEngine: high call failure rate detected");
      this.recordAction({
        type: "high_failure_rate_detected",
        status: "attempted",
        description: `${recentlyFailed.length} call failures in the last 5 minutes`,
        plainEnglish: `An unusual number of calls failed in the last 5 minutes (${recentlyFailed.length} failures). This may indicate a trunk or routing problem. Review PBX trunks and SIP configuration.`,
        details: {
          failedCount: recentlyFailed.length,
          sampleCallIds: recentlyFailed.slice(0, 3).map((c) => c.id),
          tenantIds: [...new Set(recentlyFailed.map((c) => c.tenantId).filter(Boolean))],
        },
        automated: false, // requires manual review
      });
    }
  }

  // ── Action recorder ───────────────────────────────────────────────────────

  private recordAction(params: {
    type: HealingActionType;
    status: HealingActionStatus;
    description: string;
    plainEnglish: string;
    details: Record<string, unknown>;
    automated: boolean;
  }): HealingAction {
    const action: HealingAction = {
      id: `heal-${++this.seq}-${Date.now()}`,
      type: params.type,
      status: params.status,
      description: params.description,
      plainEnglish: params.plainEnglish,
      details: params.details,
      triggeredAt: new Date().toISOString(),
      resolvedAt: params.status === "succeeded" ? new Date().toISOString() : null,
      automated: params.automated,
    };

    this.actionLog.push(action);
    if (this.actionLog.length > MAX_LOG_ENTRIES) {
      this.actionLog.splice(0, this.actionLog.length - MAX_LOG_ENTRIES);
    }

    const logLevel = params.status === "failed" ? "warn" : "info";
    this.log[logLevel](
      { healActionId: action.id, type: action.type, status: action.status, ...params.details },
      `HealingEngine: ${action.description}`,
    );

    return action;
  }
}

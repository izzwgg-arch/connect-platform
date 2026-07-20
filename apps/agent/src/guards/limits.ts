/**
 * Per-tenant rate + spend caps (PLAN.md §16, Phase 7). Cheap in-memory sliding
 * counters keyed by tenant, checked BEFORE any LLM call or action execution.
 * A DB-backed counter can replace this later; the interface stays the same.
 *
 * Defaults are conservative and overridable per tenant via policy. Exceeding a
 * cap returns a typed denial the caller surfaces politely + escalates — it never
 * silently drops a customer's request.
 */
export interface LimitConfig {
  maxMessagesPerDay: number;
  maxActionsPerDay: number;
  maxLlmCallsPerHour: number;
  /** soft USD ceiling on LLM spend per day (metering-based). */
  maxLlmSpendUsdPerDay: number;
}

export const DEFAULT_LIMITS: LimitConfig = {
  maxMessagesPerDay: 500,
  maxActionsPerDay: 50,
  maxLlmCallsPerHour: 300,
  maxLlmSpendUsdPerDay: 25,
};

export type LimitKind = "messages" | "actions" | "llm_calls" | "llm_spend";

interface Bucket {
  windowStart: number;
  count: number;
  spend: number;
}

export class RateLimiter {
  private day = new Map<string, Bucket>();
  private hour = new Map<string, Bucket>();

  constructor(private limits: LimitConfig = DEFAULT_LIMITS) {}

  private roll(map: Map<string, Bucket>, key: string, windowMs: number, now: number): Bucket {
    const b = map.get(key);
    if (!b || now - b.windowStart >= windowMs) {
      const fresh = { windowStart: now, count: 0, spend: 0 };
      map.set(key, fresh);
      return fresh;
    }
    return b;
  }

  /** Returns null if allowed, or a denial reason string if a cap is hit. */
  check(tenantId: string, kind: LimitKind, opts: { spendUsd?: number; limits?: Partial<LimitConfig>; now?: number } = {}): string | null {
    const now = opts.now ?? Date.now();
    const L = { ...this.limits, ...opts.limits };
    const DAY = 86400_000;
    const HOUR = 3600_000;
    if (kind === "messages") {
      const b = this.roll(this.day, `msg:${tenantId}`, DAY, now);
      if (b.count >= L.maxMessagesPerDay) return `Daily message limit reached (${L.maxMessagesPerDay}/day).`;
      b.count++;
      return null;
    }
    if (kind === "actions") {
      const b = this.roll(this.day, `act:${tenantId}`, DAY, now);
      if (b.count >= L.maxActionsPerDay) return `Daily action limit reached (${L.maxActionsPerDay}/day).`;
      b.count++;
      return null;
    }
    if (kind === "llm_calls") {
      const b = this.roll(this.hour, `llm:${tenantId}`, HOUR, now);
      if (b.count >= L.maxLlmCallsPerHour) return `Hourly AI-call limit reached (${L.maxLlmCallsPerHour}/hr).`;
      b.count++;
      return null;
    }
    // llm_spend
    const b = this.roll(this.day, `spend:${tenantId}`, DAY, now);
    if (b.spend >= L.maxLlmSpendUsdPerDay) return `Daily AI spend cap reached ($${L.maxLlmSpendUsdPerDay}).`;
    b.spend += opts.spendUsd ?? 0;
    return null;
  }

  /** Read current usage (for the digest / admin). */
  usage(tenantId: string, now = Date.now()): { messages: number; actions: number; llmCallsThisHour: number; spendUsdToday: number } {
    const DAY = 86400_000;
    const HOUR = 3600_000;
    const msg = this.roll(this.day, `msg:${tenantId}`, DAY, now);
    const act = this.roll(this.day, `act:${tenantId}`, DAY, now);
    const llm = this.roll(this.hour, `llm:${tenantId}`, HOUR, now);
    const spend = this.roll(this.day, `spend:${tenantId}`, DAY, now);
    return { messages: msg.count, actions: act.count, llmCallsThisHour: llm.count, spendUsdToday: spend.spend };
  }
}

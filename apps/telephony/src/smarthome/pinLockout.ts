// PIN attempt limiting — in-memory sliding window, per caller ID and global.
// Caller ID is spoofable, so it is only ever used to *restrict* (never to
// authenticate); the global window backstops callers with withheld/rotating IDs.

export interface PinLockoutConfig {
  windowMs: number;
  maxPerCaller: number;
  maxGlobal: number;
}

export const DEFAULT_LOCKOUT: PinLockoutConfig = {
  windowMs: 15 * 60_000,
  maxPerCaller: 5,
  maxGlobal: 20,
};

export class PinLockout {
  private readonly cfg: PinLockoutConfig;
  private readonly perCaller = new Map<string, number[]>();
  private globalFails: number[] = [];

  constructor(cfg: PinLockoutConfig = DEFAULT_LOCKOUT) {
    this.cfg = cfg;
  }

  /** True when this caller (or everyone, globally) is currently locked out. */
  isLocked(callerId: string, now = Date.now()): boolean {
    this.prune(now);
    const key = callerId || "(withheld)";
    const fails = this.perCaller.get(key) ?? [];
    if (fails.length >= this.cfg.maxPerCaller) return true;
    return this.globalFails.length >= this.cfg.maxGlobal;
  }

  recordFailure(callerId: string, now = Date.now()): void {
    this.prune(now);
    const key = callerId || "(withheld)";
    const fails = this.perCaller.get(key) ?? [];
    fails.push(now);
    this.perCaller.set(key, fails);
    this.globalFails.push(now);
  }

  recordSuccess(callerId: string): void {
    this.perCaller.delete(callerId || "(withheld)");
  }

  private prune(now: number): void {
    const cutoff = now - this.cfg.windowMs;
    for (const [key, arr] of this.perCaller) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length === 0) this.perCaller.delete(key);
      else this.perCaller.set(key, kept);
    }
    this.globalFails = this.globalFails.filter((t) => t > cutoff);
  }
}

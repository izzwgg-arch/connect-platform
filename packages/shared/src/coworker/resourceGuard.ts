/**
 * Resource limits, loop detection and backpressure.
 *
 * ⛔⛔ THE FAILURE THIS PREVENTS: a coworker task that never ends. A model in a bad
 * spot will retry the same failing tool call forever, spawn browser after browser,
 * or fan out concurrent tasks until the machine is on its knees — and every one of
 * those degrades the thing that matters most on this machine, the phone call
 * (invariant #13). None of these guards trust the model to stop; they stop it.
 *
 * Pure and clock-injected: `now` is passed in so the loop/rate logic is testable
 * without waiting real seconds.
 */

/** Ceilings the runtime enforces. Sized so idle cost is ~zero and calls stay first. */
export type ResourceLimits = {
  maxConcurrentTasks: number;
  maxConcurrentBrowsers: number;
  maxChildProcesses: number;
  maxToolCallsPerTask: number;
  maxModelCallsPerTask: number;
  /** Wall-clock ceiling for one task. */
  maxTaskDurationMs: number;
  /** How many times the SAME tool+args may be attempted before it's a loop. */
  maxIdenticalAttempts: number;
  /** Window for the "too many calls too fast" check. */
  rateWindowMs: number;
  maxCallsPerRateWindow: number;
};

export const DEFAULT_LIMITS: ResourceLimits = {
  maxConcurrentTasks: 3,
  maxConcurrentBrowsers: 2,
  maxChildProcesses: 6,
  maxToolCallsPerTask: 200,
  maxModelCallsPerTask: 60,
  maxTaskDurationMs: 30 * 60 * 1000,
  maxIdenticalAttempts: 3,
  rateWindowMs: 10_000,
  maxCallsPerRateWindow: 40,
};

export type AdmissionState = {
  activeTasks: number;
  activeBrowsers: number;
  activeChildProcesses: number;
};

export type AdmissionRequest = {
  needsBrowser?: boolean;
  needsChildProcess?: boolean;
};

export type AdmissionDecision =
  | { admit: true }
  | { admit: false; refused: string; message: string };

/**
 * May a new task/tool start right now given what is already running?
 * ⛔ Backpressure, not a queue-forever: the runtime refuses and the caller decides
 * whether to wait or tell the user. Silent unbounded queueing is its own leak.
 */
export function admit(limits: ResourceLimits, state: AdmissionState, req: AdmissionRequest = {}): AdmissionDecision {
  if (state.activeTasks >= limits.maxConcurrentTasks) {
    return { admit: false, refused: "too_many_tasks", message: "The Coworker is already working on as much as it safely can at once. This will start when something finishes." };
  }
  if (req.needsBrowser && state.activeBrowsers >= limits.maxConcurrentBrowsers) {
    return { admit: false, refused: "too_many_browsers", message: "Too many browser sessions are open. This will start when one closes." };
  }
  if (req.needsChildProcess && state.activeChildProcesses >= limits.maxChildProcesses) {
    return { admit: false, refused: "too_many_processes", message: "Too many background processes are running. This will start when one finishes." };
  }
  return { admit: true };
}

/* ─────────────────────── per-task budget ────────────────────────── */

export type TaskBudget = {
  startedAt: number;
  toolCalls: number;
  modelCalls: number;
  /** Rolling record of recent call timestamps for the rate check. */
  recentCallTimes: number[];
  /** attemptSignature -> count, for loop detection. */
  attempts: Record<string, number>;
};

export function newTaskBudget(now: number): TaskBudget {
  return { startedAt: now, toolCalls: 0, modelCalls: 0, recentCallTimes: [], attempts: {} };
}

/**
 * A stable signature for "the same action again". ⛔ Uses canonical args (sorted
 * keys) so a reordered-args retry is still recognised as the same attempt — the
 * same laundering trick the approval hash defends against.
 */
export function attemptSignature(toolName: string, canonicalArgs: string): string {
  return `${toolName}::${canonicalArgs}`;
}

export type BudgetDecision =
  | { ok: true }
  | { ok: false; refused: string; message: string };

/**
 * Charge one tool call against the budget and judge whether it may proceed.
 *
 * ⛔ THE LOOP CHECK IS THE POINT. `maxIdenticalAttempts` identical calls means the
 * task is stuck; the runtime must replan or fail, not try a fourth time. This is
 * what stops the "repeats the same failed action forever" pathology named in the
 * mandate. Mutates `budget` in place (the runtime owns one per task).
 */
export function chargeToolCall(
  limits: ResourceLimits,
  budget: TaskBudget,
  signature: string,
  now: number,
): BudgetDecision {
  if (now - budget.startedAt > limits.maxTaskDurationMs) {
    return { ok: false, refused: "task_timed_out", message: "This task has been running too long and was stopped." };
  }
  if (budget.toolCalls >= limits.maxToolCallsPerTask) {
    return { ok: false, refused: "tool_call_limit", message: "This task tried to do far more steps than expected and was stopped for safety." };
  }

  budget.recentCallTimes = budget.recentCallTimes.filter((t) => now - t < limits.rateWindowMs);
  if (budget.recentCallTimes.length >= limits.maxCallsPerRateWindow) {
    return { ok: false, refused: "rate_limited", message: "This task is doing things too quickly; it was paused to protect your computer." };
  }

  const priorAttempts = budget.attempts[signature] ?? 0;
  if (priorAttempts >= limits.maxIdenticalAttempts) {
    return { ok: false, refused: "repeated_action_loop", message: "The Coworker kept trying the same step without progress, so it stopped to rethink." };
  }

  // Commit.
  budget.toolCalls++;
  budget.recentCallTimes.push(now);
  budget.attempts[signature] = priorAttempts + 1;
  return { ok: true };
}

export function chargeModelCall(limits: ResourceLimits, budget: TaskBudget): BudgetDecision {
  if (budget.modelCalls >= limits.maxModelCallsPerTask) {
    return { ok: false, refused: "model_call_limit", message: "This task needed far more reasoning steps than expected and was stopped." };
  }
  budget.modelCalls++;
  return { ok: true };
}

/**
 * A different action clears a signature's loop count — genuine forward progress is
 * not a loop. The runtime calls this after any successful step.
 */
export function recordProgress(budget: TaskBudget, succeededSignature: string): void {
  delete budget.attempts[succeededSignature];
}

/**
 * The Loopcom Coworker task lifecycle — a pure state machine.
 *
 * ⛔⛔ WHY THIS IS A PURE MODULE WITH NO I/O: a coworker task can run for an hour,
 * survive the window closing, and touch the customer's files, shell and browser.
 * The single most dangerous failure mode is a task that reports COMPLETED after a
 * partial failure (Non-negotiable invariant #9: "No unverified success"). That is a
 * question about STATE TRANSITIONS, so the transitions live here, in a module with
 * no database, no clock and no network, and every one of them is exhaustively
 * tested. A state machine that can only be exercised by standing up a runtime is a
 * state machine nobody tests.
 *
 * ⛔ The terminal states are deliberately FOUR, not one. "It finished" is not a
 * boolean here: COMPLETED, PARTIALLY_COMPLETED, FAILED and CANCELLED are distinct
 * outcomes and the runtime must choose between them explicitly. A task that did
 * three of five steps is PARTIALLY_COMPLETED, and `isSuccess()` answers false for
 * it — so a caller cannot accidentally read a half-done job as a win.
 */

/** Every state a coworker task can be in. */
export const TASK_STATES = [
  "CREATED",
  "PLANNING",
  "WAITING_FOR_PERMISSION",
  "RUNNING",
  "WAITING_FOR_USER",
  "RETRYING",
  "PAUSED",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/**
 * States from which nothing further happens. ⛔ Once a task is terminal it may
 * NEVER leave — a resumed "completed" task would re-run side effects that already
 * happened (a second invoice paid, a second file deleted). `canTransition` enforces
 * this and `terminalIsFinal` in the test suite proves it for all 11 × 11 pairs.
 */
export const TERMINAL_STATES: readonly TaskState[] = [
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

/** States where the task is actively consuming resources (worker, browser, child procs). */
export const ACTIVE_STATES: readonly TaskState[] = ["PLANNING", "RUNNING", "RETRYING"] as const;

/** States where the task is alive but deliberately idle, waiting on a human. */
export const WAITING_STATES: readonly TaskState[] = [
  "WAITING_FOR_PERMISSION",
  "WAITING_FOR_USER",
  "PAUSED",
] as const;

/**
 * The legal transition graph.
 *
 * ⛔ CANCELLED is reachable from every non-terminal state ON PURPOSE. Cancellation
 * that only works while RUNNING is not cancellation — a task parked on an approval
 * prompt overnight is exactly the one a user wants to kill.
 *
 * ⛔ There is deliberately NO edge from RUNNING straight to COMPLETED without the
 * runtime having recorded its steps; that is not expressible in a state graph, so it
 * is enforced by `decideCompletion()` below instead. Both halves matter.
 */
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  CREATED: ["PLANNING", "CANCELLED", "FAILED"],
  PLANNING: ["WAITING_FOR_PERMISSION", "RUNNING", "WAITING_FOR_USER", "FAILED", "CANCELLED"],
  WAITING_FOR_PERMISSION: ["RUNNING", "PLANNING", "CANCELLED", "FAILED", "PAUSED"],
  RUNNING: [
    "WAITING_FOR_PERMISSION",
    "WAITING_FOR_USER",
    "RETRYING",
    "PAUSED",
    "PLANNING",
    "COMPLETED",
    "PARTIALLY_COMPLETED",
    "FAILED",
    "CANCELLED",
  ],
  WAITING_FOR_USER: ["RUNNING", "PLANNING", "PAUSED", "CANCELLED", "FAILED"],
  RETRYING: ["RUNNING", "PLANNING", "FAILED", "PARTIALLY_COMPLETED", "CANCELLED", "PAUSED"],
  PAUSED: ["RUNNING", "PLANNING", "CANCELLED", "FAILED"],
  COMPLETED: [],
  PARTIALLY_COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isActive(state: TaskState): boolean {
  return ACTIVE_STATES.includes(state);
}

export function isWaiting(state: TaskState): boolean {
  return WAITING_STATES.includes(state);
}

/**
 * ⛔ Only COMPLETED is success. PARTIALLY_COMPLETED is deliberately NOT success —
 * this function exists so that no caller has to remember that, and so that adding a
 * future terminal state cannot silently be read as a win.
 */
export function isSuccess(state: TaskState): boolean {
  return state === "COMPLETED";
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  if (from === to) return false;
  const allowed = TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export function allowedTransitions(from: TaskState): readonly TaskState[] {
  return TRANSITIONS[from] ?? [];
}

export type TransitionResult =
  | { ok: true; state: TaskState }
  | { ok: false; refused: string; state: TaskState };

/**
 * Apply a transition, refusing anything illegal.
 *
 * ⛔ Returns the CURRENT state on refusal rather than throwing, because the runtime
 * calls this from event handlers where a throw becomes an unhandled rejection that
 * kills a worker mid-task. A refusal is data, and the caller audits it.
 */
export function applyTransition(from: TaskState, to: TaskState): TransitionResult {
  if (!isTaskState(from)) return { ok: false, refused: "unknown_from_state", state: "FAILED" };
  if (!isTaskState(to)) return { ok: false, refused: "unknown_to_state", state: from };
  if (isTerminal(from)) return { ok: false, refused: "task_already_finished", state: from };
  if (from === to) return { ok: false, refused: "no_op_transition", state: from };
  if (!canTransition(from, to)) return { ok: false, refused: "illegal_transition", state: from };
  return { ok: true, state: to };
}

/** One step of a task's plan, as the runtime records it. */
export type TaskStepOutcome = "pending" | "succeeded" | "failed" | "skipped";

export type TaskStepRecord = {
  id: string;
  /** True when this step must succeed for the task to count as done. */
  required: boolean;
  outcome: TaskStepOutcome;
};

/**
 * ⛔⛔ THE "NO UNVERIFIED SUCCESS" RULE, AS CODE.
 *
 * The runtime does not get to decide it finished. It hands over the recorded step
 * outcomes and this function picks the terminal state. The rules, in order:
 *
 *  - any step still `pending`      -> not finishable at all (the caller must not end)
 *  - every required step succeeded
 *      and nothing failed          -> COMPLETED
 *  - every required step succeeded
 *      but an optional step failed -> PARTIALLY_COMPLETED
 *  - a required step failed
 *      and something else succeeded-> PARTIALLY_COMPLETED  (work landed; say so)
 *  - a required step failed
 *      and nothing succeeded       -> FAILED
 *  - no steps at all               -> FAILED (a task that did nothing did not succeed)
 *
 * The fourth rule is the important one: when a required step fails but earlier steps
 * already changed the world, reporting FAILED is a lie of a different kind — it tells
 * the user nothing happened when files were already moved. PARTIALLY_COMPLETED is the
 * honest answer and the summary must name what landed.
 */
export function decideCompletion(steps: readonly TaskStepRecord[]):
  | { finishable: false; reason: string }
  | { finishable: true; state: Extract<TaskState, "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED"> } {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { finishable: true, state: "FAILED" };
  }
  if (steps.some((s) => s.outcome === "pending")) {
    return { finishable: false, reason: "steps_still_pending" };
  }

  const anySucceeded = steps.some((s) => s.outcome === "succeeded");
  const requiredFailed = steps.some((s) => s.required && s.outcome === "failed");
  const optionalFailed = steps.some((s) => !s.required && s.outcome === "failed");

  // A required step that was SKIPPED is not a success. Treat it like a failure of the
  // requirement, or "skip everything" becomes a way to report COMPLETED.
  const requiredSkipped = steps.some((s) => s.required && s.outcome === "skipped");

  if (requiredFailed || requiredSkipped) {
    return { finishable: true, state: anySucceeded ? "PARTIALLY_COMPLETED" : "FAILED" };
  }
  if (optionalFailed) return { finishable: true, state: "PARTIALLY_COMPLETED" };
  if (!anySucceeded) {
    // Everything was optional and everything was skipped: nothing was done.
    return { finishable: true, state: "FAILED" };
  }
  return { finishable: true, state: "COMPLETED" };
}

/**
 * Which states a task may be resumed from after a crash or restart.
 *
 * ⛔ RUNNING is NOT resumable automatically. A task that was mid-`RUNNING` when the
 * process died may have half-applied a side effect (a file moved, a form submitted,
 * a payment posted) and the runtime cannot know which. It is moved to PAUSED and a
 * human decides. Auto-resuming RUNNING is how you double-charge somebody.
 */
export function isResumableAfterRestart(state: TaskState): boolean {
  return state === "WAITING_FOR_PERMISSION" || state === "WAITING_FOR_USER" || state === "PAUSED";
}

/**
 * The state a task should be moved to when the process that owned it died.
 * Returns null for states that need no repair.
 */
export function recoverStateAfterRestart(state: TaskState): TaskState | null {
  if (isTerminal(state)) return null;
  if (state === "RUNNING" || state === "RETRYING" || state === "PLANNING") return "PAUSED";
  if (state === "CREATED") return "PAUSED";
  return null;
}

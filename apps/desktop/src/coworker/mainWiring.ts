/**
 * Wiring the Coworker's hands into the real app.
 *
 * ⛔⛔ TWO CHANNELS, TWO SHAPES, NOTHING ELSE. The renderer (the hosted portal
 * inside the Coworker popover) can send `coworker:decide` (a task → a local
 * verdict) and `coworker:run` (an APPROVED task → it runs). Both take a task from
 * the fixed allowlist in tasks.ts and refuse anything else. There is no channel that
 * takes a path, a command or a host — the same posture as phoneSetup/mainWiring.ts.
 *
 * ⛔ The renderer loads a web page from our server. Anything it can express is
 * something a compromised server could express too, which is why the allowlist,
 * the rate gate and the "a write asks first" rule all live HERE, on the customer's
 * machine, and not in the page.
 */
import { parseTask, decideLocally, admitTask, newGate, type CoworkerProfile, type LocalVerdict, COWORKER_PROFILES } from "./tasks";
import { runCoworkerTask, type ExecutorDeps, type TaskResult } from "./executor";

export const COWORKER_DECIDE_CHANNEL = "coworker:decide";
export const COWORKER_RUN_CHANNEL = "coworker:run";

export type CoworkerWiringDeps = {
  ipcMain: { handle(channel: string, fn: (event: unknown, ...args: any[]) => any): void };
  /** The profile the customer chose in the popover's Permissions view; SAFE when unset. */
  getProfile: () => CoworkerProfile | undefined;
  /** True while the softphone is on a call — a write then always asks. */
  isCallActive: () => boolean;
  executor?: ExecutorDeps;
  now?: () => number;
  log?: (line: string) => void;
};

export type DecideResponse = { ok: true; verdict: LocalVerdict } | { ok: false; refused: string };
/** ⛔ `moves` (full paths) is stripped: the renderer gets names and counts only. */
export type RunResponse = { ok: true; result: Omit<TaskResult, "moves"> } | { ok: false; refused: string };

export function normalizeProfile(raw: unknown): CoworkerProfile {
  return typeof raw === "string" && (COWORKER_PROFILES as readonly string[]).includes(raw) ? (raw as CoworkerProfile) : "SAFE";
}

export function registerCoworkerHands(deps: CoworkerWiringDeps): void {
  const gate = newGate();
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  /** One task at a time on this machine; a second run while one is in flight is refused. */
  let running = false;

  deps.ipcMain.handle(COWORKER_DECIDE_CHANNEL, (_e: unknown, raw: unknown): DecideResponse => {
    const parsed = parseTask(raw);
    if (!parsed.ok) return { ok: false, refused: parsed.refused };
    const verdict = decideLocally(parsed.task, normalizeProfile(deps.getProfile()), { callActive: deps.isCallActive() });
    return { ok: true, verdict };
  });

  deps.ipcMain.handle(COWORKER_RUN_CHANNEL, async (_e: unknown, payload: { id?: unknown; task?: unknown }): Promise<RunResponse> => {
    const parsed = parseTask(payload?.task);
    if (!parsed.ok) return { ok: false, refused: parsed.refused };
    const id = typeof payload?.id === "string" ? payload.id.slice(0, 64) : "";
    if (!id) return { ok: false, refused: "missing_task_id" };
    // ⛔ Re-decided at run time, never trusted from the decide call: the profile or
    // the call state may have changed in between. A "deny" never runs; an "ask"
    // runs only because the renderer is reporting the person's press — and the
    // server-side approve is what makes that press single-use.
    const verdict = decideLocally(parsed.task, normalizeProfile(deps.getProfile()), { callActive: deps.isCallActive() });
    if (verdict.verdict === "deny") return { ok: false, refused: verdict.code };
    if (running) return { ok: false, refused: "busy" };
    const admitted = admitTask(gate, parsed.task, now());
    if (!admitted.ok) { log(`coworker task ${id} refused locally: ${admitted.refused}`); return { ok: false, refused: admitted.refused }; }
    running = true;
    log(`coworker task ${id} start kind=${parsed.task.kind}${"folder" in parsed.task ? ` folder=${parsed.task.folder}` : ""}`);
    try {
      const result = await runCoworkerTask(parsed.task, { ...deps.executor, log: deps.executor?.log ?? log });
      const { moves, ...rest } = result;
      log(`coworker task ${id} ${result.ok ? "done" : "failed"}${moves ? ` moves=${moves.length}` : ""}${result.code ? ` code=${result.code}` : ""}`);
      return { ok: true, result: rest };
    } catch (err) {
      // ⛔ The message is swallowed on purpose: an fs error carries a full path,
      // and this value goes straight back to a web page.
      log(`coworker task ${id} threw: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      return { ok: false, refused: "task_failed" };
    } finally {
      running = false;
    }
  });
}

/**
 * The Watchman — the support agent never works blind (Phase 5b, 2026-08-20).
 *
 * Izzy, 2026-08-20: *"the agent working in the IDE should constantly be checking
 * the MD files, the server, and the PBX to make sure that everything is good and
 * nothing gets messed up."*
 *
 * Three standing checks, re-run before every job and on a timer:
 *   1. THE RULE FILES  — CLAUDE.md and the agent-knowledge docs are readable.
 *      If the agent cannot read its own rules, it must not act.
 *   2. THE SERVER      — the platform's own services are healthy.
 *   3. THE PBX         — reachable, and reachable READ-ONLY. ⛔ A write path to
 *      the PBX appearing here is a stop-everything condition (house rule).
 *
 * ⛔⛔ FAIL SAFE, NOT FAIL QUIET. A check that cannot RUN is "unknown", and
 * unknown blocks work exactly like a failure does. The alternative — treating an
 * unreachable probe as "probably fine" — is how this platform learned that a
 * watchdog with a typo is decoration (the voicemail watchdog that had never
 * completed once, the trainer that taught nothing for nine days).
 *
 * ⛔ Every check is INJECTED, so the whole verdict layer is unit-testable
 * without a server, a database or a PBX.
 */

export type CheckStatus = "ok" | "warn" | "bad" | "unknown";

export type WatchmanCheck = {
  id: "rules" | "server" | "pbx";
  label: string;
  status: CheckStatus;
  /** Plain English, safe to put on screen next to a support person's work. */
  detail: string;
};

export type WatchmanVerdict = {
  checkedAt: string;
  /** ⛔ The one field the execution engine reads before starting a job. */
  safeToWork: boolean;
  /** Why not, in plain English — empty when safeToWork. */
  blockers: string[];
  checks: WatchmanCheck[];
};

export type WatchmanProbes = {
  /** Rule files the agent must be able to read (CLAUDE.md + knowledge docs). */
  rules: () => Promise<{ found: number; missing: string[] }>;
  /** Platform services. `unhealthy` names anything not answering. */
  server: () => Promise<{ healthy: number; unhealthy: string[] }>;
  /** PBX reachability AND the read-only guarantee. */
  pbx: () => Promise<{ reachable: boolean; readOnly: boolean; detail?: string }>;
};

/** Pure: turn raw probe answers into the verdict the engine and the screen use. */
export function evaluateWatchman(
  input: {
    rules?: { found: number; missing: string[] } | null;
    server?: { healthy: number; unhealthy: string[] } | null;
    pbx?: { reachable: boolean; readOnly: boolean; detail?: string } | null;
  },
  now: Date = new Date(),
): WatchmanVerdict {
  const checks: WatchmanCheck[] = [];
  const blockers: string[] = [];

  // 1. Rule files — the agent must be able to read its own rules.
  if (!input.rules) {
    checks.push({ id: "rules", label: "Rule files", status: "unknown", detail: "Couldn't check the rule files." });
    blockers.push("The rule files couldn't be checked, so the agent shouldn't act.");
  } else if (input.rules.missing.length > 0) {
    checks.push({
      id: "rules",
      label: "Rule files",
      status: "bad",
      detail: `Missing: ${input.rules.missing.join(", ")}.`,
    });
    blockers.push(`The agent can't read its own rules (${input.rules.missing.join(", ")}).`);
  } else {
    checks.push({
      id: "rules",
      label: "Rule files",
      status: "ok",
      detail: `${input.rules.found} rule ${input.rules.found === 1 ? "file" : "files"} read.`,
    });
  }

  // 2. The server.
  if (!input.server) {
    checks.push({ id: "server", label: "Server", status: "unknown", detail: "Couldn't check the server." });
    blockers.push("The server's health couldn't be checked.");
  } else if (input.server.unhealthy.length > 0) {
    checks.push({
      id: "server",
      label: "Server",
      status: "bad",
      detail: `Not answering: ${input.server.unhealthy.join(", ")}.`,
    });
    blockers.push(`Something on the server isn't healthy (${input.server.unhealthy.join(", ")}).`);
  } else {
    checks.push({
      id: "server",
      label: "Server",
      status: "ok",
      detail: `${input.server.healthy} services healthy.`,
    });
  }

  // 3. The PBX. ⛔ Two different failures with two different meanings:
  //    unreachable is a WARNING (the agent can still work on Connect), but a
  //    WRITE path is a stop-everything — the PBX is read-only, always.
  if (!input.pbx) {
    checks.push({ id: "pbx", label: "Phone system", status: "unknown", detail: "Couldn't check the phone system." });
    blockers.push("The phone system couldn't be checked.");
  } else if (!input.pbx.readOnly) {
    checks.push({
      id: "pbx",
      label: "Phone system",
      status: "bad",
      detail: input.pbx.detail || "The phone system is NOT read-only from here.",
    });
    blockers.push("The phone system is not read-only from here — that must be fixed before any work.");
  } else if (!input.pbx.reachable) {
    // Read-only and unreachable: nothing can be damaged, so this is a warning.
    checks.push({
      id: "pbx",
      label: "Phone system",
      status: "warn",
      detail: input.pbx.detail || "Can't reach the phone system right now (read-only either way).",
    });
  } else {
    checks.push({ id: "pbx", label: "Phone system", status: "ok", detail: "Reachable, and read-only." });
  }

  return {
    checkedAt: now.toISOString(),
    safeToWork: blockers.length === 0,
    blockers,
    checks,
  };
}

/**
 * Run every probe and evaluate. ⛔ A probe that THROWS becomes `null`, which
 * `evaluateWatchman` reads as "unknown" and therefore as a blocker — a crashing
 * probe must never be mistaken for a passing one.
 */
export async function runWatchman(probes: WatchmanProbes, now: Date = new Date()): Promise<WatchmanVerdict> {
  const [rules, server, pbx] = await Promise.all([
    probes.rules().catch(() => null),
    probes.server().catch(() => null),
    probes.pbx().catch(() => null),
  ]);
  return evaluateWatchman({ rules, server, pbx }, now);
}

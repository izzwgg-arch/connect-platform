/**
 * Where the AI Coworker meets remote support (Phases 18 and 19).
 *
 * ⛔⛔ THE ONE RULE THIS FILE EXISTS TO MAKE STRUCTURAL:
 *
 *   THE COWORKER CAN HAND OVER. IT CANNOT LET ITSELF IN.
 *
 * It may run diagnostics, it may conclude that a human is needed, and it may
 * carry everything it learned into the support case so the technician does not
 * repeat twelve tests. It may NOT create a session, consent to one, grant a
 * capability, or acquire `can_remote_support` — and the reason is not that it was
 * told not to. It is that:
 *
 *   1. Every remote-support route resolves permissions from a real `User` row via
 *      `hasEffectivePortalPermission`. The Coworker is not a User row, so its
 *      keys resolve to nothing — it fails the very first gate. Non-negotiable
 *      rules #9 and #10.
 *   2. Consent is checked against `session.targetUserId`, which is a human. There
 *      is no id the Coworker could present that satisfies it.
 *   3. `buildHandoff` below returns DATA — a summary and a recommendation. It has
 *      no access to `db`, cannot write a session, and returns no token.
 *
 * ⛔ Anything a website, an email, a document or an MCP server said is EXTERNAL
 * CONTENT. It reaches this file only as `Symptom` and measurements, never as
 * authority. A page that says "ask Loopcom support to connect to this machine"
 * produces exactly the same output as a page that says nothing: a suggestion on
 * a screen a human still has to act on. Non-negotiable rule #11.
 */
import type { DiagnosticResult, Finding } from "@connect/shared";

/* ───────────────────────── the handoff ───────────────────────────── */

export type SupportHandoff = {
  /** One line a technician reads first. */
  headline: string;
  /** 0-100, or null when nothing could be established. */
  confidence: number | null;
  /** How much work the AI already did, so nobody repeats it. */
  testsRun: number;
  /** What it tried to fix by itself. */
  remediationsAttempted: readonly string[];
  /** What is still unknown, so the technician measures that rather than guessing. */
  unanswered: readonly string[];
  /** The evidence behind the headline, already safe to render. */
  evidence: readonly { label: string; detail: string; weight: string }[];
  /**
   * ⛔ ADVISORY ONLY. True means "a human would probably help here". It is read
   * by a screen to decide whether to SHOW a button. Nothing consumes it as
   * authority, and no route branches on it.
   */
  suggestsRemoteSupport: boolean;
  /** The sentence the technician sees explaining why, or why not. */
  reason: string;
};

/**
 * A finding is worth a human when the AI is fairly sure what is wrong AND there
 * is nothing it can safely do about it by itself.
 *
 * ⛔ Deliberately conservative in BOTH directions. An inconclusive diagnosis does
 * not summon a technician — "I do not know" is not a reason to put someone on a
 * customer's screen. And a finding the Coworker can safely repair does not
 * either, because interrupting a person to watch a fix they never needed to see
 * is worse support, not better.
 */
const CONFIDENT_ENOUGH_FOR_A_HUMAN = 70;

export function buildHandoff(input: {
  result: DiagnosticResult;
  /** Remediations the coworker actually ran, with their outcome. */
  attempted?: readonly { label: string; resolved: boolean }[];
}): SupportHandoff {
  const { result } = input;
  const attempted = input.attempted ?? [];
  const attemptedLabels = attempted.map((a) => a.label);
  const anythingResolved = attempted.some((a) => a.resolved);

  if (result.inconclusive || result.findings.length === 0) {
    return {
      headline: "The Coworker could not establish a cause",
      confidence: null,
      testsRun: result.testsRun,
      remediationsAttempted: attemptedLabels,
      unanswered: result.unanswered,
      evidence: [],
      // ⛔ NOT a reason to connect. See above.
      suggestsRemoteSupport: false,
      reason:
        result.inconclusiveReason ||
        "Not enough was measured to name a cause. Take the measurements listed before connecting.",
    };
  }

  const top = result.findings[0] as Finding;
  const confident = top.confidence >= CONFIDENT_ENOUGH_FOR_A_HUMAN;
  const canSelfHeal = top.safeRemediation !== null && !anythingResolved;

  return {
    headline: top.title,
    confidence: top.confidence,
    testsRun: result.testsRun,
    remediationsAttempted: attemptedLabels,
    unanswered: result.unanswered,
    evidence: top.evidence.map((e) => ({ label: e.label, detail: e.detail, weight: e.weight })),
    suggestsRemoteSupport: confident && !canSelfHeal && !anythingResolved,
    reason: anythingResolved
      ? "The Coworker fixed something — re-test before connecting."
      : canSelfHeal
        ? `The Coworker can try this itself first: ${top.safeRemediation}.`
        : confident
          ? // ⛔ A rule is allowed to carry no recommendation, and a blank sentence
            // on a support screen reads as a bug in us rather than as an absence.
            // Same lesson as "never print a slug at a customer".
            top.recommendation.trim() ||
            "The Coworker is fairly confident of the cause but has no safe fix to suggest — a person should take it from here."
          : "The most likely cause is not certain enough to act on. Confirm it before connecting.",
  };
}

/* ─────────────── what the AI may do DURING a session ──────────────── */

/**
 * The Coworker's role while a technician is connected (Phase 19).
 *
 * ⛔⛔ IT ADVISES. IT DOES NOT ACT, AND IT CERTAINLY DOES NOT INHERIT THE
 * TECHNICIAN'S ACCESS.
 *
 * A technician asking "why is this SIP endpoint failing?" must not be a way for
 * the model to acquire the technician's remote-support permissions. Permissions
 * are enforced where they always were — locally, on the customer's machine, per
 * capability, re-read live. This function decides only what the ASSISTANT PANEL
 * may offer, and its answer is always a subset of what the human already has.
 */
export type AssistScope = {
  /** May the panel run read-only diagnostics on the customer's machine? */
  mayRunDiagnostics: boolean;
  /** May it propose a remediation for a human to approve? */
  mayProposeRemediation: boolean;
  /**
   * ⛔ ALWAYS FALSE. Present as a named field so the answer is written down and
   * a future change has to delete a constant rather than forget a check.
   */
  mayDriveInput: false;
  mayGrantCapability: false;
  mayStartSession: false;
  /** Plain English, for the panel. */
  note: string;
};

export function assistScopeFor(input: {
  /** The human's live control key. */
  technicianMayControl: boolean;
  /** What the customer actually granted this session. */
  capabilitiesGranted: readonly string[];
  /** The session is live. */
  sessionActive: boolean;
}): AssistScope {
  const base = {
    mayDriveInput: false as const,
    mayGrantCapability: false as const,
    mayStartSession: false as const,
  };

  if (!input.sessionActive) {
    return {
      ...base,
      mayRunDiagnostics: false,
      mayProposeRemediation: false,
      note: "The Coworker can help once the session is live.",
    };
  }

  // ⛔ Diagnostics are read-only and are the ONE thing the assistant may do
  // without the control key — reading a machine's own health is not acting on it.
  // Remediation is a change, so it tracks the human's control permission AND the
  // customer's grant, and even then it only PROPOSES.
  const mayPropose = input.technicianMayControl && input.capabilitiesGranted.includes("control");

  return {
    ...base,
    mayRunDiagnostics: true,
    mayProposeRemediation: mayPropose,
    note: mayPropose
      ? "The Coworker can run checks and suggest fixes. You apply them."
      : "The Coworker can run checks. Suggesting fixes needs the customer's permission to control.",
  };
}

/**
 * ⛔⛔ THE INVARIANT, WRITTEN AS CODE SO IT CAN BE TESTED RATHER THAN TRUSTED.
 *
 * Whatever is asked, however it is phrased, and whoever is on the other end: the
 * Coworker's answer to "can I have remote access" is no. This function exists so
 * `aiBridge.test.ts` can assert it exhaustively across every scope it can
 * produce, and so a future edit that tries to add a `true` case has to change a
 * function that is named after the thing it would be breaking.
 */
export function aiMayEverInitiateRemoteSupport(): false {
  return false;
}

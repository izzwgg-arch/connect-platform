/**
 * The coworker audit record.
 *
 * ⛔⛔ EVERY MEANINGFUL ACTION IS AUDITABLE, AND NO AUDIT RECORD CONTAINS A SECRET.
 * These two rules fight each other — you want the record complete, and you want it
 * safe to keep forever — so this module resolves the fight in ONE place: every
 * builder runs its payload through `redactStructured` before the event is returned.
 * There is no path to an audit event that skips redaction.
 *
 * ⛔ This mirrors, and is meant to feed, the existing hash-chained `AgentAuditLog`
 * (packages/db schema). It does not replace it; it produces well-shaped, pre-
 * redacted events the runtime persists there and mirrors to the append-only file.
 */

import { redactStructured } from "./redaction";
import type { PolicyVerdict } from "./policy";
import type { RiskLevel, ToolCategory } from "./types";

export type AuditEventType =
  | "task.created"
  | "task.state"
  | "task.completed"
  | "plan.created"
  | "tool.requested"
  | "tool.decided"
  | "tool.executed"
  | "tool.failed"
  | "approval.requested"
  | "approval.granted"
  | "approval.denied"
  | "permission.changed"
  | "mcp.connected"
  | "mcp.disconnected"
  | "security.injection_detected"
  | "security.policy_denied"
  | "diagnostic.run"
  | "remediation.applied"
  | "support.job_received"
  | "support.job_rejected"
  | "resource.limited";

export type AuditEvent = {
  type: AuditEventType;
  /** ms epoch; supplied by the caller so this stays pure and testable. */
  at: number;
  taskId: string | null;
  tenantId: string | null;
  actor: string;
  /** Tool name when relevant. */
  tool?: string;
  toolCategory?: ToolCategory;
  risk?: RiskLevel;
  verdict?: PolicyVerdict;
  /** Machine-readable reason code (policy code, refusal code, error code). */
  code?: string;
  /** Duration of the action in ms, when known. */
  durationMs?: number;
  /** Model/provider used, for cost attribution. */
  model?: string;
  /**
   * Free-form, ALWAYS-REDACTED metadata. Runs through redactStructured — a caller
   * cannot leak a secret through here even by accident.
   */
  meta?: Record<string, unknown>;
};

export type AuditInput = Omit<AuditEvent, "meta"> & { meta?: Record<string, unknown> };

/**
 * Build a persistable event. ⛔ The redaction here is not optional and not
 * skippable — it is the reason this is a function and not a plain object literal at
 * every call site.
 */
export function buildAuditEvent(input: AuditInput): { event: AuditEvent; redactionCount: number } {
  let meta = input.meta;
  let redactionCount = 0;
  if (meta && typeof meta === "object") {
    const r = redactStructured(meta);
    meta = r.value;
    redactionCount = r.redactionCount;
  }
  return { event: { ...input, meta }, redactionCount };
}

/**
 * Render a task's audit trail as plain English for the "task history" UI (Phase 26).
 * ⛔ Reads only fields that are already redaction-safe; never re-derives from raw
 * inputs.
 */
export function describeEvent(e: AuditEvent): string {
  switch (e.type) {
    case "task.created":
      return "Task started.";
    case "plan.created":
      return "Made a plan.";
    case "tool.requested":
      return `Wanted to use ${e.tool ?? "a tool"}.`;
    case "tool.decided":
      return e.verdict === "allow"
        ? `Allowed to use ${e.tool ?? "a tool"}.`
        : e.verdict === "ask"
          ? `Asked you before using ${e.tool ?? "a tool"}.`
          : `Blocked from using ${e.tool ?? "a tool"} (${e.code ?? "not permitted"}).`;
    case "tool.executed":
      return `Used ${e.tool ?? "a tool"}${e.durationMs ? ` (${Math.round(e.durationMs)}ms)` : ""}.`;
    case "tool.failed":
      return `${e.tool ?? "A tool"} did not work (${e.code ?? "error"}).`;
    case "approval.requested":
      return "Asked for your approval.";
    case "approval.granted":
      return "You approved an action.";
    case "approval.denied":
      return "You declined an action.";
    case "security.injection_detected":
      return "Spotted an instruction hidden in content it was reading, and ignored it.";
    case "security.policy_denied":
      return `Refused an action for safety (${e.code ?? "policy"}).`;
    case "support.job_rejected":
      return `Rejected a support request (${e.code ?? "not valid"}).`;
    case "resource.limited":
      return `Slowed itself down to protect your computer (${e.code ?? "limit"}).`;
    case "task.completed":
      return `Finished (${e.code ?? "done"}).`;
    default:
      return e.type.replace(/[._]/g, " ");
  }
}

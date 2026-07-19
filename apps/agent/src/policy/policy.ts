/**
 * Policy Engine — server-side enforcement of who may do what (PLAN.md §6a).
 *
 * Two roles:
 *  - owner   : full manifest access. Owner's instruction counts as approval for
 *              his own requests, but pre-flight, audit, and email always run.
 *  - customer: everything filtered through the tenant's policy. Enforcement is
 *              CODE, not prompt — a denial here is a hard wall.
 *
 * Absolute prohibitions live above policy: payments/pension/non-catalog PBX
 * operations have no capability id, so they cannot be permitted by any policy.
 */
import { z } from "zod";
import { Capability } from "../manifest/manifest";

export const CapabilityGrant = z.object({
  mode: z.enum(["allowed", "ask_owner", "blocked"]),
  /** e.g. { maxDurationHours: 24, maxPerDay: 3 } */
  limits: z.record(z.string(), z.number()).optional(),
  businessHoursOnly: z.boolean().optional(),
  /** Extensions this grant may never touch (e.g. protect the boss's ext). */
  protectedExtensions: z.array(z.string()).optional(),
});
export type CapabilityGrant = z.infer<typeof CapabilityGrant>;

export const TenantPolicy = z.object({
  tenantId: z.string(),
  version: z.number(),
  updatedBy: z.string(),
  historyVisible: z.boolean().default(false),
  channels: z.array(z.enum(["chat", "email", "whatsapp", "sms", "phone"])).default(["chat"]),
  /** capabilityId -> grant. Missing id = blocked (whitelist semantics). */
  grants: z.record(z.string(), CapabilityGrant).default({}),
});
export type TenantPolicy = z.infer<typeof TenantPolicy>;

export type Role = "owner" | "customer";

export interface PolicyContext {
  role: Role;
  tenantId: string;
  /** Tenant the request wants to act on — must equal ctx.tenantId for customers. */
  targetTenantId: string;
  now?: Date;
  /** Usage counters injected by the caller (DB-backed later). */
  usageToday?: Record<string, number>;
}

export type PolicyDecision =
  | { ok: true; requiresApproval: boolean; grant?: CapabilityGrant }
  | { ok: false; code: PolicyDenialCode; message: string };

export type PolicyDenialCode =
  | "CROSS_TENANT"
  | "CAPABILITY_NOT_GRANTED"
  | "CAPABILITY_BLOCKED"
  | "LIMIT_EXCEEDED"
  | "OUTSIDE_BUSINESS_HOURS"
  | "PROTECTED_EXTENSION"
  | "ROLE_NOT_PERMITTED";

const BUSINESS_HOURS = { start: 8, end: 18 }; // local server time; per-tenant later

export function evaluate(
  capability: Capability,
  ctx: PolicyContext,
  policy: TenantPolicy | null,
  opts: { targetExtension?: string; requestedDurationHours?: number } = {},
): PolicyDecision {
  // Tenant isolation is absolute for customers.
  if (ctx.role === "customer" && ctx.targetTenantId !== ctx.tenantId) {
    return deny("CROSS_TENANT", "Customers can only act within their own tenant.");
  }

  // Role gate from the manifest.
  if (!capability.roles.includes(ctx.role)) {
    return deny("ROLE_NOT_PERMITTED", `Capability ${capability.id} is not available to role ${ctx.role}.`);
  }

  // Owner: full access. Actions still require pre-flight + audit + email, but the
  // owner's own request is its own approval (no second loop).
  if (ctx.role === "owner") {
    return { ok: true, requiresApproval: false };
  }

  // Customer: whitelist semantics against tenant policy.
  const grant = policy?.grants[capability.id];
  if (!grant) {
    // Fall back to manifest default customer mode if declared, else blocked.
    if (capability.defaultCustomerMode === "allowed" || capability.kind === "read") {
      // Reads default-allowed within own tenant; actions never default-allowed.
      if (capability.kind === "read" || capability.defaultCustomerMode === "allowed") {
        return capability.kind === "read"
          ? { ok: true, requiresApproval: false }
          : { ok: true, requiresApproval: true };
      }
    }
    if (capability.defaultCustomerMode === "ask_owner") {
      return { ok: true, requiresApproval: true };
    }
    return deny("CAPABILITY_NOT_GRANTED", `This isn't something I can do for your account — I'll pass it to the team.`);
  }

  if (grant.mode === "blocked") {
    return deny("CAPABILITY_BLOCKED", "This action is disabled for your account — I'll pass it to the team.");
  }

  if (grant.protectedExtensions && opts.targetExtension && grant.protectedExtensions.includes(opts.targetExtension)) {
    return deny("PROTECTED_EXTENSION", `Extension ${opts.targetExtension} is protected and can't be changed this way.`);
  }

  if (grant.businessHoursOnly) {
    const h = (ctx.now ?? new Date()).getHours();
    if (h < BUSINESS_HOURS.start || h >= BUSINESS_HOURS.end) {
      return deny("OUTSIDE_BUSINESS_HOURS", "This change can only be requested during business hours.");
    }
  }

  const limits = { ...capability.defaultLimits, ...grant.limits };
  if (limits.maxDurationHours != null && opts.requestedDurationHours != null && opts.requestedDurationHours > limits.maxDurationHours) {
    return deny("LIMIT_EXCEEDED", `Maximum duration for this change is ${limits.maxDurationHours} hours.`);
  }
  if (limits.maxPerDay != null) {
    const used = ctx.usageToday?.[capability.id] ?? 0;
    if (used >= limits.maxPerDay) {
      return deny("LIMIT_EXCEEDED", `Daily limit reached for this change (${limits.maxPerDay}/day).`);
    }
  }

  // Customer actions ALWAYS require human approval (owner decision 2026-07-19).
  // ask_owner mode routes specifically to the owner; allowed mode to the approver set.
  return { ok: true, requiresApproval: capability.kind === "action", grant };
}

function deny(code: PolicyDenialCode, message: string): PolicyDecision {
  return { ok: false, code, message };
}

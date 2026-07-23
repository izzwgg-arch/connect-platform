// Failed-delivery / exception rules — PURE. Maps a reason code to its downstream behavior
// (Gate 3 §15). The service applies these: required evidence, approvals, notifications,
// routing, and the target order status.

import type { DeliveryOrderStatus } from "./status";

export type ExceptionReason =
  | "customer_unavailable" | "no_answer" | "incorrect_address" | "cannot_access"
  | "reschedule_requested" | "refused" | "unsafe_location" | "vehicle_issue"
  | "driver_issue" | "damaged" | "missing_package" | "store_error" | "payment_issue"
  | "age_verification_failed" | "weather" | "traffic" | "app_gps_issue" | "other";

export interface ExceptionRule {
  requiresPhoto: boolean;
  requiresNote: boolean;
  requiresApproval: boolean; // dispatcher/manager approval
  notifiesCustomer: boolean;
  returnsToStore: boolean;
  createsRedelivery: boolean;
  keepsOnRoute: boolean; // driver may retry later on the same run
  targetStatus: DeliveryOrderStatus;
}

const R = (r: Partial<ExceptionRule> & { targetStatus: DeliveryOrderStatus }): ExceptionRule => ({
  requiresPhoto: false, requiresNote: false, requiresApproval: false, notifiesCustomer: true,
  returnsToStore: false, createsRedelivery: false, keepsOnRoute: false, ...r,
});

const RULES: Record<ExceptionReason, ExceptionRule> = {
  customer_unavailable: R({ targetStatus: "CUSTOMER_UNAVAILABLE", requiresPhoto: true, returnsToStore: true, createsRedelivery: true }),
  no_answer: R({ targetStatus: "CUSTOMER_UNAVAILABLE", requiresPhoto: true, keepsOnRoute: true }),
  incorrect_address: R({ targetStatus: "ADDRESS_ISSUE", requiresNote: true, requiresApproval: true, returnsToStore: true }),
  cannot_access: R({ targetStatus: "ADDRESS_ISSUE", requiresPhoto: true, requiresNote: true }),
  reschedule_requested: R({ targetStatus: "DELIVERY_FAILED", createsRedelivery: true, requiresApproval: true }),
  refused: R({ targetStatus: "REFUSED", requiresNote: true, returnsToStore: true }),
  unsafe_location: R({ targetStatus: "DELIVERY_FAILED", requiresNote: true, keepsOnRoute: true }),
  vehicle_issue: R({ targetStatus: "EXCEPTION", requiresNote: true, requiresApproval: true, notifiesCustomer: false }),
  driver_issue: R({ targetStatus: "EXCEPTION", requiresNote: true, requiresApproval: true, notifiesCustomer: false }),
  damaged: R({ targetStatus: "DELIVERY_FAILED", requiresPhoto: true, requiresNote: true, returnsToStore: true, createsRedelivery: true }),
  missing_package: R({ targetStatus: "PARTIALLY_DELIVERED", requiresNote: true, requiresApproval: true }),
  store_error: R({ targetStatus: "EXCEPTION", requiresNote: true, requiresApproval: true }),
  payment_issue: R({ targetStatus: "DELIVERY_FAILED", requiresNote: true, requiresApproval: true, returnsToStore: true }),
  age_verification_failed: R({ targetStatus: "REFUSED", requiresPhoto: true, requiresNote: true, returnsToStore: true }),
  weather: R({ targetStatus: "DELIVERY_FAILED", requiresNote: true, keepsOnRoute: true }),
  traffic: R({ targetStatus: "DELIVERY_FAILED", requiresNote: true, keepsOnRoute: true, notifiesCustomer: false }),
  app_gps_issue: R({ targetStatus: "EXCEPTION", requiresNote: true, notifiesCustomer: false }),
  other: R({ targetStatus: "EXCEPTION", requiresNote: true, requiresApproval: true }),
};

export function exceptionRule(reason: ExceptionReason): ExceptionRule {
  return RULES[reason] ?? RULES.other;
}

export function isValidExceptionReason(v: unknown): v is ExceptionReason {
  return typeof v === "string" && v in RULES;
}

/** Validate a submitted exception against its rule. Pure. */
export interface ExceptionSubmission {
  reason: ExceptionReason;
  hasPhoto: boolean;
  note?: string | null;
}
export function validateException(sub: ExceptionSubmission): { ok: boolean; missing: string[]; rule: ExceptionRule } {
  const rule = exceptionRule(sub.reason);
  const missing: string[] = [];
  if (rule.requiresPhoto && !sub.hasPhoto) missing.push("photo");
  if (rule.requiresNote && !String(sub.note || "").trim()) missing.push("note");
  // "other" always needs a substantive note (guard against misuse of the generic reason).
  if (sub.reason === "other" && !String(sub.note || "").trim()) missing.push("note");
  return { ok: missing.length === 0, missing, rule };
}

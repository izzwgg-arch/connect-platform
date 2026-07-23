// Label-scan decision logic — PURE, dependency-free.
// Given a resolved order + the scanning driver's context, decide the outcome.
// The service layer (scanService.ts) resolves the token → order via the db,
// then calls decideScan(); this keeps the security-critical branching unit-testable.
//
// Design ref: Gate 3 plan §07 (tenant isolation, idempotent scans) and the
// driver "scan states" mockups (success / wrong-tenant / already-assigned / duplicate).

import type { DeliveryOrderStatus } from "./status";

export interface ScanOrderView {
  id: string;
  tenantId: string;
  storeId: string;
  status: DeliveryOrderStatus;
}

export interface ScanContext {
  /** Effective tenant of the authenticated driver. */
  driverTenantId: string;
  /** Store ids the driver is permitted to work. */
  driverStoreIds: string[];
  /** The DriverProfile id of the scanning driver. */
  driverId: string;
  /** Resolved order for the scanned token, or null if the token didn't resolve. */
  order: ScanOrderView | null;
  /** DriverProfile id currently assigned to this order, or null if unassigned. */
  currentAssigneeDriverId: string | null;
  /** Whether this exact client operation id was already processed (idempotency). */
  alreadyProcessed?: boolean;
}

export type ScanOutcome =
  | "assigned" // newly assigned to this driver
  | "duplicate" // same order already assigned to THIS driver (idempotent no-op)
  | "already_assigned" // assigned to ANOTHER driver — reassignment requires confirmation
  | "invalid_token" // token didn't resolve to an order
  | "wrong_tenant" // order belongs to a different tenant (hard block)
  | "wrong_store" // order belongs to a store this driver isn't permitted for
  | "already_delivered" // terminal — cannot be re-scanned for delivery
  | "not_scannable"; // order not in a state that accepts scanning

export interface ScanDecision {
  outcome: ScanOutcome;
  /** True only when the server should create/confirm an assignment now. */
  canAssign: boolean;
  /** True when a destructive confirmation (reassignment) is needed first. */
  needsConfirmation: boolean;
  /** Human-safe message for the driver app. */
  message: string;
  /** Machine code mirrors outcome for API responses. */
  code: ScanOutcome;
}

const SCANNABLE_STATUSES: ReadonlySet<DeliveryOrderStatus> = new Set([
  "READY",
  "SCANNED",
  "ASSIGNED", // re-scan of an order already assigned (idempotent / reassign path)
  "LOADED",
  "RETURNED_TO_STORE",
  "RESCHEDULED",
]);

/**
 * Decide the outcome of a label scan. Never throws. Server-authoritative:
 * the Android app must not pre-decide any of these branches.
 */
export function decideScan(ctx: ScanContext): ScanDecision {
  const { order } = ctx;

  if (!order) {
    return mk("invalid_token", false, false, "We couldn't read a valid delivery label. Try scanning again or enter the code.");
  }

  // Hard tenant boundary — this is the most important guard.
  if (order.tenantId !== ctx.driverTenantId) {
    return mk("wrong_tenant", false, false, "This order isn't for your company.");
  }

  // Store permission.
  if (!ctx.driverStoreIds.includes(order.storeId)) {
    return mk("wrong_store", false, false, "This order isn't for your store. Ask your dispatcher if this looks wrong.");
  }

  // Already delivered / canceled — terminal.
  if (order.status === "DELIVERED" || order.status === "CANCELED") {
    return mk("already_delivered", false, false, "This order is already completed.");
  }

  if (!SCANNABLE_STATUSES.has(order.status)) {
    return mk("not_scannable", false, false, "This order isn't ready to load right now.");
  }

  // Idempotent duplicate of the exact same client operation.
  if (ctx.alreadyProcessed) {
    return mk("duplicate", false, false, "Already scanned — it's on your run.");
  }

  // Assigned already?
  if (ctx.currentAssigneeDriverId) {
    if (ctx.currentAssigneeDriverId === ctx.driverId) {
      // Same driver re-scanning their own order — safe no-op.
      return mk("duplicate", false, false, "Already scanned — it's on your run.");
    }
    // Assigned to someone else — deliberate, warned reassignment.
    return mk(
      "already_assigned",
      false,
      true,
      "This order is assigned to another driver. Taking it will move it off their run.",
    );
  }

  // Clean assignment.
  return mk("assigned", true, false, "Order added to your run.");
}

function mk(
  outcome: ScanOutcome,
  canAssign: boolean,
  needsConfirmation: boolean,
  message: string,
): ScanDecision {
  return { outcome, canAssign, needsConfirmation, message, code: outcome };
}

/**
 * Normalize a client-supplied idempotency/operation id. Returns null when
 * missing/blank so the caller can reject (idempotency is mandatory for writes).
 */
export function normalizeClientOpId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > 128) return null;
  return v;
}

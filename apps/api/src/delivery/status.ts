// Delivery order state machine — PURE, dependency-free (no db, no I/O).
// This is the single source of truth for legal normalized-status transitions.
// The raw supermarket source status is stored separately on Order.rawSourceStatus;
// this module only governs the Connect-normalized Order.status.
//
// Design ref: Gate 3 architecture plan, §04 State machine.
// Every accepted transition is expected to write an OrderStatusEvent + AuditLog row
// at the call site (see orderService.ts).

export const DELIVERY_ORDER_STATUSES = [
  "RECEIVED",
  "AWAITING_PREP",
  "READY",
  "SCANNED",
  "ASSIGNED",
  "LOADED",
  "OUT_FOR_DELIVERY",
  "EN_ROUTE",
  "APPROACHING",
  "ARRIVED",
  "DELIVERED",
  "PARTIALLY_DELIVERED",
  "DELIVERY_FAILED",
  "CUSTOMER_UNAVAILABLE",
  "ADDRESS_ISSUE",
  "REFUSED",
  "RETURNED_TO_STORE",
  "RESCHEDULED",
  "CANCELED",
  "ON_HOLD",
  "EXCEPTION",
] as const;

export type DeliveryOrderStatus = (typeof DELIVERY_ORDER_STATUSES)[number];

/** Actor categories permitted to drive a transition. */
export type TransitionActor = "system" | "driver" | "dispatcher" | "manager";

export interface TransitionMeta {
  /** Roles/actors allowed to perform this transition. */
  actors: TransitionActor[];
  /** Whether a driver location fix is required at transition time. */
  requiresLocation?: boolean;
  /** Whether proof of delivery is required (subject to tenant policy). */
  requiresProof?: boolean;
  /** Whether a reason code/note is mandatory. */
  requiresReason?: boolean;
  /** Whether this transition triggers a customer notification. */
  notifies?: boolean;
  /** Whether the transition can be reversed by a later legal transition. */
  reversible?: boolean;
  /** Whether manager approval is required. */
  requiresApproval?: boolean;
}

type TransitionTable = Partial<
  Record<DeliveryOrderStatus, Partial<Record<DeliveryOrderStatus, TransitionMeta>>>
>;

// Terminal (successful) states — no outgoing transitions except administrative reopen.
export const TERMINAL_STATUSES: ReadonlySet<DeliveryOrderStatus> = new Set([
  "DELIVERED",
  "CANCELED",
]);

// Exception states requiring dispatcher/manager attention.
export const EXCEPTION_STATUSES: ReadonlySet<DeliveryOrderStatus> = new Set([
  "DELIVERY_FAILED",
  "CUSTOMER_UNAVAILABLE",
  "ADDRESS_ISSUE",
  "REFUSED",
  "EXCEPTION",
]);

const S = (m: TransitionMeta): TransitionMeta => m;

/**
 * The legal transition graph. Anything not listed here is rejected.
 * Kept intentionally explicit — no wildcard "any → any" edges.
 */
export const DELIVERY_TRANSITIONS: TransitionTable = {
  RECEIVED: {
    AWAITING_PREP: S({ actors: ["system", "dispatcher"] }),
    READY: S({ actors: ["system", "dispatcher"] }),
    CANCELED: S({ actors: ["system", "dispatcher"], requiresReason: true, requiresApproval: true, notifies: true }),
  },
  AWAITING_PREP: {
    READY: S({ actors: ["system", "dispatcher"] }),
    CANCELED: S({ actors: ["system", "dispatcher"], requiresReason: true, requiresApproval: true, notifies: true }),
    ON_HOLD: S({ actors: ["dispatcher", "manager"], requiresReason: true, reversible: true }),
  },
  READY: {
    SCANNED: S({ actors: ["driver"], reversible: true }),
    CANCELED: S({ actors: ["system", "dispatcher"], requiresReason: true, requiresApproval: true, notifies: true }),
    ON_HOLD: S({ actors: ["dispatcher", "manager"], requiresReason: true, reversible: true }),
  },
  SCANNED: {
    ASSIGNED: S({ actors: ["driver", "dispatcher"], reversible: true }),
    READY: S({ actors: ["dispatcher"], reversible: true }), // unscan / release
  },
  ASSIGNED: {
    LOADED: S({ actors: ["driver"], reversible: true }),
    OUT_FOR_DELIVERY: S({ actors: ["driver"], notifies: true }),
    READY: S({ actors: ["dispatcher"], reversible: true }), // reassignment release
    ON_HOLD: S({ actors: ["dispatcher", "manager"], requiresReason: true, reversible: true }),
  },
  LOADED: {
    OUT_FOR_DELIVERY: S({ actors: ["driver"], notifies: true }),
    READY: S({ actors: ["dispatcher"], reversible: true }),
  },
  OUT_FOR_DELIVERY: {
    EN_ROUTE: S({ actors: ["system", "driver"] }),
    ARRIVED: S({ actors: ["driver"], requiresLocation: true }),
    ON_HOLD: S({ actors: ["dispatcher", "manager"], requiresReason: true, reversible: true }),
  },
  EN_ROUTE: {
    APPROACHING: S({ actors: ["system"] }),
    ARRIVED: S({ actors: ["driver"], requiresLocation: true }),
  },
  APPROACHING: {
    ARRIVED: S({ actors: ["driver"], requiresLocation: true }),
    EN_ROUTE: S({ actors: ["system"] }), // driver diverted to another stop first
  },
  ARRIVED: {
    DELIVERED: S({ actors: ["driver"], requiresLocation: true, requiresProof: true, notifies: true }),
    PARTIALLY_DELIVERED: S({ actors: ["driver"], requiresProof: true, requiresReason: true, notifies: true }),
    DELIVERY_FAILED: S({ actors: ["driver"], requiresReason: true, notifies: true }),
    CUSTOMER_UNAVAILABLE: S({ actors: ["driver"], requiresReason: true, notifies: true }),
    ADDRESS_ISSUE: S({ actors: ["driver"], requiresReason: true, notifies: true }),
    REFUSED: S({ actors: ["driver"], requiresReason: true, notifies: true }),
  },
  DELIVERY_FAILED: {
    RESCHEDULED: S({ actors: ["dispatcher", "driver"], notifies: true, requiresApproval: true }),
    RETURNED_TO_STORE: S({ actors: ["driver", "dispatcher"] }),
    EXCEPTION: S({ actors: ["dispatcher"], requiresReason: true }),
  },
  CUSTOMER_UNAVAILABLE: {
    RESCHEDULED: S({ actors: ["dispatcher", "driver"], notifies: true, requiresApproval: true }),
    RETURNED_TO_STORE: S({ actors: ["driver", "dispatcher"] }),
  },
  ADDRESS_ISSUE: {
    RESCHEDULED: S({ actors: ["dispatcher"], notifies: true, requiresApproval: true }),
    RETURNED_TO_STORE: S({ actors: ["driver", "dispatcher"] }),
    EXCEPTION: S({ actors: ["dispatcher"], requiresReason: true }),
  },
  REFUSED: {
    RETURNED_TO_STORE: S({ actors: ["driver", "dispatcher"] }),
  },
  RETURNED_TO_STORE: {
    RESCHEDULED: S({ actors: ["dispatcher"], notifies: true, requiresApproval: true }),
    READY: S({ actors: ["dispatcher"], reversible: true }), // re-enter fulfilment
  },
  RESCHEDULED: {
    READY: S({ actors: ["system", "dispatcher"] }),
    CANCELED: S({ actors: ["dispatcher"], requiresReason: true, requiresApproval: true, notifies: true }),
  },
  PARTIALLY_DELIVERED: {
    RETURNED_TO_STORE: S({ actors: ["driver", "dispatcher"] }),
    EXCEPTION: S({ actors: ["dispatcher"], requiresReason: true }),
  },
  ON_HOLD: {
    READY: S({ actors: ["dispatcher", "manager"], reversible: true }),
    CANCELED: S({ actors: ["dispatcher", "manager"], requiresReason: true, requiresApproval: true, notifies: true }),
    EXCEPTION: S({ actors: ["dispatcher", "manager"], requiresReason: true }),
  },
  EXCEPTION: {
    ON_HOLD: S({ actors: ["dispatcher", "manager"], reversible: true }),
    RETURNED_TO_STORE: S({ actors: ["dispatcher"] }),
    RESCHEDULED: S({ actors: ["dispatcher", "manager"], notifies: true, requiresApproval: true }),
    CANCELED: S({ actors: ["manager"], requiresReason: true, requiresApproval: true, notifies: true }),
  },
};

export function isValidStatus(value: unknown): value is DeliveryOrderStatus {
  return typeof value === "string" && (DELIVERY_ORDER_STATUSES as readonly string[]).includes(value);
}

export function isTerminalStatus(status: DeliveryOrderStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isExceptionStatus(status: DeliveryOrderStatus): boolean {
  return EXCEPTION_STATUSES.has(status);
}

export function transitionMeta(
  from: DeliveryOrderStatus,
  to: DeliveryOrderStatus,
): TransitionMeta | undefined {
  return DELIVERY_TRANSITIONS[from]?.[to];
}

export function canTransition(from: DeliveryOrderStatus, to: DeliveryOrderStatus): boolean {
  return Boolean(transitionMeta(from, to));
}

export interface TransitionCheck {
  ok: boolean;
  /** machine-readable failure code when ok=false */
  code?: "invalid_from" | "invalid_to" | "illegal_transition" | "actor_not_allowed";
  reason?: string;
  meta?: TransitionMeta;
}

/**
 * Validate a proposed transition. Pure — the caller enforces preconditions
 * (proof/location/reason presence) using the returned meta.
 */
export function checkTransition(
  from: DeliveryOrderStatus,
  to: DeliveryOrderStatus,
  actor: TransitionActor,
): TransitionCheck {
  if (!isValidStatus(from)) return { ok: false, code: "invalid_from", reason: `unknown from-status: ${from}` };
  if (!isValidStatus(to)) return { ok: false, code: "invalid_to", reason: `unknown to-status: ${to}` };
  const meta = transitionMeta(from, to);
  if (!meta) {
    return { ok: false, code: "illegal_transition", reason: `${from} → ${to} is not permitted` };
  }
  if (!meta.actors.includes(actor)) {
    return {
      ok: false,
      code: "actor_not_allowed",
      reason: `${actor} may not perform ${from} → ${to}`,
      meta,
    };
  }
  return { ok: true, meta };
}

/** All statuses reachable in one legal step from `from` (any actor). */
export function nextStatuses(from: DeliveryOrderStatus): DeliveryOrderStatus[] {
  return Object.keys(DELIVERY_TRANSITIONS[from] ?? {}) as DeliveryOrderStatus[];
}

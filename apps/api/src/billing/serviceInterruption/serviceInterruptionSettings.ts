/**
 * The per-tenant switch and the interruption state, stored on
 * `TenantBillingSettings.metadata.serviceInterruption`.
 *
 * Metadata rather than a column, matching the existing `metadata.collections`
 * pattern — no migration, and this ships alongside billing work that other
 * sessions are touching.
 *
 * ⛔ OFF IS THE DEFAULT AND ABSENT MEANS OFF. A default-on switch is
 * indistinguishable from no switch at all the moment the metadata goes
 * missing, and the consequence here is cutting off a paying customer's phones.
 */

export type ServiceInterruptionConfig = {
  /** Master switch. Absent or false = this tenant is never interrupted. */
  enabled: boolean;
  /** Days between the first failed payment and the cutoff. Null = the default 7. */
  graceDays: number | null;
};

export type ServiceInterruptionState = {
  /** Set when the countdown started — the FIRST failed payment, not the latest. */
  countdownStartedAt: string | null;
  /** The invoice the countdown belongs to. */
  invoiceId: string | null;
  /** Last daily reminder, so a restart cannot double-send. */
  lastReminderAt: string | null;
  /** How many days-left the last reminder announced. */
  lastReminderDaysLeft: number | null;
  /** Set when service was actually switched off. */
  interruptedAt: string | null;
  /** What we disabled, so restore puts back exactly that and nothing else. */
  disabledArsMembers: Array<{ arsId: string; outboundRouteId: string }>;
  /** Set when service was put back. */
  restoredAt: string | null;
};

export type ServiceInterruptionSlice = ServiceInterruptionConfig & ServiceInterruptionState;

export const SERVICE_INTERRUPTION_METADATA_KEY = "serviceInterruption";

function asRecord(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

function asIsoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Read the slice. Never throws — bad metadata reads as "switched off". */
export function readServiceInterruption(metadata: unknown): ServiceInterruptionSlice {
  const s = asRecord(asRecord(metadata)[SERVICE_INTERRUPTION_METADATA_KEY]);
  const rawGrace = s.graceDays;
  const graceDays =
    rawGrace != null && Number.isFinite(Number(rawGrace))
      ? Math.min(60, Math.max(1, Math.floor(Number(rawGrace))))
      : null;
  const members = Array.isArray(s.disabledArsMembers) ? s.disabledArsMembers : [];
  return {
    // ⛔ Strict === true: a truthy string like "false" must not switch a
    // customer's phones off.
    enabled: s.enabled === true,
    graceDays,
    countdownStartedAt: asIsoOrNull(s.countdownStartedAt),
    invoiceId: typeof s.invoiceId === "string" && s.invoiceId ? s.invoiceId : null,
    lastReminderAt: asIsoOrNull(s.lastReminderAt),
    lastReminderDaysLeft:
      s.lastReminderDaysLeft != null && Number.isFinite(Number(s.lastReminderDaysLeft))
        ? Math.floor(Number(s.lastReminderDaysLeft))
        : null,
    interruptedAt: asIsoOrNull(s.interruptedAt),
    disabledArsMembers: members
      .map((m: any) => ({ arsId: String(m?.arsId ?? ""), outboundRouteId: String(m?.outboundRouteId ?? "") }))
      .filter((m) => m.arsId && m.outboundRouteId),
    restoredAt: asIsoOrNull(s.restoredAt),
  };
}

/** True when this tenant is switched off right now. */
export function isInterrupted(metadata: unknown): boolean {
  const s = readServiceInterruption(metadata);
  return Boolean(s.interruptedAt) && !s.restoredAt;
}

/**
 * Merge a partial update into the metadata, preserving every other key.
 * ⛔ Returns the WHOLE metadata object — the caller writes it back wholesale,
 * so anything it drops is lost. Never build the metadata from scratch here.
 */
export function writeServiceInterruption(
  metadata: unknown,
  patch: Partial<ServiceInterruptionSlice>,
): Record<string, unknown> {
  const root = { ...asRecord(metadata) };
  const current = readServiceInterruption(metadata);
  root[SERVICE_INTERRUPTION_METADATA_KEY] = { ...current, ...patch };
  return root;
}

/** Start the countdown. Idempotent: an existing countdown is never restarted. */
export function startCountdown(
  metadata: unknown,
  params: { invoiceId: string; failedAt: Date },
): Record<string, unknown> {
  const current = readServiceInterruption(metadata);
  // ⛔ The clock runs from the FIRST failure. Autopay retries a declined card,
  // and restarting here would push the cutoff back on every retry, forever.
  if (current.countdownStartedAt && current.invoiceId === params.invoiceId && !current.restoredAt) {
    return asRecord(metadata) as Record<string, unknown>;
  }
  return writeServiceInterruption(metadata, {
    countdownStartedAt: params.failedAt.toISOString(),
    invoiceId: params.invoiceId,
    lastReminderAt: null,
    lastReminderDaysLeft: null,
    interruptedAt: null,
    restoredAt: null,
    disabledArsMembers: [],
  });
}

/** Clear everything — the customer paid. */
export function clearCountdown(metadata: unknown, restoredAt: Date): Record<string, unknown> {
  return writeServiceInterruption(metadata, {
    countdownStartedAt: null,
    invoiceId: null,
    lastReminderAt: null,
    lastReminderDaysLeft: null,
    interruptedAt: null,
    disabledArsMembers: [],
    restoredAt: restoredAt.toISOString(),
  });
}

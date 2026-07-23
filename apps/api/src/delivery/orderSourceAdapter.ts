// OrderSourceAdapter — the seam to the external supermarket ordering system.
// The real API has not been supplied (Gate 3 §14). This defines the interface and
// a MockOrderSourceAdapter so the whole downstream pipeline is testable in Phase 2.
// Phase 10 implements the real adapter behind the same interface — no rework.
//
// IMPORTANT: no undocumented fields are invented. Optional fields are explicitly
// optional; unknown source fields are ignored, not guessed.

export type OrderSourceEventType = "created" | "updated" | "ready" | "canceled";

/** Normalized order shape the delivery domain understands. */
export interface NormalizedOrderInput {
  /** Stable id from the source system — the idempotency anchor. */
  sourceId: string;
  /** External store reference the adapter maps to a DeliveryStore. */
  storeExternalRef: string;
  customerName?: string;
  customerPhone?: string;
  address: {
    line1: string;
    line2?: string;
    unit?: string;
    city?: string;
    region?: string;
    postal?: string;
    instructions?: string;
    /** Optional source-provided coordinates (used for route optimization + Waze nav). */
    lat?: number;
    lng?: number;
  };
  requestedWindowStart?: string; // ISO
  requestedWindowEnd?: string; // ISO
  packages?: { label?: string; tempSensitive?: boolean }[];
  priority?: "LOW" | "NORMAL" | "HIGH";
  flags?: {
    signatureRequired?: boolean;
    ageRestricted?: boolean;
    cashOnDelivery?: boolean;
  };
  language?: string;
  messagingConsent?: boolean;
  /** The raw source-system status string, preserved verbatim on the order. */
  rawStatus?: string;
}

export interface NormalizedOrderEvent {
  type: OrderSourceEventType;
  sourceId: string;
  order?: NormalizedOrderInput; // present for created/updated/ready
}

export interface OrderSourceAdapter {
  readonly name: string;
  /** Normalize a raw inbound payload into a delivery-domain event. Never throws on shape. */
  normalizeEvent(payload: unknown): NormalizedOrderEvent | null;
}

// ── Mock adapter ────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Mock adapter. Accepts a simple, documented JSON envelope so the setup wizard's
 * "create a test order" and integration tests can exercise the full pipeline.
 *
 * Expected envelope:
 * { "type": "created"|"updated"|"ready"|"canceled", "id": "<sourceId>",
 *   "storeRef": "<external store ref>", "customer": {...}, "address": {...}, ... }
 */
export class MockOrderSourceAdapter implements OrderSourceAdapter {
  readonly name = "mock";

  normalizeEvent(payload: unknown): NormalizedOrderEvent | null {
    if (!payload || typeof payload !== "object") return null;
    const p = payload as Record<string, any>;
    const type = str(p.type) as OrderSourceEventType | undefined;
    const sourceId = str(p.id) ?? str(p.sourceId);
    if (!type || !sourceId) return null;
    if (!["created", "updated", "ready", "canceled"].includes(type)) return null;

    if (type === "canceled") return { type, sourceId };

    const storeExternalRef = str(p.storeRef) ?? str(p.storeExternalRef);
    const addr = p.address && typeof p.address === "object" ? p.address : {};
    const line1 = str(addr.line1);
    if (!storeExternalRef || !line1) return null; // minimum viable order

    const order: NormalizedOrderInput = {
      sourceId,
      storeExternalRef,
      customerName: str(p.customer?.name),
      customerPhone: str(p.customer?.phone),
      address: {
        line1,
        line2: str(addr.line2),
        unit: str(addr.unit),
        city: str(addr.city),
        region: str(addr.region),
        postal: str(addr.postal),
        instructions: str(addr.instructions),
        lat: typeof addr.lat === "number" && Number.isFinite(addr.lat) ? addr.lat : undefined,
        lng: typeof addr.lng === "number" && Number.isFinite(addr.lng) ? addr.lng : undefined,
      },
      requestedWindowStart: str(p.windowStart),
      requestedWindowEnd: str(p.windowEnd),
      packages: Array.isArray(p.packages)
        ? p.packages.map((x: any) => ({ label: str(x?.label), tempSensitive: Boolean(x?.tempSensitive) }))
        : undefined,
      priority: (["LOW", "NORMAL", "HIGH"] as const).find((x) => x === str(p.priority)) ?? undefined,
      flags: p.flags && typeof p.flags === "object"
        ? {
            signatureRequired: Boolean(p.flags.signatureRequired),
            ageRestricted: Boolean(p.flags.ageRestricted),
            cashOnDelivery: Boolean(p.flags.cashOnDelivery),
          }
        : undefined,
      language: str(p.language),
      messagingConsent: typeof p.messagingConsent === "boolean" ? p.messagingConsent : undefined,
      rawStatus: str(p.rawStatus) ?? (type === "ready" ? "READY" : "NEW"),
    };
    return { type, sourceId, order };
  }

  /** Deterministic sample orders for the setup wizard / demos (no real data). */
  sampleOrders(storeExternalRef: string, count = 3): NormalizedOrderEvent[] {
    const streets = ["Maple Court", "Oak Ridge", "Cedar Lane", "Birch Ave", "Pine Hollow"];
    return Array.from({ length: count }, (_, i) => ({
      type: "created" as const,
      sourceId: `SAMPLE-${storeExternalRef}-${1000 + i}`,
      order: {
        sourceId: `SAMPLE-${storeExternalRef}-${1000 + i}`,
        storeExternalRef,
        customerName: `Sample Customer ${i + 1}`,
        customerPhone: `+1555000${String(1000 + i)}`,
        address: {
          line1: `${100 + i} ${streets[i % streets.length]}`,
          unit: `${i + 1}B`,
          // Deterministic demo coordinates around a base point (so route optimization + Waze work).
          lat: 40.7 + ((i * 7) % 20) * 0.004,
          lng: -74.0 - ((i * 11) % 20) * 0.004,
        },
        packages: [{ label: "tote-1" }, { label: "tote-2", tempSensitive: i % 2 === 0 }],
        priority: "NORMAL",
        flags: { signatureRequired: i === 0 },
        rawStatus: "NEW",
      },
    }));
  }
}

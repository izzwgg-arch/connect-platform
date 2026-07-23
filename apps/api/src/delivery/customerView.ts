// Customer-facing view builder — PURE. Turns internal order/run/location/ETA state into the
// privacy-filtered payload a customer may see. This is the enforcement point for:
//  - coarse public status (never the raw internal status vocabulary)
//  - progressive map reveal (decision 1)
//  - tiered detail gating (decision 4) — sensitive fields only at verified tier 2
//  - honest ETA / "location unavailable" (never stale-as-live)
//
// Server-authoritative: the customer API returns ONLY what this produces.

import type { DeliveryOrderStatus } from "./status";
import { decideReveal, type MapReveal } from "./progressiveReveal";
import { movementLabel, type MovementStatus } from "./staleness";
import { formatEtaRange, type EtaResult } from "./eta";

export type PublicStatus =
  | "preparing"
  | "on_the_way"
  | "arriving"
  | "delivered"
  | "attempted"
  | "rescheduled"
  | "canceled"
  | "processing";

const STATUS_MAP: Record<DeliveryOrderStatus, { code: PublicStatus; label: string }> = {
  RECEIVED: { code: "preparing", label: "Order received" },
  AWAITING_PREP: { code: "preparing", label: "Being prepared" },
  READY: { code: "preparing", label: "Being prepared" },
  SCANNED: { code: "preparing", label: "Getting ready" },
  ASSIGNED: { code: "preparing", label: "Getting ready" },
  LOADED: { code: "preparing", label: "Getting ready" },
  OUT_FOR_DELIVERY: { code: "on_the_way", label: "Out for delivery" },
  EN_ROUTE: { code: "on_the_way", label: "On the way" },
  APPROACHING: { code: "arriving", label: "Arriving soon" },
  ARRIVED: { code: "arriving", label: "Your driver has arrived" },
  DELIVERED: { code: "delivered", label: "Delivered" },
  PARTIALLY_DELIVERED: { code: "delivered", label: "Partially delivered" },
  DELIVERY_FAILED: { code: "attempted", label: "Delivery attempted" },
  CUSTOMER_UNAVAILABLE: { code: "attempted", label: "We missed you" },
  ADDRESS_ISSUE: { code: "attempted", label: "Delivery issue" },
  REFUSED: { code: "attempted", label: "Delivery not completed" },
  RETURNED_TO_STORE: { code: "attempted", label: "Returning to store" },
  RESCHEDULED: { code: "rescheduled", label: "Rescheduled" },
  CANCELED: { code: "canceled", label: "Canceled" },
  ON_HOLD: { code: "processing", label: "Being processed" },
  EXCEPTION: { code: "processing", label: "Being processed" },
};

export interface CustomerViewInput {
  status: DeliveryOrderStatus;
  orderRef: string; // masked/order number — safe to show
  mapReveal: MapReveal;
  exactPinStopsAway: number;
  stopsAway: number | null;
  isLive: boolean;
  movement: MovementStatus;
  eta: EtaResult | null;
  nowMs: number;
  position: { lat: number; lng: number; heading?: number | null } | null;
  lastUpdateSec: number | null;
  verifiedTier: 0 | 1 | 2; // 0 invalid, 1 token, 2 OTP-verified
  // tier-2 fields (only surfaced when verifiedTier >= 2)
  deliveryAddress?: string | null;
  proofSummary?: { method: string; capturedAt: string } | null;
}

export interface CustomerView {
  statusCode: PublicStatus;
  statusLabel: string;
  orderRef: string;
  eta: string | null;
  stopsAway: number | null;
  movementLabel: string;
  lastUpdated: string | null;
  map: { show: boolean; exactPin: boolean; approximateArea: boolean; position: { lat: number; lng: number; heading?: number | null } | null };
  detail: { address?: string; proof?: { method: string; capturedAt: string } } | null;
}

export function buildCustomerView(input: CustomerViewInput): CustomerView {
  const mapped = STATUS_MAP[input.status] ?? { code: "processing" as PublicStatus, label: "Being processed" };

  const isActive = mapped.code === "on_the_way" || mapped.code === "arriving";
  const reveal = decideReveal({
    mapReveal: input.mapReveal,
    stopsAway: input.stopsAway,
    isLive: input.isLive,
    exactPinStopsAway: input.exactPinStopsAway,
  });

  // ETA only meaningful while en route/arriving and not terminal.
  const etaText = isActive && input.eta ? formatEtaRange(input.nowMs, input.eta) : null;

  // Map only rendered for active deliveries; exact position withheld unless reveal allows.
  const showMap = reveal.showMap && isActive;
  const exactPin = showMap && reveal.showExactPin;

  const detail =
    input.verifiedTier >= 2
      ? {
          ...(input.deliveryAddress ? { address: input.deliveryAddress } : {}),
          ...(input.proofSummary ? { proof: input.proofSummary } : {}),
        }
      : null;

  return {
    statusCode: mapped.code,
    statusLabel: mapped.label,
    orderRef: input.orderRef,
    eta: etaText,
    stopsAway: reveal.showStopsAway && isActive ? input.stopsAway : null,
    movementLabel: movementLabel(input.movement),
    lastUpdated: input.lastUpdateSec == null ? null : `${Math.round(input.lastUpdateSec)}s ago`,
    map: {
      show: showMap,
      exactPin,
      approximateArea: showMap && reveal.showApproximateArea,
      position: exactPin ? input.position : null,
    },
    detail: detail && Object.keys(detail).length ? detail : null,
  };
}

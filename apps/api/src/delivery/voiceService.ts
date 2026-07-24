// Voice status resolve service (Phase 8). READ-ONLY. Resolves a caller to their order and
// returns a prerecorded-fragment voice plan. Writes NOTHING to the PBX/AstDB/VitalPBX.
// The PBX dialplan overlay would call this (via AGI/HTTP) once the delivery IVR branch is
// wired under separate approval — that wiring is NOT part of this phase.

import { db } from "@connect/db";
import { buildVoiceResponse, type VoiceScenario, type VoiceContext } from "./voiceStatus";
import { publicStatus } from "./customerView";
import type { DeliveryOrderStatus } from "./status";

function last10(raw: string | null | undefined): string {
  return String(raw || "").replace(/\D/g, "").slice(-10);
}

async function etaMinutesForOrder(orderId: string): Promise<{ from: number; to: number } | null> {
  const snap = await db.etaSnapshot.findFirst({
    where: { orderId },
    orderBy: { calcAt: "desc" },
    select: { etaMinSec: true, etaMaxSec: true },
  });
  if (!snap) return null;
  return { from: Math.round(snap.etaMinSec / 60), to: Math.round(snap.etaMaxSec / 60) };
}

export interface VoiceResolveInput {
  tenantId: string;
  callerId?: string;
  digits?: string; // manual phone / order-number entry
  afterHours?: boolean;
}

export interface VoiceResolveResult {
  scenario: VoiceScenario;
  fragments: ReturnType<typeof buildVoiceResponse>;
  orderRef?: string;
}

export async function resolveVoiceStatus(input: VoiceResolveInput): Promise<VoiceResolveResult> {
  try {
    // Manual entry (digits) takes precedence over caller-ID.
    const phone = input.digits && input.digits.length >= 10 ? last10(input.digits) : last10(input.callerId);
    if (!phone || phone.length < 10) {
      return { scenario: "unmatched", fragments: buildVoiceResponse("unmatched") };
    }

    const candidates = await db.deliveryOrder.findMany({
      where: { tenantId: input.tenantId },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, sourceId: true, status: true, customerPhone: true },
    });
    let orders = candidates.filter((o) => last10(o.customerPhone) === phone);

    // Order-number digits (last 4) disambiguate.
    if (input.digits && input.digits.length <= 6 && orders.length > 1) {
      const d = last10(input.digits) || input.digits;
      orders = orders.filter((o) => o.sourceId.toUpperCase().endsWith(String(d).toUpperCase()));
    }

    const active = orders.filter((o) => !["DELIVERED", "CANCELED"].includes(o.status));

    if (active.length === 0) {
      // Nothing active — but a recent order might be delivered/canceled.
      const recent = orders[0];
      if (recent?.status === "DELIVERED") return { scenario: "delivered", fragments: buildVoiceResponse("delivered"), orderRef: `#${recent.sourceId}` };
      if (recent?.status === "CANCELED") return { scenario: "canceled", fragments: buildVoiceResponse("canceled"), orderRef: `#${recent.sourceId}` };
      return { scenario: "no_order", fragments: buildVoiceResponse("no_order") };
    }

    if (active.length > 1) {
      return { scenario: "matched_multiple", fragments: buildVoiceResponse("matched_multiple", { orderCount: active.length }) };
    }

    const order = active[0];
    const status = order.status as DeliveryOrderStatus;
    const mapped = publicStatus(status);
    const isActive = mapped.code === "on_the_way" || mapped.code === "arriving";
    const eta = isActive ? await etaMinutesForOrder(order.id) : null;

    const ctx: VoiceContext = {
      statusLabel: mapped.label,
      active: isActive,
      etaMinFrom: eta?.from ?? null,
      etaMinTo: eta?.to ?? null,
    };

    const scenario: VoiceScenario = input.afterHours ? "after_hours" : "matched_single";
    return { scenario, fragments: buildVoiceResponse(scenario, ctx), orderRef: `#${order.sourceId}` };
  } catch {
    // Fail safe — never expose the error to the caller.
    return { scenario: "system_error", fragments: buildVoiceResponse("system_error") };
  }
}

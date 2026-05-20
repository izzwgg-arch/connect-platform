/**
 * Core logic for admin add-card via iFields SUT.
 * Dependencies are injectable so the function is unit-testable without
 * a live DB, SOLA adapter, or Fastify server.
 *
 * PCI boundary: xSut is a single-use Cardknox token; raw PAN/CVV never enter
 * this function. xSut must NOT appear in any logEvent call here.
 */

import type { CardknoxTransactionResponse } from "@connect/integrations";
import { solaProcessorUserMessage } from "./solaBillingPayments";

export type AdminCardSaveDeps = {
  findTenant(tenantId: string): Promise<{ id: string } | null>;
  getAdapter(tenantId: string): Promise<{
    saveCardWithSut(input: { sut: string; exp?: string; cardholderName?: string; zip?: string }): Promise<CardknoxTransactionResponse>;
  }>;
  storeMethod(opts: {
    tenantId: string;
    response: CardknoxTransactionResponse;
    cardholderName?: string;
    billingZip?: string;
    makeDefault?: boolean;
  }): Promise<{ id: string; brand: string | null; last4: string | null; expMonth: string | null; expYear: string | null; isDefault: boolean }>;
  logEvent(opts: { tenantId: string; type: string; message?: string; metadata?: Record<string, unknown> }): Promise<void>;
};

export type AdminCardSaveInput = {
  xSut: string;
  cardholderName?: string;
  billingZip?: string;
  xExp?: string;
  makeDefault?: boolean;
};

export type AdminCardSaveResult =
  | { ok: true; id: string; brand: string | null; last4: string | null; expMonth: string | null; expYear: string | null; isDefault: boolean }
  | { ok: false; code: 400; error: "sola_token_too_short" }
  | { ok: false; code: 404; error: "tenant_not_found" }
  | { ok: false; code: 402; error: "card_save_failed"; response: CardknoxTransactionResponse; message: string };

export async function saveAdminCardWithSut(
  tenantId: string,
  input: AdminCardSaveInput,
  adminUserId: string,
  deps: AdminCardSaveDeps,
): Promise<AdminCardSaveResult> {
  if (!input.xSut || input.xSut.length < 8) {
    return { ok: false, code: 400, error: "sola_token_too_short" };
  }

  const tenant = await deps.findTenant(tenantId);
  if (!tenant) return { ok: false, code: 404, error: "tenant_not_found" };

  const adapter = await deps.getAdapter(tenantId);
  const response = await adapter.saveCardWithSut({
    sut: input.xSut,
    exp: input.xExp,
    cardholderName: input.cardholderName,
    zip: input.billingZip,
  });

  if (!response.approved) {
    return {
      ok: false,
      code: 402,
      error: "card_save_failed",
      response,
      message: solaProcessorUserMessage(response),
    };
  }

  const method = await deps.storeMethod({
    tenantId,
    response,
    cardholderName: input.cardholderName,
    billingZip: input.billingZip,
    makeDefault: input.makeDefault,
  });

  // PCI: do NOT include xSut or any card token in the log metadata.
  await deps.logEvent({
    tenantId,
    type: "payment_method.saved",
    message: "Admin added card via iFields",
    metadata: { paymentMethodId: method.id, brand: method.brand, last4: method.last4, adminUserId },
  });

  return {
    ok: true,
    id: method.id,
    brand: method.brand,
    last4: method.last4,
    expMonth: method.expMonth,
    expYear: method.expYear,
    isDefault: method.isDefault,
  };
}

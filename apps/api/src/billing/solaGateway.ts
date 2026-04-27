import { SolaCardknoxAdapter, type SolaCardknoxConfig, type CardknoxTransactionResponse } from "@connect/integrations";
import { db } from "@connect/db";
import { decryptJson, encryptJson } from "@connect/security";

type BillingSolaCredentialPayload = {
  apiKey: string;
  apiSecret?: string | null;
  webhookSecret?: string | null;
};

type BillingSolaPathOverrides = {
  customerPath?: string;
  subscriptionPath?: string;
  transactionPath?: string;
  hostedSessionPath?: string;
  chargePath?: string;
  cancelPath?: string;
};

function normalizeSolaPathOverrides(input: unknown): BillingSolaPathOverrides {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const pick = (key: keyof BillingSolaPathOverrides) => {
    const raw = String(src[key] || "").trim();
    return raw || undefined;
  };
  return {
    customerPath: pick("customerPath"),
    subscriptionPath: pick("subscriptionPath"),
    transactionPath: pick("transactionPath"),
    hostedSessionPath: pick("hostedSessionPath"),
    chargePath: pick("chargePath"),
    cancelPath: pick("cancelPath"),
  };
}

export async function getBillingSolaAdapter(tenantId: string): Promise<SolaCardknoxAdapter> {
  const row = await (db as any).billingSolaConfig.findUnique({ where: { tenantId } });
  if (!row || !row.isEnabled) {
    if (process.env.SOLA_CARDKNOX_API_BASE_URL && process.env.SOLA_CARDKNOX_API_KEY) {
      return new SolaCardknoxAdapter({
        baseUrl: process.env.SOLA_CARDKNOX_API_BASE_URL,
        apiKey: process.env.SOLA_CARDKNOX_API_KEY,
        apiSecret: process.env.SOLA_CARDKNOX_API_SECRET,
        webhookSecret: process.env.SOLA_CARDKNOX_WEBHOOK_SECRET,
        transactionPath: process.env.SOLA_CARDKNOX_TRANSACTION_PATH || "/gatewayjson",
        simulate: process.env.SOLA_CARDKNOX_SIMULATE === "1",
      });
    }
    throw new Error(row ? "SOLA_NOT_ENABLED" : "SOLA_NOT_CONFIGURED");
  }
  const secrets = decryptJson<BillingSolaCredentialPayload>(row.credentialsEncrypted);
  const paths = normalizeSolaPathOverrides(row.pathOverrides);
  const config: SolaCardknoxConfig = {
    baseUrl: row.apiBaseUrl,
    apiKey: secrets.apiKey,
    apiSecret: secrets.apiSecret || undefined,
    webhookSecret: secrets.webhookSecret || undefined,
    mode: row.mode === "PROD" ? "prod" : "sandbox",
    simulate: !!row.simulate,
    authMode: row.authMode === "AUTHORIZATION_HEADER" ? "authorization_header" : "xkey_body",
    authHeaderName: row.authHeaderName || undefined,
    customerPath: paths.customerPath,
    subscriptionPath: paths.subscriptionPath,
    transactionPath: paths.transactionPath || "/gatewayjson",
    hostedSessionPath: paths.hostedSessionPath,
    chargePath: paths.chargePath,
    cancelPath: paths.cancelPath,
  };
  return new SolaCardknoxAdapter(config);
}

export async function storeSolaPaymentMethod(input: {
  tenantId: string;
  response: CardknoxTransactionResponse;
  cardholderName?: string | null;
  billingZip?: string | null;
  makeDefault?: boolean;
}) {
  if (!input.response.xToken) throw new Error("SOLA_TOKEN_MISSING");
  const masked = input.response.xMaskedCardNumber || "";
  const last4 = masked.replace(/\D/g, "").slice(-4) || null;
  const exp = input.response.xExp || "";
  const expMonth = exp.length >= 2 ? exp.slice(0, 2) : null;
  const expYear = exp.length >= 4 ? exp.slice(-2) : null;
  const created = await (db as any).paymentMethod.create({
    data: {
      tenantId: input.tenantId,
      tokenEncrypted: encryptJson(input.response.xToken),
      tokenKeyId: "v1",
      brand: input.response.xCardType || null,
      last4,
      expMonth,
      expYear,
      cardholderName: input.cardholderName || null,
      billingZip: input.billingZip || null,
      isDefault: !!input.makeDefault,
    },
  });
  if (input.makeDefault) {
    await (db as any).paymentMethod.updateMany({
      where: { tenantId: input.tenantId, id: { not: created.id } },
      data: { isDefault: false },
    });
    await (db as any).tenantBillingSettings.upsert({
      where: { tenantId: input.tenantId },
      create: { tenantId: input.tenantId, defaultPaymentMethodId: created.id },
      update: { defaultPaymentMethodId: created.id },
    });
  }
  return created;
}

export function decryptPaymentToken(paymentMethod: { tokenEncrypted: string }): string {
  return decryptJson<string>(paymentMethod.tokenEncrypted);
}

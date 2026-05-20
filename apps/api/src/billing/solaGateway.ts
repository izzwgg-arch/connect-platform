import { SolaCardknoxAdapter, type SolaCardknoxConfig, type CardknoxTransactionResponse } from "@connect/integrations";
import { db } from "@connect/db";
import { decryptJson, encryptJson } from "@connect/security";

type BillingSolaCredentialPayload = {
  apiKey: string;
  apiSecret?: string | null;
  webhookSecret?: string | null;
  ifieldsKey?: string | null;
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

function buildAdapterFromSecrets(row: any, secrets: BillingSolaCredentialPayload): SolaCardknoxAdapter {
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

function buildEnvFallbackAdapter(): SolaCardknoxAdapter | null {
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
  return null;
}

function cleanString(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.toLowerCase() === "undefined" || trimmed.toLowerCase() === "null") return "";
  return trimmed;
}

export type BillingGatewayConfigSource = "tenant" | "main_tenant" | "global" | "missing";

type ResolveGatewayOptions = {
  forTokenizing?: boolean;
  dbClient?: any;
  decodeSecrets?: (encrypted: string) => BillingSolaCredentialPayload;
};

export type ResolvedBillingGatewayConfig = {
  configured: boolean;
  enabled: boolean;
  source: BillingGatewayConfigSource;
  tenantOverridePresent: boolean;
  ifieldsKey: string | null;
  mode: "prod" | "sandbox" | null;
  simulate: boolean;
  adapter: SolaCardknoxAdapter | null;
};

const TENANT_GATEWAY_OVERRIDE_ENABLED = process.env.BILLING_GATEWAY_ALLOW_TENANT_OVERRIDE !== "0";

function parseRowConfig(
  row: any,
  decodeSecrets: (encrypted: string) => BillingSolaCredentialPayload,
): { adapter: SolaCardknoxAdapter; ifieldsKey: string | null } | null {
  if (!row?.credentialsEncrypted) return null;
  try {
    const secrets = decodeSecrets(row.credentialsEncrypted);
    const apiKey = String(secrets?.apiKey || "").trim();
    if (!apiKey) return null;
    return {
      adapter: buildAdapterFromSecrets(row, { ...secrets, apiKey }),
      ifieldsKey: String(secrets?.ifieldsKey || "").trim() || null,
    };
  } catch {
    return null;
  }
}

function envFallbackAllowed(explicitMainTenantId: string): boolean {
  if (explicitMainTenantId) return false;
  return cleanString(process.env.BILLING_GATEWAY_ALLOW_ENV_FALLBACK) === "1";
}

async function findMainTenantGatewayRow(dbClient: any): Promise<any | null> {
  const explicitMainTenantId = cleanString(process.env.BILLING_MAIN_TENANT_ID) || cleanString(process.env.PLATFORM_TENANT_ID);
  if (explicitMainTenantId) {
    const byExplicit = await dbClient.billingSolaConfig.findUnique({ where: { tenantId: explicitMainTenantId } });
    return byExplicit?.isEnabled ? byExplicit : null;
  }
  const bySuperAdminTenant = await dbClient.billingSolaConfig.findFirst({
    where: { isEnabled: true, tenant: { users: { some: { role: "SUPER_ADMIN" } } } },
    orderBy: { updatedAt: "desc" },
  });
  if (bySuperAdminTenant) return bySuperAdminTenant;
  return dbClient.billingSolaConfig.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
}

export async function resolveBillingGatewayConfig(
  tenantId: string,
  options: ResolveGatewayOptions = {},
): Promise<ResolvedBillingGatewayConfig> {
  const dbClient = options.dbClient ?? (db as any);
  const decodeSecrets = options.decodeSecrets ?? ((encrypted: string) => decryptJson<BillingSolaCredentialPayload>(encrypted));
  const forTokenizing = !!options.forTokenizing;

  const globalConfig = await dbClient.globalSolaConfig.findUnique({ where: { id: "default" } });
  const platformIfieldsKey = cleanString(process.env.SOLA_CARDKNOX_IFIELDS_KEY) || cleanString(globalConfig?.ifieldsKey) || null;
  const explicitMainTenantId = cleanString(process.env.BILLING_MAIN_TENANT_ID) || cleanString(process.env.PLATFORM_TENANT_ID);

  const tenantRow = await dbClient.billingSolaConfig.findUnique({ where: { tenantId } });
  const tenantOverridePresent = !!tenantRow;
  if (TENANT_GATEWAY_OVERRIDE_ENABLED && tenantRow) {
    const parsed = parseRowConfig(tenantRow, decodeSecrets);
    const enabledForPurpose = !!tenantRow.isEnabled || forTokenizing;
    if (parsed && enabledForPurpose) {
      return {
        configured: true,
        enabled: !!tenantRow.isEnabled,
        source: "tenant",
        tenantOverridePresent,
        ifieldsKey: parsed.ifieldsKey || platformIfieldsKey,
        mode: tenantRow.mode === "PROD" ? "prod" : "sandbox",
        simulate: !!tenantRow.simulate,
        adapter: parsed.adapter,
      };
    }
  }

  const mainRow = await findMainTenantGatewayRow(dbClient);
  if (mainRow) {
    const parsed = parseRowConfig(mainRow, decodeSecrets);
    if (parsed) {
      return {
        configured: true,
        enabled: true,
        source: "main_tenant",
        tenantOverridePresent,
        ifieldsKey: parsed.ifieldsKey || platformIfieldsKey,
        mode: mainRow.mode === "PROD" ? "prod" : "sandbox",
        simulate: !!mainRow.simulate,
        adapter: parsed.adapter,
      };
    }
  }

  const envAdapter = envFallbackAllowed(explicitMainTenantId) ? buildEnvFallbackAdapter() : null;
  if (envAdapter) {
    return {
      configured: true,
      enabled: true,
      source: "global",
      tenantOverridePresent,
      ifieldsKey: platformIfieldsKey,
      mode: "sandbox",
      simulate: process.env.SOLA_CARDKNOX_SIMULATE === "1",
      adapter: envAdapter,
    };
  }

  return {
    configured: false,
    enabled: false,
    source: "missing",
    tenantOverridePresent,
    ifieldsKey: platformIfieldsKey,
    mode: null,
    simulate: false,
    adapter: null,
  };
}

/** For billing/charging — requires isEnabled=true on the tenant config. */
export async function getBillingSolaAdapter(tenantId: string): Promise<SolaCardknoxAdapter> {
  const resolved = await resolveBillingGatewayConfig(tenantId, { forTokenizing: false });
  console.info("[billing.gateway.resolve]", { tenantId, source: resolved.source, purpose: "charge" });
  if (!resolved.configured || !resolved.adapter) throw new Error("SOLA_NOT_CONFIGURED");
  if (!resolved.enabled) throw new Error("SOLA_NOT_ENABLED");
  return resolved.adapter;
}

/**
 * For card tokenizing only (saving a card, no charge).
 * Works even when isEnabled=false so admins can vault cards before enabling autopay.
 */
export async function getBillingSolaAdapterForTokenizing(tenantId: string): Promise<SolaCardknoxAdapter> {
  const resolved = await resolveBillingGatewayConfig(tenantId, { forTokenizing: true });
  console.info("[billing.gateway.resolve]", { tenantId, source: resolved.source, purpose: "tokenize" });
  if (!resolved.configured || !resolved.adapter) throw new Error("SOLA_NOT_CONFIGURED");
  return resolved.adapter;
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

import { createHmac, timingSafeEqual } from "crypto";

export type SolaCardknoxConfig = {
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  webhookSecret?: string;
  mode?: "sandbox" | "prod";
  simulate?: boolean;
  authMode?: "xkey_body" | "authorization_header";
  authHeaderName?: string;
  transactionPath?: string;
  customerPath?: string;
  paymentMethodPath?: string;
  subscriptionPath?: string;
  chargePath?: string;
  cancelPath?: string;
  webhookSignatureHeader?: string;
  webhookTimestampHeader?: string;
  webhookVerifyMode?: "shared_secret" | "hmac_sha256" | "none";
};

export type SolaCustomerInput = {
  tenantId: string;
  billingEmail: string;
  tenantName?: string;
};

export type SolaWebhookEvent = {
  eventId?: string;
  type: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  amountCents?: number;
  currency?: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  payload: any;
};

function notConfigured(config: SolaCardknoxConfig): boolean {
  return !config.baseUrl || !config.apiKey;
}

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function normalizeHeaderName(name: string): string {
  return String(name || "").toLowerCase();
}

function getHeader(headers: Record<string, string | string[] | undefined>, key: string): string {
  const v = headers[normalizeHeaderName(key)] ?? headers[key];
  return Array.isArray(v) ? String(v[0] || "") : String(v || "");
}

function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseAmountCents(value: any): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (Number.isFinite(value) && value > 0) {
      if (Number.isInteger(value) && value > 1000) return value;
      return Math.round(value * 100);
    }
    return undefined;
  }
  const str = String(value).trim();
  if (!str) return undefined;
  if (/^\d+$/.test(str) && str.length > 2) return Number(str);
  const n = Number(str);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 100);
}

function derivePaymentStatus(payload: Record<string, any>): "PENDING" | "SUCCEEDED" | "FAILED" {
  const direct = String(payload.status || payload.paymentStatus || payload.xStatus || "").toUpperCase();
  if (["SUCCEEDED", "SUCCESS", "APPROVED", "PAID", "SETTLED", "16"].includes(direct)) return "SUCCEEDED";
  if (["FAILED", "DECLINED", "ERROR", "REJECTED", "CHARGEBACK", "RETURNED", "14", "18", "20"].includes(direct)) return "FAILED";

  const xResult = String(payload.xResult || "").toUpperCase();
  if (xResult === "A") return "SUCCEEDED";
  if (xResult === "D" || xResult === "E") return "FAILED";

  return "PENDING";
}

function normalizeResponseError(payload: any): Error | null {
  const status = derivePaymentStatus(payload || {});
  if (status !== "FAILED") return null;
  const err: any = new Error("SOLA_DECLINED");
  err.code = "SOLA_DECLINED";
  err.reason = String(payload?.xError || payload?.error || payload?.message || "Payment declined");
  return err;
}

function buildUrl(baseUrl: string, path: string): string {
  return `${String(baseUrl).replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function withAuth(config: SolaCardknoxConfig, body: Record<string, any>, headers: Record<string, string>): Record<string, any> {
  const authMode = config.authMode || "xkey_body";
  if (authMode === "authorization_header") {
    headers[config.authHeaderName || "Authorization"] = String(config.apiKey || "");
    if (config.apiSecret) headers["x-api-secret"] = String(config.apiSecret);
    return body;
  }

  const out: Record<string, any> = { ...body, xKey: config.apiKey };
  if (config.apiSecret) out.xSecret = config.apiSecret;
  return out;
}

async function postJson(config: SolaCardknoxConfig, path: string, body: Record<string, any>): Promise<any> {
  if (config.simulate) {
    return { ok: true, id: `sim_${path.replace(/\W+/g, "_")}_${Date.now()}`, xResult: "A", ...body };
  }

  if (notConfigured(config)) {
    const err: any = new Error("NOT_CONFIGURED");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  const authedBody = withAuth(config, body, headers);

  const res = await fetch(buildUrl(String(config.baseUrl), path), {
    method: "POST",
    headers,
    body: JSON.stringify(authedBody),
    signal: timeoutSignal(10000)
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error("SOLA_REQUEST_FAILED");
    err.code = "SOLA_REQUEST_FAILED";
    err.status = res.status;
    throw err;
  }

  const maybeErr = normalizeResponseError(payload);
  if (maybeErr) throw maybeErr;

  return payload;
}

export class SolaCardknoxAdapter {
  private config: SolaCardknoxConfig;

  constructor(config: SolaCardknoxConfig) {
    this.config = config;
  }

  async createCustomer(input: SolaCustomerInput): Promise<{ providerCustomerId: string }> {
    if (this.config.simulate) {
      return { providerCustomerId: `sim_cust_${input.tenantId}` };
    }

    const path = this.config.customerPath || "/customers";
    const res = await postJson(this.config, path, {
      email: input.billingEmail,
      tenantId: input.tenantId,
      name: input.tenantName || input.tenantId
    });

    return { providerCustomerId: String(res.customerId || res.customerID || res.id || res.xCustomer || "") };
  }

  async attachPaymentMethod(providerCustomerId: string, paymentToken: string): Promise<{ providerPaymentMethodId: string; brand?: string; last4?: string; expMonth?: string; expYear?: string }> {
    if (this.config.simulate) {
      return {
        providerPaymentMethodId: `sim_pm_${providerCustomerId}`,
        brand: "SIM",
        last4: "4242",
        expMonth: "12",
        expYear: "2030"
      };
    }

    const path = this.config.paymentMethodPath || "/payment-methods/attach";
    const res = await postJson(this.config, path, {
      customerId: providerCustomerId,
      xToken: paymentToken,
      paymentToken
    });

    return {
      providerPaymentMethodId: String(res.paymentMethodId || res.id || res.xToken || paymentToken),
      brand: res.brand ? String(res.brand) : undefined,
      last4: res.last4 ? String(res.last4) : undefined,
      expMonth: res.expMonth ? String(res.expMonth) : undefined,
      expYear: res.expYear ? String(res.expYear) : undefined
    };
  }

  async createSubscription(providerCustomerId: string, providerPaymentMethodId: string, planCode: string, amountCents: number): Promise<{ providerSubscriptionId: string; currentPeriodStart?: Date; currentPeriodEnd?: Date }> {
    if (this.config.simulate) {
      const start = new Date();
      const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
      return {
        providerSubscriptionId: `sim_sub_${providerCustomerId}`,
        currentPeriodStart: start,
        currentPeriodEnd: end
      };
    }

    const path = this.config.subscriptionPath || "/subscriptions";
    const res = await postJson(this.config, path, {
      customerId: providerCustomerId,
      paymentMethodId: providerPaymentMethodId,
      xToken: providerPaymentMethodId,
      planCode,
      amountCents,
      xAmount: (amountCents / 100).toFixed(2)
    });

    return {
      providerSubscriptionId: String(res.subscriptionId || res.recurringId || res.id || res.xRecurringRef || ""),
      currentPeriodStart: res.currentPeriodStart ? new Date(res.currentPeriodStart) : undefined,
      currentPeriodEnd: res.currentPeriodEnd ? new Date(res.currentPeriodEnd) : undefined
    };
  }

  async chargeSubscription(providerSubscriptionId: string): Promise<{ status: "SUCCEEDED" | "FAILED"; amountCents?: number }> {
    if (this.config.simulate) return { status: "SUCCEEDED", amountCents: 1000 };

    const path = this.config.chargePath || "/subscriptions/charge";
    const res = await postJson(this.config, path, {
      subscriptionId: providerSubscriptionId,
      xRefnum: providerSubscriptionId
    });

    const status = derivePaymentStatus(res) === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
    return {
      status,
      amountCents: parseAmountCents(res.amountCents ?? res.xAuthAmount ?? res.xAmount)
    };
  }

  async cancelSubscription(providerSubscriptionId: string, cancelAtPeriodEnd: boolean): Promise<{ success: boolean }> {
    if (this.config.simulate) return { success: true };

    const path = this.config.cancelPath || "/subscriptions/cancel";
    await postJson(this.config, path, {
      subscriptionId: providerSubscriptionId,
      cancelAtPeriodEnd
    });
    return { success: true };
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): boolean {
    if (this.config.simulate) return true;
    if (!this.config.webhookSecret) return false;

    const mode = this.config.webhookVerifyMode || "shared_secret";
    if (mode === "none") return true;

    const signatureHeader = this.config.webhookSignatureHeader || "x-sola-signature";
    const timestampHeader = this.config.webhookTimestampHeader || "x-sola-timestamp";
    const signature = getHeader(headers, signatureHeader);

    if (!signature || !rawBody) return false;

    if (mode === "shared_secret") {
      return safeEquals(signature, String(this.config.webhookSecret));
    }

    const timestamp = getHeader(headers, timestampHeader);
    const source = timestamp ? `${timestamp}.${rawBody}` : rawBody;
    const digestHex = createHmac("sha256", String(this.config.webhookSecret)).update(source).digest("hex");
    const digestBase64 = createHmac("sha256", String(this.config.webhookSecret)).update(source).digest("base64");

    return safeEquals(signature, digestHex) || safeEquals(signature, digestBase64);
  }

  parseWebhookEvent(rawBody: string): SolaWebhookEvent {
    const parsed = JSON.parse(rawBody || "{}");

    return {
      eventId: parsed.eventId || parsed.id || parsed.xRefnum,
      type: String(parsed.type || parsed.eventType || parsed.xCommand || parsed.xStatus || "unknown"),
      status: derivePaymentStatus(parsed),
      amountCents: parseAmountCents(parsed.amountCents ?? parsed.xAuthAmount ?? parsed.xAmount),
      currency: parsed.currency ? String(parsed.currency) : parsed.xCurrency ? String(parsed.xCurrency) : "USD",
      providerCustomerId: parsed.customerId ? String(parsed.customerId) : parsed.customerID ? String(parsed.customerID) : parsed.xCustomer ? String(parsed.xCustomer) : undefined,
      providerSubscriptionId: parsed.subscriptionId ? String(parsed.subscriptionId) : parsed.recurringId ? String(parsed.recurringId) : parsed.xRecurringRef ? String(parsed.xRecurringRef) : undefined,
      payload: parsed
    };
  }
}

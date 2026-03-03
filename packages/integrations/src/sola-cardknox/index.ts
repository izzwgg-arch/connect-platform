import { createHmac, timingSafeEqual } from "crypto";

export type SolaCardknoxAuthMode = "xkey_body" | "authorization_header";

export type SolaCardknoxConfig = {
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  webhookSecret?: string;
  mode?: "sandbox" | "prod";
  simulate?: boolean;
  authMode?: SolaCardknoxAuthMode;
  authHeaderName?: string;
  customerPath?: string;
  subscriptionPath?: string;
  transactionPath?: string;
  hostedSessionPath?: string;
  chargePath?: string;
  cancelPath?: string;
  webhookSignatureHeader?: string;
  webhookTimestampHeader?: string;
};

export type HostedCheckoutInput = {
  tenantId: string;
  subscriptionId: string;
  planCode: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
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

function ensureConfigured(config: SolaCardknoxConfig) {
  if (!config.baseUrl || !config.apiKey) {
    const err: any = new Error("NOT_CONFIGURED");
    err.code = "NOT_CONFIGURED";
    throw err;
  }
}

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function getHeader(headers: Record<string, string | string[] | undefined>, key: string): string {
  const val = headers[key.toLowerCase()] ?? headers[key];
  return Array.isArray(val) ? String(val[0] || "") : String(val || "");
}

function parseAmountCents(v: any): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return v > 1000 ? Math.round(v) : Math.round(v * 100);
  const s = String(v).trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s) && s.length > 2) return Number(s);
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 100);
}

function toStatus(payload: any): "PENDING" | "SUCCEEDED" | "FAILED" {
  const xResult = String(payload?.xResult || "").toUpperCase();
  if (xResult === "A") return "SUCCEEDED";
  if (xResult === "D" || xResult === "E") return "FAILED";

  const s = String(payload?.status || payload?.paymentStatus || payload?.xStatus || "").toUpperCase();
  if (["SUCCEEDED", "SUCCESS", "APPROVED", "PAID", "SETTLED", "16"].includes(s)) return "SUCCEEDED";
  if (["FAILED", "DECLINED", "ERROR", "REJECTED", "CHARGEBACK", "RETURNED", "14", "18", "20"].includes(s)) return "FAILED";
  return "PENDING";
}

async function postJson(config: SolaCardknoxConfig, path: string, body: Record<string, any>): Promise<any> {
  if (config.simulate) {
    return {
      xResult: "A",
      hostedUrl: `${body.successUrl || "https://app.connectcomunications.com/dashboard/billing?checkout=success"}`,
      id: `sim_${Date.now()}`,
      ...body
    };
  }

  ensureConfigured(config);

  const authMode = config.authMode || "xkey_body";
  const headers: Record<string, string> = { "content-type": "application/json" };
  const reqBody: Record<string, any> = { ...body };

  if (authMode === "authorization_header") {
    const authHeaderName = String(config.authHeaderName || "authorization").trim();
    const token = config.apiSecret ? `${config.apiKey}:${config.apiSecret}` : String(config.apiKey);
    headers[authHeaderName] = token;
  } else {
    reqBody.xKey = config.apiKey;
    if (config.apiSecret) reqBody.xSecret = config.apiSecret;
  }

  const res = await fetch(`${String(config.baseUrl).replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`, {
    method: "POST",
    headers,
    body: JSON.stringify(reqBody),
    signal: timeoutSignal(10000)
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error("SOLA_REQUEST_FAILED");
    err.code = "SOLA_REQUEST_FAILED";
    err.httpStatus = res.status;
    throw err;
  }
  if (toStatus(payload) === "FAILED") {
    const err: any = new Error("SOLA_DECLINED");
    err.code = "SOLA_DECLINED";
    throw err;
  }
  return payload;
}

export class SolaCardknoxAdapter {
  private config: SolaCardknoxConfig;

  constructor(config: SolaCardknoxConfig) {
    this.config = config;
  }

  async testConnection(): Promise<{ ok: boolean; simulated: boolean }> {
    if (this.config.simulate) return { ok: true, simulated: true };

    const path = this.config.transactionPath || this.config.subscriptionPath || this.config.customerPath || this.config.hostedSessionPath || "/hosted-checkout/sessions";
    await postJson(this.config, path, {
      validateOnly: true,
      action: "ping",
      xAmount: "0.00",
      amountCents: 0,
      successUrl: "https://app.connectcomunications.com/dashboard/billing?validate=success",
      cancelUrl: "https://app.connectcomunications.com/dashboard/billing?validate=cancel"
    });
    return { ok: true, simulated: false };
  }

  async createHostedSession(input: HostedCheckoutInput): Promise<{ redirectUrl: string; providerSessionId?: string }> {
    const path = this.config.hostedSessionPath || "/hosted-checkout/sessions";
    const res = await postJson(this.config, path, {
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      planCode: input.planCode,
      amountCents: input.amountCents,
      xAmount: (input.amountCents / 100).toFixed(2),
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl
    });

    return {
      redirectUrl: String(res.redirectUrl || res.hostedUrl || input.successUrl),
      providerSessionId: res.sessionId ? String(res.sessionId) : res.xRefnum ? String(res.xRefnum) : undefined
    };
  }

  async chargeSubscription(providerSubscriptionId: string, amountCents: number): Promise<{ status: "SUCCEEDED" | "FAILED"; amountCents?: number }> {
    const path = this.config.chargePath || "/subscriptions/charge";
    const res = await postJson(this.config, path, {
      subscriptionId: providerSubscriptionId,
      xRefnum: providerSubscriptionId,
      amountCents,
      xAmount: (amountCents / 100).toFixed(2)
    });
    const status = toStatus(res) === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
    return { status, amountCents: parseAmountCents(res.amountCents ?? res.xAuthAmount ?? res.xAmount) };
  }

  async cancelSubscription(providerSubscriptionId: string, cancelAtPeriodEnd: boolean): Promise<{ success: boolean }> {
    const path = this.config.cancelPath || "/subscriptions/cancel";
    await postJson(this.config, path, { subscriptionId: providerSubscriptionId, cancelAtPeriodEnd });
    return { success: true };
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): boolean {
    if (!this.config.webhookSecret) return false;

    const signatureHeader = this.config.webhookSignatureHeader || "x-sola-signature";
    const timestampHeader = this.config.webhookTimestampHeader || "x-sola-timestamp";
    const signature = getHeader(headers, signatureHeader);
    const tsRaw = getHeader(headers, timestampHeader);

    if (!signature || !tsRaw || !rawBody) return false;
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts)) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > 300) return false;

    const source = `${tsRaw}.${rawBody}`;
    const hex = createHmac("sha256", String(this.config.webhookSecret)).update(source).digest("hex");
    const b64 = createHmac("sha256", String(this.config.webhookSecret)).update(source).digest("base64");
    return safeEquals(signature, hex) || safeEquals(signature, b64);
  }

  parseWebhookEvent(rawBody: string): SolaWebhookEvent {
    const parsed = JSON.parse(rawBody || "{}");
    return {
      eventId: parsed.eventId || parsed.id || parsed.xRefnum,
      type: String(parsed.type || parsed.eventType || parsed.xCommand || parsed.xStatus || "unknown"),
      status: toStatus(parsed),
      amountCents: parseAmountCents(parsed.amountCents ?? parsed.xAuthAmount ?? parsed.xAmount),
      currency: parsed.currency ? String(parsed.currency) : parsed.xCurrency ? String(parsed.xCurrency) : "USD",
      providerCustomerId: parsed.customerId ? String(parsed.customerId) : parsed.customerID ? String(parsed.customerID) : parsed.xCustomer ? String(parsed.xCustomer) : undefined,
      providerSubscriptionId: parsed.subscriptionId ? String(parsed.subscriptionId) : parsed.recurringId ? String(parsed.recurringId) : parsed.xRecurringRef ? String(parsed.xRecurringRef) : undefined,
      payload: parsed
    };
  }
}

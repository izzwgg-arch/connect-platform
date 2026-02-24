export type SolaCardknoxConfig = {
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  webhookSecret?: string;
  mode?: "sandbox" | "prod";
  simulate?: boolean;
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

async function postJson(config: SolaCardknoxConfig, path: string, body: Record<string, any>): Promise<any> {
  if (config.simulate) {
    return { ok: true, id: `sim_${path.replace(/\W+/g, "_")}_${Date.now()}`, ...body };
  }

  if (notConfigured(config)) {
    const err: any = new Error("NOT_CONFIGURED");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": String(config.apiKey)
  };
  if (config.apiSecret) headers["x-api-secret"] = String(config.apiSecret);

  const res = await fetch(`${String(config.baseUrl).replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: timeoutSignal(10000)
  });
  if (!res.ok) {
    const err: any = new Error("SOLA_REQUEST_FAILED");
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
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
    const res = await postJson(this.config, "/customers", {
      email: input.billingEmail,
      tenantId: input.tenantId,
      name: input.tenantName || input.tenantId
    });
    return { providerCustomerId: String(res.customerId || res.id || "") };
  }

  async attachPaymentMethod(providerCustomerId: string, paymentToken: string): Promise<{ providerPaymentMethodId: string; brand?: string; last4?: string; expMonth?: string; expYear?: string }> {
    if (this.config.simulate) {
      return { providerPaymentMethodId: `sim_pm_${providerCustomerId}`, brand: "SIM", last4: "4242", expMonth: "12", expYear: "2030" };
    }
    const res = await postJson(this.config, "/payment-methods/attach", {
      customerId: providerCustomerId,
      paymentToken
    });
    return {
      providerPaymentMethodId: String(res.paymentMethodId || res.id || ""),
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
      return { providerSubscriptionId: `sim_sub_${providerCustomerId}`, currentPeriodStart: start, currentPeriodEnd: end };
    }
    const res = await postJson(this.config, "/subscriptions", {
      customerId: providerCustomerId,
      paymentMethodId: providerPaymentMethodId,
      planCode,
      amountCents
    });
    return {
      providerSubscriptionId: String(res.subscriptionId || res.id || ""),
      currentPeriodStart: res.currentPeriodStart ? new Date(res.currentPeriodStart) : undefined,
      currentPeriodEnd: res.currentPeriodEnd ? new Date(res.currentPeriodEnd) : undefined
    };
  }

  async chargeSubscription(providerSubscriptionId: string): Promise<{ status: "SUCCEEDED" | "FAILED"; amountCents?: number }> {
    if (this.config.simulate) return { status: "SUCCEEDED", amountCents: 1000 };
    const res = await postJson(this.config, "/subscriptions/charge", { subscriptionId: providerSubscriptionId });
    return { status: String(res.status || "FAILED").toUpperCase() === "SUCCEEDED" ? "SUCCEEDED" : "FAILED", amountCents: res.amountCents ? Number(res.amountCents) : undefined };
  }

  async cancelSubscription(providerSubscriptionId: string, cancelAtPeriodEnd: boolean): Promise<{ success: boolean }> {
    if (this.config.simulate) return { success: true };
    await postJson(this.config, "/subscriptions/cancel", {
      subscriptionId: providerSubscriptionId,
      cancelAtPeriodEnd
    });
    return { success: true };
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): boolean {
    if (this.config.simulate) return true;
    if (!this.config.webhookSecret) return false;
    const sigHeader = headers["x-sola-signature"];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    return sig === this.config.webhookSecret && rawBody.length > 0;
  }

  parseWebhookEvent(rawBody: string): SolaWebhookEvent {
    const parsed = JSON.parse(rawBody || "{}");
    return {
      eventId: parsed.eventId || parsed.id,
      type: String(parsed.type || "unknown"),
      status: String(parsed.status || "PENDING").toUpperCase() as "PENDING" | "SUCCEEDED" | "FAILED",
      amountCents: parsed.amountCents ? Number(parsed.amountCents) : undefined,
      currency: parsed.currency ? String(parsed.currency) : undefined,
      providerCustomerId: parsed.customerId ? String(parsed.customerId) : undefined,
      providerSubscriptionId: parsed.subscriptionId ? String(parsed.subscriptionId) : undefined,
      payload: parsed
    };
  }
}

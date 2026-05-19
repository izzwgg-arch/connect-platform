/**
 * Sola/Cardknox Customer & Recurring API v2 (https://api.cardknox.com/v2).
 * Read-only listing for external schedule import — never log apiKey or Token values.
 */

export const SOLA_RECURRING_API_BASE = "https://api.cardknox.com/v2";
export const SOLA_RECURRING_SOFTWARE_NAME = "Connect Communications";
export const SOLA_RECURRING_SOFTWARE_VERSION = "1.0";

export type SolaRecurringClientConfig = {
  apiKey: string;
  baseUrl?: string;
  simulate?: boolean;
};

export type SolaRecurringListResult<T> = {
  items: T[];
  nextToken?: string;
  refNum?: string;
};

export type SolaRecurringScheduleRow = Record<string, unknown>;
export type SolaRecurringPaymentMethodRow = Record<string, unknown>;

const SENSITIVE_RECURRING_KEYS = new Set([
  "token",
  "xtoken",
  "xsut",
  "sut",
  "xcardnum",
  "xcvv",
  "xmagstripe",
  "xtokeninput",
  "cardnumber",
  "cvv",
  "pan",
  "apikey",
  "xkey",
  "authorization",
]);

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/** Redact vault tokens and card data from recurring API payloads before persistence. */
export function redactSolaRecurringPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (SENSITIVE_RECURRING_KEYS.has(key.toLowerCase())) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactSolaRecurringPayload(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === "object" ? redactSolaRecurringPayload(item as Record<string, unknown>) : item,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

function recurringBaseUrl(config: SolaRecurringClientConfig): string {
  const raw = String(config.baseUrl || "").trim();
  return (raw || SOLA_RECURRING_API_BASE).replace(/\/$/, "");
}

async function postRecurringJson<T extends Record<string, unknown>>(
  config: SolaRecurringClientConfig,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<T> {
  if (config.simulate) {
    return { Result: "S", RefNum: `sim_${Date.now()}`, Error: "", ...body } as unknown as T;
  }
  if (!config.apiKey) {
    const err: Error & { code?: string } = new Error("SOLA_RECURRING_NOT_CONFIGURED");
    err.code = "SOLA_RECURRING_NOT_CONFIGURED";
    throw err;
  }

  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const res = await fetch(`${recurringBaseUrl(config)}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: config.apiKey,
      "x-recurring-api-version": "2.1",
    },
    body: JSON.stringify({
      SoftwareName: SOLA_RECURRING_SOFTWARE_NAME,
      SoftwareVersion: SOLA_RECURRING_SOFTWARE_VERSION,
      ...body,
    }),
    signal: timeoutSignal(20_000),
  });

  const payload = (await res.json().catch(() => ({}))) as T;
  const result = String((payload as Record<string, unknown>).Result || "").toUpperCase();
  if (!res.ok || result === "E") {
    const err: Error & { code?: string; solaError?: string } = new Error("SOLA_RECURRING_REQUEST_FAILED");
    err.code = "SOLA_RECURRING_REQUEST_FAILED";
    err.solaError = String((payload as Record<string, unknown>).Error || `HTTP ${res.status}`);
    throw err;
  }
  return payload;
}

export class SolaRecurringClient {
  private config: SolaRecurringClientConfig;

  constructor(config: SolaRecurringClientConfig) {
    this.config = config;
  }

  async listSchedules(input?: {
    pageSize?: number;
    nextToken?: string;
    filters?: Record<string, unknown>;
  }): Promise<SolaRecurringListResult<SolaRecurringScheduleRow>> {
    if (this.config.simulate) {
      return {
        items: [
          {
            ScheduleId: "c_sim_s001",
            CustomerId: "c_sim_001",
            PaymentMethodId: "c_sim_001_pm001",
            Amount: 49.99,
            IntervalType: "month",
            IntervalCount: 1,
            IsActive: true,
            NextScheduledRunTime: "2026-06-01",
            Email: "billing@example.com",
            BillFirstName: "Jane",
            BillLastName: "Doe",
            BillCompany: "Acme Voice LLC",
            LastTransactionStatus: "Approved",
          },
        ],
        nextToken: undefined,
        refNum: "sim_ref",
      };
    }

    const payload = await postRecurringJson<Record<string, unknown>>(this.config, "/ListSchedules", {
      PageSize: input?.pageSize ?? 100,
      NextToken: input?.nextToken || "",
      Filters: input?.filters ?? { IsDeleted: false },
    });

    const schedules = Array.isArray(payload.Schedules) ? (payload.Schedules as SolaRecurringScheduleRow[]) : [];
    const nextToken = payload.NextToken ? String(payload.NextToken) : undefined;
    return { items: schedules, nextToken, refNum: payload.RefNum ? String(payload.RefNum) : undefined };
  }

  async getSchedule(scheduleId: string): Promise<SolaRecurringScheduleRow> {
    if (this.config.simulate) {
      return {
        ScheduleId: scheduleId,
        CustomerId: "c_sim_001",
        PaymentMethodId: "c_sim_001_pm001",
        Amount: 49.99,
        IntervalType: "month",
        IntervalCount: 1,
        IsActive: true,
        NextScheduledRunTime: "2026-06-01",
        Email: "billing@example.com",
        BillFirstName: "Jane",
        BillLastName: "Doe",
        BillCompany: "Acme Voice LLC",
      };
    }

    const payload = await postRecurringJson<Record<string, unknown>>(this.config, "/GetSchedule", {
      ScheduleId: scheduleId,
      ShowDeleted: false,
    });
    return payload as SolaRecurringScheduleRow;
  }

  /**
   * Masked card metadata only — caller must not persist Token from the response.
   */
  async getPaymentMethodMasked(paymentMethodId: string): Promise<SolaRecurringPaymentMethodRow> {
    if (this.config.simulate) {
      return {
        PaymentMethodId: paymentMethodId,
        TokenType: "cc",
        Issuer: "Visa",
        MaskedCardNumber: "4xxxxxxxxxxx4242",
        Exp: "1228",
        Token: "sim_token_redacted_at_service",
      };
    }

    const payload = await postRecurringJson<Record<string, unknown>>(this.config, "/GetPaymentMethod", {
      PaymentMethodId: paymentMethodId,
      ShowDeleted: false,
    });
    return payload as SolaRecurringPaymentMethodRow;
  }

  /**
   * Retrieve the reusable vault Token for server-side token linking (Phase A cutover).
   * NEVER log or return the token to the browser. Caller must encrypt immediately.
   * Returns { token: string, issuer, maskedCardNumber, exp } — raw Token is included.
   */
  async getPaymentMethodWithToken(paymentMethodId: string): Promise<{
    token: string;
    issuer: string | null;
    maskedCardNumber: string | null;
    exp: string | null;
    rawRow: SolaRecurringPaymentMethodRow;
  }> {
    if (this.config.simulate) {
      return {
        token: "sim_reusable_token_abc123",
        issuer: "Visa",
        maskedCardNumber: "4xxxxxxxxxxx4242",
        exp: "1228",
        rawRow: {
          PaymentMethodId: paymentMethodId,
          TokenType: "cc",
          Issuer: "Visa",
          MaskedCardNumber: "4xxxxxxxxxxx4242",
          Exp: "1228",
          Token: "sim_reusable_token_abc123",
        },
      };
    }

    const payload = await postRecurringJson<Record<string, unknown>>(this.config, "/GetPaymentMethod", {
      PaymentMethodId: paymentMethodId,
      ShowDeleted: false,
    });

    const token = String(payload.Token || "").trim();
    if (!token) {
      const err: Error & { code?: string } = new Error("SOLA_RECURRING_TOKEN_MISSING");
      err.code = "SOLA_RECURRING_TOKEN_MISSING";
      throw err;
    }

    return {
      token,
      issuer: payload.Issuer ? String(payload.Issuer) : null,
      maskedCardNumber: payload.MaskedCardNumber ? String(payload.MaskedCardNumber) : null,
      exp: payload.Exp ? String(payload.Exp) : null,
      rawRow: payload as SolaRecurringPaymentMethodRow,
    };
  }

  /**
   * Retrieve a customer record. The response includes a PaymentMethods array
   * which is the authoritative source for the vault token when schedules do not
   * carry a PaymentMethodId directly (common in Cardknox recurring v2).
   */
  async getCustomer(customerId: string): Promise<Record<string, unknown>> {
    if (this.config.simulate) {
      return {
        CustomerId: customerId,
        BillFirstName: "Sim",
        BillLastName: "Customer",
        PaymentMethods: [
          {
            PaymentMethodId: `${customerId}_pm001`,
            TokenType: "cc",
            Issuer: "Visa",
            MaskedCardNumber: "4xxxxxxxxxxx4242",
            Exp: "1228",
          },
        ],
      };
    }

    const payload = await postRecurringJson<Record<string, unknown>>(this.config, "/GetCustomer", {
      CustomerId: customerId,
    });
    return payload as Record<string, unknown>;
  }

  /**
   * Disable or re-enable a recurring schedule (Phase C cutover).
   * Pass isActive: false to disable the old schedule before enabling Connect autopay.
   */
  async updateSchedule(scheduleId: string, update: { isActive: boolean }): Promise<{ ok: boolean; refNum?: string }> {
    if (this.config.simulate) {
      return { ok: true, refNum: `sim_upd_${Date.now()}` };
    }

    const payload = await postRecurringJson<Record<string, unknown>>(this.config, "/UpdateSchedule", {
      ScheduleId: scheduleId,
      IsActive: update.isActive,
    });

    const result = String((payload as Record<string, unknown>).Result || "").toUpperCase();
    if (result === "E") {
      const err: Error & { code?: string; solaError?: string } = new Error("SOLA_RECURRING_UPDATE_FAILED");
      err.code = "SOLA_RECURRING_UPDATE_FAILED";
      err.solaError = String((payload as Record<string, unknown>).Error || "update_failed");
      throw err;
    }

    return {
      ok: result === "S" || result === "A" || result === "",
      refNum: payload.RefNum ? String(payload.RefNum) : undefined,
    };
  }
}

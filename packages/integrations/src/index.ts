export interface NumberSearchInput {
  type: "local" | "tollfree";
  areaCode?: string;
  contains?: string;
  limit?: number;
}

export interface NumberSearchResult {
  phoneNumber: string;
  region?: string;
  capabilities?: { sms?: boolean; mms?: boolean; voice?: boolean };
  monthlyCostCents?: number;
  providerMeta?: Record<string, unknown>;
}

export interface NumberPurchaseInput {
  phoneNumber: string;
}

export interface NumberPurchaseResult {
  providerId: string;
  phoneNumber: string;
  capabilities?: { sms?: boolean; mms?: boolean; voice?: boolean };
  monthlyCostCents?: number;
}

export interface NumberProvider {
  searchNumbers(input: NumberSearchInput): Promise<NumberSearchResult[]>;
  purchaseNumber(input: NumberPurchaseInput): Promise<NumberPurchaseResult>;
  releaseNumber(input: { providerId?: string; phoneNumber?: string }): Promise<{ success: boolean }>;
}

export interface SmsSendInput {
  tenantId: string;
  to: string;
  from: string;
  body: string;
  idempotencyKey?: string;
}

export interface SmsProvider {
  sendMessage(input: SmsSendInput): Promise<{ status: string; providerMessageId?: string; providerStatus?: string }>;
}

export interface PbxProvider {
  provisionExtension(input: { tenantId: string; extension: string; displayName: string }): Promise<{ status: string }>;
  provisionDid(input: { tenantId: string; did: string }): Promise<{ status: string }>;
  fetchCdr(input: { tenantId: string; from: string; to: string }): Promise<Array<Record<string, unknown>>>;
}

export type TwilioCredentials = {
  accountSid: string;
  authToken: string;
  messagingServiceSid?: string;
  fromNumber?: string;
};

export type VoipMsCredentials = {
  username: string;
  password: string;
  fromNumber: string;
  apiBaseUrl?: string;
};

export type NormalizedProviderError = {
  code: "TEMP_RATE_LIMIT" | "TEMP_PROVIDER_DOWN" | "TEMP_CARRIER" | "PERM_INVALID_NUMBER" | "PERM_OPTED_OUT" | "PERM_POLICY";
  retryable: boolean;
  humanMessage: string;
};

const VOIPMS_DEFAULT_BASE = "https://voip.ms/api/v1/rest.php";

function makeDeterministicNumbers(prefix: string, areaCode?: string, limit = 5): NumberSearchResult[] {
  const ac = (areaCode || "305").replace(/[^0-9]/g, "").slice(0, 3) || "305";
  const out: NumberSearchResult[] = [];
  for (let i = 0; i < Math.min(limit, 20); i += 1) {
    const suffix = String(1000 + i);
    out.push({
      phoneNumber: `+1${ac}555${suffix}`,
      region: prefix,
      capabilities: { sms: true, mms: false, voice: true },
      monthlyCostCents: 150,
      providerMeta: { simulated: true }
    });
  }
  return out;
}

export class TwilioNumberProvider implements NumberProvider {
  private client: any;
  private credentials: TwilioCredentials;
  private testMode: boolean;

  constructor(credentials: TwilioCredentials, testMode = true) {
    this.credentials = credentials;
    this.testMode = testMode;
    if (!credentials.accountSid || !credentials.authToken) {
      throw new Error("Twilio credentials are incomplete");
    }
    if (!this.testMode) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const twilio = require("twilio");
      this.client = twilio(credentials.accountSid, credentials.authToken);
    }
  }

  async searchNumbers(input: NumberSearchInput): Promise<NumberSearchResult[]> {
    const lim = Math.min(Math.max(input.limit || 20, 1), 50);
    if ((process.env.SIMULATE_NUMBER_PROVIDER || "false").toLowerCase() === "true" || this.testMode) {
      return makeDeterministicNumbers("US", input.areaCode, lim);
    }

    try {
      let list: any[] = [];
      if (input.type === "tollfree") {
        list = await this.client.availablePhoneNumbers("US").tollFree.list({ limit: lim, contains: input.contains || undefined });
      } else {
        list = await this.client.availablePhoneNumbers("US").local.list({
          limit: lim,
          areaCode: input.areaCode ? Number(input.areaCode) : undefined,
          contains: input.contains || undefined
        });
      }

      return list.map((n: any) => ({
        phoneNumber: String(n.phoneNumber),
        region: String(n.region || "US"),
        capabilities: { sms: !!n.capabilities?.SMS, mms: !!n.capabilities?.MMS, voice: !!n.capabilities?.voice },
        monthlyCostCents: undefined,
        providerMeta: { isoCountry: n.isoCountry, beta: !!n.beta }
      }));
    } catch (e: any) {
      e.provider = "TWILIO";
      throw e;
    }
  }

  async purchaseNumber(input: NumberPurchaseInput): Promise<NumberPurchaseResult> {
    if ((process.env.SIMULATE_NUMBER_PROVIDER || "false").toLowerCase() === "true" || this.testMode) {
      return {
        providerId: `SIM_TWILIO_${input.phoneNumber.replace(/\D/g, "")}`,
        phoneNumber: input.phoneNumber,
        capabilities: { sms: true, mms: false, voice: true },
        monthlyCostCents: 150
      };
    }

    try {
      const created = await this.client.incomingPhoneNumbers.create({ phoneNumber: input.phoneNumber });
      return {
        providerId: String(created.sid),
        phoneNumber: String(created.phoneNumber || input.phoneNumber),
        capabilities: { sms: true, mms: false, voice: true }
      };
    } catch (e: any) {
      e.provider = "TWILIO";
      throw e;
    }
  }

  async releaseNumber(input: { providerId?: string; phoneNumber?: string }): Promise<{ success: boolean }> {
    if ((process.env.SIMULATE_NUMBER_PROVIDER || "false").toLowerCase() === "true" || this.testMode) {
      return { success: true };
    }

    if (!input.providerId) throw new Error("providerId_required");
    try {
      await this.client.incomingPhoneNumbers(input.providerId).remove();
      return { success: true };
    } catch (e: any) {
      e.provider = "TWILIO";
      throw e;
    }
  }
}

export class VoipMsNumberProvider implements NumberProvider {
  private credentials: VoipMsCredentials;
  private testMode: boolean;

  constructor(credentials: VoipMsCredentials, testMode = true) {
    this.credentials = credentials;
    this.testMode = testMode;
    if (!credentials.username || !credentials.password) {
      throw new Error("VoIP.ms credentials are incomplete");
    }
  }

  async searchNumbers(input: NumberSearchInput): Promise<NumberSearchResult[]> {
    if ((process.env.SIMULATE_NUMBER_PROVIDER || "false").toLowerCase() === "true" || this.testMode) {
      return makeDeterministicNumbers("US", input.areaCode, Math.min(Math.max(input.limit || 20, 1), 50));
    }

    const err: any = new Error("VoIP.ms number search not available yet");
    err.code = "VOIPMS_NUMBER_SEARCH_UNAVAILABLE";
    err.provider = "VOIPMS";
    throw err;
  }

  async purchaseNumber(input: NumberPurchaseInput): Promise<NumberPurchaseResult> {
    if ((process.env.SIMULATE_NUMBER_PROVIDER || "false").toLowerCase() === "true" || this.testMode) {
      return {
        providerId: `SIM_VOIPMS_${input.phoneNumber.replace(/\D/g, "")}`,
        phoneNumber: input.phoneNumber,
        capabilities: { sms: true, mms: false, voice: true },
        monthlyCostCents: 125
      };
    }

    const err: any = new Error("VoIP.ms number purchase not available yet");
    err.code = "VOIPMS_NUMBER_PURCHASE_UNAVAILABLE";
    err.provider = "VOIPMS";
    throw err;
  }

  async releaseNumber(_input: { providerId?: string; phoneNumber?: string }): Promise<{ success: boolean }> {
    if ((process.env.SIMULATE_NUMBER_PROVIDER || "false").toLowerCase() === "true" || this.testMode) {
      return { success: true };
    }

    const err: any = new Error("VoIP.ms number release not available yet");
    err.code = "VOIPMS_NUMBER_RELEASE_UNAVAILABLE";
    err.provider = "VOIPMS";
    throw err;
  }
}

export class FakeNumberProvider implements NumberProvider {
  async searchNumbers(input: NumberSearchInput): Promise<NumberSearchResult[]> {
    return makeDeterministicNumbers("US", input.areaCode, Math.min(Math.max(input.limit || 20, 1), 50));
  }

  async purchaseNumber(input: NumberPurchaseInput): Promise<NumberPurchaseResult> {
    return {
      providerId: `fake-number-${input.phoneNumber.replace(/\D/g, "")}`,
      phoneNumber: input.phoneNumber,
      capabilities: { sms: true, mms: false, voice: true },
      monthlyCostCents: 100
    };
  }

  async releaseNumber(_input: { providerId?: string; phoneNumber?: string }): Promise<{ success: boolean }> {
    return { success: true };
  }
}

export class FakeSmsProvider implements SmsProvider {
  async sendMessage(input: SmsSendInput): Promise<{ status: string; providerMessageId: string; providerStatus: string }> {
    const providerMessageId = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[FakeSmsProvider] tenant=${input.tenantId} from=${input.from} to=${input.to}`);
    return { status: "SENT", providerMessageId, providerStatus: "simulated" };
  }
}

export class TwilioSmsProvider implements SmsProvider {
  private client: any;
  private credentials: TwilioCredentials;
  private testMode: boolean;

  constructor(credentials: TwilioCredentials, testMode = true) {
    this.credentials = credentials;
    this.testMode = testMode;

    if (!credentials.accountSid || !credentials.authToken) {
      throw new Error("Twilio credentials are incomplete");
    }

    if (!this.testMode) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const twilio = require("twilio");
      this.client = twilio(credentials.accountSid, credentials.authToken);
    }
  }

  async sendMessage(input: SmsSendInput): Promise<{ status: string; providerMessageId?: string; providerStatus?: string }> {
    if ((process.env.SIMULATE_PROVIDER_FAILURE_TWILIO || "false").toLowerCase() === "true") {
      const err: any = new Error("Simulated Twilio provider outage");
      err.provider = "TWILIO";
      err.status = 503;
      err.code = "SIM_TWILIO_DOWN";
      throw err;
    }

    if (this.testMode) {
      return {
        status: "SENT",
        providerMessageId: `twilio-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        providerStatus: "queued"
      };
    }

    const payload: Record<string, string> = { to: input.to, body: input.body };
    if (this.credentials.messagingServiceSid) payload.messagingServiceSid = this.credentials.messagingServiceSid;
    else if (this.credentials.fromNumber) payload.from = this.credentials.fromNumber;
    else payload.from = input.from;

    try {
      const res = await this.client.messages.create(payload);
      return { status: "SENT", providerMessageId: res.sid, providerStatus: String(res.status || "sent") };
    } catch (e: any) {
      e.provider = "TWILIO";
      throw e;
    }
  }
}

export class VoipMsSmsProvider implements SmsProvider {
  private credentials: VoipMsCredentials;
  private testMode: boolean;

  constructor(credentials: VoipMsCredentials, testMode = true) {
    this.credentials = credentials;
    this.testMode = testMode;
    if (!credentials.username || !credentials.password || !credentials.fromNumber) throw new Error("VoIP.ms credentials are incomplete");
  }

  async sendMessage(input: SmsSendInput): Promise<{ status: string; providerMessageId?: string; providerStatus?: string }> {
    if ((process.env.SIMULATE_PROVIDER_FAILURE_VOIPMS || "false").toLowerCase() === "true") {
      const err: any = new Error("Simulated VoIP.ms provider outage");
      err.provider = "VOIPMS";
      err.status = 503;
      err.code = "SIM_VOIPMS_DOWN";
      throw err;
    }

    if (this.testMode) {
      return {
        status: "SENT",
        providerMessageId: `voipms-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        providerStatus: "accepted"
      };
    }

    const base = this.credentials.apiBaseUrl || VOIPMS_DEFAULT_BASE;
    const url = new URL(base);
    url.searchParams.set("api_username", this.credentials.username);
    url.searchParams.set("api_password", this.credentials.password);
    url.searchParams.set("method", "sendSMS");
    url.searchParams.set("did", this.credentials.fromNumber || input.from);
    url.searchParams.set("dst", input.to);
    url.searchParams.set("message", input.body);

    try {
      const res = await fetch(url.toString(), { method: "GET" });
      const json: any = await res.json().catch(() => ({}));
      const status = String(json.status || "").toLowerCase();
      if (!res.ok || status !== "success") {
        const err: any = new Error("VoIP.ms send failed");
        err.provider = "VOIPMS";
        err.status = res.status;
        err.code = json.response?.code || json.code || "VOIPMS_SEND_FAILED";
        throw err;
      }
      return {
        status: "SENT",
        providerMessageId: String(json.sms || json.id || `voipms-${Date.now()}`),
        providerStatus: "sent"
      };
    } catch (e: any) {
      e.provider = "VOIPMS";
      throw e;
    }
  }
}

export async function validateTwilioCredentials(credentials: TwilioCredentials): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require("twilio");
    const client = twilio(credentials.accountSid, credentials.authToken);

    await client.api.accounts(credentials.accountSid).fetch();

    if (credentials.messagingServiceSid) {
      await client.messaging.v1.services(credentials.messagingServiceSid).fetch();
    }

    if (credentials.fromNumber) {
      const list = await client.incomingPhoneNumbers.list({ phoneNumber: credentials.fromNumber, limit: 1 });
      if (!Array.isArray(list) || list.length === 0) {
        return { ok: false, message: "Twilio fromNumber was not found in the account." };
      }
    }

    return { ok: true };
  } catch {
    return { ok: false, message: "Unable to validate Twilio credentials. Check account SID, auth token, and sender configuration." };
  }
}

export async function validateVoipMsCredentials(credentials: VoipMsCredentials): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!/^\+?[1-9][0-9]{7,15}$/.test(credentials.fromNumber)) return { ok: false, message: "VoIP.ms fromNumber format is invalid." };

  if ((process.env.SMS_PROVIDER_TEST_MODE || "true").toLowerCase() !== "false") return { ok: true };

  try {
    const base = credentials.apiBaseUrl || VOIPMS_DEFAULT_BASE;
    const url = new URL(base);
    url.searchParams.set("api_username", credentials.username);
    url.searchParams.set("api_password", credentials.password);
    url.searchParams.set("method", "getBalance");

    const res = await fetch(url.toString(), { method: "GET" });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || String(json.status || "").toLowerCase() !== "success") {
      return { ok: false, message: "VoIP.ms validation failed. Check API credentials and account status." };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Unable to validate VoIP.ms credentials." };
  }
}

export async function sendTwilioTestMessage(credentials: TwilioCredentials, to: string, body: string): Promise<{ ok: true; providerMessageId: string } | { ok: false; message: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require("twilio");
    const client = twilio(credentials.accountSid, credentials.authToken);

    const payload: Record<string, string> = { to, body };
    if (credentials.messagingServiceSid) payload.messagingServiceSid = credentials.messagingServiceSid;
    else if (credentials.fromNumber) payload.from = credentials.fromNumber;
    else return { ok: false, message: "Twilio sender configuration missing (messagingServiceSid or fromNumber)." };

    const res = await client.messages.create(payload);
    return { ok: true, providerMessageId: String(res.sid) };
  } catch {
    return { ok: false, message: "Twilio test send failed. Verify destination number and account configuration." };
  }
}

export function normalizeProviderError(provider: "TWILIO" | "VOIPMS", err: any): NormalizedProviderError {
  const status = Number(err?.status || err?.statusCode || 0);
  const code = String(err?.code || "").toLowerCase();
  const msg = String(err?.message || "Provider error");

  if (status === 429 || code.includes("rate") || code.includes("throttle")) {
    return { code: "TEMP_RATE_LIMIT", retryable: true, humanMessage: "Provider rate limit reached." };
  }
  if (status >= 500 || code.includes("down") || code.includes("timeout") || code.includes("sim_")) {
    return { code: "TEMP_PROVIDER_DOWN", retryable: true, humanMessage: `${provider} temporary outage.` };
  }
  if (code.includes("carrier") || code.includes("queue")) {
    return { code: "TEMP_CARRIER", retryable: true, humanMessage: "Carrier temporary rejection." };
  }
  if (code.includes("21614") || code.includes("invalid") || code.includes("number")) {
    return { code: "PERM_INVALID_NUMBER", retryable: false, humanMessage: "Invalid destination number." };
  }
  if (code.includes("opt") || code.includes("stop")) {
    return { code: "PERM_OPTED_OUT", retryable: false, humanMessage: "Recipient opted out." };
  }
  if (code.includes("policy") || code.includes("compliance") || msg.toLowerCase().includes("policy")) {
    return { code: "PERM_POLICY", retryable: false, humanMessage: "Provider policy restriction." };
  }

  return { code: "TEMP_PROVIDER_DOWN", retryable: true, humanMessage: "Temporary provider failure." };
}

export function getSmsProvider(): SmsProvider {
  return new FakeSmsProvider();
}

export function validateTwilioRequest(authToken: string, signature: string, url: string, params: Record<string, string>): boolean {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const twilio = require("twilio");
  return twilio.validateRequest(authToken, signature, url, params);
}

export * from "./sola-cardknox";

export * from "./pbx-wirepbx";

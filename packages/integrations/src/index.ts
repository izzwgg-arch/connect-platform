export interface NumberProvider {
  searchNumbers(input: { areaCode?: string; type?: string }): Promise<Array<{ e164: string; monthlyPrice: number }>>;
  purchaseNumber(input: { e164: string; tenantId: string }): Promise<{ success: boolean; providerRef: string }>;
}

export interface SmsSendInput {
  tenantId: string;
  to: string;
  from: string;
  body: string;
  idempotencyKey?: string;
}

export interface SmsProvider {
  sendMessage(input: SmsSendInput): Promise<{ status: string; providerMessageId?: string }>;
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

export class FakeNumberProvider implements NumberProvider {
  async searchNumbers(_input: { areaCode?: string; type?: string }): Promise<Array<{ e164: string; monthlyPrice: number }>> {
    return [
      { e164: "+16465550100", monthlyPrice: 1.5 },
      { e164: "+16465550101", monthlyPrice: 1.5 },
      { e164: "+12125550100", monthlyPrice: 2.0 }
    ];
  }

  async purchaseNumber(input: { e164: string; tenantId: string }): Promise<{ success: boolean; providerRef: string }> {
    return { success: true, providerRef: `fake-number-${input.tenantId}-${input.e164}` };
  }
}

export class FakeSmsProvider implements SmsProvider {
  async sendMessage(input: SmsSendInput): Promise<{ status: string; providerMessageId: string }> {
    const providerMessageId = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[FakeSmsProvider] tenant=${input.tenantId} from=${input.from} to=${input.to}`);
    return { status: "SENT", providerMessageId };
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

  async sendMessage(input: SmsSendInput): Promise<{ status: string; providerMessageId?: string }> {
    if (this.testMode) {
      return {
        status: "SENT",
        providerMessageId: `twilio-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      };
    }

    const payload: Record<string, string> = {
      to: input.to,
      body: input.body
    };

    if (this.credentials.messagingServiceSid) {
      payload.messagingServiceSid = this.credentials.messagingServiceSid;
    } else if (this.credentials.fromNumber) {
      payload.from = this.credentials.fromNumber;
    } else {
      payload.from = input.from;
    }

    const res = await this.client.messages.create(payload);
    return { status: "SENT", providerMessageId: res.sid };
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

export async function sendTwilioTestMessage(credentials: TwilioCredentials, to: string, body: string): Promise<{ ok: true; providerMessageId: string } | { ok: false; message: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require("twilio");
    const client = twilio(credentials.accountSid, credentials.authToken);

    const payload: Record<string, string> = { to, body };
    if (credentials.messagingServiceSid) {
      payload.messagingServiceSid = credentials.messagingServiceSid;
    } else if (credentials.fromNumber) {
      payload.from = credentials.fromNumber;
    } else {
      return { ok: false, message: "Twilio sender configuration missing (messagingServiceSid or fromNumber)." };
    }

    const res = await client.messages.create(payload);
    return { ok: true, providerMessageId: String(res.sid) };
  } catch {
    return { ok: false, message: "Twilio test send failed. Verify destination number and account configuration." };
  }
}

export function getSmsProvider(): SmsProvider {
  return new FakeSmsProvider();
}

export function validateTwilioRequest(authToken: string, signature: string, url: string, params: Record<string, string>): boolean {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const twilio = require("twilio");
  return twilio.validateRequest(authToken, signature, url, params);
}

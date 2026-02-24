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
    console.log(`[FakeSmsProvider] tenant=${input.tenantId} from=${input.from} to=${input.to} body=${input.body}`);
    return { status: "SENT", providerMessageId };
  }
}

export class TwilioSmsProvider implements SmsProvider {
  private client: any;
  private fromFallback: string;

  constructor() {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      throw new Error("Twilio env vars are missing (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN)");
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require("twilio");
    this.client = twilio(sid, token);
    this.fromFallback = process.env.TWILIO_FROM_NUMBER || "";
  }

  async sendMessage(input: SmsSendInput): Promise<{ status: string; providerMessageId?: string }> {
    const res = await this.client.messages.create({
      to: input.to,
      from: input.from || this.fromFallback,
      body: input.body
    });
    return { status: "SENT", providerMessageId: res.sid };
  }
}

export function getSmsProvider(): SmsProvider {
  if ((process.env.SMS_PROVIDER || "fake").toLowerCase() === "twilio") {
    return new TwilioSmsProvider();
  }
  return new FakeSmsProvider();
}

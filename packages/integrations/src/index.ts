export interface NumberProvider {
  searchNumbers(input: { areaCode?: string; type?: string }): Promise<Array<{ e164: string; monthlyPrice: number }>>;
  purchaseNumber(input: { e164: string; tenantId: string }): Promise<{ success: boolean; providerRef: string }>;
}

export interface SmsProvider {
  sendMessage(input: { tenantId: string; to: string; from: string; body: string }): Promise<{ status: string }>;
  sendCampaign(input: { tenantId: string; campaignId: string; message: string; audience: string }): Promise<{ status: string }>;
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
  async sendMessage(input: { tenantId: string; to: string; from: string; body: string }): Promise<{ status: string }> {
    console.log(`[FakeSmsProvider] tenant=${input.tenantId} to=${input.to} body=${input.body}`);
    return { status: "sent" };
  }

  async sendCampaign(input: { tenantId: string; campaignId: string; message: string; audience: string }): Promise<{ status: string }> {
    console.log(`[FakeSmsProvider] campaign tenant=${input.tenantId} id=${input.campaignId} audience=${input.audience}`);
    return { status: "queued" };
  }
}

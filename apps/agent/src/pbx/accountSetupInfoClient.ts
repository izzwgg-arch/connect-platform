/**
 * Client for the api service's read-only account/pricing door
 * (POST /internal/agent/account-setup-info, shared-secret header, fail-closed).
 *
 * ⛔ This exists so the agent NEVER invents a price. Everything it quotes comes
 * from the invoice engine on the api side; an existing account may be on a
 * different plan or a negotiated rate, and a price the invoice then contradicts
 * is the one billing mistake customers never forget.
 */
import { postInternalApi } from "./internalApiPost";
import type { AccountSetupInfo } from "../tools/provisioningTools";

export function makeAccountSetupInfoClient(
  opts: { baseUrl?: string; secret?: string; timeoutMs?: number } = {},
): (tenantId: string) => Promise<AccountSetupInfo> {
  const baseUrl = (opts.baseUrl ?? process.env.AGENT_API_BASE_URL ?? "http://api:3001").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return async (tenantId: string): Promise<AccountSetupInfo> => {
    const secret = (opts.secret ?? process.env.AGENT_INTERNAL_SECRET ?? "").trim();
    if (!secret) throw new Error("account_setup_info_secret_unset (AGENT_INTERNAL_SECRET) — fail-closed");
    const resp = await postInternalApi({
      url: `${baseUrl}/internal/agent/account-setup-info`,
      secret,
      body: { tenantId },
      timeoutMs,
    });
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || json?.ok !== true || !json?.info) {
      throw new Error(`account_setup_info_error status=${resp.status} ${JSON.stringify(json).slice(0, 200)}`);
    }
    return json.info as AccountSetupInfo;
  };
}

/** Read-only number search. It looks; it never buys. */
export function makePhoneNumberSearchClient(
  opts: { baseUrl?: string; secret?: string; timeoutMs?: number } = {},
): (tenantId: string, areaCode?: string) => Promise<Array<{ did: string; pretty: string; location: string }>> {
  const baseUrl = (opts.baseUrl ?? process.env.AGENT_API_BASE_URL ?? "http://api:3001").replace(/\/$/, "");
  // Searching upstream stock is slower than a DB read — VoIP.ms is a live call.
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return async (tenantId: string, areaCode?: string) => {
    const secret = (opts.secret ?? process.env.AGENT_INTERNAL_SECRET ?? "").trim();
    if (!secret) throw new Error("search_phone_numbers_secret_unset (AGENT_INTERNAL_SECRET) — fail-closed");
    const resp = await postInternalApi({
      url: `${baseUrl}/internal/agent/search-phone-numbers`,
      secret,
      body: { tenantId, ...(areaCode ? { areaCode } : {}) },
      timeoutMs,
    });
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || json?.ok !== true) {
      throw new Error(`search_phone_numbers_error status=${resp.status} ${JSON.stringify(json).slice(0, 200)}`);
    }
    return Array.isArray(json.numbers) ? json.numbers : [];
  };
}

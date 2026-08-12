/**
 * Connect's own texting number, used for every billing text we send.
 *
 * ⛔ THE RULE: a billing text is sent BY CONNECT, not by the customer. The
 * from-number is a platform setting and is identical for every customer,
 * present and future. Nothing in here may read a per-tenant number, per-tenant
 * provider credentials, or a caller-supplied from-number — that is exactly what
 * the old per-tenant resolver did, and it meant the feature could never work:
 * it required a `ProviderCredential` row plus an active `phoneNumber` row on the
 * CUSTOMER's tenant, and onboarding customers have neither (their numbers live
 * in `PbxTenantInboundDid` / `TenantSmsNumber`). Every send returned
 * `sms_provider_unavailable`.
 *
 * Credentials are the platform VoIP.ms account (`GlobalVoipMsConfig`), the same
 * account the Connect Chat texting path uses.
 */

import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VoipMsSmsProvider } from "@connect/integrations";
import { splitVoipMsSendSmsParts } from "@connect/shared";

/** Connect Communications' texting number — (845) 723-1213. */
export const CONNECT_BILLING_SMS_FROM_FALLBACK = "+18457231213";

type VoipMsStoredCreds = { username: string; password: string; apiBaseUrl?: string };

/** Digits-only US/E.164 normaliser. Returns null when it cannot be a US number. */
export function normalizeUsPhone(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    // Already international — keep whatever country code was given.
    return digits.length >= 10 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** "+18457231213" → "(845) 723-1213", for screens and plain-English messages. */
export function formatUsPhoneForHumans(e164: string | null | undefined): string {
  const v = String(e164 ?? "").trim();
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(v);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : v;
}

/**
 * The number every billing text goes out from.
 *
 * `BILLING_SMS_FROM_NUMBER` is already set on the production api and worker
 * containers. Read at CALL time, never at module load, so it stays testable.
 */
export function resolveBillingSmsFromNumber(): string {
  return normalizeUsPhone(process.env.BILLING_SMS_FROM_NUMBER) || CONNECT_BILLING_SMS_FROM_FALLBACK;
}

function smsTestMode(): boolean {
  // Same convention as the Connect Chat sender: only an explicit "false" sends
  // for real, so a missing setting can never surprise-send.
  return (process.env.SMS_PROVIDER_TEST_MODE || "true").toLowerCase() !== "false";
}

export type BillingSmsSender = {
  ok: true;
  fromNumber: string;
  testMode: boolean;
  send: (input: { tenantId: string; to: string; body: string }) => Promise<{ providerMessageId?: string }>;
};

export type BillingSmsSenderUnavailable = {
  ok: false;
  /** Machine code for the API response. */
  error: string;
  /** Plain English, safe to show an operator. */
  message: string;
};

/**
 * Build the platform texting sender. Returns a typed unavailable result rather
 * than throwing, so callers can answer 200 `capable:false` where that is the
 * right shape.
 */
export async function resolveBillingSmsSender(): Promise<BillingSmsSender | BillingSmsSenderUnavailable> {
  return resolvePlatformSmsSender(resolveBillingSmsFromNumber());
}

/**
 * Same platform sender, arbitrary Connect-owned from-number. Used by the agent
 * escalation dispatcher, which sends from Connect's escalation number rather
 * than the billing number (one of the escalation RECIPIENTS is the billing
 * number itself — (845) 723-1213 — so they cannot share a from).
 */
export async function resolvePlatformSmsSender(fromNumberRaw: string): Promise<BillingSmsSender | BillingSmsSenderUnavailable> {
  const fromNumber = normalizeUsPhone(fromNumberRaw) || CONNECT_BILLING_SMS_FROM_FALLBACK;

  const cfg = await (db as any).globalVoipMsConfig.findUnique({ where: { id: "default" } });
  if (!cfg?.credentialsEncrypted) {
    return {
      ok: false,
      error: "billing_sms_not_configured",
      message: "Connect's texting account is not set up yet, so payment links cannot be texted.",
    };
  }
  if (cfg.smsEnabled === false) {
    return {
      ok: false,
      error: "billing_sms_disabled",
      message: "Texting is switched off on Connect's own account, so payment links cannot be texted.",
    };
  }

  let creds: VoipMsStoredCreds;
  try {
    creds = decryptJson<VoipMsStoredCreds>(cfg.credentialsEncrypted);
  } catch {
    return {
      ok: false,
      error: "billing_sms_credentials_unreadable",
      message: "Connect's texting account credentials could not be read.",
    };
  }
  if (!creds?.username || !creds?.password) {
    return {
      ok: false,
      error: "billing_sms_credentials_incomplete",
      message: "Connect's texting account is missing a username or password.",
    };
  }

  const testMode = smsTestMode();
  // fromNumber lives in the credentials, where VoipMsSmsProvider gives it
  // priority over the per-message `from` — so no caller can override it.
  const provider = new VoipMsSmsProvider(
    {
      username: creds.username,
      password: creds.password,
      fromNumber,
      apiBaseUrl: cfg.apiBaseUrl || creds.apiBaseUrl,
    } as any,
    testMode,
  );

  return {
    ok: true,
    fromNumber,
    testMode,
    async send(input) {
      // A pay link plus an invoice label can run past one SMS segment; the
      // carrier rejects an over-long single part rather than splitting it.
      const parts = splitVoipMsSendSmsParts(input.body);
      if (!parts.length) throw new Error("Nothing to send.");
      let last: { providerMessageId?: string } = {};
      for (const part of parts) {
        last = await provider.sendMessage({ tenantId: input.tenantId, to: input.to, from: fromNumber, body: part });
      }
      return last;
    },
  };
}

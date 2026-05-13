/**
 * Masked previews for SOLA credentials in admin/tenant API responses (never return raw secrets).
 */

export type SolaCredentialMaskInput = {
  apiKey?: string | null;
  apiSecret?: string | null;
  webhookSecret?: string | null;
  ifieldsKey?: string | null;
};

function maskValue(value: string | undefined | null, start = 4, end = 2): string | null {
  if (!value) return null;
  if (value.length <= start + end) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, start)}${"*".repeat(value.length - start - end)}${value.slice(-end)}`;
}

/** Shapes the `masked` object on `GET`/`PUT` SOLA config responses. */
export function maskSolaSecretsForResponse(secrets: SolaCredentialMaskInput | null | undefined) {
  if (!secrets) {
    return { apiKey: null, apiSecret: null, webhookSecret: null, ifieldsKey: null };
  }
  return {
    apiKey: maskValue(secrets.apiKey || null),
    apiSecret: secrets.apiSecret ? "********" : null,
    webhookSecret: secrets.webhookSecret ? "********" : null,
    ifieldsKey: maskValue(secrets.ifieldsKey || null, 6, 3),
  };
}

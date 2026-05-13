import { publicBillingApiBaseUrl } from "./billingEmailLifecycle";

/** Single global webhook endpoint; tenant is resolved from invoice payload (see `solaBillingPayments`). */
export function billingSolaCardknoxWebhookUrl(): string {
  return `${publicBillingApiBaseUrl()}/webhooks/sola-cardknox`;
}

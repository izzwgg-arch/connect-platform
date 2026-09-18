# QuickBooks ACH (Hosted) - TrimPro

This implementation enables **hosted ACH payments** for invoices using **QuickBooks Payments**.

Key compliance posture:
- TrimPro **does not collect or store bank account/routing numbers**.
- Customers complete payment on a **QuickBooks-hosted** page (Invoice pay portal).

## Required Env Vars

- `QUICKBOOKS_ACH_ENABLED=true`
- `QBO_CLIENT_ID=...`
- `QBO_CLIENT_SECRET=...`
- `QBO_ENV=production` (or `sandbox`)
- `QBO_WEBHOOK_VERIFIER_TOKEN=...` (Intuit webhook verifier token for signature validation)
- `ENCRYPTION_KEY=...` (already used for IntegrationConnection secrets)
- Optional (preferred for tokens): `TOKEN_ENC_KEY` = 32 bytes base64 (decoded length 32)

## Intuit / QuickBooks App Settings

### Host/Launch/Disconnect URLs
- Host domain: `app.trimprony.com`
- Launch URL: `https://app.trimprony.com/dashboard`
- Disconnect URL: `https://app.trimprony.com/dashboard/settings/integrations/quickbooks`

### Webhook URL
Configure in Intuit developer portal:
- Webhook URL: `https://app.trimprony.com/api/payments/qbo/webhook`

TrimPro validates:
- Header: `intuit-signature`
- HMAC SHA-256 over raw body using `QBO_WEBHOOK_VERIFIER_TOKEN`

### Payments Enablement
The QuickBooks company must have **QuickBooks Payments** enabled, and **ACH** enabled.
If QuickBooks does not return an `InvoiceLink` after enabling `AllowOnlineACHPayment`, TrimPro will show an error.

## How It Works

### Admin workflow
1. Open an invoice: `/dashboard/invoices/:id`
2. In the **QuickBooks ACH** panel:
   - Toggle: **Enable ACH on this invoice**
   - Click: **Generate ACH payment link**
3. Share the generated customer link:
   - `https://app.trimprony.com/pay/invoice/:publicToken`

### Customer workflow
1. Open public link: `/pay/invoice/:publicToken`
2. Click **Pay with ACH (QuickBooks)** to open the QuickBooks-hosted payment flow.

### Status updates
- TrimPro processes Intuit webhooks at `/api/payments/qbo/webhook`.
- On Payment events, TrimPro:
  - creates a local `Payment` (method `ACH`)
  - updates invoice `paidAmount/balance/status`
  - logs `WebhookEvent` + `PaymentEvent`

## Security Notes
- OAuth tokens are stored encrypted in `integration_connections.encryptedSecrets`.
- Webhook payloads are stored for audit in `webhook_events` (tenant-scoped).
- Public pay links are random 256-bit tokens and are not guessable.


import { NextRequest } from 'next/server'
import { POST as handleQuickBooksWebhook } from '@/app/api/payments/qbo/webhook/route'

export const dynamic = 'force-dynamic'

// Intuit configuration notes:
// - Webhook URL: https://app.trimprony.com/api/webhooks/quickbooks
// - Signature header: intuit-signature (HMAC-SHA256)
// - Secret/verifier token env: QBO_WEBHOOK_VERIFIER_TOKEN
// - OAuth scope required for canonical reads: com.intuit.quickbooks.accounting
export async function POST(request: NextRequest) {
  return handleQuickBooksWebhook(request)
}

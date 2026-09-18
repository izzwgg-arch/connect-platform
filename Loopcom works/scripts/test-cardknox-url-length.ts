import {
  buildCardknoxFallbackUrl,
  CARDKNOX_MAX_URL_LENGTH,
  enforceCardknoxUrlLength,
} from '@/lib/services/cardknox-url'

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message)
  }
}

function main() {
  const longReturnUrl =
    'https://app.trimprony.com/portal/pay/inv_test123?token=' +
    'a'.repeat(400)
  const longDescription =
    'Invoice INV-99999 - Kitchen remodel with extended line items, notes, and site details '.repeat(
      8
    )

  const worstCaseUrl = buildCardknoxFallbackUrl(
    {
      invoiceRef: 'INV-99999',
      amountStr: '12345.67',
      description: longDescription,
      intentRef: 'TPINTENT:abc123def456',
      clientName: 'Acme Construction & Design LLC',
      clientEmail: 'billing@acme.com, accounts@acme.com, owner@acme.com',
      clientPhone: '+1 (555) 123-4567 ext 890',
      billingStreet: '1234 Very Long Boulevard Name Suite 500 Building C',
      billingCity: 'New York',
      billingState: 'NY',
      billingZip: '10001-1234',
      billingCountry: 'US',
      returnUrl: longReturnUrl,
      webhookUrl: 'https://app.trimprony.com/api/webhooks/sola-payment?tenant=tenant_abc123',
    },
    { invoiceId: 'inv_test123', invoiceNumber: 'INV-99999' }
  )

  assert(
    worstCaseUrl.length <= CARDKNOX_MAX_URL_LENGTH,
    `Worst-case URL length ${worstCaseUrl.length} exceeds ${CARDKNOX_MAX_URL_LENGTH}`
  )

  const parsed = new URL(worstCaseUrl)
  assert(parsed.searchParams.has('xInvoice'), 'xInvoice missing')
  assert(parsed.searchParams.has('xAmount'), 'xAmount missing')
  assert(parsed.searchParams.has('xReturnURL'), 'xReturnURL missing')
  assert(parsed.searchParams.has('xRedirectURL'), 'xRedirectURL missing')
  assert(parsed.searchParams.has('xWebhookURL'), 'xWebhookURL missing')
  assert(parsed.searchParams.has('xCustom1'), 'xCustom1 missing')
  assert(parsed.searchParams.has('xEmail'), 'xEmail missing')
  assert(parsed.searchParams.has('xName'), 'xName missing')
  assert(
    parsed.searchParams.get('xEmail') === 'billing@acme.com',
    'xEmail should use first address only'
  )
  assert(!parsed.searchParams.has('xAddress'), 'duplicate xAddress alias must not be present')

  const legacyLongUrl =
    worstCaseUrl +
    '&xAddress=duplicate&xCity=duplicate&xState=duplicate&customer_email=extra@acme.com'
  const repaired = enforceCardknoxUrlLength(legacyLongUrl, {
    invoiceId: 'inv_test123',
    invoiceNumber: 'INV-99999',
  })
  assert(
    repaired.length <= CARDKNOX_MAX_URL_LENGTH,
    `Repaired legacy URL length ${repaired.length} exceeds limit`
  )

  console.log(
    JSON.stringify(
      {
        ok: true,
        maxUrlLength: CARDKNOX_MAX_URL_LENGTH,
        worstCaseLength: worstCaseUrl.length,
        repairedLegacyLength: repaired.length,
      },
      null,
      2
    )
  )
}

main()

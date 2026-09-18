import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { getIntegrationSecrets, updateIntegrationStatus } from '@/lib/integrations/status'
import { IntegrationProvider, IntegrationTestResult } from '@/lib/integrations/types'
import { z } from 'zod'

// Import test functions
import { testEmailProvider } from '@/lib/integrations/providers/email'
import { testVoipMsSms } from '@/lib/integrations/providers/voipms'
import { testWhatsApp } from '@/lib/integrations/providers/whatsapp'
import { testQuickBooks } from '@/lib/integrations/providers/quickbooks'
import { testSola } from '@/lib/integrations/providers/sola'
import { testWebWhatis } from '@/lib/integrations/providers/webwhatis'

const testRequestSchema = z.object({
  to: z.string().optional(), // For SMS/WhatsApp/Email test
  message: z.string().optional(), // For SMS/WhatsApp test
})

export async function POST(
  request: NextRequest,
  { params }: { params: { provider: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)
  const provider = params.provider as IntegrationProvider

  try {
    const body = await request.json()
    const testParams = testRequestSchema.parse(body)

    const secrets = await getIntegrationSecrets(user.tenantId, provider)

    if (!secrets) {
      return NextResponse.json(
        { error: 'Integration not configured. Please save credentials first.' },
        { status: 400 }
      )
    }

    let result: IntegrationTestResult

    // Route to appropriate test function
    switch (provider) {
      case 'email':
        result = await testEmailProvider(
          secrets,
          testParams.to || user.email,
          'Trim Pro Test Email',
          '<p>This is a test email from Trim Pro. If you received this, your email integration is working correctly.</p>',
          { skipAdminCc: true }
        )
        break

      case 'voipms_sms':
        if (!testParams.to) {
          return NextResponse.json({ error: 'Phone number required' }, { status: 400 })
        }
        result = await testVoipMsSms(secrets, testParams.to, testParams.message || 'Trim Pro SMS test')
        break

      case 'whatsapp':
        if (!testParams.to) {
          return NextResponse.json({ error: 'Phone number required' }, { status: 400 })
        }
        result = await testWhatsApp(secrets, testParams.to, testParams.message || 'Trim Pro WhatsApp test')
        break

      case 'webwhatis':
        if (!testParams.to) {
          return NextResponse.json({ error: 'Phone number required' }, { status: 400 })
        }
        result = await testWebWhatis(secrets, testParams.to, testParams.message || 'Trim Pro Web.whatis test')
        break

      case 'quickbooks':
        result = await testQuickBooks(secrets)
        break

      case 'sola':
        result = await testSola(secrets)
        break

      default:
        return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 })
    }

    // Update connection status based on test result
    await updateIntegrationStatus(
      user.tenantId,
      provider,
      result.success ? 'CONNECTED' : 'ERROR',
      result.error || null
    )

    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.errors }, { status: 400 })
    }
    console.error('Test integration error:', error)
    return NextResponse.json(
      { success: false, message: 'Test failed', error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

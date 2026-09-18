import { IntegrationTestResult } from '../types'
import { MessagingChannel } from '@/lib/messaging/types'
import { WebWhatisProvider } from '@/lib/messaging/providers/webwhatis'

export async function testWebWhatis(
  secrets: Record<string, any>,
  to: string,
  message: string
): Promise<IntegrationTestResult> {
  try {
    const apiKey = typeof secrets.apiKey === 'string' ? secrets.apiKey.trim() : ''
    if (!apiKey) {
      return {
        success: false,
        message: 'Web.whatis test failed',
        error: 'Missing apiKey',
      }
    }

    const provider = new WebWhatisProvider(apiKey)

    const result = await provider.sendMessage({
      to,
      body: message,
      channel: MessagingChannel.SMS,
      from: typeof secrets.defaultFromNumber === 'string' ? secrets.defaultFromNumber : undefined,
    })

    if (!result.success) {
      return {
        success: false,
        message: 'Web.whatis test failed',
        error: result.error || 'Unknown error',
      }
    }

    return {
      success: true,
      message: `Test SMS sent successfully to ${to} via Web.whatis`,
    }
  } catch (error: any) {
    return {
      success: false,
      message: 'Web.whatis test failed',
      error: error?.message || 'Unknown error',
    }
  }
}


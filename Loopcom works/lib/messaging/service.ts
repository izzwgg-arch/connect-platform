/**
 * Messaging Service - Unified interface for sending messages
 */

import { MessagingProvider, SendMessageParams, SendMessageResult, MessagingChannel } from './types'
import { WebWhatisProvider } from './providers/webwhatis'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { prisma } from '@/lib/prisma'
import { sendVoipMsSms, sendVoipMsMms } from '@/lib/integrations/providers/voipms'
import { toE164, toNanp10 } from '@/lib/phone'

function getPublicBaseUrlFromEnv(): string | null {
  const envUrl =
    process.env.PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL
  if (!envUrl) return null
  const trimmed = String(envUrl).trim().replace(/\/+$/, '')
  return trimmed ? trimmed : null
}

function normalizeMediaUrls(urls: string[]): string[] {
  const base = getPublicBaseUrlFromEnv()
  return urls.map((u) => {
    if (!u) return u
    // If it's already a full URL, ensure HTTPS (except localhost)
    if (u.startsWith('https://')) return u
    if (u.startsWith('http://')) {
      // Upgrade HTTP to HTTPS for production domains
      const isLocalhost = u.includes('localhost') || u.includes('127.0.0.1')
      return isLocalhost ? u : u.replace('http://', 'https://')
    }
    // Relative URL - prepend base URL
    if (u.startsWith('/') && base) {
      // Ensure base is HTTPS
      const httpsBase = base.startsWith('https://') ? base : base.replace('http://', 'https://')
      return `${httpsBase}${u}`
    }
    return u
  })
}

function allHttps(urls: string[]): boolean {
  return urls.every((u) => typeof u === 'string' && u.startsWith('https://'))
}

export class MessagingService {
  /**
   * Get messaging provider instance
   */
  private async getProvider(tenantId: string, channel: MessagingChannel): Promise<{ provider: MessagingProvider | 'voipms', providerName: string, secrets?: any } | null> {
    // Try web.whatis first (primary provider)
    if (channel === MessagingChannel.WHATSAPP || channel === MessagingChannel.SMS || channel === MessagingChannel.MMS) {
      try {
        const secrets = await getIntegrationSecrets(tenantId, 'webwhatis' as any)
        if (secrets?.apiKey) {
          return { provider: new WebWhatisProvider(secrets.apiKey), providerName: 'webwhatis' }
        }
      } catch (error) {
        // Provider not configured, continue to fallback
      }
    }

    // Fallback to VoIP.ms for SMS/MMS.
    // If a conversation is mistakenly labeled WHATSAPP but the tenant only has VoIP.ms configured,
    // we still want outbound messaging to work (treat it as SMS/MMS).
    if (channel === MessagingChannel.SMS || channel === MessagingChannel.MMS || channel === MessagingChannel.WHATSAPP) {
      try {
        const secrets = await getIntegrationSecrets(tenantId, 'voipms_sms' as any)
        if (secrets?.username && secrets?.apiPassword) {
          return { provider: 'voipms', providerName: 'voipms_sms', secrets }
        }
      } catch (error) {
        // Provider not configured
      }
    }

    return null
  }

  /**
   * Send a message
   */
  async sendMessage(
    tenantId: string,
    params: SendMessageParams,
    conversationId?: string
  ): Promise<SendMessageResult & { messageId?: string }> {
    try {
      // If a conversation is stored as WHATSAPP but the tenant uses VoIP.ms, we treat this as SMS/MMS.
      // This avoids breaking outbound messaging when channels were mis-labeled historically.
      const effectiveChannel: MessagingChannel =
        params.channel === MessagingChannel.WHATSAPP
          ? (params.media && params.media.length > 0 ? MessagingChannel.MMS : MessagingChannel.SMS)
          : params.channel

      // Get provider
      const providerInfo = await this.getProvider(tenantId, params.channel)
      if (!providerInfo) {
        // Provide a more actionable error when an integration exists but secrets can't be decrypted.
        // This commonly happens when ENCRYPTION_KEY/NEXTAUTH_SECRET was rotated after initial setup.
        try {
          const [voipms, webwhatis] = await Promise.all([
            prisma.integrationConnection.findUnique({
              where: { tenantId_provider: { tenantId, provider: 'voipms_sms' as any } },
              select: { status: true, encryptedSecrets: true },
            }),
            prisma.integrationConnection.findUnique({
              where: { tenantId_provider: { tenantId, provider: 'webwhatis' as any } },
              select: { status: true, encryptedSecrets: true },
            }),
          ])

          if (voipms?.status === 'CONNECTED' && voipms.encryptedSecrets) {
            return {
              success: false,
              error:
                'VoIP.ms is marked CONNECTED, but its saved credentials cannot be read by the server (encryption key changed). Re-save VoIP.ms credentials in Settings → Integrations → VoIP.ms SMS & MMS.',
            }
          }
          if (webwhatis?.status === 'CONNECTED' && webwhatis.encryptedSecrets) {
            return {
              success: false,
              error:
                'Web.whatis is marked CONNECTED, but its saved credentials cannot be read by the server (encryption key changed). Re-save Web.whatis credentials in Settings → Integrations → Web.whatis.',
            }
          }
        } catch {
          // Ignore and fall back to generic message below.
        }
        return {
          success: false,
          error: `No messaging provider configured for ${params.channel}`,
        }
      }

      // Send via provider
      let result: SendMessageResult
      let actualProviderName = providerInfo.providerName

      if (providerInfo.provider === 'voipms') {
        // Use VoIP.ms directly
        const secrets = providerInfo.secrets!
        const fromDid = params.from || secrets.defaultDid
        
        if (!fromDid) {
          return {
            success: false,
            error: 'VoIP.ms default DID not configured',
          }
        }

        if (
          (effectiveChannel === MessagingChannel.MMS || (params.media && params.media.length > 0)) &&
          params.media &&
          params.media.length > 0
        ) {
          const mediaUrls = normalizeMediaUrls(params.media.map((m) => m.url))
          // VoIP.ms MMS commonly requires media URLs to be publicly reachable over HTTPS.
          // If you're running on plain HTTP, carriers/providers may drop the attachment silently.
          if (!allHttps(mediaUrls)) {
            return {
              success: false,
              error:
                'MMS photo failed: media URLs must be HTTPS-reachable. Configure a domain with SSL and set PUBLIC_APP_URL to https://..., or use Web.whatis for MMS.',
            }
          }
          result = await sendVoipMsMms(secrets, params.to, params.body || '', mediaUrls, fromDid)
        } else {
          result = await sendVoipMsSms(secrets, params.to, params.body || '', fromDid)
        }
      } else {
        // Use provider instance (web.whatis)
        const normalized =
          params.media && params.media.length > 0
            ? {
                ...params,
                media: params.media.map((m) => ({
                  ...m,
                  url: normalizeMediaUrls([m.url])[0],
                })),
              }
            : params

        result = await providerInfo.provider.sendMessage(normalized)
      }

      if (!result.success) {
        return result
      }

      // Store message in database
      let conversation = conversationId
        ? await prisma.conversation.findUnique({ where: { id: conversationId } })
        : null

      // If this is an existing conversation saved as WHATSAPP, normalize it to SMS/MMS after a successful send.
      if (
        conversation &&
        (conversation as any).channel === MessagingChannel.WHATSAPP &&
        effectiveChannel !== MessagingChannel.WHATSAPP
      ) {
        try {
          await prisma.conversation.update({
            where: { id: conversation.id },
            data: { channel: effectiveChannel as any },
          })
          conversation = await prisma.conversation.findUnique({ where: { id: conversation.id } })
        } catch {
          // Non-fatal; keep sending even if we can't update the channel.
        }
      }

      if (!conversation) {
        // Normalize to E.164 for consistent matching — prevents duplicate threads per number
        const toE164Canonical = toE164(params.to)
        const toNanp = toNanp10(params.to)

        // Fetch all SMS/MMS conversations and match by E.164
        const allConversations = await prisma.conversation.findMany({
          where: { tenantId, channel: { in: ['SMS', 'MMS'] as any } },
          select: { id: true, participants: true },
        })

        const found = allConversations.find((conv) => {
          const parts = Array.isArray(conv.participants) ? (conv.participants as string[]) : []
          return parts.some((p) => toE164(p) === toE164Canonical)
        })

        if (found) {
          // Canonicalize participants to E.164 if not already stored
          const parts = Array.isArray(found.participants) ? (found.participants as string[]) : []
          if (!parts.includes(toE164Canonical)) {
            await prisma.conversation.update({
              where: { id: found.id },
              data: { participants: [toE164Canonical, ...parts.filter((p) => toE164(p) !== toE164Canonical)] },
            })
          }
          conversation = await prisma.conversation.findUnique({ where: { id: found.id } })
        }

        if (!conversation) {
          // Find client by phone
          const client = await prisma.client.findFirst({
            where: {
              tenantId,
              OR: [
                { phone: { contains: toNanp } },
                { email: params.to },
              ],
            },
          })

          // Always store E.164 in participants
          conversation = await prisma.conversation.create({
            data: {
              tenantId,
              channel: effectiveChannel as any,
              clientId: client?.id || null,
              participants: [toE164Canonical],
              status: 'ACTIVE',
              lastMessageAt: new Date(),
            },
          })
        }
      }

      // Create message record
      // For MMS with no text, set body to null or empty (not "MMS message")
      const messageBody = params.body && params.body.trim() ? params.body.trim() : (params.media && params.media.length > 0 ? null : params.body)
      
      const message = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          tenantId,
          direction: 'OUTBOUND',
          channel: effectiveChannel as any,
          body: messageBody,
          fromNumber: params.from || null,
          toNumber: params.to,
          provider: actualProviderName,
          providerMessageId: result.providerMessageId || result.messageId || undefined,
          status: result.success ? 'SENT' : 'FAILED',
          sentAt: result.success ? new Date() : null,
          errorMessage: result.error || null,
        },
      })

      // Store media if any - MUST be created immediately so it shows in UI
      if (params.media && params.media.length > 0) {
        console.log('Creating message media records:', params.media.map(m => ({ type: m.type, url: m.url?.substring(0, 60), filename: m.filename })))
        await Promise.all(
          params.media.map((media) =>
            prisma.messageMedia.create({
              data: {
                messageId: message.id,
                type: media.type || 'image',
                url: media.url,
                thumbnailUrl: media.thumbnailUrl,
                mimeType: media.mimeType,
                size: media.size,
                filename: media.filename,
              },
            })
          )
        )
        console.log('Message media records created for message:', message.id)
      }

      // Update conversation
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date(),
        },
      })

      return {
        ...result,
        messageId: message.id,
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to send message',
      }
    }
  }
}

export const messagingService = new MessagingService()

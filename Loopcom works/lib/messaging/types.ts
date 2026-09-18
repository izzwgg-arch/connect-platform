/**
 * Messaging Provider Types
 */

export enum MessagingChannel {
  SMS = 'SMS',
  MMS = 'MMS',
  WHATSAPP = 'WHATSAPP',
  EMAIL = 'EMAIL',
}

export enum MessageDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

export enum MessageStatus {
  QUEUED = 'QUEUED',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  READ = 'READ',
}

export interface MessageMedia {
  type: 'image' | 'video' | 'file' | 'audio'
  url: string
  thumbnailUrl?: string
  mimeType?: string
  size?: number
  filename?: string
}

export interface SendMessageParams {
  to: string // Phone number or email
  from?: string // Sender number/email (if multiple available)
  body?: string
  media?: MessageMedia[]
  channel: MessagingChannel
  metadata?: Record<string, any>
}

export interface SendMessageResult {
  success: boolean
  messageId?: string
  providerMessageId?: string
  error?: string
}

export interface MessagingProvider {
  /**
   * Send a message
   */
  sendMessage(params: SendMessageParams): Promise<SendMessageResult>

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(request: Request, secret: string): Promise<boolean>

  /**
   * Parse inbound webhook payload
   */
  parseWebhookPayload(body: any): Promise<InboundWebhookPayload | null>
}

export interface InboundWebhookPayload {
  eventType: 'inbound_message' | 'message_status_update' | 'conversation_created'
  providerMessageId: string
  from: string
  to: string
  body?: string
  media?: MessageMedia[]
  status?: MessageStatus
  timestamp: Date
  metadata?: Record<string, any>
}

/**
 * Integration Registry
 * Central registry for all integrations
 */

import { IntegrationProvider, IntegrationStatus } from './types'

export interface IntegrationDefinition {
  provider: IntegrationProvider
  name: string
  description: string
  icon: string
  category: 'communication' | 'financial' | 'payment' | 'accounting'
  requiresOAuth?: boolean
  requiresWebhook?: boolean
  configFields?: Array<{
    key: string
    label: string
    type: 'text' | 'password' | 'email' | 'url' | 'number' | 'select' | 'secret' | 'textarea'
    required?: boolean
    placeholder?: string
    options?: Array<{ label: string; value: string }>
    dependsOn?: string // Field this depends on
  }>
}

export const INTEGRATIONS: Record<IntegrationProvider, IntegrationDefinition> = {
  email: {
    provider: 'email',
    name: 'Email Provider',
    description: 'Send emails via SendGrid, Mailgun, Resend, or Google (Gmail SMTP)',
    icon: 'Mail',
    category: 'communication',
    requiresWebhook: false,
    configFields: [
      {
        key: 'provider',
        label: 'Provider',
        type: 'select',
        required: true,
        options: [
          { label: 'SendGrid', value: 'sendgrid' },
          { label: 'Mailgun', value: 'mailgun' },
          { label: 'Resend', value: 'resend' },
          { label: 'Google (Gmail SMTP)', value: 'google' },
        ],
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 'Enter your API key',
      },
      {
        key: 'fromEmail',
        label: 'From Email',
        type: 'email',
        required: true,
        placeholder: 'noreply@example.com',
      },
      {
        key: 'replyTo',
        label: 'Reply-To Email',
        type: 'email',
        required: false,
        placeholder: 'support@example.com',
      },
      {
        key: 'mailgunDomain',
        label: 'Mailgun Domain',
        type: 'text',
        required: false,
        placeholder: 'mg.example.com',
        dependsOn: 'provider',
      },
      {
        key: 'mailgunRegion',
        label: 'Mailgun Region',
        type: 'select',
        required: false,
        options: [
          { label: 'US', value: 'us' },
          { label: 'EU', value: 'eu' },
        ],
        dependsOn: 'provider',
      },
      {
        key: 'googleEmail',
        label: 'Google/Gmail Email',
        type: 'email',
        required: false,
        placeholder: 'you@gmail.com',
        dependsOn: 'provider',
      },
      {
        key: 'googleAppPassword',
        label: 'Google App Password',
        type: 'password',
        required: false,
        placeholder: '16-character app password',
        dependsOn: 'provider',
      },
    ],
  },
  voipms_sms: {
    provider: 'voipms_sms',
    name: 'VoIP.ms SMS & MMS',
    description: 'Send and receive SMS and MMS messages via VoIP.ms',
    icon: 'MessageSquare',
    category: 'communication',
    requiresWebhook: true,
    configFields: [
      {
        key: 'username',
        label: 'VoIP.ms Username',
        type: 'text',
        required: true,
        placeholder: 'your_username',
      },
      {
        key: 'apiPassword',
        label: 'VoIP.ms API Password',
        type: 'password',
        required: true,
        placeholder: 'Your API password (NOT your login password)',
        description: 'This is your API Password from VoIP.ms dashboard (Settings → API), NOT your account login password. Generate one if you don\'t have it.',
      },
      {
        key: 'defaultDid',
        label: 'Default Outbound SMS DID',
        type: 'text',
        required: true,
        placeholder: '+15551234567',
      },
      {
        key: 'webhookSecret',
        label: 'Webhook URL (Auto-generated)',
        type: 'secret', // Special type for webhook secrets that need to be visible/copyable
        required: false,
        placeholder: 'Auto-generated',
        description: 'This is the webhook URL you need to configure in your VoIP.ms dashboard. Copy this URL and paste it in VoIP.ms → Settings → SMS → Webhook URL.',
      },
    ],
  },
  webwhatis: {
    provider: 'webwhatis',
    name: 'Web.whatis Messaging',
    description: 'Send and receive SMS/MMS messages via Web.whatis API',
    icon: 'MessageCircle',
    category: 'communication',
    requiresWebhook: true,
    configFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 'Your Web.whatis API Key',
      },
      {
        key: 'webhookSecret',
        label: 'Webhook Secret (Auto-generated)',
        type: 'secret',
        required: false,
        placeholder: 'Auto-generated',
      },
      {
        key: 'defaultFromNumber',
        label: 'Default From Number (Optional)',
        type: 'text',
        required: false,
        placeholder: '+15551234567',
      },
      {
        key: 'apiBase',
        label: 'API Base URL (Optional)',
        type: 'url',
        required: false,
        placeholder: 'https://api.webwhatis.com/v1',
      },
    ],
  },
  vitalpbx: {
    provider: 'vitalpbx',
    name: 'VitalPBX WebRTC (SIP)',
    description: 'In-browser softphone via SIP over WebSocket (WSS) to VitalPBX',
    icon: 'Phone',
    category: 'communication',
    requiresWebhook: false,
    configFields: [
      {
        key: 'wssUrl',
        label: 'WSS URL (SIP WebSocket)',
        type: 'url',
        required: true,
        placeholder: 'wss://pbx.yourdomain.com:8089/ws',
      },
      {
        key: 'sipDomain',
        label: 'SIP Domain / Host',
        type: 'text',
        required: true,
        placeholder: 'pbx.yourdomain.com',
      },
      {
        key: 'extension',
        label: 'Extension (Auth Username)',
        type: 'text',
        required: true,
        placeholder: '1001',
      },
      {
        key: 'password',
        label: 'Extension Password',
        type: 'password',
        required: true,
        placeholder: 'Your extension password',
      },
      {
        key: 'displayName',
        label: 'Display Name (Optional)',
        type: 'text',
        required: false,
        placeholder: 'Trim Pro',
      },
      {
        key: 'outboundCallerId',
        label: 'Outbound Caller ID (Optional)',
        type: 'text',
        required: false,
        placeholder: '+15551234567',
      },
      {
        key: 'iceServersJson',
        label: 'ICE Servers JSON (Optional)',
        type: 'textarea',
        required: false,
        placeholder: '[{\"urls\":[\"stun:stun.l.google.com:19302\"]}]',
      },
    ],
  },
  whatsapp: {
    provider: 'whatsapp',
    name: 'WhatsApp',
    description: 'Send WhatsApp messages via Twilio or Meta Cloud API',
    icon: 'MessageCircle',
    category: 'communication',
    requiresWebhook: true,
    configFields: [
      {
        key: 'provider',
        label: 'Provider',
        type: 'select',
        required: true,
        options: [
          { label: 'Twilio WhatsApp', value: 'twilio' },
          { label: 'Meta WhatsApp Cloud API', value: 'meta' },
        ],
      },
      // Twilio fields
      {
        key: 'twilioAccountSid',
        label: 'Twilio Account SID',
        type: 'text',
        required: false,
        placeholder: 'AC...',
        dependsOn: 'provider',
      },
      {
        key: 'twilioAuthToken',
        label: 'Twilio Auth Token',
        type: 'password',
        required: false,
        placeholder: 'Your auth token',
        dependsOn: 'provider',
      },
      {
        key: 'twilioFromNumber',
        label: 'WhatsApp From Number',
        type: 'text',
        required: false,
        placeholder: 'whatsapp:+14155238886',
        dependsOn: 'provider',
      },
      {
        key: 'twilioMessagingServiceSid',
        label: 'Messaging Service SID (Optional)',
        type: 'text',
        required: false,
        placeholder: 'MG...',
        dependsOn: 'provider',
      },
      // Meta fields
      {
        key: 'metaPhoneNumberId',
        label: 'Phone Number ID',
        type: 'text',
        required: false,
        placeholder: '123456789',
        dependsOn: 'provider',
      },
      {
        key: 'metaAccessToken',
        label: 'Permanent Access Token',
        type: 'password',
        required: false,
        placeholder: 'Your access token',
        dependsOn: 'provider',
      },
      {
        key: 'metaAppSecret',
        label: 'App Secret (Optional)',
        type: 'password',
        required: false,
        placeholder: 'Your app secret',
        dependsOn: 'provider',
      },
      {
        key: 'metaVerifyToken',
        label: 'Verify Token (for webhooks)',
        type: 'text',
        required: false,
        placeholder: 'Auto-generated',
        dependsOn: 'provider',
      },
    ],
  },
  quickbooks: {
    provider: 'quickbooks',
    name: 'QuickBooks Online',
    description: 'Sync invoices, payments, and customers with QuickBooks',
    icon: 'DollarSign',
    category: 'accounting',
    requiresOAuth: true,
    requiresWebhook: false,
    configFields: [
      {
        key: 'clientId',
        label: 'QuickBooks Client ID',
        type: 'text',
        required: true,
        placeholder: 'Enter Intuit Client ID',
      },
      {
        key: 'clientSecret',
        label: 'QuickBooks Client Secret',
        type: 'password',
        required: true,
        placeholder: 'Enter Intuit Client Secret',
      },
      {
        key: 'redirectUri',
        label: 'OAuth Redirect URI',
        type: 'url',
        required: false,
        placeholder: 'https://app.trimprony.com/api/integrations/quickbooks/callback',
      },
      {
        key: 'environment',
        label: 'QuickBooks Environment',
        type: 'select',
        required: true,
        options: [
          { label: 'Production', value: 'production' },
          { label: 'Sandbox', value: 'sandbox' },
        ],
      },
    ],
  },
  sola: {
    provider: 'sola',
    name: 'Sola Payments',
    description: 'Process payments and receive webhooks from Sola',
    icon: 'CreditCard',
    category: 'payment',
    requiresWebhook: true,
    configFields: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        required: true,
        options: [
          { label: 'Sandbox', value: 'sandbox' },
          { label: 'Production', value: 'production' },
        ],
      },
      {
        key: 'secretKey',
        label: 'Secret Key',
        type: 'password',
        required: true,
        placeholder: 'Your secret key',
      },
      {
        key: 'webhookSecret',
        label: 'Webhook Signing Secret',
        type: 'password',
        required: true,
        placeholder: 'Your webhook secret',
      },
      {
        key: 'merchantId',
        label: 'Merchant/Account ID (Optional)',
        type: 'text',
        required: false,
        placeholder: 'Your merchant ID',
      },
    ],
  },
}

/**
 * Get integration definition by provider
 */
export function getIntegration(provider: IntegrationProvider): IntegrationDefinition {
  return INTEGRATIONS[provider]
}

/**
 * Get all integrations
 */
export function getAllIntegrations(): IntegrationDefinition[] {
  return Object.values(INTEGRATIONS)
}

/**
 * Get integrations by category
 */
export function getIntegrationsByCategory(
  category: IntegrationDefinition['category']
): IntegrationDefinition[] {
  return Object.values(INTEGRATIONS).filter((int) => int.category === category)
}

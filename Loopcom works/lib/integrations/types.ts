/**
 * Integration Framework Types
 */

export type IntegrationProvider =
  | 'email'
  | 'voipms_sms'
  | 'whatsapp'
  | 'quickbooks'
  | 'sola'
  | 'webwhatis'
  | 'vitalpbx'

export type IntegrationStatus =
  | 'NOT_CONFIGURED'
  | 'CONNECTED'
  | 'ERROR'
  | 'CONNECTING'

export interface IntegrationConfig {
  provider: IntegrationProvider
  displayName?: string
  status: IntegrationStatus
  metadata?: Record<string, any>
  lastCheckedAt?: Date | null
  lastError?: string | null
  encryptedSecrets?: string | null
}

export interface IntegrationSecrets {
  [key: string]: string | number | boolean | undefined
}

export interface IntegrationConnection {
  id: string
  tenantId: string
  provider: IntegrationProvider
  status: IntegrationStatus
  displayName?: string | null
  encryptedSecrets: string | null
  metadata: Record<string, any> | null
  lastCheckedAt: Date | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

export interface IntegrationTestResult {
  success: boolean
  message: string
  error?: string
}

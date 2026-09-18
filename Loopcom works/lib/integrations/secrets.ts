/**
 * Secrets Encryption/Decryption
 * Uses AES-256-GCM for authenticated encryption
 */

import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16 // 128 bits
const SALT_LENGTH = 64
const TAG_LENGTH = 16
const TAG_POSITION = SALT_LENGTH + IV_LENGTH
const ENCRYPTED_POSITION = TAG_POSITION + TAG_LENGTH

function getEncryptionKeySource(): string | undefined {
  // Use bracket notation to avoid static env inlining issues in bundled server code.
  // Keep compatibility with multiple secret names used across deployments.
  const key =
    process.env['ENCRYPTION_KEY'] ||
    process.env['INTEGRATION_ENCRYPTION_KEY'] ||
    process.env['NEXTAUTH_SECRET'] ||
    process.env['AUTH_SECRET'] ||
    process.env['JWT_SECRET'] ||
    process.env['DATABASE_URL']

  if (!key || key.length < 32) {
    console.warn(
      'WARNING: Integration encryption key source missing/short. Set ENCRYPTION_KEY (32+ chars) for production.'
    )
  }
  return key
}

function getKey(): Buffer {
  const ENCRYPTION_KEY = getEncryptionKeySource()
  if (!ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY not configured')
  }

  // Derive a 32-byte key from the encryption key
  const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest()
  return key
}

/**
 * Encrypt a secrets object into a string
 */
export function encryptSecrets(secrets: Record<string, any>): string {
  const ENCRYPTION_KEY = getEncryptionKeySource()
  if (!ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY not configured. Cannot encrypt secrets.')
  }

  const key = getKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const salt = crypto.randomBytes(SALT_LENGTH)

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

  const jsonString = JSON.stringify(secrets)
  const encrypted = Buffer.concat([cipher.update(jsonString, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  // Combine: salt + iv + tag + encrypted
  const combined = Buffer.concat([salt, iv, tag, encrypted])

  return combined.toString('base64')
}

/**
 * Decrypt a secrets string back into an object
 */
export function decryptSecrets(encrypted: string): Record<string, any> {
  const ENCRYPTION_KEY = getEncryptionKeySource()
  if (!ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY not configured. Cannot decrypt secrets.')
  }

  if (!encrypted) {
    return {}
  }

  try {
    const combined = Buffer.from(encrypted, 'base64')

    const salt = combined.subarray(0, SALT_LENGTH)
    const iv = combined.subarray(SALT_LENGTH, TAG_POSITION)
    const tag = combined.subarray(TAG_POSITION, ENCRYPTED_POSITION)
    const encryptedData = combined.subarray(ENCRYPTED_POSITION)

    const key = getKey()
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)

    const decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final(),
    ])

    return JSON.parse(decrypted.toString('utf8'))
  } catch (error) {
    console.error('Failed to decrypt secrets:', error)
    throw new Error('Failed to decrypt secrets. Invalid encryption key or corrupted data.')
  }
}

/**
 * Mask a secret value for display (show last 4 characters)
 */
export function maskSecret(value: string | undefined | null, length = 4): string {
  if (!value || value.length <= length) {
    return '••••••'
  }
  return `••••••${value.slice(-length)}`
}

/**
 * Mask an object's secret values
 */
export function maskSecrets(secrets: Record<string, any>): Record<string, string> {
  const masked: Record<string, string> = {}
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value === 'string' && value.length > 0) {
      masked[key] = maskSecret(value)
    } else {
      masked[key] = String(value || '')
    }
  }
  return masked
}

/**
 * Token encryption for sensitive credentials (OAuth tokens, API keys).
 *
 * Design:
 * - AES-256-GCM (authenticated encryption)
 * - Key source: TOKEN_ENC_KEY (preferred) or ENCRYPTION_KEY / NEXTAUTH_SECRET fallback
 * - Never log plaintext tokens.
 *
 * NOTE: This is intentionally separate from integrations/secrets.ts because:
 * - That module stores whole objects; here we store single values for simpler schema upgrades.
 */

import crypto from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12 // recommended for GCM
const TAG_LEN = 16

function getKeyMaterial(): Buffer {
  const b64 = process.env.TOKEN_ENC_KEY
  if (b64) {
    const raw = Buffer.from(b64, 'base64')
    if (raw.length !== 32) {
      throw new Error('TOKEN_ENC_KEY must be 32 bytes base64 (decoded length 32).')
    }
    return raw
  }

  const fallback = process.env.ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET
  if (!fallback) {
    throw new Error('TOKEN_ENC_KEY not configured (and no ENCRYPTION_KEY/NEXTAUTH_SECRET fallback).')
  }
  // Derive a fixed 32-byte key.
  return crypto.createHash('sha256').update(fallback).digest()
}

export function encryptToken(plaintext: string): string {
  if (!plaintext) return ''
  const key = getKeyMaterial()
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // format: iv.tag.ciphertext (base64url-ish via base64, separated)
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`
}

export function decryptToken(ciphertext: string): string {
  if (!ciphertext) return ''
  const parts = ciphertext.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format.')
  }
  const [ivB64, tagB64, dataB64] = parts
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('Invalid encrypted token payload.')
  }
  const key = getKeyMaterial()
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
  return decrypted.toString('utf8')
}


import crypto from 'crypto'
import { prisma } from '@/lib/prisma'
import { encryptToken, decryptToken } from '@/lib/security/token-encryption'

const APPROVAL_TOKEN_BYTES = 32 // 256-bit
const DEFAULT_EXPIRY_DAYS = 90

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(String(input)).digest('hex')
}

export function hashApprovalToken(rawToken: string): string {
  return sha256Hex(rawToken)
}

export function buildPublicApproveEstimateUrl(rawToken: string): string {
  // IMPORTANT:
  // Public approval links must be reachable from customers (email/PDF). Do not default to an IP/port
  // or internal APP_URL in production. Use the public domain unless explicitly overridden.
  const envUrl =
    process.env.PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.PUBLIC_APPROVAL_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    ''

  const fallback = process.env.CANONICAL_PUBLIC_APP_URL || 'https://app.trimprony.com'

  const isProbablyIp = (hostname: string) => {
    // IPv4 (basic) + localhost. Good enough to prevent emitting internal URLs in emails/PDFs.
    if (!hostname) return false
    if (hostname === 'localhost') return true
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true
    return false
  }

  const chooseBase = () => {
    const candidate = (envUrl || '').trim()
    if (!candidate) return fallback
    try {
      const u = new URL(candidate)
      if (isProbablyIp(u.hostname)) return fallback
      // Avoid emitting nonstandard ports in public links (common misconfig: :3000).
      const origin = `${u.protocol}//${u.hostname}`
      return origin
    } catch {
      return fallback
    }
  }

  const rawBase = chooseBase().trim()

  // Normalize: force https and strip trailing slash.
  const httpsBase = rawBase.replace(/^http:\/\//i, 'https://')
  const base = httpsBase.replace(/\/$/, '')
  return `${base}/approve/estimate/${rawToken}`
}

export async function getOrCreateEstimateApprovalToken(params: {
  tenantId: string
  estimateId: string
  expiresInDays?: number
}): Promise<{ rawToken: string; url: string; expiresAt: Date | null }> {
  const now = new Date()
  const existing = await prisma.estimateApprovalToken.findFirst({
    where: {
      tenantId: params.tenantId,
      estimateId: params.estimateId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'desc' },
    select: { tokenEnc: true, expiresAt: true },
  })

  if (existing?.tokenEnc) {
    const rawToken = decryptToken(existing.tokenEnc)
    return { rawToken, url: buildPublicApproveEstimateUrl(rawToken), expiresAt: existing.expiresAt || null }
  }

  const rawToken = crypto.randomBytes(APPROVAL_TOKEN_BYTES).toString('hex')
  const tokenHash = hashApprovalToken(rawToken)
  const tokenEnc = encryptToken(rawToken)
  const expiresAt =
    typeof params.expiresInDays === 'number'
      ? new Date(Date.now() + params.expiresInDays * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000)

  await prisma.estimateApprovalToken.create({
    data: {
      tenantId: params.tenantId,
      estimateId: params.estimateId,
      tokenHash,
      tokenEnc,
      expiresAt,
    },
  })

  return { rawToken, url: buildPublicApproveEstimateUrl(rawToken), expiresAt }
}

export async function resolveEstimateApprovalToken(rawToken: string) {
  const tokenHash = hashApprovalToken(rawToken)
  const now = new Date()
  const token = await prisma.estimateApprovalToken.findFirst({
    where: {
      tokenHash,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  })
  return token || null
}

export async function revokeAndRotateEstimateApprovalToken(params: {
  tenantId: string
  estimateId: string
}): Promise<{ rawToken: string; url: string; expiresAt: Date | null }> {
  const now = new Date()
  await prisma.estimateApprovalToken.updateMany({
    where: {
      tenantId: params.tenantId,
      estimateId: params.estimateId,
      revokedAt: null,
    },
    data: { revokedAt: now },
  })
  return getOrCreateEstimateApprovalToken({ tenantId: params.tenantId, estimateId: params.estimateId })
}


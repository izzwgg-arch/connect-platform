import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { encryptSecrets } from '@/lib/integrations/secrets'
import { isValidEmail } from '@/lib/email'

const createSchema = z.object({
  displayName: z.string().min(1).max(120),
  fromEmail: z.string().email(),
  fromName: z.string().max(120).optional(),
  replyToEmail: z.string().email().optional().or(z.literal('')),
  smtpUser: z.string().email(),
  smtpAppPassword: z.string().min(8).max(200),
})

function requireAdmin(user: { role?: string }) {
  return String(user.role || '') === 'ADMIN'
}

function mapIntegrationForResponse(integration: any) {
  return {
    id: integration.id,
    provider: integration.provider,
    status: integration.status,
    displayName: integration.displayName,
    fromEmail: integration.fromEmail,
    fromName: integration.fromName,
    replyToEmail: integration.replyToEmail,
    isActive: integration.isActive,
    lastTestedAt: integration.lastTestedAt?.toISOString() || null,
    lastError: integration.lastError,
    assignmentsCount: integration._count?.assignments || 0,
    createdAt: integration.createdAt.toISOString(),
    updatedAt: integration.updatedAt.toISOString(),
  }
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError
  const user = getAuthUser(request)

  const db = prisma as any
  const integrations = await db.emailIntegration.findMany({
    where: { tenantId: user.tenantId },
    include: {
      _count: {
        select: { assignments: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({
    integrations: integrations.map(mapIntegrationForResponse),
    fallbackSender: {
      fromEmail: process.env.EMAIL_FROM || process.env.EMAIL_FROM_NAME || 'noreply@trimpro.com',
      fromName: process.env.FROM_NAME || 'Trim Pro',
      replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'noreply@trimpro.com',
      note: 'Used for all platform/system emails and as fallback for invoice/estimate sends.',
    },
  })
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError
  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const parsed = createSchema.parse(body)
    if (parsed.replyToEmail && !isValidEmail(parsed.replyToEmail)) {
      return NextResponse.json({ error: 'Invalid reply-to email' }, { status: 400 })
    }

    const encryptedCredentials = encryptSecrets({
      smtpUser: parsed.smtpUser.trim(),
      smtpAppPassword: parsed.smtpAppPassword,
    })

    const db = prisma as any
    const integration = await db.emailIntegration.create({
      data: {
        tenantId: user.tenantId,
        provider: 'GOOGLE_WORKSPACE',
        status: 'ACTIVE',
        displayName: parsed.displayName.trim(),
        fromEmail: parsed.fromEmail.trim(),
        fromName: parsed.fromName?.trim() || null,
        replyToEmail: parsed.replyToEmail?.trim() || null,
        encryptedCredentials,
        createdById: user.id,
        updatedById: user.id,
      },
      include: {
        _count: {
          select: { assignments: true },
        },
      },
    })

    return NextResponse.json({ integration: mapIntegrationForResponse(integration) })
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.errors }, { status: 400 })
    }
    if (error?.code === 'P2002') {
      return NextResponse.json(
        { error: 'An integration with this sender email already exists.' },
        { status: 409 }
      )
    }
    console.error('Create email integration error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

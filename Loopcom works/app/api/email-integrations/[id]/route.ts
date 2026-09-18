import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { decryptSecrets, encryptSecrets } from '@/lib/integrations/secrets'
import { isValidEmail } from '@/lib/email'

const updateSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  fromEmail: z.string().email().optional(),
  fromName: z.string().max(120).optional().or(z.literal('')),
  replyToEmail: z.string().email().optional().or(z.literal('')),
  smtpUser: z.string().email().optional(),
  smtpAppPassword: z.string().min(8).max(200).optional(),
  isActive: z.boolean().optional(),
})

function isAdmin(user: { role?: string }) {
  return String(user.role || '') === 'ADMIN'
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError
  const user = getAuthUser(request)

  const db = prisma as any
  const integration = await db.emailIntegration.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    include: {
      _count: {
        select: { assignments: true },
      },
    },
  })
  if (!integration) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    integration: {
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
      assignmentsCount: integration._count.assignments,
      // never expose secrets; frontend can re-enter app password when needed
      hasStoredCredentials: true,
    },
  })
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError
  const user = getAuthUser(request)

  const db = prisma as any
  const integration = await db.emailIntegration.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  })
  if (!integration) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    const body = await request.json()
    const parsed = updateSchema.parse(body)
    if (parsed.replyToEmail && !isValidEmail(parsed.replyToEmail)) {
      return NextResponse.json({ error: 'Invalid reply-to email' }, { status: 400 })
    }

    let encryptedCredentials: string | undefined
    if (parsed.smtpUser || parsed.smtpAppPassword) {
      const current = decryptSecrets(integration.encryptedCredentials)
      encryptedCredentials = encryptSecrets({
        smtpUser: parsed.smtpUser?.trim() || String(current.smtpUser || '').trim(),
        smtpAppPassword: parsed.smtpAppPassword || String(current.smtpAppPassword || ''),
      })
    }

    const updated = await db.emailIntegration.update({
      where: { id: integration.id },
      data: {
        displayName: parsed.displayName?.trim(),
        fromEmail: parsed.fromEmail?.trim(),
        fromName: parsed.fromName !== undefined ? parsed.fromName.trim() || null : undefined,
        replyToEmail:
          parsed.replyToEmail !== undefined ? parsed.replyToEmail.trim() || null : undefined,
        isActive: parsed.isActive,
        encryptedCredentials,
        updatedById: user.id,
      },
    })

    return NextResponse.json({
      integration: {
        id: updated.id,
        provider: updated.provider,
        status: updated.status,
        displayName: updated.displayName,
        fromEmail: updated.fromEmail,
        fromName: updated.fromName,
        replyToEmail: updated.replyToEmail,
        isActive: updated.isActive,
        lastTestedAt: updated.lastTestedAt?.toISOString() || null,
        lastError: updated.lastError,
      },
    })
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.errors }, { status: 400 })
    }
    if (error?.code === 'P2002') {
      return NextResponse.json({ error: 'Sender email must be unique per tenant' }, { status: 409 })
    }
    console.error('Update email integration error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError
  const user = getAuthUser(request)

  const db = prisma as any
  const integration = await db.emailIntegration.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  })
  if (!integration) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await db.userEmailIntegrationAssignment.deleteMany({
    where: { tenantId: user.tenantId, integrationId: integration.id },
  })
  await db.emailIntegration.delete({ where: { id: integration.id } })
  return NextResponse.json({ success: true })
}

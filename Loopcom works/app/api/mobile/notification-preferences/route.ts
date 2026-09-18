import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  normalizeNotificationPreferences,
  type NotificationPreferenceKey,
} from '@/lib/notifications/preferences'

const KEYS: NotificationPreferenceKey[] = [
  'requestStatusChanges',
  'jobStatusChanges',
  'newMessage',
  'newJobAssigned',
  'paymentReceived',
  'emailNotifications',
]

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const user = getAuthUser(request)

  const row = await prisma.user.findFirst({
    where: { id: user.id, tenantId: user.tenantId },
    select: { notificationPreferences: true },
  })

  return NextResponse.json({
    preferences: normalizeNotificationPreferences(row?.notificationPreferences),
  })
}

export async function PATCH(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const user = getAuthUser(request)

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const incoming = body?.preferences && typeof body.preferences === 'object' ? body.preferences : body
  const currentRow = await prisma.user.findFirst({
    where: { id: user.id, tenantId: user.tenantId },
    select: { notificationPreferences: true },
  })
  const current = normalizeNotificationPreferences(currentRow?.notificationPreferences)
  const next = { ...current }

  for (const key of KEYS) {
    if (typeof incoming?.[key] === 'boolean') {
      next[key] = incoming[key]
    }
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { notificationPreferences: next },
  })

  return NextResponse.json({
    preferences: next,
    defaults: DEFAULT_NOTIFICATION_PREFERENCES,
  })
}

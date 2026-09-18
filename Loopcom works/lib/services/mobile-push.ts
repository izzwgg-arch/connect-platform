import { prisma } from '@/lib/prisma'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'

export type PushPayload = {
  title: string
  body?: string | null
  data?: Record<string, any>
}

export type RegisterPushDeviceInput = {
  tenantId: string
  userId: string
  expoPushToken: string
  platform: string
  deviceId?: string | null
  appVersion?: string | null
  buildNumber?: string | null
  locale?: string | null
  timezone?: string | null
}

function isExpoToken(token: string) {
  return token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')
}

function maskedToken(token: string) {
  if (token.length <= 12) return token
  return `${token.slice(0, 8)}...${token.slice(-4)}`
}

function chunkArray<T>(rows: T[], size: number) {
  const chunks: T[][] = []
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size))
  return chunks
}

export async function registerUserPushDevice(input: RegisterPushDeviceInput) {
  const token = String(input.expoPushToken || '').trim()
  if (!token || !isExpoToken(token)) {
    throw new Error('Invalid Expo push token')
  }

  return prisma.userPushDevice.upsert({
    where: { expoPushToken: token },
    create: {
      tenantId: input.tenantId,
      userId: input.userId,
      expoPushToken: token,
      platform: String(input.platform || 'unknown'),
      deviceId: input.deviceId || null,
      appVersion: input.appVersion || null,
      buildNumber: input.buildNumber || null,
      locale: input.locale || null,
      timezone: input.timezone || null,
      disabledAt: null,
      lastSeenAt: new Date(),
    },
    update: {
      tenantId: input.tenantId,
      userId: input.userId,
      platform: String(input.platform || 'unknown'),
      deviceId: input.deviceId || null,
      appVersion: input.appVersion || null,
      buildNumber: input.buildNumber || null,
      locale: input.locale || null,
      timezone: input.timezone || null,
      disabledAt: null,
      lastSeenAt: new Date(),
    },
  })
}

export async function unregisterUserPushDevice(params: {
  tenantId: string
  userId: string
  expoPushToken?: string | null
  deviceId?: string | null
}) {
  const where: any = {
    tenantId: params.tenantId,
    userId: params.userId,
    disabledAt: null,
  }
  if (params.expoPushToken) where.expoPushToken = String(params.expoPushToken).trim()
  if (!params.expoPushToken && params.deviceId) where.deviceId = String(params.deviceId).trim()

  return prisma.userPushDevice.updateMany({
    where,
    data: {
      disabledAt: new Date(),
      lastSeenAt: new Date(),
    },
  })
}

async function disableToken(token: string) {
  await prisma.userPushDevice.updateMany({
    where: { expoPushToken: token, disabledAt: null },
    data: { disabledAt: new Date() },
  })
}

type PushSendResult = {
  tickets: Array<{ id?: string; status?: string; message?: string; details?: any }>
  receiptErrors: Array<{ id: string; status?: string; message?: string; details?: any }>
}

export async function sendPushToDevices(params: {
  traceId: string
  tenantId: string
  recipientUserId: string
  payload: PushPayload
}) {
  const devices = await prisma.userPushDevice.findMany({
    where: {
      tenantId: params.tenantId,
      userId: params.recipientUserId,
      disabledAt: null,
    },
    select: {
      expoPushToken: true,
    },
  })
  const tokens = Array.from(new Set(devices.map((d) => d.expoPushToken).filter(Boolean)))
  if (tokens.length === 0) {
    console.info(
      JSON.stringify({
        area: 'push',
        event: 'no_tokens',
        traceId: params.traceId,
        tenantId: params.tenantId,
        recipientUserId: params.recipientUserId,
      })
    )
    return { sent: 0, failed: 0, tickets: [] as PushSendResult['tickets'], receiptErrors: [] as PushSendResult['receiptErrors'] }
  }

  const messages = tokens.map((token) => ({
    to: token,
    sound: 'default',
    channelId: 'trimpro-default',
    title: params.payload.title,
    body: params.payload.body || undefined,
    data: params.payload.data || {},
    priority: 'high',
  }))

  const tickets: PushSendResult['tickets'] = []
  for (const chunk of chunkArray(messages, 100)) {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    })
    const payload = await response.json().catch(() => ({}))
    const data = Array.isArray(payload?.data) ? payload.data : []
    for (const ticket of data) tickets.push(ticket)
  }

  let sent = 0
  let failed = 0
  const ticketIds: string[] = []
  const failedTickets: Array<{ status?: string; message?: string; details?: any }> = []
  for (const ticket of tickets) {
    if (ticket?.status === 'ok') {
      sent += 1
      if (ticket?.id) ticketIds.push(String(ticket.id))
      continue
    }
    failed += 1
    failedTickets.push({
      status: ticket?.status,
      message: ticket?.message,
      details: ticket?.details,
    })
    const errorCode = String(ticket?.details?.error || '')
    if (errorCode === 'DeviceNotRegistered') {
      const target = messages.find((m) => m.to === ticket?.details?.expoPushToken)
      if (target?.to) await disableToken(target.to)
    }
  }

  const receiptErrors: PushSendResult['receiptErrors'] = []
  if (ticketIds.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1300))
    const receiptRes = await fetch(EXPO_RECEIPTS_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ticketIds }),
    })
    const receiptJson = await receiptRes.json().catch(() => ({}))
    const receiptData = receiptJson?.data && typeof receiptJson.data === 'object' ? receiptJson.data : {}
    for (const [id, receipt] of Object.entries<any>(receiptData)) {
      if (receipt?.status === 'ok') continue
      receiptErrors.push({
        id,
        status: receipt?.status,
        message: receipt?.message,
        details: receipt?.details,
      })
      if (String(receipt?.details?.error || '') === 'DeviceNotRegistered') {
        // We do not get token in receipt; disable all tokens for this recipient as safe fallback.
        await prisma.userPushDevice.updateMany({
          where: {
            tenantId: params.tenantId,
            userId: params.recipientUserId,
            disabledAt: null,
          },
          data: { disabledAt: new Date() },
        })
      }
    }
  }

  console.info(
    JSON.stringify({
      area: 'push',
      event: 'send_complete',
      traceId: params.traceId,
      tenantId: params.tenantId,
      recipientUserId: params.recipientUserId,
      tokensCount: tokens.length,
      sent,
      failed,
      ticketIds,
      failedTickets: failedTickets.slice(0, 3),
      receiptErrorCount: receiptErrors.length,
      receiptErrors: receiptErrors.slice(0, 3),
      tokenSample: tokens.slice(0, 3).map(maskedToken),
    })
  )

  return { sent, failed, tickets, receiptErrors }
}

export async function sendPushToUser(userId: string, payload: PushPayload) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, tenantId: true },
  })
  if (!user) return
  await sendPushToDevices({
    traceId: `legacy_${Date.now()}_${user.id}`,
    tenantId: user.tenantId,
    recipientUserId: user.id,
    payload,
  })
}

export async function sendPushToUsers(userIds: string[], payload: PushPayload) {
  if (userIds.length === 0) return
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, tenantId: true },
  })
  await Promise.all(
    users.map((u) =>
      sendPushToDevices({
        traceId: `legacy_${Date.now()}_${u.id}`,
        tenantId: u.tenantId,
        recipientUserId: u.id,
        payload,
      })
    )
  )
}


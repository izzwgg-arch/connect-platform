import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const user = getAuthUser(request)

  const devices = await prisma.userPushDevice.findMany({
    where: {
      tenantId: user.tenantId,
      userId: user.id,
    },
    orderBy: { updatedAt: 'desc' },
    take: 5,
    select: {
      expoPushToken: true,
      platform: true,
      deviceId: true,
      appVersion: true,
      buildNumber: true,
      disabledAt: true,
      lastSeenAt: true,
      updatedAt: true,
    },
  })

  const masked = devices.map((d) => ({
    ...d,
    expoPushToken:
      d.expoPushToken.length > 14
        ? `${d.expoPushToken.slice(0, 10)}...${d.expoPushToken.slice(-4)}`
        : d.expoPushToken,
  }))

  return NextResponse.json({ devices: masked })
}

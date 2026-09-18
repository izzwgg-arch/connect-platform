import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { generateAccessToken, generateRefreshToken, createRefreshToken } from '@/lib/auth'

type LoginUser = {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  avatar: string | null
  role: string
  tenantId: string
  allowWebLogin: boolean
  allowMobileLogin: boolean
  tenant: { name: string }
}

export async function completeLoginResponse(
  request: NextRequest,
  user: LoginUser,
  clientType: 'web' | 'mobile',
  deviceId?: string
) {
  const payload = {
    userId: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
  }

  const accessToken = generateAccessToken(payload)
  const refreshToken = generateRefreshToken(payload)
  const normalizedDeviceId =
    typeof deviceId === 'string' && deviceId.trim().length > 0
      ? deviceId.trim()
      : crypto.randomUUID()

  await createRefreshToken(user.id, refreshToken, normalizedDeviceId)

  const ipAddress =
    request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
  await prisma.user.update({
    where: { id: user.id },
    data: {
      lastLoginAt: new Date(),
      lastLoginIp: ipAddress,
    },
  })

  await prisma.auditLog.create({
    data: {
      tenantId: user.tenantId,
      userId: user.id,
      action: 'LOGIN',
      entityType: 'User',
      entityId: user.id,
      ipAddress: ipAddress,
      userAgent: request.headers.get('user-agent') || undefined,
    },
  })

  return NextResponse.json({
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar,
      role: user.role,
      tenantId: user.tenantId,
      tenantName: user.tenant.name,
      allowWebLogin: user.allowWebLogin,
      allowMobileLogin: user.allowMobileLogin,
    },
  })
}

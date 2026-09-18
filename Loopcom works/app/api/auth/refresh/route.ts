import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  verifyRefreshToken,
  generateAccessToken,
  deleteRefreshToken,
  generateRefreshToken,
  createRefreshToken,
  getRefreshTokenRecord,
} from '@/lib/auth'

export async function POST(request: NextRequest) {
  try {
    const { refreshToken, deviceId, clientType } = await request.json()
    const normalizedClientType = String(clientType || '').trim().toLowerCase() === 'mobile' ? 'mobile' : 'web'

    if (!refreshToken) {
      return NextResponse.json({ error: 'Refresh token required' }, { status: 400 })
    }

    // Verify refresh token
    let payload
    try {
      payload = verifyRefreshToken(refreshToken)
    } catch (error) {
      return NextResponse.json({ error: 'Invalid refresh token' }, { status: 401 })
    }

    // Check if token exists in database
    const tokenRecord = await getRefreshTokenRecord(refreshToken)

    if (!tokenRecord || tokenRecord.expiresAt < new Date() || tokenRecord.revokedAt) {
      await deleteRefreshToken(refreshToken)
      return NextResponse.json({ error: 'Refresh token expired' }, { status: 401 })
    }

    // Check if user is still active
    if (tokenRecord.user.status !== 'ACTIVE') {
      await deleteRefreshToken(refreshToken)
      return NextResponse.json({ error: 'User is not active' }, { status: 401 })
    }

    if (normalizedClientType === 'mobile' && !tokenRecord.user.allowMobileLogin) {
      await deleteRefreshToken(refreshToken)
      return NextResponse.json({ error: 'This user is not allowed to use the phone app.' }, { status: 401 })
    }
    if (normalizedClientType === 'web' && !tokenRecord.user.allowWebLogin) {
      await deleteRefreshToken(refreshToken)
      return NextResponse.json({ error: 'This user is not allowed to log in to the web app.' }, { status: 401 })
    }

    // Generate new tokens
    const newPayload = {
      userId: payload.userId,
      tenantId: payload.tenantId,
      email: payload.email,
      role: payload.role,
    }

    const newAccessToken = generateAccessToken(newPayload)
    const newRefreshToken = generateRefreshToken(newPayload)
    const normalizedDeviceId =
      typeof deviceId === 'string' && deviceId.trim().length > 0
        ? deviceId.trim()
        : tokenRecord.deviceId

    // Replace old refresh token with new one
    await deleteRefreshToken(refreshToken)
    await createRefreshToken(payload.userId, newRefreshToken, normalizedDeviceId)
    await prisma.refreshToken.updateMany({
      where: {
        userId: payload.userId,
        deviceId: normalizedDeviceId,
        revokedAt: null,
      },
      data: {
        lastUsedAt: new Date(),
      },
    })

    return NextResponse.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    })
  } catch (error) {
    console.error('Refresh token error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

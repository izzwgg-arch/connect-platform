import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { registerUserPushDevice, unregisterUserPushDevice } from '@/lib/services/mobile-push'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const token = String(body?.token || body?.expoPushToken || '').trim()
    const platform = String(body?.platform || '').trim()
    const deviceId = body?.deviceId ? String(body.deviceId) : null
    const appVersion = body?.appVersion ? String(body.appVersion) : null
    const buildNumber = body?.buildNumber ? String(body.buildNumber) : null
    const locale = body?.locale ? String(body.locale) : null
    const timezone = body?.timezone ? String(body.timezone) : null

    if (!token) {
      return NextResponse.json({ error: 'token is required' }, { status: 400 })
    }

    console.info(
      JSON.stringify({
        area: 'push',
        event: 'register_attempt',
        tenantId: user.tenantId,
        userId: user.id,
        platform: platform || 'unknown',
        deviceId: deviceId || null,
        tokenPrefix: token.slice(0, 12),
      })
    )

    await registerUserPushDevice({
      tenantId: user.tenantId,
      userId: user.id,
      expoPushToken: token,
      platform: platform || 'unknown',
      deviceId,
      appVersion,
      buildNumber,
      locale,
      timezone,
    })

    console.info(
      JSON.stringify({
        area: 'push',
        event: 'register_success',
        tenantId: user.tenantId,
        userId: user.id,
        platform: platform || 'unknown',
        deviceId: deviceId || null,
        tokenPrefix: token.slice(0, 12),
      })
    )

    return NextResponse.json({ success: true, tokenRegistered: true })
  } catch (error) {
    console.error('Mobile push token registration error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const token = body?.token ? String(body.token) : null
    const deviceId = body?.deviceId ? String(body.deviceId) : null
    await unregisterUserPushDevice({
      tenantId: user.tenantId,
      userId: user.id,
      expoPushToken: token,
      deviceId,
    })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Mobile push token unregister error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}


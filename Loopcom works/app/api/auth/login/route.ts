import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifyPassword } from '@/lib/auth'
import { completeLoginResponse } from '@/lib/auth/complete-login'

export async function POST(request: NextRequest) {
  try {
    const { email, password, deviceId, clientType } = await request.json()
    const normalizedClientType = String(clientType || '').trim().toLowerCase() === 'mobile' ? 'mobile' : 'web'

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
    }

    // Find user
    const user = await prisma.user.findFirst({
      where: {
        email: email.toLowerCase(),
        status: 'ACTIVE',
      },
      include: {
        tenant: true,
      },
    })

    if (!user || !user.passwordHash) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    // Check if user has temporary password
    if (user.temporaryPassword && user.temporaryPasswordExp && new Date() < user.temporaryPasswordExp) {
      const isTemporaryPassword = await verifyPassword(password, user.temporaryPassword)
      if (isTemporaryPassword) {
        // User must set a new password
        return NextResponse.json(
          {
            error: 'Temporary password detected. Please set a new password.',
            requiresPasswordChange: true,
            userId: user.id,
          },
          { status: 403 }
        )
      }
    }

    // Verify password
    const isValid = await verifyPassword(password, user.passwordHash)
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    if (normalizedClientType === 'mobile' && !user.allowMobileLogin) {
      return NextResponse.json({ error: 'This user is not allowed to use the phone app.' }, { status: 403 })
    }
    if (normalizedClientType === 'web' && !user.allowWebLogin) {
      return NextResponse.json({ error: 'This user is not allowed to log in to the web app.' }, { status: 403 })
    }

    return completeLoginResponse(request, user, normalizedClientType, deviceId)
  } catch (error) {
    console.error('Login error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

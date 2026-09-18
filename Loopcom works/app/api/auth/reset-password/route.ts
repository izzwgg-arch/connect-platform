import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hashPassword, verifyAccessToken } from '@/lib/auth'

export async function POST(request: NextRequest) {
  try {
    const { token, newPassword } = await request.json()

    if (!token || !newPassword) {
      return NextResponse.json({ error: 'Token and new password are required' }, { status: 400 })
    }

    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }

    // Verify token
    try {
      verifyAccessToken(token)
    } catch (error) {
      return NextResponse.json({ error: 'Invalid or expired reset token' }, { status: 401 })
    }

    // Find user with this reset token
    const user = await prisma.user.findUnique({
      where: {
        passwordResetToken: token,
      },
    })

    if (!user || !user.passwordResetExp || new Date() > user.passwordResetExp) {
      return NextResponse.json({ error: 'Invalid or expired reset token' }, { status: 401 })
    }

    // Hash new password
    const passwordHash = await hashPassword(newPassword)

    // Update user and clear reset token
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetToken: null,
        passwordResetExp: null,
        temporaryPassword: null,
        temporaryPasswordExp: null,
        status: user.status === 'INVITED' ? 'ACTIVE' : user.status,
        lastPasswordChange: new Date(),
      },
    })

    // Create audit log
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'PASSWORD_RESET',
        entityType: 'User',
        entityId: user.id,
        changes: {
          field: 'password',
          action: 'password_reset',
        },
      },
    })

    return NextResponse.json({ message: 'Password reset successfully. Please log in.' })
  } catch (error) {
    console.error('Reset password error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

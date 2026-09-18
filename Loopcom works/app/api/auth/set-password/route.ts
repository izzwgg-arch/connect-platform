import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hashPassword, verifyPassword, generatePasswordResetToken } from '@/lib/auth'

export async function POST(request: NextRequest) {
  try {
    const { userId, temporaryPassword, newPassword } = await request.json()

    if (!userId || !newPassword) {
      return NextResponse.json({ error: 'User ID and new password are required' }, { status: 400 })
    }

    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { id: userId },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // If temporary password is provided, verify it
    if (temporaryPassword && user.temporaryPassword) {
      const isValid = await verifyPassword(temporaryPassword, user.temporaryPassword)
      if (!isValid) {
        return NextResponse.json({ error: 'Invalid temporary password' }, { status: 401 })
      }

      // Check if temporary password expired
      if (user.temporaryPasswordExp && new Date() > user.temporaryPasswordExp) {
        return NextResponse.json({ error: 'Temporary password has expired' }, { status: 401 })
      }
    } else if (user.temporaryPassword) {
      // User must provide temporary password
      return NextResponse.json({ error: 'Temporary password required' }, { status: 403 })
    }

    // Hash new password
    const passwordHash = await hashPassword(newPassword)

    // Update user
    await prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        temporaryPassword: null,
        temporaryPasswordExp: null,
        lastPasswordChange: new Date(),
      },
    })

    // Create audit log
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entityType: 'User',
        entityId: user.id,
        changes: {
          field: 'password',
          action: 'password_set',
        },
      },
    })

    return NextResponse.json({ message: 'Password set successfully. Please log in again.' })
  } catch (error) {
    console.error('Set password error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

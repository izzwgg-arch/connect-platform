import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { generatePasswordResetToken } from '@/lib/auth'
// import { sendPasswordResetEmail } from '@/lib/email' // TODO: Implement email service

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json()

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    // Find user
    const user = await prisma.user.findFirst({
      where: {
        email: email.toLowerCase(),
        status: 'ACTIVE',
      },
    })

    // Always return success (don't reveal if user exists)
    if (!user) {
      return NextResponse.json({ message: 'If the email exists, a password reset link has been sent.' })
    }

    // Generate reset token
    const resetToken = generatePasswordResetToken()
    const resetExp = new Date()
    resetExp.setHours(resetExp.getHours() + 1) // 1 hour expiry

    // Save token to user
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: resetToken,
        passwordResetExp: resetExp,
      },
    })

    // Send email with reset link
    const resetUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/reset-password?token=${resetToken}`
    
    try {
      const { sendPasswordResetEmail } = await import('@/lib/services/email')
      await sendPasswordResetEmail(user.email, resetUrl)
    } catch (error) {
      console.error('Failed to send password reset email:', error)
      // Continue anyway - log the reset URL for manual use if email fails
      console.log('Password reset URL:', resetUrl) // Remove in production
    }

    // Create audit log
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'PASSWORD_RESET',
        entityType: 'User',
        entityId: user.id,
      },
    })

    return NextResponse.json({ message: 'If the email exists, a password reset link has been sent.' })
  } catch (error) {
    console.error('Forgot password error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

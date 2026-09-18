import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { generatePasswordResetToken } from '@/lib/auth'
import { getDefaultPermissions } from '@/lib/permissions'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { testEmailProvider } from '@/lib/integrations/providers/email'
import { getEmailBranding } from '@/lib/email/branding'
import { parseAssignedJobTypes } from '@/lib/jobs/job-type-scope'

const ALLOWED_ROLES = new Set(['ADMIN', 'MANAGER', 'OFFICE', 'FIELD', 'SALES', 'ACCOUNTING'])

export async function POST(request: NextRequest) {
  // Authenticate
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'users.create')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const {
      email,
      firstName,
      lastName,
      phone,
      role,
      roleId,
      allowWebLogin,
      allowMobileLogin,
      assignedJobTypes,
    } = await request.json()

    const resolvedAssignedJobTypes = parseAssignedJobTypes(assignedJobTypes)

    if (!email || !firstName || !lastName || (!role && !roleId)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    let selectedRoleRecord: {
      id: string
      name: string
      permissions: Array<{ permission: { key: string } }>
    } | null = null
    if (typeof roleId === 'string' && roleId.trim()) {
      selectedRoleRecord = await prisma.role.findFirst({
        where: {
          id: roleId.trim(),
          tenantId: user.tenantId,
          isActive: true,
        },
        include: {
          permissions: {
            include: {
              permission: {
                select: { key: true },
              },
            },
          },
        },
      })

      if (!selectedRoleRecord) {
        return NextResponse.json({ error: 'Selected role not found' }, { status: 400 })
      }
    }

    const normalizedRole = selectedRoleRecord
      ? (ALLOWED_ROLES.has(selectedRoleRecord.name.toUpperCase()) ? selectedRoleRecord.name.toUpperCase() : 'OFFICE')
      : String(role).trim().toUpperCase()
    if (!ALLOWED_ROLES.has(normalizedRole)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
    }

    // Check if user already exists
    const existing = await prisma.user.findFirst({
      where: {
        tenantId: user.tenantId,
        email: email.toLowerCase(),
      },
    })

    if (existing) {
      return NextResponse.json({ error: 'User already exists' }, { status: 400 })
    }

    // Generate password creation token for invite flow
    const inviteToken = generatePasswordResetToken('7d')
    const inviteExp = new Date()
    inviteExp.setDate(inviteExp.getDate() + 7)

    // Use selected role permissions when a role assignment is selected; fallback to enum defaults.
    const permissions =
      selectedRoleRecord && selectedRoleRecord.permissions.length > 0
        ? selectedRoleRecord.permissions.map((rp) => rp.permission.key)
        : getDefaultPermissions(normalizedRole)

    // Create user
    const newUser = await prisma.user.create({
      data: {
        tenantId: user.tenantId,
        email: email.toLowerCase(),
        firstName,
        lastName,
        phone: phone || null,
        role: normalizedRole as any,
        status: 'INVITED',
        allowWebLogin: allowWebLogin !== false,
        allowMobileLogin: allowMobileLogin !== false,
        assignedJobTypes: resolvedAssignedJobTypes,
        passwordResetToken: inviteToken,
        passwordResetExp: inviteExp,
        permissions,
      },
    })

    // Assign role record (custom or system) for RBAC-aware permission resolution.
    if (selectedRoleRecord) {
      await prisma.userRoleAssignment.create({
        data: {
          userId: newUser.id,
          roleId: selectedRoleRecord.id,
          assignedBy: user.id,
        },
      })
    } else {
      const fallbackRole = await prisma.role.findFirst({
        where: {
          tenantId: user.tenantId,
          name: normalizedRole,
          isActive: true,
        },
        select: { id: true },
      })
      if (fallbackRole) {
        await prisma.userRoleAssignment.create({
          data: {
            userId: newUser.id,
            roleId: fallbackRole.id,
            assignedBy: user.id,
          },
        })
      }
    }

    // Create audit log for user creation
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'CREATE',
        entityType: 'User',
        entityId: newUser.id,
        changes: {
          email,
          firstName,
          lastName,
          role: normalizedRole,
          allowWebLogin: newUser.allowWebLogin,
          allowMobileLogin: newUser.allowMobileLogin,
          selectedRoleId: selectedRoleRecord?.id || null,
          selectedRoleName: selectedRoleRecord?.name || normalizedRole,
        },
      },
    })

    // Send invite email with password creation link and APK download link.
    const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.trimprony.com'
    const setPasswordUrl = `${appBaseUrl}/auth/reset-password?token=${encodeURIComponent(inviteToken)}`
    const apkDownloadUrl =
      process.env.TRIMPRO_FIELD_APK_URL ||
      process.env.EXPO_ANDROID_APK_URL ||
      `${appBaseUrl}/download`
    let emailSent = false
    let emailError: string | null = null
    const emailBranding = await getEmailBranding(user.tenantId)
    const brandLogoUrl = emailBranding?.emailLogoUrl || emailBranding?.webLogoUrl || null
    try {
      const { sendInviteEmail, buildInviteEmailHtml } = await import('@/lib/services/email')
      const emailSecrets = await getIntegrationSecrets(user.tenantId, 'email')

      if (emailSecrets) {
        const html = buildInviteEmailHtml(firstName, setPasswordUrl, apkDownloadUrl, brandLogoUrl)
        const subject = 'Welcome to TrimPro - Create Your Password'
        const sendResult = await testEmailProvider(emailSecrets, email, subject, html)
        if (!sendResult.success) {
          emailError = sendResult.error || sendResult.message || 'Failed to send invite email'
        } else {
          emailSent = true
        }
      } else {
        // Fallback to env-based provider when tenant integration is not configured.
        await sendInviteEmail(email, firstName, setPasswordUrl, apkDownloadUrl, brandLogoUrl)
        emailSent = true
      }
    } catch (error: any) {
      console.error('Failed to send invite email:', error)
      emailError = error?.message || 'Invitation email failed to send'
    }

    return NextResponse.json(
      {
        message: emailSent ? 'User invited successfully' : 'User invited, but email send failed',
        emailSent,
        emailError,
        user: {
          id: newUser.id,
          email: newUser.email,
          firstName: newUser.firstName,
          lastName: newUser.lastName,
          role: newUser.role,
          status: newUser.status,
          allowWebLogin: newUser.allowWebLogin,
          allowMobileLogin: newUser.allowMobileLogin,
        },
      },
      { status: emailSent ? 200 : 502 }
    )
  } catch (error) {
    console.error('Invite user error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

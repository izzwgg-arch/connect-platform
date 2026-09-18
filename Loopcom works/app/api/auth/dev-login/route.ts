import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { completeLoginResponse } from '@/lib/auth/complete-login'

const DEV_LOGIN_EMAIL = 'admin@trimpro.com'

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    const user = await prisma.user.findFirst({
      where: {
        email: DEV_LOGIN_EMAIL.toLowerCase(),
        status: 'ACTIVE',
      },
      include: {
        tenant: true,
      },
    })

    if (!user) {
      return NextResponse.json(
        {
          error: 'Dev user not found. Run npm run seed to create admin@trimpro.com.',
        },
        { status: 404 }
      )
    }

    if (!user.allowWebLogin) {
      return NextResponse.json(
        { error: 'Dev user is not allowed to log in to the web app.' },
        { status: 403 }
      )
    }

    return completeLoginResponse(request, user, 'web')
  } catch (error) {
    console.error('Dev login error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

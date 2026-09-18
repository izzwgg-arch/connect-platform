import { NextRequest, NextResponse } from 'next/server'
import { deleteRefreshToken } from '@/lib/auth'

export async function POST(request: NextRequest) {
  try {
    const { refreshToken } = await request.json()

    if (refreshToken) {
      await deleteRefreshToken(refreshToken)
    }

    return NextResponse.json({ message: 'Logged out successfully' })
  } catch (error) {
    console.error('Logout error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

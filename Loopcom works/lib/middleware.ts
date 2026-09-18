import { NextRequest, NextResponse } from 'next/server'
import { getUserFromToken } from './auth'

export interface AuthRequest extends NextRequest {
  user?: {
    id: string
    tenantId: string
    email: string
    role: string
  }
}

export async function authenticateRequest(request: NextRequest): Promise<NextResponse | null> {
  const authHeader = request.headers.get('authorization')
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = authHeader.substring(7)
  const user = await getUserFromToken(token)

  if (!user || user.status !== 'ACTIVE') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Attach user to request
  ;(request as any).user = {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
  }

  return null // No error, continue
}

export function getAuthUser(request: NextRequest) {
  return (request as any).user
}

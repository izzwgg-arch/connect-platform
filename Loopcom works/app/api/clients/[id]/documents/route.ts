import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { fetchClientDocuments } from '@/lib/documents/unified-documents'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'clients.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const documents = await fetchClientDocuments(user.tenantId, params.id)
    if (!documents) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    return NextResponse.json({ documents })
  } catch (error) {
    console.error('Client documents error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

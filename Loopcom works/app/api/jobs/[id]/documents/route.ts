import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireWebOrMobilePermission } from '@/lib/authorization'
import { fetchJobDocuments } from '@/lib/documents/unified-documents'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireWebOrMobilePermission(
    request,
    'jobs.view',
    'mobile.jobs.view_documents'
  )
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const documents = await fetchJobDocuments(user.tenantId, params.id)
    if (!documents) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    return NextResponse.json({ documents })
  } catch (error) {
    console.error('Job documents error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

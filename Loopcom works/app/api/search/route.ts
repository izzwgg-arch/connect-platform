import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { getUserPermissions, requirePermission } from '@/lib/authorization'
import { runGlobalSearch } from '@/lib/search/global-search'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'dashboard.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const { searchParams } = new URL(request.url)
  const q = (searchParams.get('q') ?? '').trim()
  const limitParam = parseInt(searchParams.get('limit') ?? '8', 10)
  const limitPerGroup = Math.min(Math.max(limitParam, 3), 15)

  if (!q || q.length < 2) {
    return NextResponse.json({ groups: [] })
  }

  if (q.length > 200) {
    return NextResponse.json({ error: 'Query too long' }, { status: 400 })
  }

  try {
    const permissions = await getUserPermissions(user.id, user.tenantId)

    const groups = await runGlobalSearch({
      query: q,
      tenantId: user.tenantId,
      permissions,
      limitPerGroup,
    })

    console.log(
      `[search] tenant=${user.tenantId} user=${user.id} q="${q}" groups=${groups.length} total=${groups.reduce((n, g) => n + g.results.length, 0)}`
    )

    return NextResponse.json({ groups })
  } catch (error) {
    console.error('[search] error:', error)
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }
}

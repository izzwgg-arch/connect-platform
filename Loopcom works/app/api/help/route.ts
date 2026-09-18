import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { applySmartSearch, buildSmartSearchAnd, ilike } from '@/lib/search/prisma-filters'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'dashboard.view')
  if (permError) return permError

  const user = getAuthUser(request)
  const searchParams = request.nextUrl.searchParams
  const search = searchParams.get('search') || ''
  const module = searchParams.get('module') || 'all'
  const category = searchParams.get('category') || 'all'
  const page = parseInt(searchParams.get('page') || '1')
  const limit = parseInt(searchParams.get('limit') || '50')
  const skip = (page - 1) * limit

  try {
    const where: any = {
      tenantId: user.tenantId,
    }

    applySmartSearch(
      where,
      buildSmartSearchAnd(search, (term) => [
        { title: ilike(term) },
        { content: ilike(term) },
        { category: ilike(term) },
        { module: ilike(term) },
      ])
    )

    if (module !== 'all') {
      where.module = module
    }

    if (category !== 'all') {
      where.category = category
    }

    const [articles, total] = await Promise.all([
      prisma.helpArticle.findMany({
        where,
        orderBy: [
          { order: 'asc' },
          { createdAt: 'desc' },
        ],
        skip,
        take: limit,
      }),
      prisma.helpArticle.count({ where }),
    ])

    return NextResponse.json({
      articles,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('Get help articles error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  // Check permissions - only admins can create help articles
  if (user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  try {
    const body = await request.json()
    const {
      title,
      content,
      module,
      category,
      isPublished,
      sortOrder,
    } = body

    if (!title || !content || !module) {
      return NextResponse.json({ error: 'Title, content, and module are required' }, { status: 400 })
    }

    // Create article
    const article = await prisma.helpArticle.create({
      data: {
        tenantId: user.tenantId,
        title,
        content,
        module,
        category: category || 'GENERAL',
        isPublished: isPublished !== undefined ? isPublished : true,
        order: sortOrder || 0,
      },
    })

    // Note: Activity creation would require a valid ActivityType enum value

    return NextResponse.json({ article }, { status: 201 })
  } catch (error) {
    console.error('Create help article error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

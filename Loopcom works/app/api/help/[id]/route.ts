import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'dashboard.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const article = await prisma.helpArticle.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!article) {
      return NextResponse.json({ error: 'Article not found' }, { status: 404 })
    }

    // Note: View tracking would require HelpArticleView model in schema

    // Get related articles
    const relatedArticles = await prisma.helpArticle.findMany({
      where: {
        tenantId: user.tenantId,
        id: {
          not: params.id,
        },
        OR: [
          { module: article.module },
          { category: article.category },
        ],
        isPublished: true,
      },
      take: 5,
      orderBy: {
        order: 'asc',
      },
      select: {
        id: true,
        title: true,
        module: true,
        category: true,
      },
    })

    return NextResponse.json({
      article,
      relatedArticles,
    })
  } catch (error) {
    console.error('Get help article error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  // Check permissions
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

    // Get existing article
    const existing = await prisma.helpArticle.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Article not found' }, { status: 404 })
    }

    // Update article
    const article = await prisma.helpArticle.update({
      where: { id: params.id },
      data: {
        title: title !== undefined ? title : existing.title,
        content: content !== undefined ? content : existing.content,
        module: module !== undefined ? module : existing.module,
        category: category !== undefined ? category : existing.category,
        isPublished: isPublished !== undefined ? isPublished : existing.isPublished,
        order: sortOrder !== undefined ? sortOrder : existing.order,
      },
    })

    return NextResponse.json({ article })
  } catch (error) {
    console.error('Update help article error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  // Check permissions
  if (user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  try {
    const article = await prisma.helpArticle.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!article) {
      return NextResponse.json({ error: 'Article not found' }, { status: 404 })
    }

    await prisma.helpArticle.delete({
      where: { id: params.id },
    })

    return NextResponse.json({ message: 'Article deleted successfully' })
  } catch (error) {
    console.error('Delete help article error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

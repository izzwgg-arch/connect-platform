import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

function serializeLine(line: any) {
  const quantity = Number(line.quantity || 0)
  const unitPrice = Number(line.unitPrice || 0)
  return {
    id: line.id,
    estimateId: line.estimateId,
    materialName: line.materialName,
    vendorName: line.vendorName,
    vendorId: line.vendorId,
    quantity,
    unit: line.unit,
    unitPrice,
    lineTotal: quantity * unitPrice,
    notes: line.notes,
    sortOrder: line.sortOrder,
    vendor: line.vendor
      ? {
          id: line.vendor.id,
          name: line.vendor.name,
        }
      : null,
    createdAt: line.createdAt,
    updatedAt: line.updatedAt,
  }
}

async function ensureEstimateAccess(estimateId: string, tenantId: string) {
  return prisma.estimate.findFirst({
    where: { id: estimateId, tenantId },
    select: { id: true, estimateNumber: true, title: true },
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['estimates.view', 'estimates.edit'])
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const estimate = await ensureEstimateAccess(params.id, user.tenantId)
    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    const lines = await prisma.estimateMaterialLine.findMany({
      where: { estimateId: params.id, tenantId: user.tenantId },
      include: {
        vendor: { select: { id: true, name: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    })

    const serialized = lines.map(serializeLine)
    const totalCost = serialized.reduce((sum, line) => sum + line.lineTotal, 0)

    return NextResponse.json({
      estimate: {
        id: estimate.id,
        estimateNumber: estimate.estimateNumber,
        title: estimate.title,
      },
      lines: serialized,
      totalCost,
    })
  } catch (error) {
    console.error('List estimate material lines error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['estimates.edit', 'estimates.create'])
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const estimate = await ensureEstimateAccess(params.id, user.tenantId)
    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const materialName = String(body?.materialName || '').trim()
    if (!materialName) {
      return NextResponse.json({ error: 'materialName is required' }, { status: 400 })
    }

    const vendorName = body?.vendorName != null ? String(body.vendorName).trim() || null : null
    const vendorId = body?.vendorId ? String(body.vendorId) : null
    const unit = body?.unit != null ? String(body.unit).trim() || null : null
    const notes = body?.notes != null ? String(body.notes).trim() || null : null
    const quantity = Number(body?.quantity ?? 1)
    const unitPrice = Number(body?.unitPrice ?? 0)

    if (!Number.isFinite(quantity) || quantity < 0) {
      return NextResponse.json({ error: 'quantity must be a non-negative number' }, { status: 400 })
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return NextResponse.json({ error: 'unitPrice must be a non-negative number' }, { status: 400 })
    }

    if (vendorId) {
      const vendor = await prisma.vendor.findFirst({
        where: { id: vendorId, tenantId: user.tenantId },
        select: { id: true },
      })
      if (!vendor) {
        return NextResponse.json({ error: 'Vendor not found' }, { status: 404 })
      }
    }

    const maxSort = await prisma.estimateMaterialLine.aggregate({
      where: { estimateId: params.id, tenantId: user.tenantId },
      _max: { sortOrder: true },
    })
    const sortOrder =
      body?.sortOrder != null && Number.isFinite(Number(body.sortOrder))
        ? Number(body.sortOrder)
        : (maxSort._max.sortOrder ?? -1) + 1

    const created = await prisma.estimateMaterialLine.create({
      data: {
        tenantId: user.tenantId,
        estimateId: params.id,
        materialName,
        vendorName,
        vendorId,
        quantity,
        unit,
        unitPrice,
        notes,
        sortOrder,
      },
      include: {
        vendor: { select: { id: true, name: true } },
      },
    })

    return NextResponse.json({ line: serializeLine(created) }, { status: 201 })
  } catch (error) {
    console.error('Create estimate material line error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['estimates.edit'])
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const estimate = await ensureEstimateAccess(params.id, user.tenantId)
    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const orderedIds = Array.isArray(body?.orderedIds)
      ? body.orderedIds.map((id: unknown) => String(id))
      : null

    if (!orderedIds) {
      return NextResponse.json({ error: 'orderedIds array is required' }, { status: 400 })
    }

    await prisma.$transaction(
      orderedIds.map((id: string, index: number) =>
        prisma.estimateMaterialLine.updateMany({
          where: { id, estimateId: params.id, tenantId: user.tenantId },
          data: { sortOrder: index },
        })
      )
    )

    const lines = await prisma.estimateMaterialLine.findMany({
      where: { estimateId: params.id, tenantId: user.tenantId },
      include: { vendor: { select: { id: true, name: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    })

    return NextResponse.json({ lines: lines.map(serializeLine) })
  } catch (error) {
    console.error('Reorder estimate material lines error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

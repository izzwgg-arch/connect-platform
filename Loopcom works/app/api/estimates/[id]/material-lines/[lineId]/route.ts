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

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; lineId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['estimates.edit'])
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const existing = await prisma.estimateMaterialLine.findFirst({
      where: {
        id: params.lineId,
        estimateId: params.id,
        tenantId: user.tenantId,
      },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Material line not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const data: Record<string, unknown> = {}

    if (body.materialName !== undefined) {
      const materialName = String(body.materialName || '').trim()
      if (!materialName) {
        return NextResponse.json({ error: 'materialName cannot be empty' }, { status: 400 })
      }
      data.materialName = materialName
    }
    if (body.vendorName !== undefined) {
      data.vendorName = String(body.vendorName || '').trim() || null
    }
    if (body.vendorId !== undefined) {
      const vendorId = body.vendorId ? String(body.vendorId) : null
      if (vendorId) {
        const vendor = await prisma.vendor.findFirst({
          where: { id: vendorId, tenantId: user.tenantId },
          select: { id: true },
        })
        if (!vendor) {
          return NextResponse.json({ error: 'Vendor not found' }, { status: 404 })
        }
      }
      data.vendorId = vendorId
    }
    if (body.unit !== undefined) {
      data.unit = String(body.unit || '').trim() || null
    }
    if (body.notes !== undefined) {
      data.notes = String(body.notes || '').trim() || null
    }
    if (body.quantity !== undefined) {
      const quantity = Number(body.quantity)
      if (!Number.isFinite(quantity) || quantity < 0) {
        return NextResponse.json({ error: 'quantity must be a non-negative number' }, { status: 400 })
      }
      data.quantity = quantity
    }
    if (body.unitPrice !== undefined) {
      const unitPrice = Number(body.unitPrice)
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        return NextResponse.json({ error: 'unitPrice must be a non-negative number' }, { status: 400 })
      }
      data.unitPrice = unitPrice
    }
    if (body.sortOrder !== undefined) {
      const sortOrder = Number(body.sortOrder)
      if (!Number.isFinite(sortOrder)) {
        return NextResponse.json({ error: 'sortOrder must be a number' }, { status: 400 })
      }
      data.sortOrder = sortOrder
    }

    const updated = await prisma.estimateMaterialLine.update({
      where: { id: existing.id },
      data,
      include: { vendor: { select: { id: true, name: true } } },
    })

    return NextResponse.json({ line: serializeLine(updated) })
  } catch (error) {
    console.error('Update estimate material line error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; lineId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['estimates.edit'])
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const existing = await prisma.estimateMaterialLine.findFirst({
      where: {
        id: params.lineId,
        estimateId: params.id,
        tenantId: user.tenantId,
      },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Material line not found' }, { status: 404 })
    }

    await prisma.estimateMaterialLine.delete({ where: { id: existing.id } })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete estimate material line error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

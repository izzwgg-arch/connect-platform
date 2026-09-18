import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { getQboSessionForTenant } from '@/lib/qbo/session'
import { quickBooksService } from '@/lib/services/quickbooks'

function vendorCodeForQbo(tenantId: string, qboVendorId: string) {
  return `QB-${tenantId}-${qboVendorId}`
}

function mapQboVendor(v: any) {
  const id = String(v?.Id || '').trim()
  const displayName = String(v?.DisplayName || v?.CompanyName || '').trim() || `Vendor ${id}`
  const companyName = String(v?.CompanyName || '').trim() || null
  const email = String(v?.PrimaryEmailAddr?.Address || '').trim() || null
  const phone = String(v?.PrimaryPhone?.FreeFormNumber || v?.Mobile?.FreeFormNumber || '').trim() || null
  const website = String(v?.WebAddr?.URI || '').trim() || null
  const active = v?.Active !== false
  const bill = v?.BillAddr || {}
  const billingStreet = [bill.Line1, bill.Line2].filter(Boolean).join(', ') || null
  const billingCity = bill.City || null
  const billingState = bill.CountrySubDivisionCode || null
  const billingZip = bill.PostalCode || null
  const billingCountry = bill.Country || 'USA'
  return {
    id,
    name: displayName,
    companyName,
    email,
    phone,
    website,
    active,
    billingStreet,
    billingCity,
    billingState,
    billingZip,
    billingCountry,
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.create')
  if (permError) return permError
  const user = getAuthUser(request)

  try {
    const session = await getQboSessionForTenant(user.tenantId)
    if (!session) {
      return NextResponse.json({ error: 'QuickBooks is not connected for this tenant.' }, { status: 400 })
    }

    let start = 1
    const pageSize = 1000
    const seen = new Map<string, any>()
    while (true) {
      const q = `SELECT * FROM Vendor STARTPOSITION ${start} MAXRESULTS ${pageSize}`
      const res = await quickBooksService.makeAPIRequest(
        session.accessToken,
        session.realmId,
        `/query?query=${encodeURIComponent(q)}`,
        'GET',
        undefined,
        {
          tenantId: user.tenantId,
          entityType: 'vendor',
          entityId: `import-page-${start}`,
          triggerSource: 'vendor_import_qbo',
        }
      )
      const batch = res?.QueryResponse?.Vendor
      const rows = Array.isArray(batch) ? batch : batch ? [batch] : []
      if (rows.length === 0) break
      for (const row of rows) {
        const id = String(row?.Id || '').trim()
        if (id) seen.set(id, row)
      }
      if (rows.length < pageSize) break
      start += pageSize
    }

    let created = 0
    let updated = 0
    let skipped = 0
    const errors: string[] = []

    for (const v of seen.values()) {
      const mapped = mapQboVendor(v)
      if (!mapped.id) continue
      const code = vendorCodeForQbo(user.tenantId, mapped.id)
      try {
        const existingByCode = await prisma.vendor.findFirst({
          where: { tenantId: user.tenantId, vendorCode: code },
        })
        const existingByName = existingByCode
          ? null
          : await prisma.vendor.findFirst({
              where: { tenantId: user.tenantId, name: { equals: mapped.name, mode: 'insensitive' } },
            })

        const data = {
          name: mapped.name,
          vendorCode: code,
          status: mapped.active ? ('ACTIVE' as const) : ('INACTIVE' as const),
          email: mapped.email,
          phone: mapped.phone,
          website: mapped.website,
          billingStreet: mapped.billingStreet,
          billingCity: mapped.billingCity,
          billingState: mapped.billingState,
          billingZip: mapped.billingZip,
          billingCountry: mapped.billingCountry || 'USA',
          isActive: mapped.active,
          notes: `Imported from QuickBooks (Vendor Id ${mapped.id}).`,
        }

        if (existingByCode) {
          await prisma.vendor.update({
            where: { id: existingByCode.id },
            data,
          })
          updated++
        } else if (existingByName) {
          await prisma.vendor.update({
            where: { id: existingByName.id },
            data: { ...data, vendorCode: existingByName.vendorCode || code },
          })
          updated++
        } else {
          await prisma.vendor.create({
            data: { tenantId: user.tenantId, ...data, paymentTerms: 'NET_30' },
          })
          created++
        }
      } catch (e: any) {
        skipped++
        errors.push(`${mapped.name}: ${e?.message || 'error'}`)
      }
    }

    return NextResponse.json({
      success: true,
      fetchedFromQuickBooks: seen.size,
      created,
      updated,
      skipped,
      errors: errors.slice(0, 25),
    })
  } catch (e: any) {
    console.error('QBO vendor import error:', e)
    return NextResponse.json({ error: e?.message || 'Vendor import failed' }, { status: 500 })
  }
}

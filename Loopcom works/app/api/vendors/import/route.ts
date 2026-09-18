import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const next = line[i + 1]

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      values.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  values.push(current.trim())
  return values
}

function toHeaderMap(headers: string[]) {
  const map = new Map<string, number>()
  headers.forEach((header, index) => {
    map.set(header.trim().toLowerCase(), index)
  })
  return map
}

function getByHeader(values: string[], headerMap: Map<string, number>, header: string): string {
  const index = headerMap.get(header.toLowerCase())
  if (index === undefined || index < 0 || index >= values.length) return ''
  return values[index] || ''
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'purchase_orders.create')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { csvData } = body

    if (!csvData || typeof csvData !== 'string') {
      return NextResponse.json({ error: 'CSV data is required' }, { status: 400 })
    }

    const cleaned = csvData.replace(/^\uFEFF/, '')
    const lines = cleaned
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .filter((line: string) => line)

    if (lines.length < 2) {
      return NextResponse.json({ error: 'CSV must have at least a header and one data row' }, { status: 400 })
    }

    const headers = parseCsvLine(lines[0]).map((h: string) => h.trim().replace(/^"|"$/g, ''))
    const headerMap = toHeaderMap(headers)
    const dataRows = lines.slice(1)

    const errors: Array<{ row: number; error: string }> = []
    const imported: string[] = []
    const skipped: string[] = []

    const validStatuses = ['ACTIVE', 'INACTIVE']
    const validPaymentTerms = ['NET_15', 'NET_30', 'NET_45', 'DUE_ON_RECEIPT', 'CUSTOM']

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i]
      if (!row.trim()) continue

      const values = parseCsvLine(row).map((v: string) => v.replace(/^"|"$/g, '').replace(/""/g, '"'))

      try {
        const name = getByHeader(values, headerMap, 'name')
        if (!name) {
          errors.push({ row: i + 2, error: 'Name is required' })
          continue
        }

        const vendorCodeRaw = getByHeader(values, headerMap, 'vendor code')
        const statusRaw = getByHeader(values, headerMap, 'status')
        const emailRaw = getByHeader(values, headerMap, 'email')
        const phoneRaw = getByHeader(values, headerMap, 'phone')
        const websiteRaw = getByHeader(values, headerMap, 'website')
        const primaryContactRaw = getByHeader(values, headerMap, 'primary contact')
        const primaryContactEmailRaw = getByHeader(values, headerMap, 'primary contact email')
        const primaryContactPhoneRaw = getByHeader(values, headerMap, 'primary contact phone')
        const paymentTermsRaw = getByHeader(values, headerMap, 'payment terms')
        const notesRaw = getByHeader(values, headerMap, 'notes')
        const billingStreetRaw = getByHeader(values, headerMap, 'billing street')
        const billingCityRaw = getByHeader(values, headerMap, 'billing city')
        const billingStateRaw = getByHeader(values, headerMap, 'billing state')
        const billingZipRaw = getByHeader(values, headerMap, 'billing zip')
        const billingCountryRaw = getByHeader(values, headerMap, 'billing country')
        const shippingStreetRaw = getByHeader(values, headerMap, 'shipping street')
        const shippingCityRaw = getByHeader(values, headerMap, 'shipping city')
        const shippingStateRaw = getByHeader(values, headerMap, 'shipping state')
        const shippingZipRaw = getByHeader(values, headerMap, 'shipping zip')
        const shippingCountryRaw = getByHeader(values, headerMap, 'shipping country')

        const vendorCode = vendorCodeRaw || null
        const status = (statusRaw || 'ACTIVE').toUpperCase()
        const paymentTerms = (paymentTermsRaw || 'NET_30').toUpperCase()

        if (!validStatuses.includes(status)) {
          errors.push({ row: i + 2, error: `Invalid status: ${status}` })
          continue
        }

        if (!validPaymentTerms.includes(paymentTerms)) {
          errors.push({ row: i + 2, error: `Invalid payment terms: ${paymentTerms}` })
          continue
        }

        // Skip duplicate vendor code
        if (vendorCode) {
          const duplicateCode = await prisma.vendor.findFirst({
            where: {
              tenantId: user.tenantId,
              vendorCode,
            },
          })
          if (duplicateCode) {
            skipped.push(name)
            continue
          }
        }

        // Skip duplicate vendor name
        const duplicateName = await prisma.vendor.findFirst({
          where: {
            tenantId: user.tenantId,
            name: { equals: name, mode: 'insensitive' },
          },
        })
        if (duplicateName) {
          skipped.push(name)
          continue
        }

        const vendor = await prisma.vendor.create({
          data: {
            tenantId: user.tenantId,
            name,
            vendorCode,
            status: status as any,
            email: emailRaw || null,
            phone: phoneRaw || null,
            website: websiteRaw || null,
            paymentTerms: paymentTerms as any,
            notes: notesRaw || null,
            billingStreet: billingStreetRaw || null,
            billingCity: billingCityRaw || null,
            billingState: billingStateRaw || null,
            billingZip: billingZipRaw || null,
            billingCountry: billingCountryRaw || 'USA',
            shippingStreet: shippingStreetRaw || null,
            shippingCity: shippingCityRaw || null,
            shippingState: shippingStateRaw || null,
            shippingZip: shippingZipRaw || null,
            shippingCountry: shippingCountryRaw || null,
            isActive: status !== 'INACTIVE',
          },
        })

        if (primaryContactRaw) {
          await prisma.vendorContact.create({
            data: {
              vendorId: vendor.id,
              tenantId: user.tenantId,
              name: primaryContactRaw,
              email: primaryContactEmailRaw || null,
              phone: primaryContactPhoneRaw || null,
              isPrimary: true,
            },
          })
        }

        imported.push(name)
      } catch (error: any) {
        errors.push({ row: i + 2, error: error.message || 'Unknown error' })
      }
    }

    return NextResponse.json({
      success: true,
      imported: imported.length,
      skipped: skipped.length,
      errors: errors.length,
      details: {
        imported,
        skipped,
        errors,
      },
    })
  } catch (error) {
    console.error('Import vendors error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

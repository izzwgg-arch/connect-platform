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
  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { csvData } = body

    if (!csvData || typeof csvData !== 'string') {
      return NextResponse.json({ error: 'CSV data is required' }, { status: 400 })
    }

    // Parse CSV (quote-safe and tolerant of CRLF/BOM)
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

        const skuRaw = getByHeader(values, headerMap, 'sku')
        const typeRaw = getByHeader(values, headerMap, 'type')
        const descriptionRaw = getByHeader(values, headerMap, 'description')
        const unitRaw = getByHeader(values, headerMap, 'unit')
        const unitCostRaw = getByHeader(values, headerMap, 'unit cost')
        const unitPriceRaw = getByHeader(values, headerMap, 'unit price')
        const taxableRaw = getByHeader(values, headerMap, 'taxable')
        const taxRateRaw = getByHeader(values, headerMap, 'tax rate')
        const activeRaw = getByHeader(values, headerMap, 'active')
        const vendorRaw = getByHeader(values, headerMap, 'vendor')
        const categoryRaw = getByHeader(values, headerMap, 'category')
        const tagsStr = getByHeader(values, headerMap, 'tags')
        const notesRaw = getByHeader(values, headerMap, 'notes')

        const sku = skuRaw || null
        const type = (typeRaw || 'PRODUCT').toUpperCase()
        const description = descriptionRaw || null
        const unit = unitRaw || 'ea'
        const defaultUnitCost = unitCostRaw ? parseFloat(unitCostRaw) : null
        const defaultUnitPrice = unitPriceRaw ? parseFloat(unitPriceRaw) : 0
        const taxable = taxableRaw ? ['yes', 'true', '1'].includes(taxableRaw.toLowerCase()) : true
        const taxRate = taxRateRaw ? parseFloat(taxRateRaw) : null
        const isActive = activeRaw ? !['no', 'false', '0'].includes(activeRaw.toLowerCase()) : true
        const vendorName = vendorRaw || null
        const categoryName = categoryRaw || null
        const tags = tagsStr ? tagsStr.split(';').map((t: string) => t.trim()).filter(Boolean) : []
        const notes = notesRaw || null

        // Validate type
        const validTypes = ['PRODUCT', 'SERVICE', 'MATERIAL', 'FEE']
        if (!validTypes.includes(type)) {
          errors.push({ row: i + 2, error: `Invalid type: ${type}. Must be one of: ${validTypes.join(', ')}` })
          continue
        }

        if (unitCostRaw && Number.isNaN(defaultUnitCost)) {
          errors.push({ row: i + 2, error: `Invalid Unit Cost: ${unitCostRaw}` })
          continue
        }

        if (unitPriceRaw && Number.isNaN(defaultUnitPrice)) {
          errors.push({ row: i + 2, error: `Invalid Unit Price: ${unitPriceRaw}` })
          continue
        }

        // Check for duplicate SKU
        if (sku) {
          const existing = await prisma.item.findFirst({
            where: {
              tenantId: user.tenantId,
              sku,
            },
          })
          if (existing) {
            skipped.push(name)
            continue
          }
        }

        // Resolve vendor
        let vendorId: string | null = null
        if (vendorName) {
          const vendor = await prisma.vendor.findFirst({
            where: {
              tenantId: user.tenantId,
              name: { equals: vendorName, mode: 'insensitive' },
            },
          })
          vendorId = vendor?.id || null
        }

        // Resolve category
        let categoryId: string | null = null
        if (categoryName) {
          let category = await prisma.itemCategory.findFirst({
            where: {
              tenantId: user.tenantId,
              name: { equals: categoryName, mode: 'insensitive' },
            },
          })
          if (!category) {
            // Create category if it doesn't exist
            category = await prisma.itemCategory.create({
              data: {
                tenantId: user.tenantId,
                name: categoryName,
              },
            })
          }
          categoryId = category.id
        }

        await prisma.item.create({
          data: {
            tenantId: user.tenantId,
            name,
            sku,
            type: type as any,
            description,
            unit,
            defaultUnitCost,
            defaultUnitPrice,
            taxable,
            taxRate,
            isActive,
            vendorId,
            categoryId,
            tags,
            notes,
          },
        })

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
    console.error('Import items error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { brandingSettingsSchema } from '@/lib/validation'
import { sanitizeOptionalHtmlBlock } from '@/lib/branding/sanitize'
import { prisma } from '@/lib/prisma'
import path from 'path'
import { promises as fs } from 'fs'

function getBrandingModel() {
  const model = (prisma as any)?.brandingSettings
  return model && typeof model.findUnique === 'function' && typeof model.upsert === 'function'
    ? model
    : null
}

function getBrandingFilePath(tenantId: string) {
  return path.join(process.cwd(), 'data', 'branding', `${tenantId}.json`)
}

async function readBrandingFile(tenantId: string) {
  try {
    const raw = await fs.readFile(getBrandingFilePath(tenantId), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function writeBrandingFile(tenantId: string, payload: Record<string, unknown>) {
  const filePath = getBrandingFilePath(tenantId)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const withTimestamp = { ...payload, updatedAt: new Date().toISOString() }
  await fs.writeFile(filePath, JSON.stringify(withTimestamp, null, 2), 'utf8')
  return withTimestamp
}

async function getBrandingSettings(tenantId: string) {
  const model = getBrandingModel()
  if (model) {
    return model.findUnique({ where: { tenantId } })
  }
  return readBrandingFile(tenantId)
}

async function upsertBrandingSettings(tenantId: string, data: Record<string, unknown>) {
  const model = getBrandingModel()
  if (model) {
    return model.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    })
  }
  const existing = (await readBrandingFile(tenantId)) || {}
  return writeBrandingFile(tenantId, { ...existing, ...data })
}

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'settings.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const branding = await getBrandingSettings(user.tenantId)
    return NextResponse.json(
      { branding: branding || null },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } }
    )
  } catch (error) {
    console.error('Get branding error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'settings.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const payload = await request.json()
    const parsed = brandingSettingsSchema.safeParse(payload)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ') },
        { status: 400 }
      )
    }

    const data = {
      ...parsed.data,
      emailCustomHeaderHTML: sanitizeOptionalHtmlBlock(parsed.data.emailCustomHeaderHTML),
      emailCustomFooterHTML: sanitizeOptionalHtmlBlock(parsed.data.emailCustomFooterHTML),
    }

    const branding = await upsertBrandingSettings(user.tenantId, data)
    return NextResponse.json({ branding })
  } catch (error) {
    console.error('Update branding error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}


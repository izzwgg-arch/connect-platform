import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import path from 'path'
import { promises as fs } from 'fs'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import {
  getMaxBytesForMimeType,
  isAllowedUploadMimeType,
  resolveUploadMimeType,
  safeExtFromMimeType,
} from '@/lib/uploads/policy'
import { normalizePublicFileUrl } from '@/lib/public-url'

function getPublicBaseUrl(req: NextRequest): string {
  const envUrl = process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL
  if (envUrl && envUrl.trim()) return envUrl.trim().replace(/\/+$/, '')
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host')
  if (!host) return 'https://app.trimprony.com'
  return `${proto}://${host}`.replace('http://', 'https://')
}

export const runtime = 'nodejs'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'leads.edit')
  if (permError) return permError

  const user = getAuthUser(request)
  try {
    const requestRecord = await prisma.lead.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      select: { id: true },
    })
    if (!requestRecord) {
      return NextResponse.json({ error: "You don't have access to this request" }, { status: 403 })
    }

    const form = await request.formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 })
    }

    const mimeType = resolveUploadMimeType(file.type || 'application/octet-stream', file.name)
    if (!isAllowedUploadMimeType(mimeType, file.name)) {
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
    }

    const arrayBuffer = await file.arrayBuffer()
    const sizeBytes = arrayBuffer.byteLength
    if (sizeBytes <= 0) return NextResponse.json({ error: 'Empty file' }, { status: 400 })

    const maxBytes = getMaxBytesForMimeType(mimeType, file.name)
    if (sizeBytes > maxBytes) {
      return NextResponse.json(
        { error: `File too large for this type (max ${Math.floor(maxBytes / (1024 * 1024))}MB).` },
        { status: 413 }
      )
    }

    const ext = safeExtFromMimeType(mimeType, file.name)
    const storedFileName = `${crypto.randomUUID()}.${ext}`
    const relDir = path.join('public', 'uploads', user.tenantId)
    const absDir = path.join(process.cwd(), relDir)
    await fs.mkdir(absDir, { recursive: true })
    const absPath = path.join(absDir, storedFileName)
    await fs.writeFile(absPath, Buffer.from(arrayBuffer))

    const relUrl = `/uploads/${encodeURIComponent(user.tenantId)}/${encodeURIComponent(storedFileName)}`
    const absoluteUrl = `${getPublicBaseUrl(request)}${relUrl}`
    const attachment = await prisma.attachment.create({
      data: {
        leadId: params.id,
        fileName: file.name || storedFileName,
        key: storedFileName,
        mimeType,
        fileSize: sizeBytes,
        url: absoluteUrl,
        uploadedById: user.id,
      },
    })

    return NextResponse.json(
      {
        attachment: {
          ...attachment,
          url: normalizePublicFileUrl(attachment.url, request),
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Request attachment upload failed:', error)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { promises as fs } from 'fs'
import crypto from 'crypto'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { prisma } from '@/lib/prisma'
import { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_FILE_BYTES, normalizeMimeType, safeExtFromMimeType } from '@/lib/uploads/policy'

export const runtime = 'nodejs'

function getPublicBaseUrl(req: NextRequest): string {
  const envUrl = process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL
  if (envUrl && typeof envUrl === 'string' && envUrl.trim()) {
    const normalized = envUrl.trim().replace(/\/+$/, '')
    try {
      const parsed = new URL(normalized)
      const host = parsed.hostname
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
      const isLocal = host === 'localhost' || host === '127.0.0.1'
      if (!isIp && !isLocal) return normalized.replace('http://', 'https://')
    } catch {
      // Ignore malformed env values and fall through.
    }
  }

  const host = req.headers.get('x-forwarded-host') || req.headers.get('host')
  if (!host) return 'https://app.trimprony.com'
  const isIpHost = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host)
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1')
  if (!isLocalhost && !isIpHost) return `https://${host}`
  return 'https://app.trimprony.com'
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const user = getAuthUser(request)

  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'Missing image file' }, { status: 400 })
    }

    const mimeType = normalizeMimeType(file.type || 'application/octet-stream')
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      return NextResponse.json({ error: 'Unsupported image type. Use JPG, PNG, HEIC, or WEBP.' }, { status: 400 })
    }

    const bytes = Buffer.from(await file.arrayBuffer())
    if (bytes.byteLength <= 0) {
      return NextResponse.json({ error: 'Empty file' }, { status: 400 })
    }
    if (bytes.byteLength > MAX_IMAGE_FILE_BYTES) {
      return NextResponse.json({ error: 'Image too large (max 15MB).' }, { status: 413 })
    }

    const ext = safeExtFromMimeType(mimeType)
    const fileName = `${crypto.randomUUID()}.${ext}`
    const relDir = path.join('public', 'uploads', user.tenantId, 'avatars')
    const absDir = path.join(process.cwd(), relDir)
    await fs.mkdir(absDir, { recursive: true })
    const absPath = path.join(absDir, fileName)
    await fs.writeFile(absPath, bytes)

    const relUrl = `/uploads/${encodeURIComponent(user.tenantId)}/avatars/${encodeURIComponent(fileName)}`
    const baseUrl = getPublicBaseUrl(request)
    const avatarUrl = `${baseUrl}${relUrl}`

    await prisma.user.update({
      where: { id: user.id },
      data: { avatar: avatarUrl },
    })

    return NextResponse.json({ avatarUrl })
  } catch (error) {
    console.error('avatar upload POST error', error)
    return NextResponse.json({ error: 'Failed to upload avatar' }, { status: 500 })
  }
}


import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { promises as fs } from 'fs'
import crypto from 'crypto'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireAnyPermission } from '@/lib/authorization'
import {
  getMaxBytesForMimeType,
  isAllowedUploadMimeType,
  resolveUploadMimeType,
  safeExtFromMimeType,
} from '@/lib/uploads/policy'

export const runtime = 'nodejs'

// Returns empty string intentionally — upload URLs are always relative (/uploads/...).
// Relative URLs resolve correctly on any hostname without hardcoded domain assumptions.
function getPublicBaseUrl(_req: NextRequest): string {
  return ''
}

export async function POST(request: NextRequest) {
  console.log('[uploads] Upload route hit')
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireAnyPermission(request, ['jobs.upload_files', 'leads.edit', 'clients.edit'])
  if (permError) return permError

  const user = getAuthUser(request)
  console.log('[uploads] Authenticated user:', { userId: user.id, tenantId: user.tenantId })

  try {
    const form = await request.formData()
    const file = form.get('file')

    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 })
    }

    const contentType = resolveUploadMimeType(file.type || 'application/octet-stream', file.name)
    if (!isAllowedUploadMimeType(contentType, file.name)) {
      console.log('Upload rejected - unsupported file type:', { contentType, fileName: file.name })
      return NextResponse.json(
        {
          error:
            'Unsupported file type. Allowed: PDF, Word, Excel, CSV, PowerPoint, TXT, common images, and common videos.',
        },
        { status: 400 }
      )
    }

    const arrayBuffer = await file.arrayBuffer()
    const size = arrayBuffer.byteLength
    if (size <= 0) {
      return NextResponse.json({ error: 'Empty file' }, { status: 400 })
    }
    const maxBytes = getMaxBytesForMimeType(contentType, file.name)
    if (size > maxBytes) {
      console.log('Upload rejected - file too large:', { fileName: file.name, size, maxBytes, contentType })
      return NextResponse.json(
        { error: `File too large for this type (max ${Math.floor(maxBytes / (1024 * 1024))}MB).` },
        { status: 413 }
      )
    }

    const ext = safeExtFromMimeType(contentType, file.name)
    const id = crypto.randomUUID()
    const filename = `${id}.${ext}`

    const relDir = path.join('public', 'uploads', user.tenantId)
    const absDir = path.join(process.cwd(), relDir)
    await fs.mkdir(absDir, { recursive: true })

    const absPath = path.join(absDir, filename)
    await fs.writeFile(absPath, Buffer.from(arrayBuffer))

    // Ensure nginx (www-data) can read newly created directories and files
    await fs.chmod(absDir, 0o755).catch(() => {})
    await fs.chmod(absPath, 0o644).catch(() => {})

    // Verify file was written
    const fileStats = await fs.stat(absPath)
    console.log('[uploads] File uploaded successfully:', {
      filename,
      path: absPath,
      size: fileStats.size,
      tenantId: user.tenantId,
      contentType,
      originalFileName: file.name,
    })

    const relUrl = `/uploads/${encodeURIComponent(user.tenantId)}/${encodeURIComponent(filename)}`
    const baseUrl = getPublicBaseUrl(request)
    const url = baseUrl ? `${baseUrl}${relUrl}` : relUrl
    
    console.log('Upload response URLs:', { url, relativeUrl: relUrl, baseUrl })

    return NextResponse.json({
      url,
      relativeUrl: relUrl,
      mimeType: contentType,
      size,
      filename,
    })
  } catch (error: any) {
    console.error('Upload error:', error?.message || error)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}


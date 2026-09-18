import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { promises as fs } from 'fs'
import { createReadStream } from 'fs'
import { Readable } from 'stream'

export const runtime = 'nodejs'

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  amr: 'audio/amr',
  '3gp': 'audio/3gpp',
  '3g2': 'video/3gpp2',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rtf: 'application/rtf',
}

function getMime(filename: string, request?: NextRequest): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'webm') {
    const destination = request?.headers.get('sec-fetch-dest') || ''
    const accept = request?.headers.get('accept') || ''
    if (destination === 'audio' || accept.includes('audio/')) return 'audio/webm'
    if (destination === 'video' || accept.includes('video/')) return 'video/webm'
  }
  return MIME_MAP[ext] ?? 'application/octet-stream'
}

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  try {
    // Reconstruct the relative path and resolve to public/uploads/
    const segments = (params.path ?? []).map((seg) => decodeURIComponent(seg))

    // Prevent path traversal
    for (const seg of segments) {
      if (seg.includes('..') || seg.includes('/') || seg.includes('\\')) {
        return new NextResponse('Forbidden', { status: 403 })
      }
    }

    const filePath = path.join(process.cwd(), 'public', 'uploads', ...segments)
    const stat = await fs.stat(filePath)
    const mime = getMime(segments[segments.length - 1] ?? '', request)
    const rangeHeader = request.headers.get('range')

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0
        const end = match[2] ? parseInt(match[2], 10) : stat.size - 1
        const safeStart = Math.max(0, Math.min(start, stat.size - 1))
        const safeEnd = Math.max(safeStart, Math.min(end, stat.size - 1))
        const stream = Readable.toWeb(
          createReadStream(filePath, { start: safeStart, end: safeEnd })
        ) as ReadableStream

        return new NextResponse(stream, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${safeStart}-${safeEnd}/${stat.size}`,
            'Content-Length': String(safeEnd - safeStart + 1),
            'Content-Disposition': 'inline',
          },
        })
      }
    }
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream

    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(stat.size),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': 'inline',
      },
    })
  } catch {
    return new NextResponse('Not Found', { status: 404 })
  }
}

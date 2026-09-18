/**
 * Fetches a logo URL and returns it as a base64 data URI so it is embedded
 * directly in email HTML — eliminating the remote-image loading delay in
 * email clients.  Falls back to the original URL if the fetch fails or the
 * image is too large (> 500 KB).
 *
 * For /uploads/ paths, reads directly from the local filesystem to avoid
 * issues where the server cannot reach its own public HTTPS URL.
 */

import fs from 'fs'
import path from 'path'

// Logos may be moderately large (high-res PNG/JPG). Allow up to 5 MB so we
// embed them as data URIs instead of falling back to an unfetchable URL.
const MAX_LOGO_BYTES = 5 * 1024 * 1024 // 5 MB

function getAppUrl(): string {
  return (
    String(process.env.PUBLIC_APP_URL || '').trim() ||
    String(process.env.NEXT_PUBLIC_APP_URL || '').trim() ||
    String(process.env.APP_URL || '').trim() ||
    'https://app.trimprony.com'
  )
}

/** Build an absolute URL for a possibly-relative logo path. */
function toAbsoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  const base = getAppUrl().replace(/\/$/, '')
  return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`
}

function extractUploadsPath(url: string): string | null {
  const cleaned = url.trim()

  // Already a relative /uploads/ path
  if (cleaned.startsWith('/uploads/')) return cleaned

  // Absolute URL pointing to our own app — extract the path portion
  try {
    const appUrl = getAppUrl().replace(/\/$/, '')
    if (cleaned.startsWith(appUrl + '/uploads/')) {
      return cleaned.slice(appUrl.length)
    }
    // Also handle http vs https variants
    const parsed = new URL(cleaned)
    if (parsed.pathname.startsWith('/uploads/')) {
      return parsed.pathname
    }
  } catch {
    // Not a valid URL — ignore
  }

  return null
}

async function readLocalFile(uploadsPath: string): Promise<Buffer | null> {
  try {
    const cwd = process.cwd()
    const filePath = path.join(cwd, 'public', uploadsPath)
    return await fs.promises.readFile(filePath)
  } catch {
    return null
  }
}

export async function embedLogoAsDataUri(logoUrl: string | null | undefined): Promise<string | null> {
  const url = String(logoUrl || '').trim()
  if (!url) return null
  // Already embedded or not a fetchable URL — return as-is
  if (url.startsWith('data:') || url.startsWith('cid:')) return url

  // Try to read from local filesystem first (avoids server fetching itself via HTTPS)
  const localPath = extractUploadsPath(url)
  if (localPath) {
    const buf = await readLocalFile(localPath)
    if (buf && buf.byteLength > 0 && buf.byteLength <= MAX_LOGO_BYTES) {
      const contentType = guessContentType(localPath)
      const base64 = buf.toString('base64')
      return `data:${contentType};base64,${base64}`
    }
    // File too large — cannot embed; let caller decide a safe fallback.
    if (buf && buf.byteLength > MAX_LOGO_BYTES) return null
    // File not found locally — fall through to HTTP using an absolute URL.
  }

  // HTTP fallback for external logos (and local paths not on this host's disk).
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(toAbsoluteUrl(url), { signal: controller.signal })
    clearTimeout(timeout)

    if (!res.ok) return null // unreachable — caller falls back

    const buffer = await res.arrayBuffer()
    if (buffer.byteLength > MAX_LOGO_BYTES) return null // too large to embed

    const contentType =
      res.headers.get('content-type')?.split(';')[0].trim() || guessContentType(url)

    const base64 = Buffer.from(buffer).toString('base64')
    return `data:${contentType};base64,${base64}`
  } catch {
    return null // network error — caller falls back to a safe branded logo
  }
}

function guessContentType(url: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'svg': return 'image/svg+xml'
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    default: return 'image/png'
  }
}

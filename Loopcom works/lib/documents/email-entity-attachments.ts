import { readFile } from 'fs/promises'
import path from 'path'
import { prisma } from '@/lib/prisma'
import type { EmailAttachment } from '@/lib/integrations/providers/email'

type EmailAttachmentEntityType = 'estimate' | 'invoice' | 'purchase_order'

function localFileCandidates(url: string, key: string): string[] {
  const values = [key, url]
  const candidates = new Set<string>()

  for (const rawValue of values) {
    const value = String(rawValue || '').trim()
    if (!value) continue

    let pathname = value
    try {
      pathname = new URL(value).pathname
    } catch {
      // Relative upload path.
    }

    const decoded = decodeURIComponent(pathname).replace(/\\/g, '/')
    const publicRelative = decoded
      .replace(/^\/+/, '')
      .replace(/^public\//, '')
    if (publicRelative) {
      candidates.add(path.resolve(process.cwd(), 'public', publicRelative))
    }
  }

  const publicRoot = path.resolve(process.cwd(), 'public')
  return Array.from(candidates).filter(
    (candidate) => candidate === publicRoot || candidate.startsWith(`${publicRoot}${path.sep}`)
  )
}

async function readAttachmentContent(url: string, key: string): Promise<Buffer> {
  for (const candidate of localFileCandidates(url, key)) {
    try {
      return await readFile(candidate)
    } catch {
      // Try the next local representation before using the remote URL.
    }
  }

  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Attachment download failed with status ${response.status}`)
    }
    return Buffer.from(await response.arrayBuffer())
  }

  throw new Error('Attachment file was not found on disk')
}

export async function loadEmailEntityAttachments(params: {
  tenantId: string
  entityType: EmailAttachmentEntityType
  entityId: string
}): Promise<EmailAttachment[]> {
  const where =
    params.entityType === 'estimate'
      ? { estimateId: params.entityId, estimate: { tenantId: params.tenantId } }
      : params.entityType === 'invoice'
        ? { invoiceId: params.entityId, invoice: { tenantId: params.tenantId } }
        : { purchaseOrderId: params.entityId, purchaseOrder: { tenantId: params.tenantId } }

  const rows = await prisma.attachment.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      url: true,
      key: true,
    },
  })

  const attachments: EmailAttachment[] = []
  for (const row of rows) {
    try {
      attachments.push({
        filename: row.fileName,
        content: await readAttachmentContent(row.url, row.key),
        contentType: row.mimeType || 'application/octet-stream',
      })
    } catch (error) {
      console.warn(`Skipping unreadable email attachment ${row.id}:`, error)
    }
  }
  return attachments
}

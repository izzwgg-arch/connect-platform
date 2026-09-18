import type { Prisma, PrismaClient } from '@prisma/client'

type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * Copies attachment rows from a request (lead) onto a job.
 * Reuses the same file url/key; does not delete request attachments.
 * Idempotent: skips files already present on the job (matched by key or url).
 */
export async function copyRequestAttachmentsToJob(
  db: DbClient,
  params: { leadId: string | null | undefined; jobId: string }
): Promise<number> {
  const leadId = String(params.leadId || '').trim()
  const jobId = String(params.jobId || '').trim()
  if (!leadId || !jobId) return 0

  const source = await db.attachment.findMany({
    where: { leadId },
    select: {
      fileName: true,
      fileSize: true,
      mimeType: true,
      url: true,
      key: true,
      uploadedById: true,
    },
  })
  if (source.length === 0) return 0

  const existing = await db.attachment.findMany({
    where: { jobId },
    select: { key: true, url: true },
  })
  const existingKeys = new Set(existing.map((a) => a.key).filter(Boolean))
  const existingUrls = new Set(existing.map((a) => a.url).filter(Boolean))

  const toCreate = source.filter((a) => !existingKeys.has(a.key) && !existingUrls.has(a.url))
  if (toCreate.length === 0) return 0

  await db.attachment.createMany({
    data: toCreate.map((a) => ({
      jobId,
      fileName: a.fileName,
      fileSize: a.fileSize,
      mimeType: a.mimeType,
      url: a.url,
      key: a.key,
      uploadedById: a.uploadedById,
    })),
  })

  return toCreate.length
}

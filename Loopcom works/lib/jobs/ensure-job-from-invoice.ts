import { prisma } from '@/lib/prisma'
import { getEstimateConversionSummary } from '@/lib/documents/conversion'
import { copyRequestAttachmentsToJob } from '@/lib/jobs/copy-request-attachments-to-job'
import { syncJobCostFromLinkedDocuments } from '@/lib/jobs/sync-job-cost'
import { parseJobType } from '@/lib/jobs/types'

function normalizePhone(value: string | null | undefined) {
  return (value || '').replace(/\D/g, '')
}

function parseJobSiteAddress(address: string | null | undefined) {
  if (!address) return null
  const trimmed = address.trim()
  if (!trimmed) return null
  const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean)
  const street = parts[0] || trimmed
  const city = parts[1] || ''
  const stateZip = parts[2] || ''
  const stateZipMatch = stateZip.match(/^([A-Za-z]{2})\s+(.+)$/)
  const state = stateZipMatch ? stateZipMatch[1] : stateZip
  const zipCode = stateZipMatch ? stateZipMatch[2] : ''
  return {
    street,
    city,
    state,
    zipCode,
    country: 'US',
  }
}

function formatJobNameFromEstimate(
  jobNumber: string,
  jobSiteAddress: string | null | undefined,
  estimateTitle: string | null | undefined
) {
  const rawAddress = String(jobSiteAddress || '').trim()
  const rawTitle = String(estimateTitle || '').trim()
  const numberLabel = jobNumber.replace(/^JOB-0*/, '')

  let conciseAddress = ''
  if (rawAddress) {
    const parts = rawAddress
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)

    const street = parts[0] || ''
    const city = parts[1] || ''
    const state = parts[2] || ''
    const stateNoZip = state.replace(/\b\d{5}(?:-\d{4})?\b/g, '').trim()
    const cityOrState = city || stateNoZip

    conciseAddress = [street, cityOrState].filter(Boolean).join(', ').trim()
    if (!conciseAddress) {
      conciseAddress = rawAddress
        .replace(/\b\d{5}(?:-\d{4})?\b/g, '')
        .replace(/\b(US|USA|United States)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+,/g, ',')
        .replace(/,\s*,+/g, ',')
        .replace(/,\s*$/, '')
        .trim()
    }
  }

  if (conciseAddress) return `Job #${numberLabel} - ${conciseAddress}`
  if (rawTitle) return `Job #${numberLabel} - ${rawTitle}`
  return `Job #${numberLabel}`
}

export type EnsureJobFromInvoiceResult = {
  job: { id: string; jobNumber: string; title: string } | null
  created: boolean
  skippedReason?: 'invoice_not_found' | 'already_linked' | 'no_client'
}

/**
 * Ensures an invoice has a linked job.
 * Called at estimate→invoice conversion time, NOT on payment.
 * Idempotent: safe to call multiple times for the same invoice.
 */
export async function ensureJobFromInvoice(
  invoiceId: string,
  options?: { jobType?: string | null }
): Promise<EnsureJobFromInvoiceResult> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId },
    include: {
      job: {
        select: { id: true, jobNumber: true, title: true },
      },
      estimate: {
        include: {
          lead: true,
          job: {
            select: { id: true, jobNumber: true, title: true },
          },
        },
      },
    },
  })

  if (!invoice) return { job: null, created: false, skippedReason: 'invoice_not_found' }
  if (invoice.jobId && invoice.job) {
    await copyRequestAttachmentsToJob(prisma, {
      leadId: invoice.estimate?.leadId,
      jobId: invoice.job.id,
    })
    await syncJobCostFromLinkedDocuments(invoice.job.id)
    return { job: invoice.job, created: false, skippedReason: 'already_linked' }
  }

  const estimate = invoice.estimate
  if (estimate?.jobId && estimate.job) {
    if (invoice.jobId !== estimate.job.id) {
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { jobId: estimate.job.id },
      })
    }
    await copyRequestAttachmentsToJob(prisma, {
      leadId: estimate.leadId,
      jobId: estimate.job.id,
    })
    await syncJobCostFromLinkedDocuments(estimate.job.id)
    return { job: estimate.job, created: false, skippedReason: 'already_linked' }
  }

  let clientId = invoice.clientId || estimate?.clientId || null
  if (!clientId && estimate?.lead?.convertedToClientId) {
    clientId = estimate.lead.convertedToClientId
  }

  if (!clientId && estimate?.lead) {
    const fullName = `${estimate.lead.firstName} ${estimate.lead.lastName}`.trim()
    const normalizedEmail = (estimate.lead.email || '').trim().toLowerCase()
    const normalizedPhone = normalizePhone(estimate.lead.phone)
    const existingClient = await prisma.client.findFirst({
      where: {
        tenantId: invoice.tenantId,
        OR: [
          ...(normalizedEmail
            ? [{ email: { equals: normalizedEmail, mode: 'insensitive' as const } }]
            : []),
          ...(normalizedPhone ? [{ phone: { contains: normalizedPhone } }] : []),
          {
            AND: [
              { name: { equals: fullName, mode: 'insensitive' } },
              ...(estimate.lead.company
                ? [{ companyName: { equals: estimate.lead.company, mode: 'insensitive' } }]
                : []),
            ],
          },
        ],
      },
      orderBy: { updatedAt: 'desc' },
    })

    if (existingClient) {
      clientId = existingClient.id
    } else {
      const createdClient = await prisma.client.create({
        data: {
          tenantId: invoice.tenantId,
          name: fullName,
          companyName: estimate.lead.company || null,
          email: estimate.lead.email || null,
          phone: estimate.lead.phone || null,
          notes: estimate.lead.notes || null,
          isActive: true,
        },
      })
      clientId = createdClient.id
    }
  }

  if (!clientId) {
    console.error('[ensureJobFromInvoice] No client resolvable for invoice', {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      tenantId: invoice.tenantId,
    })
    return { job: null, created: false, skippedReason: 'no_client' }
  }

  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const createdJob = await prisma.$transaction(async (tx) => {
        const latestJob = await tx.job.findFirst({
          where: { tenantId: invoice.tenantId, jobNumber: { startsWith: 'JOB-' } },
          orderBy: { jobNumber: 'desc' },
          select: { jobNumber: true },
        })
        const latestJobNum = latestJob?.jobNumber
          ? parseInt(String(latestJob.jobNumber).replace(/^JOB-/, ''), 10)
          : 0
        const baseNum = Number.isFinite(latestJobNum) ? latestJobNum : 0
        const jobNumber = `JOB-${String(baseNum + 1 + attempt).padStart(6, '0')}`
        const mergedDescription = [
          estimate?.notes ? `Estimate Notes: ${estimate.notes}` : null,
          invoice.notes ? `Invoice Notes: ${invoice.notes}` : null,
          estimate?.lead?.notes ? `Request Notes: ${estimate.lead.notes}` : null,
        ]
          .filter(Boolean)
          .join('\n\n')
          .trim()

        const createdJob = await tx.job.create({
          data: {
            tenantId: invoice.tenantId,
            clientId,
            jobNumber,
            title: formatJobNameFromEstimate(jobNumber, estimate?.jobSiteAddress || estimate?.lead?.jobSiteAddress, estimate?.title),
            description: mergedDescription || null,
            status: 'QUOTE',
            jobType: parseJobType(options?.jobType, 'CUSTOM'),
            priority: 3,
            estimateAmount: estimate?.total || invoice.total,
          },
          select: { id: true, jobNumber: true, title: true },
        })

        const parsedAddress = parseJobSiteAddress(estimate?.jobSiteAddress || estimate?.lead?.jobSiteAddress)
        if (parsedAddress) {
          await tx.address.create({
            data: {
              jobId: createdJob.id,
              type: 'job_site',
              street: parsedAddress.street,
              city: parsedAddress.city,
              state: parsedAddress.state,
              zipCode: parsedAddress.zipCode,
              country: parsedAddress.country,
            },
          })
        }

        if (estimate) {
          const conversion = await getEstimateConversionSummary(tx, estimate.id, estimate.total, invoice.tenantId)
          await tx.estimate.update({
            where: { id: estimate.id },
            data: {
              clientId,
              jobId: createdJob.id,
              status: 'CONVERTED',
              convertedPercent: conversion.convertedPercent,
            },
          })
        }

        await tx.invoice.update({
          where: { id: invoice.id },
          data: { jobId: createdJob.id },
        })

        if (estimate?.leadId) {
          await tx.lead.update({
            where: { id: estimate.leadId },
            data: { status: 'CONVERTED' },
          })
          await copyRequestAttachmentsToJob(tx, {
            leadId: estimate.leadId,
            jobId: createdJob.id,
          })
        }

        await tx.activity.create({
          data: {
            tenantId: invoice.tenantId,
            type: 'JOB_CREATED',
            description: `Estimate converted to invoice "${invoice.invoiceNumber}". Job ${createdJob.jobNumber} created automatically.`,
            clientId,
            invoiceId: invoice.id,
            estimateId: estimate?.id,
            leadId: estimate?.leadId || null,
            jobId: createdJob.id,
          },
        })

        return createdJob
      })
      await syncJobCostFromLinkedDocuments(createdJob.id)
      return { job: createdJob, created: true }
    } catch (err: any) {
      if (err?.code === 'P2002' && err?.meta?.target?.includes?.('jobNumber')) {
        continue
      }
      throw err
    }
  }
  throw new Error('Unable to allocate a unique job number')
}

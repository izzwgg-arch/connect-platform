import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { enqueueQboSync } from '@/lib/qbo/sync-queue'
import { copyRequestAttachmentsToJob } from '@/lib/jobs/copy-request-attachments-to-job'

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

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'leads.convert')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    let createdClientIdForSync: string | null = null
    const lead = await prisma.lead.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!lead) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    }

    // Idempotency guard: if this lead was already converted to a job, return that job.
    const existingConversion = await prisma.activity.findFirst({
      where: {
        tenantId: user.tenantId,
        leadId: lead.id,
        type: 'JOB_CREATED',
        jobId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { jobId: true },
    })
    if (existingConversion?.jobId) {
      const existingJob = await prisma.job.findFirst({
        where: { id: existingConversion.jobId, tenantId: user.tenantId },
        select: { id: true, jobNumber: true, title: true },
      })
      if (existingJob) {
        await copyRequestAttachmentsToJob(prisma, {
          leadId: lead.id,
          jobId: existingJob.id,
        })
        return NextResponse.json({ job: existingJob }, { status: 200 })
      }
    }

    let clientId = lead.convertedToClientId || null
    if (!clientId) {
      const fullName = `${lead.firstName} ${lead.lastName}`.trim()
      const normalizedEmail = (lead.email || '').trim().toLowerCase()
      const normalizedPhone = normalizePhone(lead.phone)
      const existingClient = await prisma.client.findFirst({
        where: {
          tenantId: user.tenantId,
          OR: [
            ...(normalizedEmail
              ? [{ email: { equals: normalizedEmail, mode: 'insensitive' as const } }]
              : []),
            ...(normalizedPhone ? [{ phone: { contains: normalizedPhone } }] : []),
            {
              AND: [
                { name: { equals: fullName, mode: 'insensitive' } },
                ...(lead.company
                  ? [{ companyName: { equals: lead.company, mode: 'insensitive' as const } }]
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
            tenantId: user.tenantId,
            name: fullName,
            companyName: lead.company || null,
            email: lead.email || null,
            phone: lead.phone || null,
            notes: lead.notes || null,
            isActive: true,
          },
        })
        clientId = createdClient.id
        createdClientIdForSync = createdClient.id
      }
    }

    if (!clientId) {
      return NextResponse.json({ error: 'Unable to resolve client for request' }, { status: 400 })
    }

    const fullName = `${lead.firstName} ${lead.lastName}`.trim()
    const titleBase = lead.company ? `Job for ${lead.company}` : `Job for ${fullName}`
    const estimateAmount = lead.value ? Number(lead.value) : null
    const parsedAddress = parseJobSiteAddress(lead.jobSiteAddress)

    let job: { id: string } | null = null
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        job = await prisma.$transaction(async (tx) => {
          const latestJob = await tx.job.findFirst({
            where: {
              tenantId: user.tenantId,
              jobNumber: { startsWith: 'JOB-' },
            },
            orderBy: { jobNumber: 'desc' },
            select: { jobNumber: true },
          })
          const latestNumMatch = latestJob?.jobNumber?.match(/^JOB-(\d+)/)
          const latestNum = latestNumMatch ? parseInt(latestNumMatch[1], 10) : 0
          const baseNum = Number.isFinite(latestNum) ? latestNum : 0
          const jobNumber = `JOB-${String(baseNum + 1 + attempt).padStart(6, '0')}`

          const createdJob = await tx.job.create({
            data: {
              tenantId: user.tenantId,
              clientId,
              jobNumber,
              title: titleBase,
              description: lead.notes || null,
              status: 'QUOTE',
              jobType: lead.jobType || 'CUSTOM',
              priority: 3,
              estimateAmount: estimateAmount && Number.isFinite(estimateAmount) ? estimateAmount : null,
            },
          })

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

          await tx.lead.update({
            where: { id: lead.id },
            data: {
              status: 'CONVERTED',
              convertedToClientId: clientId,
              convertedAt: lead.convertedAt || new Date(),
            },
          })

          await tx.activity.create({
            data: {
              tenantId: user.tenantId,
              userId: user.id,
              type: 'JOB_CREATED',
              description: `Request "${fullName}" converted to job ${jobNumber}`,
              leadId: lead.id,
              clientId,
              jobId: createdJob.id,
            },
          })

          await copyRequestAttachmentsToJob(tx, {
            leadId: lead.id,
            jobId: createdJob.id,
          })

          return createdJob
        })
        break
      } catch (error: any) {
        if (error?.code === 'P2002' && error?.meta?.target?.includes?.('jobNumber')) {
          continue
        }
        throw error
      }
    }

    if (!job) {
      return NextResponse.json({ error: 'Unable to allocate a new job number. Please retry.' }, { status: 409 })
    }

    if (createdClientIdForSync) {
      try {
        await enqueueQboSync(user.tenantId, 'client', createdClientIdForSync)
      } catch (error) {
        console.error('QuickBooks client sync trigger error (request convert-to-job):', error)
      }
    }

    return NextResponse.json({ job }, { status: 201 })
  } catch (error) {
    console.error('Convert request to job error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

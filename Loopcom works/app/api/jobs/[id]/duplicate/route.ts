import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'jobs.create')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const source = await prisma.job.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
      include: {
        addresses: true,
      },
    })

    if (!source) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const jobCount = await prisma.job.count({
      where: { tenantId: user.tenantId },
    })
    const jobNumber = `JOB-${String(jobCount + 1).padStart(6, '0')}`

    const duplicate = await prisma.job.create({
      data: {
        tenantId: user.tenantId,
        clientId: source.clientId,
        jobNumber,
        title: `${source.title} (Copy)`,
        description: source.description,
        status: 'QUOTE',
        jobType: source.jobType,
        priority: source.priority,
        estimateAmount: source.estimateAmount,
        actualAmount: source.actualAmount,
        laborCost: source.laborCost,
        materialCost: source.materialCost,
        scheduledStart: source.scheduledStart,
        scheduledEnd: source.scheduledEnd,
        actualStart: null,
        actualEnd: null,
      },
    })

    const sourceJobSite = source.addresses.find((a) => a.type === 'job_site')
    if (sourceJobSite) {
      await prisma.address.create({
        data: {
          jobId: duplicate.id,
          type: 'job_site',
          street: sourceJobSite.street,
          city: sourceJobSite.city,
          state: sourceJobSite.state,
          zipCode: sourceJobSite.zipCode,
          country: sourceJobSite.country,
          notes: sourceJobSite.notes,
        },
      })
    }

    return NextResponse.json({ job: duplicate, id: duplicate.id }, { status: 201 })
  } catch (error) {
    console.error('Duplicate job error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

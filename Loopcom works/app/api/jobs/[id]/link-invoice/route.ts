import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { syncJobCostFromLinkedDocuments } from '@/lib/jobs/sync-job-cost'

/**
 * Attach an existing saved invoice (with no job) to this job.
 * Also allows re-pointing an invoice that was previously unlinked.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError

  const permError = await requirePermission(request, 'invoices.edit')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json().catch(() => ({}))
    const invoiceId = String(body?.invoiceId || '').trim()
    if (!invoiceId) {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
    }

    const job = await prisma.job.findFirst({
      where: { id: params.id, tenantId: user.tenantId },
      select: { id: true, clientId: true, jobNumber: true, title: true },
    })
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId: user.tenantId },
      select: {
        id: true,
        invoiceNumber: true,
        clientId: true,
        jobId: true,
        status: true,
        total: true,
      },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.status === 'CANCELLED' || invoice.status === 'REFUNDED') {
      return NextResponse.json(
        { error: 'Cannot attach a cancelled or refunded invoice to a job' },
        { status: 400 }
      )
    }

    if (invoice.clientId !== job.clientId) {
      return NextResponse.json(
        { error: 'Invoice must belong to the same client as this job' },
        { status: 400 }
      )
    }

    if (invoice.jobId && invoice.jobId !== job.id) {
      return NextResponse.json(
        { error: 'Invoice is already attached to another job. Unlink it first.' },
        { status: 400 }
      )
    }

    if (invoice.jobId === job.id) {
      await syncJobCostFromLinkedDocuments(job.id)
      return NextResponse.json({
        invoice: { id: invoice.id, invoiceNumber: invoice.invoiceNumber, jobId: job.id },
        job: { id: job.id, jobNumber: job.jobNumber, title: job.title },
        alreadyLinked: true,
      })
    }

    const previousJobId = invoice.jobId
    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { jobId: job.id },
      select: {
        id: true,
        invoiceNumber: true,
        jobId: true,
        total: true,
        status: true,
      },
    })

    if (previousJobId) {
      await syncJobCostFromLinkedDocuments(previousJobId)
    }
    await syncJobCostFromLinkedDocuments(job.id)

    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'OTHER',
        description: `Invoice "${updated.invoiceNumber}" attached to job ${job.jobNumber}`,
        clientId: job.clientId,
        invoiceId: updated.id,
        jobId: job.id,
      },
    }).catch(() => null)

    return NextResponse.json({
      invoice: updated,
      job: { id: job.id, jobNumber: job.jobNumber, title: job.title },
    })
  } catch (error) {
    console.error('Link invoice to job error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

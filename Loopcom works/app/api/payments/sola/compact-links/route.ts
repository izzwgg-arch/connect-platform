import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import {
  CARDKNOX_HOSTED_FORM_URL,
  CARDKNOX_LONG_URL_THRESHOLD,
  CARDKNOX_MAX_URL_LENGTH,
  compactCardknoxUrl,
  enforceCardknoxUrlLength,
} from '@/lib/services/cardknox-url'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'payments.manage')
  if (permError) return permError

  const user = getAuthUser(request)

  const body = await request.json().catch(() => ({}))
  const write = Boolean(body?.write)

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId: user.tenantId,
      solaPaymentUrl: {
        startsWith: `${CARDKNOX_HOSTED_FORM_URL}?`,
      },
    },
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      balance: true,
      solaPaymentUrl: true,
    },
    orderBy: {
      invoiceNumber: 'desc',
    },
  })

  const affected = invoices
    .map((invoice) => {
      const currentUrl = invoice.solaPaymentUrl || ''
      let compactUrl = compactCardknoxUrl(currentUrl)
      try {
        compactUrl = enforceCardknoxUrlLength(compactUrl, {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
        })
      } catch {
        return null
      }
      return {
        ...invoice,
        currentLength: currentUrl.length,
        compactLength: compactUrl.length,
        compactUrl,
      }
    })
    .filter(
      (invoice): invoice is NonNullable<typeof invoice> =>
        invoice !== null &&
        (invoice.currentLength >= CARDKNOX_LONG_URL_THRESHOLD ||
          invoice.compactLength > CARDKNOX_MAX_URL_LENGTH) &&
        invoice.compactUrl !== invoice.solaPaymentUrl
    )

  if (write) {
    for (const invoice of affected) {
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { solaPaymentUrl: invoice.compactUrl },
      })
    }
  }

  return NextResponse.json({
    mode: write ? 'write' : 'dry-run',
    maxUrlLength: CARDKNOX_MAX_URL_LENGTH,
    longUrlThreshold: CARDKNOX_LONG_URL_THRESHOLD,
    scanned: invoices.length,
    affected: affected.length,
    invoices: affected.map((invoice) => ({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      balance: invoice.balance.toString(),
      before: invoice.currentLength,
      after: invoice.compactLength,
    })),
  })
}

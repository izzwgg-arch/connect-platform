import { PrismaClient } from '@prisma/client'
import {
  CARDKNOX_HOSTED_FORM_URL,
  CARDKNOX_LONG_URL_THRESHOLD,
  CARDKNOX_MAX_URL_LENGTH,
  compactCardknoxUrl,
  enforceCardknoxUrlLength,
} from '@/lib/services/cardknox-url'

const prisma = new PrismaClient()

async function main() {
  const write = process.argv.includes('--write')
  const invoices = await prisma.invoice.findMany({
    where: {
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
      } catch (error) {
        console.error(
          `[Cardknox URL] Skipping invoice ${invoice.invoiceNumber || invoice.id}:`,
          error instanceof Error ? error.message : error
        )
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

  console.log(
    JSON.stringify(
      {
        mode: write ? 'write' : 'dry-run',
        maxUrlLength: CARDKNOX_MAX_URL_LENGTH,
        longUrlThreshold: CARDKNOX_LONG_URL_THRESHOLD,
        scanned: invoices.length,
        affected: affected.length,
        invoices: affected.map((invoice) => ({
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          balance: String(invoice.balance),
          before: invoice.currentLength,
          after: invoice.compactLength,
        })),
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

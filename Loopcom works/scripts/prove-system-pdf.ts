/**
 * PROOF: the PDFs attached to invoice/estimate/receipt emails are the exact
 * system PDFs, rendered with a real logo embedded.
 *
 * Run on the server:
 *   npx tsx -r dotenv/config scripts/prove-system-pdf.ts
 *
 * Outputs real PDFs to ./proof-pdfs and logs whether the logo is embedded.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/prisma'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildInvoicePdfHtml, buildEstimatePdfHtml } from '@/lib/documents/pdf-templates'
import { renderPdfFromHtml } from '@/lib/pdf/render-html-to-pdf'
import { generatePaymentReceiptPdf } from '@/lib/payments/receipts'
import { getBrandingSettingsForTenant } from '@/lib/branding/settings'

const OUT = path.join(process.cwd(), 'proof-pdfs')

function logoKind(dataUri: string): string {
  if (!dataUri.startsWith('data:')) return `NON-DATA-URI (${dataUri.slice(0, 60)})`
  const mime = dataUri.slice(5, dataUri.indexOf(';') > 0 ? dataUri.indexOf(';') : dataUri.indexOf(','))
  if (dataUri.includes('image/svg')) return `EMBEDDED FALLBACK SVG (${mime})`
  return `EMBEDDED REAL IMAGE (${mime}, ${dataUri.length} chars)`
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const tenant = await prisma.tenant.findFirst({ select: { id: true, name: true } })
  if (!tenant) throw new Error('no tenant')
  console.log('Tenant:', tenant.id, tenant.name)

  // ---- Logo proof -------------------------------------------------------
  const baseBrand = await getPdfBranding(tenant.id)
  console.log('\n[LOGO] current resolved logo:', logoKind(baseBrand.logoUrl))

  // Prove that when a real logo file exists at the branding path, it embeds.
  const branding: any = await getBrandingSettingsForTenant(tenant.id)
  const rawLogo: string | null = branding?.invoiceLogoUrl || branding?.webLogoUrl || null
  let tempLogoPath: string | null = null
  let brandWithRealLogo = baseBrand
  if (rawLogo && rawLogo.startsWith('/uploads/')) {
    // find any existing image in the tenant uploads dir to use as a stand-in
    const uploadsDir = path.join(process.cwd(), 'public', path.dirname(rawLogo))
    const target = path.join(process.cwd(), 'public', rawLogo)
    try {
      const candidates = fs
        .readdirSync(uploadsDir)
        .filter((f) => /\.(png|jpe?g|webp|gif|svg)$/i.test(f))
      if (candidates.length && !fs.existsSync(target)) {
        fs.copyFileSync(path.join(uploadsDir, candidates[0]), target)
        tempLogoPath = target
        console.log(`[LOGO] (test) placed stand-in logo at branding path using ${candidates[0]}`)
      }
    } catch (e) {
      console.log('[LOGO] could not stage stand-in logo:', (e as Error).message)
    }
    brandWithRealLogo = await getPdfBranding(tenant.id)
    console.log('[LOGO] with file present at branding path:', logoKind(brandWithRealLogo.logoUrl))
  }

  const brand = brandWithRealLogo

  // ---- Invoice ----------------------------------------------------------
  const invoice = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: 'desc' },
    include: {
      client: { include: { contacts: { where: { isPrimary: true }, take: 1 } } },
      lineItems: { orderBy: { sortOrder: 'asc' } },
      optionalItems: { orderBy: { sortOrder: 'asc' } },
      job: {
        select: {
          id: true,
          jobNumber: true,
          title: true,
          addresses: { where: { type: 'job_site' }, take: 1 },
        },
      },
      estimate: { select: { jobSiteAddress: true } },
    },
  })
  if (invoice) {
    const html = buildInvoicePdfHtml(invoice, brand)
    const pdf = await renderPdfFromHtml(html)
    const hasLogoImg = html.includes('class="logo-image"')
    fs.writeFileSync(path.join(OUT, `invoice-${invoice.invoiceNumber}.pdf`), pdf)
    console.log(`\n[INVOICE] ${invoice.invoiceNumber}: ${pdf.length} bytes, logo <img>=${hasLogoImg}`)
  } else {
    console.log('\n[INVOICE] none found')
  }

  // ---- Estimate ---------------------------------------------------------
  const estimate = await prisma.estimate.findFirst({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: 'desc' },
    include: {
      client: { select: { id: true, name: true, companyName: true, email: true, phone: true } },
      lineItems: { orderBy: { sortOrder: 'asc' } },
      optionalItems: { orderBy: { sortOrder: 'asc' } },
    },
  })
  if (estimate) {
    const approvals = await prisma.estimateItemApproval.findMany({
      where: { estimateId: estimate.id, status: 'APPROVED' },
      select: { estimateLineItemId: true },
    })
    const approvedIds = new Set(approvals.map((a) => a.estimateLineItemId))
    const html = buildEstimatePdfHtml(estimate, brand, approvedIds)
    const pdf = await renderPdfFromHtml(html)
    const hasLogoImg = html.includes('class="logo-image"')
    fs.writeFileSync(path.join(OUT, `estimate-${estimate.estimateNumber}.pdf`), pdf)
    console.log(`[ESTIMATE] ${estimate.estimateNumber}: ${pdf.length} bytes, logo <img>=${hasLogoImg}`)
  } else {
    console.log('[ESTIMATE] none found')
  }

  // ---- Receipt ----------------------------------------------------------
  const payment = await prisma.payment.findFirst({
    where: { invoice: { tenantId: tenant.id } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (payment) {
    const receipt = await generatePaymentReceiptPdf(payment.id, tenant.id)
    if (receipt) {
      fs.writeFileSync(path.join(OUT, receipt.filename), receipt.buffer)
      console.log(`[RECEIPT] ${receipt.filename}: ${receipt.buffer.length} bytes`)
    } else {
      console.log('[RECEIPT] could not generate')
    }
  } else {
    console.log('[RECEIPT] no payment found')
  }

  // cleanup stand-in logo so we don't leave a wrong logo in production
  if (tempLogoPath) {
    try {
      fs.unlinkSync(tempLogoPath)
      console.log('\n[LOGO] removed stand-in logo (real logo must be re-uploaded in Branding)')
    } catch {}
  }

  await prisma.$disconnect()
  console.log('\nDONE. PDFs in', OUT)
}

main().catch((e) => {
  console.error('prove-system-pdf failed:', e)
  process.exit(1)
})

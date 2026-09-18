/**
 * Render the invoice/estimate PDF HTML to PNG screenshots (with a real logo
 * embedded) so the output can be visually verified.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import puppeteer from 'puppeteer'
import { prisma } from '@/lib/prisma'
import { getPdfBranding } from '@/lib/branding/pdf'
import { buildInvoicePdfHtml, buildEstimatePdfHtml, buildPurchaseOrderPdfHtml } from '@/lib/documents/pdf-templates'
import { getBrandingSettingsForTenant } from '@/lib/branding/settings'
import { getPaymentReceiptHtmlByToken } from '@/lib/payments/receipts'

const OUT = path.join(process.cwd(), 'proof-pdfs')

async function shoot(html: string, file: string) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 1400, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: ['load', 'networkidle0'] })
  await page.screenshot({ path: path.join(OUT, file), fullPage: true })
  await browser.close()
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const tenant = await prisma.tenant.findFirst({ select: { id: true } })
  if (!tenant) throw new Error('no tenant')

  const branding: any = await getBrandingSettingsForTenant(tenant.id)
  const rawLogo: string | null = branding?.invoiceLogoUrl || branding?.webLogoUrl || null
  let tempLogoPath: string | null = null
  if (rawLogo && rawLogo.startsWith('/uploads/')) {
    const uploadsDir = path.join(process.cwd(), 'public', path.dirname(rawLogo))
    const target = path.join(process.cwd(), 'public', rawLogo)
    try {
      const candidates = fs.readdirSync(uploadsDir).filter((f) => /\.(png|jpe?g|webp|gif|svg)$/i.test(f))
      if (candidates.length && !fs.existsSync(target)) {
        fs.copyFileSync(path.join(uploadsDir, candidates[0]), target)
        tempLogoPath = target
      }
    } catch {}
  }

  const brand = await getPdfBranding(tenant.id)

  const invoice = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: 'desc' },
    include: {
      client: { include: { contacts: { where: { isPrimary: true }, take: 1 } } },
      lineItems: { orderBy: { sortOrder: 'asc' } },
      optionalItems: { orderBy: { sortOrder: 'asc' } },
      job: { select: { id: true, jobNumber: true, title: true, addresses: { where: { type: 'job_site' }, take: 1 } } },
      estimate: { select: { jobSiteAddress: true } },
    },
  })
  if (invoice) await shoot(buildInvoicePdfHtml(invoice, brand), `invoice-${invoice.invoiceNumber}.png`)

  const purchaseOrder = await prisma.purchaseOrder.findFirst({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: 'desc' },
    include: {
      vendorRef: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          address: true,
          city: true,
          state: true,
          zipCode: true,
          contactPerson: true,
        },
      },
      lineItems: { orderBy: { sortOrder: 'asc' } },
      job: {
        select: {
          id: true,
          jobNumber: true,
          title: true,
          addresses: { where: { type: 'job_site' }, take: 1 },
          client: { select: { id: true, name: true } },
        },
      },
    },
  })
  if (purchaseOrder) {
    await shoot(
      buildPurchaseOrderPdfHtml(purchaseOrder, {
        logoUrl: brand.logoUrl,
        businessName: brand.businessName,
      }),
      `purchase-order-${purchaseOrder.poNumber}.png`
    )
  }

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
    await shoot(
      buildEstimatePdfHtml(estimate, brand, new Set(approvals.map((a) => a.estimateLineItemId))),
      `estimate-${estimate.estimateNumber}.png`
    )
  }

  const payment = await prisma.payment.findFirst({
    where: { invoice: { tenantId: tenant.id }, receiptToken: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { receiptToken: true },
  })
  if (payment?.receiptToken) {
    const r = await getPaymentReceiptHtmlByToken(payment.receiptToken)
    if (r) await shoot(r.html, `receipt.png`)
  }

  if (tempLogoPath) {
    try { fs.unlinkSync(tempLogoPath) } catch {}
  }
  await prisma.$disconnect()
  console.log('PNGs written to', OUT)
}

main().catch((e) => { console.error(e); process.exit(1) })

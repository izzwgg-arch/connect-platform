import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import puppeteer from 'puppeteer'
import { prisma } from '@/lib/prisma'
import { generateAccessToken } from '@/lib/auth'

const OUT = path.join(process.cwd(), 'proof-pdfs')
const BASE_URL = process.env.PROOF_BASE_URL || 'http://127.0.0.1:3000'

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  const user = await prisma.user.findFirst({
    where: {
      status: 'ACTIVE',
      allowWebLogin: true,
    },
    select: {
      id: true,
      tenantId: true,
      email: true,
      role: true,
    },
  })

  if (!user) throw new Error('No active web user found for proof capture')

  const invoice = await prisma.invoice.findFirst({
    where: {
      tenantId: user.tenantId,
      OR: [
        {
          job: {
            addresses: {
              some: {
                type: 'job_site',
              },
            },
          },
        },
        {
          estimate: {
            jobSiteAddress: { not: null },
          },
        },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, invoiceNumber: true },
  })

  const purchaseOrder = await prisma.purchaseOrder.findFirst({
    where: {
      tenantId: user.tenantId,
      job: {
        addresses: {
          some: { type: 'job_site' },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, poNumber: true },
  })

  if (!invoice) throw new Error('No invoice with job site address found')
  if (!purchaseOrder) throw new Error('No purchase order with job site address found')

  const accessToken = generateAccessToken({
    userId: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
  })

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1600, deviceScaleFactor: 1 })
  page.setDefaultNavigationTimeout(120000)

  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate((token) => {
    localStorage.setItem('accessToken', token)
  }, accessToken)

  await page.goto(`${BASE_URL}/dashboard/invoices/${invoice.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('body')
  await page.waitForSelector('text/Job Site Address', { timeout: 60000 }).catch(() => undefined)
  await page.screenshot({
    path: path.join(OUT, `invoice-page-${invoice.invoiceNumber}.png`),
    fullPage: true,
  })

  await page.goto(`${BASE_URL}/dashboard/purchase-orders/${purchaseOrder.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('body')
  await page.waitForSelector('text/Job Site Address', { timeout: 60000 }).catch(() => undefined)
  await page.screenshot({
    path: path.join(OUT, `purchase-order-page-${purchaseOrder.poNumber}.png`),
    fullPage: true,
  })

  await browser.close()
  await prisma.$disconnect()

  console.log('Page proofs written to', OUT)
  console.log('Invoice ID:', invoice.id, invoice.invoiceNumber)
  console.log('Purchase Order ID:', purchaseOrder.id, purchaseOrder.poNumber)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

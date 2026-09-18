/**
 * Diagnose why the branding logo is not rendering in PDFs.
 * Run on the server: npx tsx -r dotenv/config scripts/diagnose-logo.ts
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/prisma'
import { getBrandingSettingsForTenant } from '@/lib/branding/settings'
import { getPdfBranding } from '@/lib/branding/pdf'

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } })
  console.log(`Tenants: ${tenants.length}`)

  for (const t of tenants) {
    const branding: any = await getBrandingSettingsForTenant(t.id)
    const invoiceLogoUrl = branding?.invoiceLogoUrl || null
    const webLogoUrl = branding?.webLogoUrl || null
    const raw = invoiceLogoUrl || webLogoUrl || null

    console.log('\n=== TENANT', t.id, `(${t.name}) ===`)
    console.log('  invoiceLogoUrl:', invoiceLogoUrl)
    console.log('  webLogoUrl    :', webLogoUrl)

    if (raw && raw.startsWith('/')) {
      const p = path.join(process.cwd(), 'public', raw.replace(/^\/api\/public/, ''))
      try {
        const st = fs.statSync(p)
        console.log('  local file    :', p, `(${st.size} bytes)`) 
      } catch {
        console.log('  local file    : NOT FOUND at', p)
      }
    }

    const brand = await getPdfBranding(t.id)
    const resolved = brand.logoUrl || ''
    console.log('  resolved logo : prefix=', resolved.slice(0, 40).replace(/\n/g, ' '), '... length=', resolved.length)
    console.log('  is data URI?  :', resolved.startsWith('data:'))
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('diagnose-logo failed:', e)
  process.exit(1)
})

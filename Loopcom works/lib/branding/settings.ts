import { prisma } from '@/lib/prisma'
import path from 'path'
import { promises as fs } from 'fs'

export const BRANDING_SECTION_KEYS = {
  ui: [
    'primaryColor',
    'secondaryColor',
    'backgroundColor',
    'sidebarColor',
    'menuColor',
    'buttonColor',
    'buttonTextColor',
    'textPrimaryColor',
    'textSecondaryColor',
    'linkColor',
    'borderColor',
    'successColor',
    'warningColor',
    'dangerColor',
  ],
  logos: ['webLogoUrl', 'faviconUrl', 'mobileAppIconUrl', 'mobileAppSplashLogoUrl'],
  invoice: [
    'invoicePdfTemplateId',
    'invoiceStyle',
    'invoiceBusinessName',
    'invoicePhone',
    'invoiceEmail',
    'invoiceAddress',
    'invoiceFooterText',
    'invoiceLogoUrl',
  ],
  email: [
    'emailPrimaryColor',
    'emailButtonColor',
    'emailButtonTextColor',
    'emailBackgroundColor',
    'emailCardBackgroundColor',
    'emailHeaderBackgroundColor',
    'emailFooterBackgroundColor',
    'emailTextPrimaryColor',
    'emailTextSecondaryColor',
    'emailLinkColor',
    'emailBorderColor',
    'emailLogoUrl',
    'emailFooterText',
    'emailSignature',
    'emailCustomHeaderHTML',
    'emailCustomFooterHTML',
  ],
} as const

type BrandingSection = keyof typeof BRANDING_SECTION_KEYS

function buildNullPatch(keys: readonly string[]) {
  return keys.reduce<Record<string, null>>((acc, key) => {
    acc[key] = null
    return acc
  }, {})
}

function getBrandingFilePath(tenantId: string) {
  return path.join(process.cwd(), 'data', 'branding', `${tenantId}.json`)
}

async function readBrandingFromFile(tenantId: string) {
  try {
    const filePath = getBrandingFilePath(tenantId)
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function writeBrandingToFile(tenantId: string, next: Record<string, unknown>) {
  const filePath = getBrandingFilePath(tenantId)
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const withTimestamp = { ...next, updatedAt: new Date().toISOString() }
  await fs.writeFile(filePath, JSON.stringify(withTimestamp, null, 2), 'utf8')
  return withTimestamp
}

function getBrandingModel() {
  const model = (prisma as any)?.brandingSettings
  return model && typeof model.findUnique === 'function' && typeof model.upsert === 'function'
    ? model
    : null
}

export async function getBrandingSettingsForTenant(tenantId: string) {
  const model = getBrandingModel()
  if (model) {
    return model.findUnique({
      where: { tenantId },
    })
  }
  return readBrandingFromFile(tenantId)
}

export async function upsertBrandingSettingsForTenant(tenantId: string, data: Record<string, unknown>) {
  const model = getBrandingModel()
  if (model) {
    return model.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    })
  }

  const existing = (await readBrandingFromFile(tenantId)) || {}
  const merged = { ...existing, ...data }
  return writeBrandingToFile(tenantId, merged)
}

export async function resetAllBrandingSettingsForTenant(tenantId: string) {
  const keys = [
    ...BRANDING_SECTION_KEYS.ui,
    ...BRANDING_SECTION_KEYS.logos,
    ...BRANDING_SECTION_KEYS.invoice,
    ...BRANDING_SECTION_KEYS.email,
  ]
  return upsertBrandingSettingsForTenant(tenantId, buildNullPatch(keys))
}

export async function resetBrandingSectionForTenant(tenantId: string, section: BrandingSection) {
  return upsertBrandingSettingsForTenant(tenantId, buildNullPatch(BRANDING_SECTION_KEYS[section]))
}


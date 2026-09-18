import { getInvoiceTemplateById } from '@/lib/invoices/templates/registry'

type AnyRecord = Record<string, any>

export function buildInvoiceRenderSnapshot(branding: AnyRecord | null | undefined) {
  if (!branding) return null
  const template = getInvoiceTemplateById(branding.invoicePdfTemplateId || branding.invoiceStyle || null)
  return {
    templateKey: template?.id || null,
    templateVersion: template?.version || 1,
    accentColor: template?.preview.accentColor || '#12344d',
    businessName: branding.invoiceBusinessName || null,
    businessPhone: branding.invoicePhone || null,
    businessEmail: branding.invoiceEmail || null,
    businessAddress: branding.invoiceAddress || null,
    footerText: branding.invoiceFooterText || null,
    logoUrl: branding.invoiceLogoUrl || null,
  }
}

export function resolveInvoiceRenderSnapshot(invoice: AnyRecord, branding: AnyRecord | null | undefined) {
  const snap = (invoice?.renderSnapshot as AnyRecord | null) || null
  if (snap) {
    return {
      templateKey: invoice.renderTemplateKey || snap.templateKey || null,
      templateVersion: invoice.renderTemplateVersion || snap.templateVersion || 1,
      accentColor: snap.accentColor || '#12344d',
      businessName: snap.businessName || null,
      businessPhone: snap.businessPhone || null,
      businessEmail: snap.businessEmail || null,
      businessAddress: snap.businessAddress || null,
      footerText: snap.footerText || null,
      logoUrl: snap.logoUrl || null,
    }
  }

  const template = getInvoiceTemplateById(branding?.invoicePdfTemplateId || branding?.invoiceStyle || null)
  return {
    templateKey: template?.id || null,
    templateVersion: template?.version || 1,
    accentColor: template?.preview.accentColor || '#12344d',
    businessName: branding?.invoiceBusinessName || null,
    businessPhone: branding?.invoicePhone || null,
    businessEmail: branding?.invoiceEmail || null,
    businessAddress: branding?.invoiceAddress || null,
    footerText: branding?.invoiceFooterText || null,
    logoUrl: branding?.invoiceLogoUrl || null,
  }
}


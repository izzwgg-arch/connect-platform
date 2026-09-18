import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeUiTheme, resolveEmailTheme } from '../lib/branding/theme'
import { resolveInvoiceRenderSnapshot } from '../lib/invoices/templates/rendering'
import { INVOICE_TEMPLATES, getInvoiceTemplateById } from '../lib/invoices/templates/registry'

test('mergeUiTheme preserves defaults when branding is unset', () => {
  const defaults = {
    primaryColor: '#123456',
    secondaryColor: '#abcdef',
    backgroundColor: '#ffffff',
    sidebarColor: '#111111',
    menuColor: '#222222',
    buttonColor: '#333333',
    buttonTextColor: '#ffffff',
    textPrimaryColor: '#101010',
    textSecondaryColor: '#707070',
    linkColor: '#4444ff',
    borderColor: '#dddddd',
    successColor: '#00aa00',
    warningColor: '#ffaa00',
    dangerColor: '#dd0000',
  }

  const merged = mergeUiTheme(defaults, null)
  assert.deepEqual(merged, defaults)
})

test('mergeUiTheme only overrides provided keys', () => {
  const defaults = {
    primaryColor: '#123456',
    secondaryColor: '#abcdef',
    backgroundColor: '#ffffff',
    sidebarColor: '#111111',
    menuColor: '#222222',
    buttonColor: '#333333',
    buttonTextColor: '#ffffff',
    textPrimaryColor: '#101010',
    textSecondaryColor: '#707070',
    linkColor: '#4444ff',
    borderColor: '#dddddd',
    successColor: '#00aa00',
    warningColor: '#ffaa00',
    dangerColor: '#dd0000',
  }

  const merged = mergeUiTheme(defaults, {
    primaryColor: '#ff0000',
    buttonColor: '#00ff00',
  })
  assert.equal(merged.primaryColor, '#ff0000')
  assert.equal(merged.buttonColor, '#00ff00')
  assert.equal(merged.secondaryColor, defaults.secondaryColor)
  assert.equal(merged.backgroundColor, defaults.backgroundColor)
})

test('invoice snapshot takes precedence over active branding style', () => {
  const invoice = {
    renderTemplateKey: 'classic-ledger',
    renderTemplateVersion: 1,
    renderSnapshot: {
      templateKey: 'classic-ledger',
      accentColor: '#c2410c',
      footerText: 'Snapshot footer',
    },
  }
  const branding = {
    invoicePdfTemplateId: 'modern-minimal-left-header',
    invoiceFooterText: 'Live footer',
  }

  const resolved = resolveInvoiceRenderSnapshot(invoice, branding)
  assert.equal(resolved.templateKey, 'classic-ledger')
  assert.equal(resolved.accentColor, '#c2410c')
  assert.equal(resolved.footerText, 'Snapshot footer')
})

test('resolveEmailTheme falls back to defaults when unset', () => {
  const theme = resolveEmailTheme(null)
  assert.equal(theme.button, '#12344d')
  assert.equal(theme.background, '#ffffff')
})

test('invoice PDF template registry contains required 20 templates', () => {
  assert.equal(INVOICE_TEMPLATES.length, 20)
  assert.equal(INVOICE_TEMPLATES[0].name, 'Modern Minimal Left Header')
  assert.equal(INVOICE_TEMPLATES[19].name, 'Asymmetrical Modern')
})

test('getInvoiceTemplateById resolves valid template ids', () => {
  const template = getInvoiceTemplateById('classic-ledger')
  assert.ok(template)
  assert.equal(template?.category, 'classic')
})


export interface InvoiceTemplateDefinition {
  id: string
  name: string
  category: 'modern' | 'classic' | 'vintage' | 'bold'
  description: string
  preview: {
    accentColor: string
    headerStyle: 'left' | 'center' | 'split' | 'band' | 'receipt'
    tableStyle: 'grid' | 'striped' | 'boxed' | 'minimal'
  }
  version: number
}

export const INVOICE_TEMPLATES: InvoiceTemplateDefinition[] = [
  { id: 'modern-minimal-left-header', name: 'Modern Minimal Left Header', category: 'modern', description: 'Minimal left-aligned header with compact metadata.', preview: { accentColor: '#1f2937', headerStyle: 'left', tableStyle: 'minimal' }, version: 1 },
  { id: 'modern-centered-logo', name: 'Modern Centered Logo', category: 'modern', description: 'Centered branding block with stacked invoice details.', preview: { accentColor: '#0f766e', headerStyle: 'center', tableStyle: 'grid' }, version: 1 },
  { id: 'modern-split-columns', name: 'Modern Split Columns', category: 'modern', description: 'Business and client info split into mirrored columns.', preview: { accentColor: '#2563eb', headerStyle: 'split', tableStyle: 'grid' }, version: 1 },
  { id: 'modern-full-header-band', name: 'Modern Full Header Band', category: 'modern', description: 'Full-width top band with strong title hierarchy.', preview: { accentColor: '#0f172a', headerStyle: 'band', tableStyle: 'minimal' }, version: 1 },
  { id: 'modern-card-sections', name: 'Modern Card Sections', category: 'modern', description: 'Card-based sections for parties, items, and totals.', preview: { accentColor: '#334155', headerStyle: 'left', tableStyle: 'boxed' }, version: 1 },
  { id: 'modern-sidebar-totals', name: 'Modern Sidebar Totals', category: 'modern', description: 'Main content with right-side totals column.', preview: { accentColor: '#0891b2', headerStyle: 'split', tableStyle: 'striped' }, version: 1 },
  { id: 'modern-large-total-focus', name: 'Modern Large Total Focus', category: 'modern', description: 'Large balance emphasis near page footer.', preview: { accentColor: '#111827', headerStyle: 'left', tableStyle: 'minimal' }, version: 1 },
  { id: 'modern-clean-grid-table', name: 'Modern Clean Grid Table', category: 'modern', description: 'Dense clean-grid line item presentation.', preview: { accentColor: '#0369a1', headerStyle: 'split', tableStyle: 'grid' }, version: 1 },

  { id: 'classic-ledger', name: 'Classic Ledger', category: 'classic', description: 'Traditional ledger style with ruled rows.', preview: { accentColor: '#7c2d12', headerStyle: 'left', tableStyle: 'striped' }, version: 1 },
  { id: 'classic-formal-business', name: 'Classic Formal Business', category: 'classic', description: 'Formal corporate hierarchy and conservative spacing.', preview: { accentColor: '#1f2937', headerStyle: 'split', tableStyle: 'boxed' }, version: 1 },
  { id: 'classic-serif-legal', name: 'Classic Serif Legal', category: 'classic', description: 'Serif typography with legal-style sectioning.', preview: { accentColor: '#44403c', headerStyle: 'left', tableStyle: 'grid' }, version: 1 },
  { id: 'classic-double-border', name: 'Classic Double Border', category: 'classic', description: 'Framed invoice with double-border emphasis.', preview: { accentColor: '#111827', headerStyle: 'center', tableStyle: 'boxed' }, version: 1 },
  { id: 'classic-letterhead', name: 'Classic Letterhead', category: 'classic', description: 'Letterhead-first layout with compact body.', preview: { accentColor: '#1e3a8a', headerStyle: 'band', tableStyle: 'minimal' }, version: 1 },

  { id: 'vintage-paper-look', name: 'Vintage Paper Look', category: 'vintage', description: 'Paper-toned spacing and retro separators.', preview: { accentColor: '#92400e', headerStyle: 'left', tableStyle: 'striped' }, version: 1 },
  { id: 'typewriter-monospace', name: 'Typewriter Monospace', category: 'vintage', description: 'Monospace typewriter hierarchy and fixed widths.', preview: { accentColor: '#57534e', headerStyle: 'left', tableStyle: 'grid' }, version: 1 },
  { id: 'old-retail-receipt-layout', name: 'Old Retail Receipt Layout', category: 'vintage', description: 'Receipt-style narrow hierarchy and totals stack.', preview: { accentColor: '#4b5563', headerStyle: 'receipt', tableStyle: 'minimal' }, version: 1 },
  { id: '80s-boxed-invoice', name: '80s Boxed Invoice', category: 'vintage', description: 'Heavy box grid inspired by 80s office printouts.', preview: { accentColor: '#1f2937', headerStyle: 'split', tableStyle: 'boxed' }, version: 1 },

  { id: 'bold-high-contrast', name: 'Bold High Contrast', category: 'bold', description: 'High contrast header and dramatic totals.', preview: { accentColor: '#dc2626', headerStyle: 'band', tableStyle: 'grid' }, version: 1 },
  { id: 'geometric-accent', name: 'Geometric Accent', category: 'bold', description: 'Geometric blocks and accent dividers.', preview: { accentColor: '#7c3aed', headerStyle: 'split', tableStyle: 'striped' }, version: 1 },
  { id: 'asymmetrical-modern', name: 'Asymmetrical Modern', category: 'bold', description: 'Asymmetrical layout with offset totals and metadata.', preview: { accentColor: '#0f766e', headerStyle: 'left', tableStyle: 'boxed' }, version: 1 },
]

export function getInvoiceTemplateById(id: string | null | undefined) {
  if (!id) return null
  return INVOICE_TEMPLATES.find((template) => template.id === id) || null
}


'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { INVOICE_TEMPLATES } from '@/lib/invoices/templates/registry'
import Cropper, { type Area } from 'react-easy-crop'
import 'react-easy-crop/react-easy-crop.css'

type Branding = Record<string, string | null>

const BRANDING_ALLOWED_KEYS = new Set<string>([
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
  'webLogoUrl',
  'faviconUrl',
  'mobileAppIconUrl',
  'mobileAppSplashLogoUrl',
  'invoiceStyle',
  'invoicePdfTemplateId',
  'invoiceBusinessName',
  'invoicePhone',
  'invoiceEmail',
  'invoiceAddress',
  'invoiceFooterText',
  'invoiceLogoUrl',
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
])

function sanitizeBrandingPayload(input: Record<string, unknown>): Branding {
  const output: Branding = {}
  for (const [key, value] of Object.entries(input || {})) {
    if (!BRANDING_ALLOWED_KEYS.has(key)) continue
    if (value == null) {
      output[key] = null
      continue
    }
    output[key] = typeof value === 'string' ? value : String(value)
  }
  return output
}

const COLOR_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'primaryColor', label: 'Primary' },
  { key: 'secondaryColor', label: 'Secondary' },
  { key: 'backgroundColor', label: 'Background' },
  { key: 'sidebarColor', label: 'Sidebar' },
  { key: 'menuColor', label: 'Menu' },
  { key: 'buttonColor', label: 'Buttons' },
  { key: 'buttonTextColor', label: 'Button Text' },
  { key: 'textPrimaryColor', label: 'Main Text' },
  { key: 'textSecondaryColor', label: 'Secondary Text' },
  { key: 'linkColor', label: 'Link' },
  { key: 'borderColor', label: 'Border' },
  { key: 'successColor', label: 'Success' },
  { key: 'warningColor', label: 'Warning' },
  { key: 'dangerColor', label: 'Danger' },
]

const LOGO_FIELDS: Array<{ key: string; label: string; note: string }> = [
  { key: 'webLogoUrl', label: 'Web Logo', note: 'Recommended SVG, min 200x60' },
  { key: 'faviconUrl', label: 'Favicon', note: 'Recommended 32x32 PNG' },
  { key: 'mobileAppIconUrl', label: 'Mobile App Icon', note: 'Recommended 1024x1024 PNG' },
  { key: 'mobileAppSplashLogoUrl', label: 'Mobile Splash Logo', note: 'Recommended SVG or 512x512 PNG' },
]

const EMAIL_COLOR_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'emailPrimaryColor', label: 'Primary' },
  { key: 'emailButtonColor', label: 'Button Background' },
  { key: 'emailButtonTextColor', label: 'Button Text' },
  { key: 'emailBackgroundColor', label: 'Background' },
  { key: 'emailCardBackgroundColor', label: 'Card Background' },
  { key: 'emailHeaderBackgroundColor', label: 'Header Background' },
  { key: 'emailFooterBackgroundColor', label: 'Footer Background' },
  { key: 'emailTextPrimaryColor', label: 'Primary Text' },
  { key: 'emailTextSecondaryColor', label: 'Secondary Text' },
  { key: 'emailLinkColor', label: 'Link' },
  { key: 'emailBorderColor', label: 'Border' },
]

function isValidHex(value: string) {
  return /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(value)
}

function createImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = url
  })
}

/**
 * Finds the bounding box of non-transparent pixels in a canvas.
 * Returns null if the canvas is fully transparent.
 */
function findContentBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { x: number; y: number; w: number; h: number } | null {
  let top = height, bottom = -1, left = width, right = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3]
      if (alpha > 8) {
        if (y < top) top = y
        if (y > bottom) bottom = y
        if (x < left) left = x
        if (x > right) right = x
      }
    }
  }

  if (bottom < 0) return null

  // 2px padding so content doesn't touch the very edge
  const pad = 2
  const x = Math.max(0, left - pad)
  const y = Math.max(0, top - pad)
  const w = Math.min(width, right + pad + 1) - x
  const h = Math.min(height, bottom + pad + 1) - y
  return { x, y, w, h }
}

/** Max output dimension (longest side) for saved logo PNGs. */
const LOGO_MAX_PX = 1200

async function getCroppedImageFile(
  imageSrc: string,
  crop: Area,
  outputName: string
): Promise<File> {
  const image = await createImage(imageSrc)

  const cropW = Math.max(1, Math.round(crop.width))
  const cropH = Math.max(1, Math.round(crop.height))

  // Step 1: draw the user's selected crop region at natural pixel size
  const cropCanvas = document.createElement('canvas')
  cropCanvas.width = cropW
  cropCanvas.height = cropH
  const cropCtx = cropCanvas.getContext('2d')
  if (!cropCtx) throw new Error('Canvas not available')

  cropCtx.drawImage(image, crop.x, crop.y, cropW, cropH, 0, 0, cropW, cropH)

  // Step 2: auto-trim transparent padding
  const imageData = cropCtx.getImageData(0, 0, cropW, cropH)
  const bounds = findContentBounds(imageData.data, cropW, cropH)

  const trimX = bounds?.x ?? 0
  const trimY = bounds?.y ?? 0
  const trimW = bounds?.w ?? cropW
  const trimH = bounds?.h ?? cropH

  // Step 3: scale to LOGO_MAX_PX on the longest side (preserve aspect ratio)
  const scale = Math.min(1, LOGO_MAX_PX / Math.max(trimW, trimH))
  const outW = Math.max(1, Math.round(trimW * scale))
  const outH = Math.max(1, Math.round(trimH * scale))

  const finalCanvas = document.createElement('canvas')
  finalCanvas.width = outW
  finalCanvas.height = outH
  const finalCtx = finalCanvas.getContext('2d')
  if (!finalCtx) throw new Error('Canvas not available')

  finalCtx.drawImage(cropCanvas, trimX, trimY, trimW, trimH, 0, 0, outW, outH)

  const blob = await new Promise<Blob | null>((resolve) =>
    finalCanvas.toBlob(resolve, 'image/png', 0.95)
  )
  if (!blob) throw new Error('Failed to create cropped image')

  return new File([blob], outputName, { type: 'image/png' })
}

/** Generate a small preview data-URL from the current crop selection (for live preview). */
async function generateCropPreview(
  imageSrc: string,
  crop: Area,
  previewW: number,
  previewH: number
): Promise<string | null> {
  try {
    const image = await createImage(imageSrc)
    const canvas = document.createElement('canvas')
    canvas.width = previewW
    canvas.height = previewH
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // Draw crop region scaled to preview size
    ctx.drawImage(
      image,
      crop.x, crop.y, Math.max(1, crop.width), Math.max(1, crop.height),
      0, 0, previewW, previewH
    )
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

export default function BrandingSettingsPage() {
  const [branding, setBranding] = useState<Branding>({})
  const [draft, setDraft] = useState<Branding>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [invoicePreviewUrl, setInvoicePreviewUrl] = useState<string | null>(null)
  const [invoicePreviewLoading, setInvoicePreviewLoading] = useState(false)
  const [cropFieldKey, setCropFieldKey] = useState<string | null>(null)
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null)
  const [cropX, setCropX] = useState(0)
  const [cropY, setCropY] = useState(0)
  const [cropZoom, setCropZoom] = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [cropping, setCropping] = useState(false)
  const [cropPreviewUrl, setCropPreviewUrl] = useState<string | null>(null)
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null

  const fetchBranding = async () => {
    if (!token) return
    setLoading(true)
    try {
      const response = await fetch('/api/branding', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json()
      const nextBranding = sanitizeBrandingPayload(data?.branding || {})
      setBranding(nextBranding)
      setDraft(nextBranding)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchBranding()
  }, [])

  const setField = (key: string, value: string | null) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const saveBranding = async () => {
    if (!token) return

    for (const field of [...COLOR_FIELDS, ...EMAIL_COLOR_FIELDS]) {
      const val = draft[field.key]
      if (val && !isValidHex(val)) {
        alert(`Invalid HEX for ${field.label}`)
        return
      }
    }

    setSaving(true)
    try {
      const response = await fetch('/api/branding', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sanitizeBrandingPayload(draft)),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to save branding' }))
        alert(payload.error || 'Failed to save branding')
        return
      }
      await fetchBranding()
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('branding-updated'))
      }
    } finally {
      setSaving(false)
    }
  }

  const resetAll = async () => {
    if (!token) return
    await fetch('/api/branding/reset', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    await fetchBranding()
  }

  const resetSection = async (section: 'ui' | 'logos' | 'invoice' | 'email') => {
    if (!token) return
    await fetch('/api/branding/reset-section', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ section }),
    })
    await fetchBranding()
  }

  const uploadAsset = async (file: File, fieldKey: string) => {
    if (!token) return
    const form = new FormData()
    form.append('file', file)
    const response = await fetch('/api/uploads', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: 'Upload failed' }))
      alert(payload.error || 'Upload failed')
      return
    }
    const data = await response.json()
    setField(fieldKey, data.url)
  }

  const startCropUpload = async (file: File, fieldKey: string) => {
    // SVGs are vectors — skip the canvas cropper and upload directly
    if (file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
      await uploadAsset(file, fieldKey)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setCropFieldKey(fieldKey)
      setCropImageSrc(String(reader.result || ''))
      setCropX(0)
      setCropY(0)
      setCropZoom(1)
      setCroppedAreaPixels(null)
    }
    reader.readAsDataURL(file)
  }

  const closeCropper = () => {
    setCropFieldKey(null)
    setCropImageSrc(null)
    setCroppedAreaPixels(null)
    setCropping(false)
    setCropPreviewUrl(null)
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current)
  }

  const confirmCropAndUpload = async () => {
    if (!cropImageSrc || !cropFieldKey || !croppedAreaPixels) return
    setCropping(true)
    try {
      const file = await getCroppedImageFile(
        cropImageSrc,
        croppedAreaPixels,
        `${cropFieldKey}-${Date.now()}.png`
      )
      await uploadAsset(file, cropFieldKey)
      closeCropper()
    } catch {
      alert('Failed to crop image')
    } finally {
      setCropping(false)
    }
  }

  const cropAspect = useMemo(() => {
    // favicon is square; all logo fields use free-form (undefined = no constraint)
    if (cropFieldKey === 'faviconUrl') return 1
    if (cropFieldKey === 'mobileAppIconUrl') return 1
    return undefined
  }, [cropFieldKey])

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'branding-settings.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const importJson = async (file: File) => {
    const text = await file.text()
    try {
      const parsed = JSON.parse(text)
      setDraft((prev) => ({ ...prev, ...sanitizeBrandingPayload(parsed) }))
    } catch {
      alert('Invalid JSON file')
    }
  }

  const emailPreview = useMemo(() => {
    const bg = draft.emailBackgroundColor || '#ffffff'
    const cardBg = draft.emailCardBackgroundColor || '#111827'
    const headerBg = draft.emailHeaderBackgroundColor || '#111827'
    const footerBg = draft.emailFooterBackgroundColor || '#111827'
    const textPrimary = draft.emailTextPrimaryColor || 'rgba(255,255,255,0.92)'
    const textSecondary = draft.emailTextSecondaryColor || 'rgba(255,255,255,0.68)'
    const button = draft.emailButtonColor || '#12344d'
    const buttonText = draft.emailButtonTextColor || '#ffffff'
    return { bg, cardBg, headerBg, footerBg, textPrimary, textSecondary, button, buttonText }
  }, [draft])

  const selectedInvoiceTemplate = useMemo(() => {
    const id = draft.invoicePdfTemplateId
    if (!id) return null
    return INVOICE_TEMPLATES.find((template) => template.id === id) || null
  }, [draft.invoicePdfTemplateId])

  useEffect(() => {
    const loadInvoicePreviewPdf = async () => {
      if (!token) return
      setInvoicePreviewLoading(true)
      try {
        const templateId = draft.invoicePdfTemplateId || ''
        const response = await fetch(`/api/branding/invoice-preview-pdf?templateId=${encodeURIComponent(templateId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!response.ok) {
          setInvoicePreviewUrl(null)
          return
        }
        const blob = await response.blob()
        if (invoicePreviewUrl) URL.revokeObjectURL(invoicePreviewUrl)
        const nextUrl = URL.createObjectURL(blob)
        setInvoicePreviewUrl(nextUrl)
      } finally {
        setInvoicePreviewLoading(false)
      }
    }
    void loadInvoicePreviewPdf()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.invoicePdfTemplateId, draft.invoiceBusinessName, draft.invoicePhone, draft.invoiceEmail, draft.invoiceAddress, draft.invoiceFooterText, draft.invoiceLogoUrl, token])

  if (loading) return <div className="p-6 text-sm text-gray-600">Loading branding settings...</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Branding</h1>
          <p className="text-sm text-gray-600">Optional overrides layered over existing defaults.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={resetAll}>Restore All Defaults</Button>
          <Button onClick={saveBranding} disabled={saving}>{saving ? 'Saving...' : 'Save Branding'}</Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>UI Colors</CardTitle>
          <CardDescription>Each field is optional and falls back to defaults when empty.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {COLOR_FIELDS.map((field) => (
            <div key={field.key} className="rounded border p-3">
              <Label>{field.label}</Label>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  value={draft[field.key] || ''}
                  placeholder="#000000"
                  onChange={(e) => setField(field.key, e.target.value || null)}
                />
                <input
                  type="color"
                  value={draft[field.key] || '#000000'}
                  onChange={(e) => setField(field.key, e.target.value || null)}
                  className="h-10 w-12 rounded border"
                />
                <div
                  className="h-10 w-10 rounded border"
                  style={{ background: draft[field.key] || 'transparent' }}
                />
                <Button variant="outline" onClick={() => setField(field.key, null)}>Reset</Button>
              </div>
            </div>
          ))}
          <div className="md:col-span-2">
            <Button variant="outline" onClick={() => resetSection('ui')}>Reset UI Section</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logos & Icons</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {LOGO_FIELDS.map((field) => (
            <div key={field.key} className="rounded border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label>{field.label}</Label>
                  <p className="text-xs text-gray-500">{field.note}</p>
                </div>
                <Button variant="outline" onClick={() => setField(field.key, null)}>Remove</Button>
              </div>
              <div className="mt-2 space-y-2">
                <Input
                  value={draft[field.key] || ''}
                  onChange={(e) => setField(field.key, e.target.value || null)}
                  placeholder="https://... or upload below"
                />
                <label className="flex cursor-pointer items-center gap-2 rounded border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-600 hover:border-gray-400 hover:bg-gray-50">
                  <span>Choose file (JPEG, PNG, SVG)</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/jpg,image/png,image/svg+xml,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void startCropUpload(file, field.key)
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
              {draft[field.key] ? (
                <img
                  src={draft[field.key] as string}
                  alt={field.label}
                  className="mt-2 h-16 max-w-full rounded border object-contain"
                  onError={(e) => {
                    const img = e.currentTarget
                    img.style.display = 'none'
                  }}
                />
              ) : null}
            </div>
          ))}
          <Button variant="outline" onClick={() => resetSection('logos')}>Reset Logos Section</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoice Styling</CardTitle>
          <CardDescription>Select a template and preview a sample invoice below.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {INVOICE_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => setField('invoicePdfTemplateId', template.id)}
                className={`rounded border p-3 text-left ${draft.invoicePdfTemplateId === template.id ? 'border-blue-500 ring-2 ring-blue-200' : ''}`}
              >
                <div className="h-8 rounded" style={{ backgroundColor: template.preview.accentColor }} />
                <div className="mt-2 text-sm font-medium">{template.name}</div>
                <div className="text-xs text-gray-500">{template.description}</div>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Input placeholder="Business Name" value={draft.invoiceBusinessName || ''} onChange={(e) => setField('invoiceBusinessName', e.target.value || null)} />
            <Input placeholder="Phone" value={draft.invoicePhone || ''} onChange={(e) => setField('invoicePhone', e.target.value || null)} />
            <Input placeholder="Email" value={draft.invoiceEmail || ''} onChange={(e) => setField('invoiceEmail', e.target.value || null)} />
            <Input placeholder="Address" value={draft.invoiceAddress || ''} onChange={(e) => setField('invoiceAddress', e.target.value || null)} />
            <Input placeholder="Footer Text" value={draft.invoiceFooterText || ''} onChange={(e) => setField('invoiceFooterText', e.target.value || null)} />
            <div className="space-y-1">
              <Label className="text-xs text-gray-600">Invoice Logo</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="https://... or upload"
                  value={draft.invoiceLogoUrl || ''}
                  onChange={(e) => setField('invoiceLogoUrl', e.target.value || null)}
                />
                <label className="flex shrink-0 cursor-pointer items-center rounded border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">
                  Upload
                  <input
                    type="file"
                    accept="image/jpeg,image/jpg,image/png,image/svg+xml,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void startCropUpload(file, 'invoiceLogoUrl')
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
              {draft.invoiceLogoUrl ? (
                <img
                  src={draft.invoiceLogoUrl}
                  alt="Invoice logo preview"
                  className="mt-1 h-10 max-w-xs rounded border object-contain"
                  onError={(e) => { e.currentTarget.style.display = 'none' }}
                />
              ) : null}
            </div>
          </div>

          <div className="rounded border p-4">
            <div className="mb-3 text-sm font-medium text-gray-700">PDF Preview</div>
            <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
              <span>{selectedInvoiceTemplate ? `${selectedInvoiceTemplate.name}` : 'Default production template'}</span>
              <span className="rounded border bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-700">
                {selectedInvoiceTemplate
                  ? `id: ${selectedInvoiceTemplate.id} | v${selectedInvoiceTemplate.version}`
                  : 'id: production-default'}
              </span>
            </div>
            <div className="overflow-hidden rounded border bg-white">
              {invoicePreviewLoading ? (
                <div className="p-8 text-center text-sm text-gray-500">Rendering PDF preview...</div>
              ) : invoicePreviewUrl ? (
                <iframe
                  title="Invoice PDF Preview"
                  src={invoicePreviewUrl}
                  className="h-[560px] w-full"
                />
              ) : (
                <div className="p-8 text-center text-sm text-gray-500">
                  Preview unavailable. Save and try again.
                </div>
              )}
            </div>
          </div>
          <Button variant="outline" onClick={() => resetSection('invoice')}>Reset Invoice Section</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email Templates & Branding</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {EMAIL_COLOR_FIELDS.map((field) => (
              <div key={field.key}>
                <Label>{field.label}</Label>
                <div className="mt-1 flex items-center gap-2">
                  <Input
                    value={draft[field.key] || ''}
                    placeholder="#000000"
                    onChange={(e) => setField(field.key, e.target.value || null)}
                  />
                  <input
                    type="color"
                    value={draft[field.key] || '#000000'}
                    onChange={(e) => setField(field.key, e.target.value || null)}
                    className="h-10 w-12 rounded border"
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-gray-600">Email Logo</Label>
            <div className="flex gap-2">
              <Input
                placeholder="https://... or upload"
                value={draft.emailLogoUrl || ''}
                onChange={(e) => setField('emailLogoUrl', e.target.value || null)}
              />
              <label className="flex shrink-0 cursor-pointer items-center rounded border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">
                Upload
                <input
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,image/svg+xml,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void startCropUpload(file, 'emailLogoUrl')
                    e.target.value = ''
                  }}
                />
              </label>
            </div>
            {draft.emailLogoUrl ? (
              <img
                src={draft.emailLogoUrl}
                alt="Email logo preview"
                className="mt-1 h-10 max-w-xs rounded border object-contain"
                onError={(e) => { e.currentTarget.style.display = 'none' }}
              />
            ) : null}
          </div>
          <textarea className="w-full rounded border p-2" rows={3} placeholder="Footer text" value={draft.emailFooterText || ''} onChange={(e) => setField('emailFooterText', e.target.value || null)} />
          <textarea className="w-full rounded border p-2" rows={3} placeholder="Email signature" value={draft.emailSignature || ''} onChange={(e) => setField('emailSignature', e.target.value || null)} />
          <textarea className="w-full rounded border p-2" rows={4} placeholder="Custom header HTML (sanitized)" value={draft.emailCustomHeaderHTML || ''} onChange={(e) => setField('emailCustomHeaderHTML', e.target.value || null)} />
          <textarea className="w-full rounded border p-2" rows={4} placeholder="Custom footer HTML (sanitized)" value={draft.emailCustomFooterHTML || ''} onChange={(e) => setField('emailCustomFooterHTML', e.target.value || null)} />

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {['Invoice Email', 'Invitation Email', 'Receipt Email'].map((title) => (
              <div key={title} className="rounded border p-3" style={{ background: emailPreview.bg }}>
                <div className="rounded p-2 text-xs font-medium" style={{ background: emailPreview.headerBg, color: emailPreview.textPrimary }}>
                  {title}
                </div>
                <div className="mt-2 rounded p-3" style={{ background: emailPreview.cardBg, color: emailPreview.textSecondary }}>
                  <p style={{ color: emailPreview.textPrimary }}>Preview content</p>
                  <button type="button" className="mt-2 rounded px-3 py-1 text-xs" style={{ background: emailPreview.button, color: emailPreview.buttonText }}>
                    Action
                  </button>
                </div>
                <div className="mt-2 rounded p-2 text-xs" style={{ background: emailPreview.footerBg, color: emailPreview.textSecondary }}>
                  Footer
                </div>
              </div>
            ))}
          </div>
          <Button variant="outline" onClick={() => resetSection('email')}>Reset Email Section</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Advanced Controls</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={resetAll}>Restore All Defaults</Button>
          <Button variant="outline" onClick={exportJson}>Export Branding JSON</Button>
          <Input type="file" accept="application/json" onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void importJson(file)
          }} />
        </CardContent>
      </Card>

      {cropImageSrc && cropFieldKey ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-3xl rounded-lg bg-white p-4 flex flex-col gap-3">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">Crop Image</div>
                <div className="text-xs text-gray-500">
                  {cropFieldKey === 'faviconUrl' || cropFieldKey === 'mobileAppIconUrl'
                    ? 'Square crop enforced · zoom in to fill tightly'
                    : 'Zoom in to remove white/transparent padding · drag to reposition'}
                </div>
              </div>
              <Button variant="outline" onClick={closeCropper}>Cancel</Button>
            </div>

            {/* Crop area */}
            <div className="relative h-[520px] w-full overflow-hidden rounded border bg-black">
              <Cropper
                image={cropImageSrc}
                crop={{ x: cropX, y: cropY }}
                zoom={cropZoom}
                aspect={cropAspect}
                objectFit="contain"
                minZoom={0.5}
                maxZoom={15}
                restrictPosition={false}
                initialCroppedAreaPercentages={{ x: 0, y: 0, width: 100, height: 100 }}
                onCropChange={(next) => { setCropX(next.x); setCropY(next.y) }}
                onZoomChange={setCropZoom}
                onCropComplete={(_, pixels) => {
                  setCroppedAreaPixels(pixels)
                  // Debounced live preview
                  if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current)
                  previewDebounceRef.current = setTimeout(async () => {
                    const url = await generateCropPreview(cropImageSrc, pixels, 400, 120)
                    setCropPreviewUrl(url)
                  }, 250)
                }}
                showGrid
              />
            </div>

            {/* Zoom slider */}
            <div className="flex items-center gap-3">
              <Label className="text-xs shrink-0">Zoom</Label>
              <input
                type="range"
                min={0.5}
                max={15}
                step={0.1}
                value={cropZoom}
                onChange={(e) => setCropZoom(Number(e.target.value))}
                className="w-full"
              />
              <span className="text-xs text-gray-500 shrink-0 w-8 text-right">{cropZoom.toFixed(1)}×</span>
            </div>

            {/* Live sidebar preview */}
            {(cropFieldKey === 'webLogoUrl' || cropFieldKey === 'invoiceLogoUrl' || cropFieldKey === 'emailLogoUrl') && (
              <div className="rounded border bg-gray-50 p-3">
                <div className="text-xs font-medium text-gray-500 mb-2">Sidebar preview (actual render size)</div>
                <div
                  className="flex items-center px-4 gap-3 rounded"
                  style={{ height: 64, backgroundColor: '#2E4A59' }}
                >
                  {cropPreviewUrl ? (
                    <img
                      src={cropPreviewUrl}
                      alt="logo preview"
                      style={{ height: 52, width: 'auto', maxWidth: 200, objectFit: 'contain', objectPosition: 'left center' }}
                    />
                  ) : (
                    <div className="text-white/40 text-xs">adjust crop to see preview</div>
                  )}
                  <div className="ml-auto w-6 h-6 rounded-full bg-white/20" />
                </div>
                <div className="text-xs text-gray-400 mt-1">
                  Transparent edges will be auto-trimmed on save. Zoom in to crop tightly for best results.
                </div>
              </div>
            )}

            {/* Upload button */}
            <div className="flex justify-end">
              <Button onClick={confirmCropAndUpload} disabled={cropping || !croppedAreaPixels}>
                {cropping ? 'Uploading...' : 'Crop & Upload'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}


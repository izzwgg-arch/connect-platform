'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Download,
  Eraser,
  ExternalLink,
  FileText,
  Film,
  Minus,
  Music,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  Type,
} from 'lucide-react'

export type GalleryAttachment = {
  id: string
  fileName: string
  fileSize?: number
  mimeType: string
  url: string
}

type Props = {
  open: boolean
  attachments: GalleryAttachment[]
  index: number
  onOpenChange: (open: boolean) => void
  onIndexChange: (index: number) => void
}

type Point = { x: number; y: number }
type MarkupTool = 'pan' | 'pen' | 'arrow' | 'box' | 'text'
type MarkupItem =
  | { id: string; type: 'pen'; color: string; width: number; points: Point[] }
  | { id: string; type: 'arrow'; color: string; width: number; start: Point; end: Point }
  | { id: string; type: 'box'; color: string; width: number; start: Point; end: Point }
  | { id: string; type: 'text'; color: string; size: number; point: Point; text: string }

const MARKUP_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ffffff', '#111827']

function newMarkupId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  lineWidth: number
) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const headLen = Math.max(10, lineWidth * 3.2)
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI / 6), to.y - headLen * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI / 6), to.y - headLen * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()
}

function projectPoint(
  point: Point,
  origin: Point,
  fit: number,
  zoom: number
): Point {
  return {
    x: origin.x + point.x * fit * zoom,
    y: origin.y + point.y * fit * zoom,
  }
}

function normalizePublicUrl(rawUrl: string) {
  try {
    const origin =
      typeof window !== 'undefined' ? window.location.origin : 'https://app.trimprony.com'
    const parsed = new URL(rawUrl, origin)
    const host = parsed.hostname
    const isInternalHost =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host)

    const browsingLocally =
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        /^\d{1,3}(\.\d{1,3}){3}$/.test(window.location.hostname))

    if (isInternalHost) {
      if (browsingLocally) {
        return `${window.location.origin}${parsed.pathname}${parsed.search}`
      }
      return `https://app.trimprony.com${parsed.pathname}${parsed.search}`
    }
    return parsed.toString()
  } catch {
    if (rawUrl.startsWith('/')) {
      if (typeof window !== 'undefined') return `${window.location.origin}${rawUrl}`
      return `https://app.trimprony.com${rawUrl}`
    }
    return rawUrl
  }
}

function formatBytes(bytes?: number) {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function getPreviewKind(mimeType: string, fileName: string) {
  const mime = (mimeType || '').toLowerCase()
  const name = (fileName || '').toLowerCase()
  if (mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(name)) return 'image'
  if (mime.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi)$/i.test(name)) return 'video'
  if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(name)) return 'audio'
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  return 'other'
}

function ImageMarkupViewer({
  src,
  fileName,
  active,
}: {
  src: string
  fileName: string
  active: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const textInputRef = useRef<HTMLInputElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [tool, setTool] = useState<MarkupTool>('pan')
  const [color, setColor] = useState(MARKUP_COLORS[0])
  const [brush, setBrush] = useState(4)
  const [items, setItems] = useState<MarkupItem[]>([])
  const [draft, setDraft] = useState<MarkupItem | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [panning, setPanning] = useState(false)
  const [pendingText, setPendingText] = useState<{
    point: Point
    screenX: number
    screenY: number
    value: string
  } | null>(null)
  const panStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 })
  const itemsRef = useRef<MarkupItem[]>([])
  const draftRef = useRef<MarkupItem | null>(null)

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  useEffect(() => {
    if (!active) return
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setItems([])
    setDraft(null)
    setTool('pan')
    setDrawing(false)
    setPanning(false)
    setPendingText(null)
  }, [src, active])

  useEffect(() => {
    if (pendingText) {
      requestAnimationFrame(() => textInputRef.current?.focus())
    }
  }, [pendingText])

  const getViewMetrics = () => {
    const image = imageRef.current
    const container = containerRef.current
    if (!image || !container) return null
    const rect = container.getBoundingClientRect()
    const naturalW = image.naturalWidth || 1
    const naturalH = image.naturalHeight || 1
    const fit = Math.min(rect.width / naturalW, rect.height / naturalH)
    const drawW = naturalW * fit * zoom
    const drawH = naturalH * fit * zoom
    const origin = {
      x: (rect.width - drawW) / 2 + offset.x,
      y: (rect.height - drawH) / 2 + offset.y,
    }
    return { rect, fit, origin, naturalW, naturalH }
  }

  const renderItem = (
    ctx: CanvasRenderingContext2D,
    item: MarkupItem,
    origin: Point,
    fit: number,
    zoomValue: number
  ) => {
    if (item.type === 'pen') {
      if (item.points.length < 2) return
      ctx.strokeStyle = item.color
      ctx.lineWidth = item.width * zoomValue
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      const first = projectPoint(item.points[0], origin, fit, zoomValue)
      ctx.moveTo(first.x, first.y)
      for (let i = 1; i < item.points.length; i += 1) {
        const point = projectPoint(item.points[i], origin, fit, zoomValue)
        ctx.lineTo(point.x, point.y)
      }
      ctx.stroke()
      return
    }

    if (item.type === 'arrow') {
      const from = projectPoint(item.start, origin, fit, zoomValue)
      const to = projectPoint(item.end, origin, fit, zoomValue)
      drawArrowHead(ctx, from, to, item.color, item.width * zoomValue)
      return
    }

    if (item.type === 'box') {
      const a = projectPoint(item.start, origin, fit, zoomValue)
      const b = projectPoint(item.end, origin, fit, zoomValue)
      ctx.strokeStyle = item.color
      ctx.lineWidth = item.width * zoomValue
      ctx.lineJoin = 'miter'
      ctx.strokeRect(
        Math.min(a.x, b.x),
        Math.min(a.y, b.y),
        Math.abs(b.x - a.x),
        Math.abs(b.y - a.y)
      )
      return
    }

    if (item.type === 'text') {
      const at = projectPoint(item.point, origin, fit, zoomValue)
      const fontSize = Math.max(10, item.size * zoomValue)
      ctx.fillStyle = item.color
      ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif`
      ctx.textBaseline = 'top'
      ctx.shadowColor = 'rgba(0,0,0,0.55)'
      ctx.shadowBlur = 2
      ctx.fillText(item.text, at.x, at.y)
      ctx.shadowBlur = 0
    }
  }

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const image = imageRef.current
    const metrics = getViewMetrics()
    if (!canvas || !image || !metrics || !image.complete) return

    const { rect, fit, origin } = metrics
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(rect.width * dpr))
    canvas.height = Math.max(1, Math.floor(rect.height * dpr))
    canvas.style.width = `${rect.width}px`
    canvas.style.height = `${rect.height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)

    const naturalW = image.naturalWidth || 1
    const naturalH = image.naturalHeight || 1
    const drawW = naturalW * fit * zoom
    const drawH = naturalH * fit * zoom
    ctx.drawImage(image, origin.x, origin.y, drawW, drawH)

    for (const item of itemsRef.current) {
      renderItem(ctx, item, origin, fit, zoom)
    }
    if (draftRef.current) {
      renderItem(ctx, draftRef.current, origin, fit, zoom)
    }
  }, [offset.x, offset.y, zoom])

  useEffect(() => {
    redraw()
  }, [redraw, items, draft])

  useEffect(() => {
    if (!active) return
    const onResize = () => redraw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [active, redraw])

  const getImageSpacePoint = (clientX: number, clientY: number): Point | null => {
    const metrics = getViewMetrics()
    if (!metrics) return null
    const { rect, fit, origin } = metrics
    return {
      x: (clientX - rect.left - origin.x) / (fit * zoom),
      y: (clientY - rect.top - origin.y) / (fit * zoom),
    }
  }

  const commitPendingText = () => {
    if (!pendingText) return
    const text = pendingText.value.trim()
    if (text) {
      setItems((prev) => [
        ...prev,
        {
          id: newMarkupId(),
          type: 'text',
          color,
          size: Math.max(14, brush * 4),
          point: pendingText.point,
          text,
        },
      ])
    }
    setPendingText(null)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    if (pendingText) {
      commitPendingText()
      return
    }
    canvasRef.current?.setPointerCapture(event.pointerId)
    const point = getImageSpacePoint(event.clientX, event.clientY)
    if (!point) return

    if (tool === 'pen') {
      setDrawing(true)
      setDraft({
        id: newMarkupId(),
        type: 'pen',
        color,
        width: brush,
        points: [point],
      })
      return
    }

    if (tool === 'arrow') {
      setDrawing(true)
      setDraft({
        id: newMarkupId(),
        type: 'arrow',
        color,
        width: brush,
        start: point,
        end: point,
      })
      return
    }

    if (tool === 'box') {
      setDrawing(true)
      setDraft({
        id: newMarkupId(),
        type: 'box',
        color,
        width: brush,
        start: point,
        end: point,
      })
      return
    }

    if (tool === 'text') {
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      setPendingText({
        point,
        screenX: Math.min(Math.max(8, event.clientX - rect.left), rect.width - 180),
        screenY: Math.min(Math.max(8, event.clientY - rect.top), rect.height - 44),
        value: '',
      })
      return
    }

    setPanning(true)
    panStart.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawing) {
      const point = getImageSpacePoint(event.clientX, event.clientY)
      if (!point) return
      setDraft((current) => {
        if (!current) return current
        if (current.type === 'pen') {
          return { ...current, points: [...current.points, point] }
        }
        if (current.type === 'arrow' || current.type === 'box') {
          return { ...current, end: point }
        }
        return current
      })
      return
    }
    if (panning && tool === 'pan') {
      setOffset({
        x: panStart.current.ox + (event.clientX - panStart.current.x),
        y: panStart.current.oy + (event.clientY - panStart.current.y),
      })
    }
  }

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      canvasRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      // ignore
    }
    const currentDraft = draftRef.current
    if (drawing && currentDraft) {
      if (currentDraft.type === 'pen' && currentDraft.points.length >= 2) {
        setItems((prev) => [...prev, currentDraft])
      } else if (currentDraft.type === 'arrow' || currentDraft.type === 'box') {
        const dx = currentDraft.end.x - currentDraft.start.x
        const dy = currentDraft.end.y - currentDraft.start.y
        if (Math.hypot(dx, dy) > 4) {
          setItems((prev) => [...prev, currentDraft])
        }
      }
      setDraft(null)
    }
    setDrawing(false)
    setPanning(false)
  }

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const delta = event.deltaY > 0 ? -0.12 : 0.12
    setZoom((prev) => Math.min(5, Math.max(0.4, Number((prev + delta).toFixed(2)))))
  }

  const downloadMarked = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    const base = fileName.replace(/\.[^.]+$/, '') || 'attachment'
    link.download = `${base}-marked.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  const toolButtonClass = (activeTool: MarkupTool) =>
    `h-8 ${tool === activeTool ? 'bg-white text-zinc-900 hover:bg-zinc-100' : 'bg-white/10 text-white hover:bg-white/20'}`

  const showStyleControls = tool === 'pen' || tool === 'arrow' || tool === 'box' || tool === 'text'

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8 bg-white/10 text-white hover:bg-white/20"
          onClick={() => setZoom((z) => Math.min(5, Number((z + 0.25).toFixed(2))))}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8 bg-white/10 text-white hover:bg-white/20"
          onClick={() => setZoom((z) => Math.max(0.4, Number((z - 0.25).toFixed(2))))}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <span className="min-w-[3.5rem] text-center text-xs text-zinc-300">{Math.round(zoom * 100)}%</span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8 bg-white/10 text-white hover:bg-white/20"
          onClick={() => {
            setZoom(1)
            setOffset({ x: 0, y: 0 })
          }}
          title="Reset zoom"
        >
          <RotateCcw className="h-4 w-4" />
        </Button>

        <div className="mx-1 h-5 w-px bg-white/15" />

        <Button
          type="button"
          size="sm"
          variant="secondary"
          className={toolButtonClass('pan')}
          onClick={() => setTool('pan')}
          title="Pan / move"
        >
          Move
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className={toolButtonClass('pen')}
          onClick={() => setTool('pen')}
          title="Freehand markup"
        >
          <Pencil className="mr-1 h-4 w-4" />
          Pen
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className={toolButtonClass('arrow')}
          onClick={() => setTool('arrow')}
          title="Draw arrow"
        >
          <ArrowUpRight className="mr-1 h-4 w-4" />
          Arrow
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className={toolButtonClass('box')}
          onClick={() => setTool('box')}
          title="Draw box"
        >
          <Square className="mr-1 h-4 w-4" />
          Box
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className={toolButtonClass('text')}
          onClick={() => setTool('text')}
          title="Add text"
        >
          <Type className="mr-1 h-4 w-4" />
          Text
        </Button>

        {showStyleControls && (
          <>
            <div className="flex items-center gap-1">
              {MARKUP_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  onClick={() => setColor(c)}
                  className={`h-6 w-6 rounded-full border ${color === c ? 'border-white ring-2 ring-white/50' : 'border-white/30'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              Size
              <input
                type="range"
                min={2}
                max={16}
                value={brush}
                onChange={(e) => setBrush(Number(e.target.value))}
                className="w-20"
              />
            </label>
          </>
        )}

        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8 bg-white/10 text-white hover:bg-white/20"
          disabled={items.length === 0}
          onClick={() => setItems((prev) => prev.slice(0, -1))}
          title="Undo last mark"
        >
          <Eraser className="mr-1 h-4 w-4" />
          Undo
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8 bg-white/10 text-white hover:bg-white/20"
          disabled={items.length === 0}
          onClick={() => setItems([])}
          title="Clear markup"
        >
          <Trash2 className="mr-1 h-4 w-4" />
          Clear
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8 bg-white/10 text-white hover:bg-white/20"
          onClick={downloadMarked}
          title="Download image with markup"
        >
          <Download className="mr-1 h-4 w-4" />
          Save
        </Button>
      </div>

      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-black"
        onWheel={onWheel}
      >
        <img
          ref={imageRef}
          src={src}
          alt={fileName}
          className="pointer-events-none absolute h-0 w-0 opacity-0"
          onLoad={redraw}
        />
        <canvas
          ref={canvasRef}
          className={`h-full w-full touch-none ${
            tool === 'pan' ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'
          }`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {pendingText && (
          <form
            className="absolute z-30"
            style={{ left: pendingText.screenX, top: pendingText.screenY }}
            onSubmit={(event) => {
              event.preventDefault()
              commitPendingText()
            }}
          >
            <input
              ref={textInputRef}
              value={pendingText.value}
              onChange={(e) => setPendingText({ ...pendingText, value: e.target.value })}
              onBlur={commitPendingText}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setPendingText(null)
                }
              }}
              placeholder="Type text…"
              className="min-w-[160px] rounded-md border border-white/30 bg-zinc-900/95 px-2 py-1.5 text-sm text-white shadow-lg outline-none ring-2 ring-white/20"
            />
          </form>
        )}
      </div>
    </div>
  )
}

export function AttachmentGalleryDialog({
  open,
  attachments,
  index,
  onOpenChange,
  onIndexChange,
}: Props) {
  const total = attachments.length
  const safeIndex = total > 0 ? ((index % total) + total) % total : 0
  const current = total > 0 ? attachments[safeIndex] : null
  const url = current ? normalizePublicUrl(current.url) : ''
  const kind = current ? getPreviewKind(current.mimeType, current.fileName) : 'other'
  const canNavigate = total > 1

  const goPrev = useCallback(() => {
    if (!canNavigate) return
    onIndexChange((safeIndex - 1 + total) % total)
  }, [canNavigate, onIndexChange, safeIndex, total])

  const goNext = useCallback(() => {
    if (!canNavigate) return
    onIndexChange((safeIndex + 1) % total)
  }, [canNavigate, onIndexChange, safeIndex, total])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        goPrev()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, goPrev, goNext])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(99vw,1500px)] w-[min(99vw,1500px)] h-[min(96dvh,1040px)] gap-0 overflow-hidden border-0 bg-zinc-950 p-0 text-white sm:rounded-xl max-sm:h-[96dvh]">
        <DialogTitle className="sr-only">
          {current ? `Attachment ${current.fileName}` : 'Attachments gallery'}
        </DialogTitle>

        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 pr-14">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{current?.fileName || 'Attachment'}</p>
              <p className="text-xs text-zinc-400">
                {total > 0 ? `${safeIndex + 1} of ${total}` : '0 of 0'}
                {current?.fileSize ? ` · ${formatBytes(current.fileSize)}` : ''}
                {current?.mimeType ? ` · ${current.mimeType}` : ''}
              </p>
            </div>
            {current && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="shrink-0 bg-white/10 text-white hover:bg-white/20"
                onClick={() => window.open(url, '_blank')}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Open
              </Button>
            )}
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
            {canNavigate && (
              <button
                type="button"
                aria-label="Previous attachment"
                className="absolute left-2 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 sm:left-3"
                onClick={goPrev}
              >
                <ChevronLeft className="h-7 w-7" />
              </button>
            )}

            <div className={`flex h-full w-full items-center justify-center ${kind === 'image' ? '' : 'p-4 sm:px-16'}`}>
              {!current ? (
                <p className="text-sm text-zinc-400">No attachments</p>
              ) : kind === 'image' ? (
                <ImageMarkupViewer key={current.id} src={url} fileName={current.fileName} active={open} />
              ) : kind === 'video' ? (
                <video
                  key={current.id}
                  src={url}
                  controls
                  autoPlay
                  className="max-h-full max-w-full rounded"
                />
              ) : kind === 'audio' ? (
                <div className="flex w-full max-w-lg flex-col items-center gap-6 rounded-xl bg-zinc-900 px-6 py-10">
                  <Music className="h-14 w-14 text-zinc-300" />
                  <p className="text-center text-sm font-medium">{current.fileName}</p>
                  <audio key={current.id} src={url} controls autoPlay className="w-full" />
                </div>
              ) : kind === 'pdf' ? (
                <iframe
                  key={current.id}
                  src={url}
                  title={current.fileName}
                  className="h-full w-full rounded bg-white"
                />
              ) : (
                <div className="flex max-w-md flex-col items-center gap-4 rounded-xl bg-zinc-900 px-8 py-10 text-center">
                  {current.mimeType.includes('sheet') || current.fileName.match(/\.(xls|xlsx|csv)$/i) ? (
                    <FileText className="h-14 w-14 text-zinc-300" />
                  ) : current.mimeType.startsWith('video/') ? (
                    <Film className="h-14 w-14 text-zinc-300" />
                  ) : (
                    <Paperclip className="h-14 w-14 text-zinc-300" />
                  )}
                  <div>
                    <p className="text-sm font-medium">{current.fileName}</p>
                    <p className="mt-1 text-xs text-zinc-400">
                      Preview not available for this file type. Use Open to view or download.
                    </p>
                  </div>
                  <Button
                    type="button"
                    className="bg-white text-zinc-900 hover:bg-zinc-100"
                    onClick={() => window.open(url, '_blank')}
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open file
                  </Button>
                </div>
              )}
            </div>

            {canNavigate && (
              <button
                type="button"
                aria-label="Next attachment"
                className="absolute right-2 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 sm:right-3"
                onClick={goNext}
              >
                <ChevronRight className="h-7 w-7" />
              </button>
            )}
          </div>

          {total > 1 && (
            <div className="flex gap-2 overflow-x-auto border-t border-white/10 px-3 py-2">
              {attachments.map((item, itemIndex) => {
                const thumbUrl = normalizePublicUrl(item.url)
                const thumbKind = getPreviewKind(item.mimeType, item.fileName)
                const active = itemIndex === safeIndex
                return (
                  <button
                    key={item.id}
                    type="button"
                    title={item.fileName}
                    onClick={() => onIndexChange(itemIndex)}
                    className={`h-14 w-14 shrink-0 overflow-hidden rounded border ${
                      active ? 'border-white ring-2 ring-white/40' : 'border-white/20 opacity-70 hover:opacity-100'
                    }`}
                  >
                    {thumbKind === 'image' ? (
                      <img src={thumbUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-zinc-800 text-[10px] font-semibold uppercase text-zinc-300">
                        {thumbKind === 'pdf'
                          ? 'PDF'
                          : thumbKind === 'video'
                            ? 'VID'
                            : thumbKind === 'audio'
                              ? 'AUD'
                              : 'FILE'}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Paperclip, Upload, Trash2, ExternalLink, Film, Music, FileText } from 'lucide-react'
import { AttachmentGalleryDialog } from '@/components/common/attachment-gallery-dialog'

type EntityType = 'estimate' | 'invoice' | 'purchase_order' | 'job' | 'request'

interface Attachment {
  id: string
  fileName: string
  fileSize: number
  mimeType: string
  url: string
  createdAt: string
}

interface Props {
  entityType: EntityType
  entityId: string
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

    // In local/dev, keep files on the current origin so /uploads works.
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

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function getThumbKind(mimeType: string, fileName: string) {
  const mime = (mimeType || '').toLowerCase()
  const name = (fileName || '').toLowerCase()
  if (mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(name)) return 'image'
  if (mime.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi)$/i.test(name)) return 'video'
  if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(name)) return 'audio'
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  return 'other'
}

export function DocumentAttachments({ entityType, entityId }: Props) {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number; fileName: string } | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [galleryIndex, setGalleryIndex] = useState(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const load = async () => {
    setLoading(true)
    setErrorMessage(null)
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/attachments?entityType=${entityType}&entityId=${entityId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (res.ok) {
        setAttachments(data.attachments || [])
      } else {
        setErrorMessage(data.error || 'Failed to load attachments')
      }
    } catch (error) {
      console.error('Failed to load attachments:', error)
      setErrorMessage('Failed to load attachments')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (entityId) load()
  }, [entityType, entityId])

  const openGallery = (index: number) => {
    setGalleryIndex(index)
    setGalleryOpen(true)
  }

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    setErrorMessage(null)
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        alert('Please sign in again and retry upload.')
        return
      }
      const fileList = Array.from(files)
      const errors: string[] = []
      for (let i = 0; i < fileList.length; i += 1) {
        const file = fileList[i]
        setUploadProgress({ current: i + 1, total: fileList.length, fileName: file.name })
        const fd = new FormData()
        fd.append('file', file)
        const upRes = await fetch('/api/uploads', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        })
        const upData = await upRes.json()
        if (!upRes.ok) {
          errors.push(upData.error || `Upload failed for ${file.name}`)
          continue
        }

        const createRes = await fetch('/api/attachments', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            entityType,
            entityId,
            fileName: file.name,
            fileSize: upData.size || file.size,
            mimeType: upData.mimeType || file.type || 'application/octet-stream',
            url: upData.url,
            key: upData.relativeUrl || upData.filename || upData.url,
          }),
        })
        if (!createRes.ok) {
          const err = await createRes.json().catch(() => ({}))
          errors.push(err.error || `Failed to attach ${file.name}`)
        }
      }
      if (errors.length > 0) {
        setErrorMessage(errors[0])
      }
      await load()
    } catch (error) {
      console.error('Upload attachments error:', error)
      setErrorMessage('Failed to upload files')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
      setUploading(false)
      setUploadProgress(null)
    }
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (!uploading) setDragActive(true)
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDragActive(false)
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragActive(false)
    if (uploading) return
    void uploadFiles(e.dataTransfer?.files || null)
  }

  const deleteAttachment = async (id: string) => {
    if (!confirm('Delete this attachment?')) return
    try {
      const token = localStorage.getItem('accessToken')
      const res = await fetch(`/api/attachments/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setErrorMessage(err.error || 'Failed to delete attachment')
        return
      }
      setAttachments((prev) => {
        const next = prev.filter((a) => a.id !== id)
        if (galleryOpen) {
          if (next.length === 0) {
            setGalleryOpen(false)
          } else if (galleryIndex >= next.length) {
            setGalleryIndex(next.length - 1)
          }
        }
        return next
      })
    } catch (error) {
      console.error('Delete attachment error:', error)
    }
  }

  return (
    <div
      className={`space-y-3 rounded-md border-2 border-dashed p-3 transition-colors ${
        dragActive ? 'border-blue-500 bg-blue-50/40' : 'border-gray-200'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-medium">
          <Paperclip className="h-4 w-4" />
          Attachments
        </div>
        <label className="cursor-pointer">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => uploadFiles(e.target.files)}
            accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip,.rar,.mp3,.mp4,.wav,.m4a"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            {uploading && uploadProgress
              ? `Uploading ${uploadProgress.current}/${uploadProgress.total}`
              : 'Upload'}
          </Button>
        </label>
      </div>

      <p className="text-xs text-gray-500">Drag and drop files here, or click Upload.</p>

      {uploading && uploadProgress && (
        <p className="text-xs text-gray-500">Uploading {uploadProgress.fileName}...</p>
      )}

      {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading attachments...</p>
      ) : attachments.length === 0 ? (
        <p className="text-sm text-gray-500">No files uploaded yet.</p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {attachments.map((a, index) => {
            const kind = getThumbKind(a.mimeType, a.fileName)
            const publicUrl = normalizePublicUrl(a.url)
            return (
              <div key={a.id} className="relative rounded border p-2">
                <button
                  type="button"
                  className="mb-2 block w-full overflow-hidden rounded border bg-gray-100"
                  onClick={() => openGallery(index)}
                  title={`Open ${a.fileName}`}
                >
                  {kind === 'image' ? (
                    <img
                      src={publicUrl}
                      alt={a.fileName}
                      className="h-24 w-full object-cover hover:opacity-90"
                    />
                  ) : (
                    <div className="flex h-24 w-full flex-col items-center justify-center gap-1 bg-slate-100 text-slate-500 hover:bg-slate-200">
                      {kind === 'video' ? (
                        <Film className="h-8 w-8" />
                      ) : kind === 'audio' ? (
                        <Music className="h-8 w-8" />
                      ) : kind === 'pdf' ? (
                        <FileText className="h-8 w-8" />
                      ) : (
                        <Paperclip className="h-8 w-8" />
                      )}
                      <span className="text-[10px] font-semibold uppercase tracking-wide">
                        {kind === 'video' ? 'Video' : kind === 'audio' ? 'Audio' : kind === 'pdf' ? 'PDF' : 'File'}
                      </span>
                    </div>
                  )}
                </button>

                <div className="flex items-center justify-between gap-1">
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="block w-full truncate text-left text-xs font-medium hover:underline"
                      onClick={() => openGallery(index)}
                    >
                      {a.fileName}
                    </button>
                    <div className="text-xs text-gray-500">{formatBytes(a.fileSize)}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      title="Open in new tab"
                      onClick={() => window.open(publicUrl, '_blank')}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => deleteAttachment(a.id)}
                    >
                      <Trash2 className="h-3 w-3 text-red-600" />
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <AttachmentGalleryDialog
        open={galleryOpen}
        attachments={attachments}
        index={galleryIndex}
        onOpenChange={setGalleryOpen}
        onIndexChange={setGalleryIndex}
      />
    </div>
  )
}

import { useCallback, useMemo, useRef, useState } from 'react'
import { LocalAttachmentFile, UploadQueueItem } from '../services/attachment-upload'

type UploadTaskStarter<T> = (
  file: LocalAttachmentFile,
  onProgress: (progress: number) => void
) => { promise: Promise<T>; cancel: () => void }

export function useAttachmentUploadQueue<T>({
  startUpload,
  onUploaded,
}: {
  startUpload: UploadTaskStarter<T>
  onUploaded?: (result: T, file: LocalAttachmentFile) => void
}) {
  const [items, setItems] = useState<Array<UploadQueueItem<T>>>([])
  const cancelMap = useRef<Record<string, () => void>>({})

  const upsert = useCallback((itemId: string, updater: (current: UploadQueueItem<T>) => UploadQueueItem<T>) => {
    setItems((prev) => prev.map((item) => (item.id === itemId ? updater(item) : item)))
  }, [])

  const removeItem = useCallback((itemId: string) => {
    setItems((prev) => prev.filter((item) => item.id !== itemId))
    const cancel = cancelMap.current[itemId]
    if (cancel) {
      cancel()
      delete cancelMap.current[itemId]
    }
  }, [])

  const cancelItem = useCallback((itemId: string) => {
    const cancel = cancelMap.current[itemId]
    if (cancel) {
      cancel()
      delete cancelMap.current[itemId]
    }
    upsert(itemId, (current) => ({
      ...current,
      status: 'cancelled',
      error: 'Upload cancelled',
    }))
  }, [upsert])

  const runUpload = useCallback(
    (itemId: string, file: LocalAttachmentFile) => {
      upsert(itemId, (current) => ({
        ...current,
        status: 'uploading',
        progress: 0.01,
        error: undefined,
      }))
      const task = startUpload(file, (progress) => {
        upsert(itemId, (current) => ({
          ...current,
          status: 'uploading',
          progress: Math.max(current.progress, progress),
        }))
      })
      cancelMap.current[itemId] = task.cancel

      void task.promise
        .then((result) => {
          delete cancelMap.current[itemId]
          upsert(itemId, (current) => ({
            ...current,
            status: 'success',
            progress: 1,
            result,
          }))
          onUploaded?.(result, file)
        })
        .catch((error: any) => {
          delete cancelMap.current[itemId]
          upsert(itemId, (current) => ({
            ...current,
            status: 'failed',
            error: error?.message || 'Upload failed',
          }))
        })
    },
    [onUploaded, startUpload, upsert]
  )

  const enqueueFiles = useCallback(
    (files: LocalAttachmentFile[]) => {
      if (!files.length) return
      const newItems: Array<UploadQueueItem<T>> = files.map((file) => ({
        id: file.localId,
        file,
        status: 'pending',
        progress: 0,
      }))
      setItems((prev) => [...newItems, ...prev])
      for (const file of files) {
        runUpload(file.localId, file)
      }
    },
    [runUpload]
  )

  const retryItem = useCallback(
    (itemId: string) => {
      const item = items.find((entry) => entry.id === itemId)
      if (!item) return
      runUpload(item.id, item.file)
    },
    [items, runUpload]
  )

  const hasUploading = useMemo(() => items.some((item) => item.status === 'uploading' || item.status === 'pending'), [items])
  const failedCount = useMemo(() => items.filter((item) => item.status === 'failed').length, [items])

  return {
    items,
    enqueueFiles,
    retryItem,
    removeItem,
    cancelItem,
    hasUploading,
    failedCount,
    setItems,
  }
}

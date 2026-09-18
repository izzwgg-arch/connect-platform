import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Audio, ResizeMode, Video } from 'expo-av'
import { ImageMarkupWebView } from './ImageMarkupWebView'
import { PdfJsWebView } from './PdfJsWebView'
import {
  getAttachmentKind,
  normalizeAttachmentUrl,
  openAttachment,
} from '../../services/open-attachment'
import { BRAND } from '../../config/env'

export type GalleryAttachment = {
  id: string
  fileName: string
  fileSize?: number
  mimeType: string
  url: string
}

type Props = {
  visible: boolean
  attachments: GalleryAttachment[]
  index: number
  onClose: () => void
  onIndexChange: (index: number) => void
  entityType?: 'job' | 'request' | 'task' | 'issue' | string
  entityId?: string
  onAttachmentCreated?: () => void
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

export function AttachmentGalleryModal({
  visible,
  attachments,
  index,
  onClose,
  onIndexChange,
  entityType,
  entityId,
  onAttachmentCreated,
}: Props) {
  const total = attachments.length
  const safeIndex = total > 0 ? ((index % total) + total) % total : 0
  const current = total > 0 ? attachments[safeIndex] : null
  const url = current ? normalizeAttachmentUrl(current.url) : ''
  const kind = current ? getAttachmentKind(current.mimeType, current.fileName) : 'other'
  const canNavigate = total > 1
  const [opening, setOpening] = useState(false)
  const soundRef = useRef<Audio.Sound | null>(null)

  useEffect(() => {
    return () => {
      void soundRef.current?.unloadAsync()
      soundRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      await soundRef.current?.unloadAsync()
      soundRef.current = null
      if (!visible || kind !== 'audio' || !url) return
      try {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true })
        const { sound } = await Audio.Sound.createAsync({ uri: url }, { shouldPlay: true })
        if (cancelled) {
          await sound.unloadAsync()
          return
        }
        soundRef.current = sound
      } catch {
        // User can still tap Open.
      }
    }
    void run()
    return () => {
      cancelled = true
      void soundRef.current?.unloadAsync()
      soundRef.current = null
    }
  }, [visible, kind, url, current?.id])

  const goPrev = () => {
    if (!canNavigate) return
    onIndexChange((safeIndex - 1 + total) % total)
  }

  const goNext = () => {
    if (!canNavigate) return
    onIndexChange((safeIndex + 1) % total)
  }

  const onOpenExternal = async () => {
    if (!current) return
    setOpening(true)
    try {
      await openAttachment({
        url: current.url,
        fileName: current.fileName,
        mimeType: current.mimeType,
      })
    } finally {
      setOpening(false)
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerTextWrap}>
            <Text style={styles.title} numberOfLines={1}>
              {current?.fileName || 'Attachment'}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {total > 0 ? `${safeIndex + 1} of ${total}` : '0 of 0'}
              {current?.fileSize ? ` · ${formatBytes(current.fileSize)}` : ''}
              {current?.mimeType ? ` · ${current.mimeType}` : ''}
            </Text>
          </View>
          <Pressable style={styles.headerBtn} onPress={onOpenExternal} disabled={!current || opening}>
            {opening ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Ionicons name="open-outline" size={16} color="#fff" />
                <Text style={styles.headerBtnText}>Open with…</Text>
              </>
            )}
          </Pressable>
          <Pressable style={styles.headerBtn} onPress={onClose}>
            <Text style={styles.headerBtnText}>Close</Text>
          </Pressable>
        </View>

        <View style={styles.body}>
          {canNavigate ? (
            <Pressable style={[styles.navBtn, styles.navLeft]} onPress={goPrev}>
              <Ionicons name="chevron-back" size={28} color="#fff" />
            </Pressable>
          ) : null}

          {!current ? (
            <Text style={styles.empty}>No attachments</Text>
          ) : kind === 'image' ? (
            <ImageMarkupWebView
              key={current.id}
              src={url}
              fileName={current.fileName}
              active={visible}
              entityType={entityType}
              entityId={entityId}
              onSavedCopy={onAttachmentCreated}
            />
          ) : kind === 'video' ? (
            <Video
              key={current.id}
              source={{ uri: url }}
              style={styles.video}
              useNativeControls
              shouldPlay
              resizeMode={ResizeMode.CONTAIN}
            />
          ) : kind === 'audio' ? (
            <View style={styles.centerCard}>
              <Ionicons name="musical-notes-outline" size={48} color="#fff" />
              <Text style={styles.centerTitle}>{current.fileName}</Text>
              <Text style={styles.meta}>Playing audio… Use Open with… to share/download.</Text>
            </View>
          ) : kind === 'pdf' ? (
            <PdfJsWebView
              key={current.id}
              url={current.url}
              fileName={current.fileName}
              mimeType={current.mimeType || 'application/pdf'}
              onOpenExternal={onOpenExternal}
              openingExternal={opening}
            />
          ) : (
            <View style={styles.centerCard}>
              <Ionicons name="document-text-outline" size={48} color="#fff" />
              <Text style={styles.centerTitle}>{current.fileName}</Text>
              <Text style={styles.meta}>Tap Open with… to view this file in another app.</Text>
              <Pressable style={styles.primaryBtn} onPress={onOpenExternal} disabled={opening}>
                <Text style={styles.primaryBtnText}>{opening ? 'Opening…' : 'Open with…'}</Text>
              </Pressable>
            </View>
          )}

          {canNavigate ? (
            <Pressable style={[styles.navBtn, styles.navRight]} onPress={goNext}>
              <Ionicons name="chevron-forward" size={28} color="#fff" />
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#09090b' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  headerTextWrap: { flex: 1, minWidth: 0 },
  title: { color: '#fff', fontSize: 14, fontWeight: '700' },
  meta: { color: '#a1a1aa', fontSize: 12, marginTop: 2, textAlign: 'center' },
  headerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 64,
    justifyContent: 'center',
  },
  headerBtnText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  body: { flex: 1, minHeight: 0, backgroundColor: '#000' },
  video: { width: '100%', height: '100%' },
  empty: { color: '#a1a1aa', textAlign: 'center', marginTop: 40 },
  centerCard: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 24,
  },
  centerTitle: { color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center' },
  primaryBtn: {
    marginTop: 8,
    backgroundColor: BRAND.primary,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryBtnText: { color: '#fff', fontWeight: '700' },
  navBtn: {
    position: 'absolute',
    top: '45%',
    zIndex: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navLeft: { left: 8 },
  navRight: { right: 8 },
})

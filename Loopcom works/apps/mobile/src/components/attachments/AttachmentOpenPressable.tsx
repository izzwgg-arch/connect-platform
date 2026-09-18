import React, { useCallback, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import * as Haptics from 'expo-haptics'
import { openAttachment } from '../../services/open-attachment'

type AttachmentLike = {
  id: string
  url?: string | null
  fileName?: string | null
  mimeType?: string | null
}

type TileProps = {
  attachment: AttachmentLike
  /** Prefer this — opens the in-app gallery immediately (clear visual feedback). */
  onOpenGallery?: () => void
  style?: StyleProp<ViewStyle>
  children: React.ReactNode
}

/**
 * Tappable attachment tile with unmistakable feedback.
 * Always opens the gallery when provided; otherwise opens via system share sheet.
 */
export function AttachmentOpenPressable({ attachment, onOpenGallery, style, children }: TileProps) {
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)

  const handlePress = useCallback(async () => {
    if (locked.current) return
    locked.current = true

    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    } catch {
      // haptics optional
    }

    // Instant UI path — gallery modal is the most reliable "something happened" signal.
    if (onOpenGallery) {
      onOpenGallery()
      // Unlock quickly so user can tap another file after closing gallery.
      setTimeout(() => {
        locked.current = false
      }, 400)
      return
    }

    if (!attachment?.url) {
      locked.current = false
      Alert.alert('Unable to open', 'This file has no download URL.')
      return
    }

    setBusy(true)
    try {
      await openAttachment({
        url: attachment.url,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
      })
    } catch (error: any) {
      Alert.alert('Unable to open file', error?.message || 'Please try again.')
    } finally {
      setBusy(false)
      locked.current = false
    }
  }, [attachment, onOpenGallery])

  return (
    <>
      <TouchableOpacity
        style={style}
        activeOpacity={0.55}
        disabled={busy}
        onPress={() => {
          void handlePress()
        }}
        accessibilityRole="button"
        accessibilityLabel={`Open ${attachment.fileName || 'attachment'}`}
      >
        {children}
      </TouchableOpacity>

      <Modal visible={busy} transparent animationType="fade" onRequestClose={() => {}}>
        <View style={styles.busyRoot}>
          <View style={styles.busyCard}>
            <ActivityIndicator color="#fff" size="large" />
            <Text style={styles.busyTitle}>Opening…</Text>
            <Text style={styles.busySub} numberOfLines={2}>
              {attachment.fileName || 'File'}
            </Text>
          </View>
        </View>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  busyRoot: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  busyCard: {
    minWidth: 180,
    maxWidth: 280,
    backgroundColor: '#0F172A',
    borderRadius: 14,
    paddingVertical: 22,
    paddingHorizontal: 20,
    alignItems: 'center',
    gap: 10,
  },
  busyTitle: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 16,
  },
  busySub: {
    color: '#CBD5E1',
    fontSize: 12,
    textAlign: 'center',
  },
})

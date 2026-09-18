import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import {
  UploadQueueItem,
  fileTypeIconName,
  formatFileSize,
  LocalAttachmentFile,
} from '../../services/attachment-upload'
import { colors, spacing, typography } from '../../theme/tokens'

function statusText(status: UploadQueueItem['status'], error?: string): string {
  if (status === 'pending') return 'Pending'
  if (status === 'uploading') return 'Uploading...'
  if (status === 'success') return 'Uploaded'
  if (status === 'cancelled') return 'Cancelled'
  return `Failed${error ? `: ${error}` : ''}`
}

export function AttachmentUploadQueue({
  items,
  onRetry,
  onRemove,
  onCancel,
}: {
  items: Array<UploadQueueItem>
  onRetry: (item: UploadQueueItem) => void
  onRemove: (item: UploadQueueItem) => void
  onCancel: (item: UploadQueueItem) => void
}) {
  if (!items.length) return null
  return (
    <View style={styles.wrap}>
      {items.map((item) => (
        <View key={item.id} style={styles.row}>
          <View style={styles.iconWrap}>
            <Ionicons
              name={fileTypeIconName(item.file as LocalAttachmentFile) as keyof typeof Ionicons.glyphMap}
              size={18}
              color={colors.textSecondary}
            />
          </View>
          <View style={styles.infoWrap}>
            <Text style={styles.fileName} numberOfLines={1}>
              {item.file.name}
            </Text>
            <Text style={styles.metaText}>
              {formatFileSize(item.file.sizeBytes)} • {statusText(item.status, item.error)}
            </Text>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.max(0, Math.min(100, Math.round(item.progress * 100)))}%` },
                ]}
              />
            </View>
          </View>
          <View style={styles.actions}>
            {item.status === 'failed' ? (
              <Pressable onPress={() => onRetry(item)} style={styles.actionButton}>
                <Ionicons name="refresh-outline" size={18} color={colors.brandPrimary} />
              </Pressable>
            ) : null}
            {item.status === 'uploading' ? (
              <Pressable onPress={() => onCancel(item)} style={styles.actionButton}>
                <Ionicons name="close-circle-outline" size={18} color={colors.danger} />
              </Pressable>
            ) : (
              <Pressable onPress={() => onRemove(item)} style={styles.actionButton}>
                <Ionicons name="trash-outline" size={18} color={colors.danger} />
              </Pressable>
            )}
          </View>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing.xs,
  },
  row: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 10,
    padding: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#EEF2F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoWrap: {
    flex: 1,
  },
  fileName: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  metaText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 1,
  },
  progressTrack: {
    height: 4,
    borderRadius: 999,
    backgroundColor: '#E5EAF0',
    marginTop: 5,
  },
  progressFill: {
    height: 4,
    borderRadius: 999,
    backgroundColor: colors.brandPrimary,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionButton: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
})

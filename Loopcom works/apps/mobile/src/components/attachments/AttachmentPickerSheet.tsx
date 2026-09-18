import React from 'react'
import { InteractionManager, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../../theme/tokens'
import { AttachmentPickAction } from '../../services/attachment-upload'

const OPTIONS: Array<{ action: AttachmentPickAction; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { action: 'take-photo', label: 'Take Photo', icon: 'camera-outline' },
  { action: 'record-video', label: 'Record Video', icon: 'videocam-outline' },
  { action: 'choose-photos', label: 'Choose Photos', icon: 'images-outline' },
  { action: 'choose-videos', label: 'Choose Videos', icon: 'film-outline' },
  { action: 'choose-audio', label: 'Choose Audio (MP3)', icon: 'musical-notes-outline' },
  { action: 'choose-document', label: 'Choose Files (PDF, MP3, MP4…)', icon: 'document-attach-outline' },
]

export function AttachmentPickerSheet({
  visible,
  onClose,
  onSelect,
}: {
  visible: boolean
  onClose: () => void
  onSelect: (action: AttachmentPickAction) => void
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.card}>
          <Text style={styles.title}>Add Attachment</Text>
          {OPTIONS.map((option) => (
            <Pressable
              key={option.action}
              style={styles.optionRow}
              onPress={() => {
                onClose()
                // Let modal fully close before invoking camera/document intents on Android.
                InteractionManager.runAfterInteractions(() => {
                  setTimeout(() => onSelect(option.action), 220)
                })
              }}
            >
              <Ionicons name={option.icon} size={20} color={colors.textPrimary} />
              <Text style={styles.optionText}>{option.label}</Text>
            </Pressable>
          ))}
          <Pressable style={styles.cancelButton} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(2,6,23,0.45)',
    justifyContent: 'flex-end',
    padding: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.divider,
    paddingVertical: spacing.sm,
  },
  title: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
  },
  optionRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  optionText: {
    ...typography.sub,
    color: colors.textPrimary,
  },
  cancelButton: {
    marginTop: spacing.xs,
    marginHorizontal: spacing.md,
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.divider,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    ...typography.sub,
    color: colors.textSecondary,
    fontWeight: '600',
  },
})

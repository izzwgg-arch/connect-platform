import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Easing,
  GestureResponderEvent,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../../theme/tokens'

interface AttachmentDraft {
  kind: 'IMAGE' | 'VIDEO' | 'FILE' | 'VOICE' | 'LOCATION'
  url?: string
  fileName?: string
  localUri?: string
  latitude?: number
  longitude?: number
  uploadProgress?: number
}

/* ─── Composer pill colours — soft-light premium ──────────────────────────
   Light frosted pill that floats above the chat background.
   Uses neutral dark tones for icons/text to keep strong contrast. */
const WA_PILL_BG  = '#FFFFFF'       // WhatsApp-style white input pill
const WA_ICON     = '#667781'       // icons + placeholder
const WA_TEXT     = '#111B21'       // input / timer text
const WA_FAB_BG   = '#00A884'       // WhatsApp green action button
const WA_FAB_ICON = '#FFFFFF'       // mic icon on accent circle

const EMOJI_PICKER_ROWS: string[][] = [
  ['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊'],
  ['😍', '🥰', '😘', '😎', '🤔', '🙄', '😢', '😭'],
  ['👍', '👎', '❤️', '🔥', '✨', '🙏', '👏', '💯'],
  ['😮', '😱', '🤝', '💪', '🎉', '✅', '❌', '⚠️'],
]

interface ComposerProps {
  text: string
  onChangeText: (text: string) => void
  onSend: () => void
  onOpenMenu: () => void
  onOpenCamera?: () => void
  onVoiceStart: (event: GestureResponderEvent) => void
  onVoiceMove: (event: GestureResponderEvent) => void
  onVoiceStop: (event: GestureResponderEvent) => void
  onVoiceCancel: () => void
  voiceLocked?: boolean
  onVoiceSendLocked?: () => void
  onVoiceDiscardLocked?: () => void
  attachments: AttachmentDraft[]
  onRemoveAttachment: (index: number) => void
  recording: boolean
  recordingDurationMs?: number
  recordingWillCancel?: boolean
  replyPreview?: {
    senderName: string
    textPreview: string
  } | null
  onClearReply?: () => void
  sending: boolean
  disabled?: boolean
  bottomInset?: number
}

/* Animated waveform for locked recording panel */
function RecordingLiveWave({ barCount = 32 }: { barCount?: number }) {
  const anims = useRef(Array.from({ length: barCount }, () => new Animated.Value(0.3))).current
  useEffect(() => {
    const loops = anims.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, {
            toValue: 0.85 + (i % 5) * 0.03,
            duration: 210 + (i % 7) * 38,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
          Animated.timing(v, {
            toValue: 0.22,
            duration: 250 + (i % 5) * 32,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
        ])
      )
    )
    loops.forEach((l) => l.start())
    return () => loops.forEach((l) => l.stop())
  }, [anims])
  return (
    <View style={styles.liveWaveRow}>
      {anims.map((v, i) => (
        <Animated.View
          key={i}
          style={[
            styles.liveWaveBar,
            {
              height: v.interpolate({ inputRange: [0, 1], outputRange: [3, 22] }),
            },
          ]}
        />
      ))}
    </View>
  )
}


export function Composer({
  text,
  onChangeText,
  onSend,
  onOpenMenu,
  onOpenCamera,
  onVoiceStart,
  onVoiceMove,
  onVoiceStop,
  onVoiceCancel,
  voiceLocked = false,
  onVoiceSendLocked,
  onVoiceDiscardLocked,
  attachments,
  onRemoveAttachment,
  recording,
  recordingDurationMs,
  recordingWillCancel,
  replyPreview,
  onClearReply,
  sending,
  disabled,
  bottomInset = 0,
}: ComposerProps) {
  const inputRef = useRef<TextInput>(null)
  const micScale = useRef(new Animated.Value(1)).current
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !sending && !disabled
  const showMic = text.trim().length === 0 && attachments.length === 0

  const triggerSend = () => {
    inputRef.current?.clear()
    onChangeText('')
    onSend()
  }

  const pulseMic = () => {
    Animated.sequence([
      Animated.timing(micScale, {
        toValue: 1.12,
        duration: 80,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(micScale, { toValue: 1, useNativeDriver: true, friction: 5 }),
    ]).start()
  }

  const handleVoicePressIn = (e: GestureResponderEvent) => {
    pulseMic()
    onVoiceStart(e)
  }

  const insertEmoji = (emo: string) => {
    onChangeText(text + emo)
    setEmojiPickerOpen(false)
  }

  const recordingSeconds = Math.max(0, Math.round((recordingDurationMs || 0) / 1000))
  const timerLabel = `${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, '0')}`

  /* ── Mic / Send FAB ─────────────────────────────────────────── */
  const micFab = (
    <Animated.View style={[styles.fabWrap, { transform: [{ scale: micScale }] }]}>
      <Pressable
        style={[
          styles.fab,
          recording && !voiceLocked && styles.fabRecording,
          recording && recordingWillCancel && !voiceLocked && styles.fabCancel,
          disabled && styles.fabDisabled,
        ]}
        onPressIn={recording || voiceLocked ? undefined : handleVoicePressIn}
        onTouchMove={recording && !voiceLocked ? onVoiceMove : undefined}
        onPressOut={recording && !voiceLocked ? onVoiceStop : undefined}
        disabled={disabled || voiceLocked}
        hitSlop={8}
      >
        <Ionicons
          name={recording && !voiceLocked ? 'mic' : 'mic-outline'}
          size={22}
          color={recording && !voiceLocked ? '#FFFFFF' : WA_FAB_ICON}
        />
      </Pressable>
    </Animated.View>
  )

  const sendFab = (
    <View style={styles.fabWrap}>
      <Pressable
        style={[styles.fab, styles.fabSend, !canSend && styles.fabSendDisabled]}
        onPress={triggerSend}
        disabled={!canSend}
      >
        {sending ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <Ionicons name="send" size={18} color="#FFFFFF" />
        )}
      </Pressable>
    </View>
  )

  /* ── Input pill content ─────────────────────────────────────── */
  const pillContent = recording && !voiceLocked ? (
    /* Compact recording UI — fits inside the pill, WhatsApp-style */
    <View style={styles.recInPill}>
      <Ionicons name="mic" size={16} color="#EA4335" style={styles.recMicIcon} />
      <Text style={styles.recTimerText}>{timerLabel}</Text>
      <Text
        style={[styles.slideToCancelText, recordingWillCancel && styles.slideToCancelWarn]}
        numberOfLines={1}
      >
        {recordingWillCancel ? 'Release to cancel' : '< Slide to cancel'}
      </Text>
    </View>
  ) : (
    <>
      <TextInput
        ref={inputRef}
        style={styles.pillInput}
        value={text}
        onChangeText={onChangeText}
        onSubmitEditing={triggerSend}
        placeholder="Message"
        placeholderTextColor={WA_ICON}
        multiline
        blurOnSubmit={false}
        returnKeyType="default"
        maxLength={2000}
        editable={!disabled && !recording}
      />
      {!recording ? (
        <View style={styles.pillRightIcons}>
          <Pressable
            style={styles.pillIconBtn}
            onPress={onOpenMenu}
            disabled={disabled}
            hitSlop={6}
          >
            <Ionicons name="attach-outline" size={22} color={WA_ICON} />
          </Pressable>
          {onOpenCamera ? (
            <Pressable
              style={styles.pillIconBtn}
              onPress={onOpenCamera}
              disabled={disabled}
              hitSlop={6}
            >
              <Ionicons name="camera-outline" size={22} color={WA_ICON} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </>
  )

  return (
    <View style={[styles.container, { paddingBottom: Math.max(spacing.sm, bottomInset) }]}>

      {/* Emoji picker modal */}
      <Modal
        visible={emojiPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setEmojiPickerOpen(false)}
      >
        <Pressable style={styles.emojiBackdrop} onPress={() => setEmojiPickerOpen(false)}>
          <View style={styles.emojiSheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.emojiSheetTitle}>Emoji</Text>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {EMOJI_PICKER_ROWS.map((row, ri) => (
                <View key={ri} style={styles.emojiRow}>
                  {row.map((emo) => (
                    <Pressable key={emo} style={styles.emojiCell} onPress={() => insertEmoji(emo)}>
                      <Text style={styles.emojiChar}>{emo}</Text>
                    </Pressable>
                  ))}
                </View>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

      {/* Reply preview */}
      {replyPreview ? (
        <View style={styles.replyPreview}>
          <View style={styles.replyAccent} />
          <View style={styles.replyBody}>
            <Text style={styles.replySender} numberOfLines={1}>{replyPreview.senderName}</Text>
            <Text style={styles.replyText} numberOfLines={1}>{replyPreview.textPreview || 'Attachment'}</Text>
          </View>
          <Pressable onPress={onClearReply} style={styles.replyClose}>
            <Ionicons name="close" size={16} color={colors.textSecondary} />
          </Pressable>
        </View>
      ) : null}

      {/* Attachment pills */}
      {attachments.length > 0 && (
        <View style={styles.attachmentsRow}>
          {attachments.map((att, idx) => (
            <View key={idx} style={styles.attPill}>
              <Text style={styles.attPillText} numberOfLines={1}>
                {att.kind === 'LOCATION' && att.latitude != null
                  ? '📍 Location'
                  : att.kind === 'VOICE'
                    ? '🎤 Voice'
                    : att.fileName || att.kind}
              </Text>
              {att.uploadProgress !== undefined && att.uploadProgress < 100 && (
                <View style={styles.attProgress}>
                  <View style={[styles.attProgressFill, { width: `${att.uploadProgress}%` }]} />
                </View>
              )}
              <Pressable onPress={() => onRemoveAttachment(idx)} style={styles.attRemove}>
                <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {/* ── LOCKED RECORDING PANEL ── */}
      {recording && voiceLocked ? (
        <View style={styles.lockedPanel}>
          <RecordingLiveWave />
          <View style={styles.lockedMeta}>
            <Ionicons name="mic" size={16} color="#EA4335" />
            <Text style={styles.lockedTimer}>{timerLabel}</Text>
            <Text style={styles.lockedHint}>Tap send when finished</Text>
          </View>
          <View style={styles.lockedActions}>
            <Pressable style={styles.lockedDiscard} onPress={onVoiceDiscardLocked} hitSlop={8}>
              <Ionicons name="trash-outline" size={22} color={colors.danger} />
            </Pressable>
            <Pressable style={styles.lockedSend} onPress={onVoiceSendLocked} hitSlop={8}>
              <Ionicons name="send" size={20} color="#FFFFFF" />
            </Pressable>
          </View>
        </View>
      ) : (
        /* ── NORMAL / UNLOCKED RECORDING ROW ── */
        <View style={styles.composerRow}>

          {/* Input pill */}
          <View style={styles.inputPill}>
            {/* Emoji button — always left inside pill */}
            <Pressable
              style={styles.pillIconBtn}
              onPress={() => setEmojiPickerOpen(true)}
              disabled={disabled || recording}
              hitSlop={6}
            >
              <Ionicons name="happy-outline" size={22} color={WA_ICON} />
            </Pressable>

            {/* Pill content: text input or recording UI */}
            <View style={styles.pillCenter}>
              {pillContent}
            </View>
          </View>

          {/* Mic FAB column (lock badge floats above when recording) */}
          <View style={styles.fabCol}>
            {recording && !voiceLocked ? (
              <View style={styles.lockBadge}>
                <Ionicons name="lock-closed" size={13} color={colors.surface} />
              </View>
            ) : null}
            {showMic || (recording && !voiceLocked) ? micFab : sendFab}
          </View>
        </View>
      )}
    </View>
  )
}

const FAB_SIZE = 46

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#F0F2F5',
    paddingTop: spacing.xs,
    paddingHorizontal: spacing.sm,
  },

  /* ── Reply preview ── */
  replyPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderRadius: 12,
    padding: 8,
    marginBottom: spacing.xs,
  },
  replyAccent: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 2,
    backgroundColor: colors.brandPrimary,
    marginRight: 8,
  },
  replyBody: { flex: 1 },
  replySender: {
    ...typography.caption,
    color: colors.brandPrimary,
    fontWeight: '700',
  },
  replyText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 1,
  },
  replyClose: { padding: 4 },

  /* ── Attachment pills ── */
  attachmentsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  attPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 16,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    maxWidth: '80%',
  },
  attPillText: { ...typography.caption, color: colors.textPrimary, fontSize: 11 },
  attProgress: {
    width: 40,
    height: 2,
    backgroundColor: colors.divider,
    borderRadius: 1,
    overflow: 'hidden',
  },
  attProgressFill: { height: '100%', backgroundColor: colors.brandPrimary },
  attRemove: { padding: 2 },

  /* ── Composer row ── */
  composerRow: {
    flexDirection: 'row',
    /* center so mic sits mid-height of pill on single-line, drops to bottom on multiline */
    alignItems: 'center',
    gap: 8,
  },

  /* ── FAB column (holds lock hint + mic/send) ── */
  fabCol: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* Floating lock badge shown above mic when recording (unlocked) */
  lockBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.brandPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 3,
  },

  /* ── Input pill ── soft-light premium, floats above chat background */
  inputPill: {
    flex: 1,
    minHeight: 42,
    maxHeight: 130,
    borderRadius: 21,
    backgroundColor: WA_PILL_BG,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    /* subtle border so pill edge is visible against #F5F7FA chat bg */
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    /* soft shadow to give floating / lifted feel */
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 3,
    elevation: 2,
  },
  pillIconBtn: {
    /* tighter hit area — WhatsApp icons have minimal padding */
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  pillCenter: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  pillInput: {
    flex: 1,
    minHeight: 30,
    maxHeight: 100,
    paddingHorizontal: 4,
    paddingVertical: 0,
    ...typography.body,
    color: WA_TEXT,
    fontSize: 16,
    lineHeight: 20,
    textAlignVertical: 'center',
  },
  pillRightIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    /* no extra bottom padding — pill is already center-aligned */
    gap: 0,
  },

  /* ── Compact recording inline (inside pill) ── */
  recInPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 0,
    paddingHorizontal: 4,
    minHeight: 30,
  },
  recMicIcon: {
    flexShrink: 0,
  },
  recTimerText: {
    ...typography.sub,
    fontSize: 15,
    fontWeight: '600',
    color: WA_TEXT,
    minWidth: 34,
  },
  slideToCancelText: {
    ...typography.caption,
    fontSize: 13,
    color: WA_ICON,
    flex: 1,
  },
  slideToCancelWarn: {
    color: colors.danger,
    fontWeight: '600',
  },

  /* ── FAB (mic / send) ── */
  fabWrap: {
    flexShrink: 0,
    /* no self-align so it sits at centre (inherits from composerRow alignItems:'center') */
  },
  fab: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    backgroundColor: WA_FAB_BG,
    alignItems: 'center',
    justifyContent: 'center',
    /* slightly stronger shadow so accent circle pops against light bg */
    shadowColor: '#006B59',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.22,
    shadowRadius: 5,
    elevation: 5,
  },
  fabRecording: {
    backgroundColor: '#25D366',
  },
  fabCancel: {
    backgroundColor: colors.warning,
  },
  fabDisabled: {
    opacity: 0.45,
  },
  fabSend: {
    backgroundColor: '#00A884',
  },
  fabSendDisabled: {
    opacity: 0.42,
    backgroundColor: colors.muted,
  },

  /* ── Locked recording panel ── */
  lockedPanel: {
    paddingVertical: spacing.sm,
  },
  liveWaveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 30,
    paddingHorizontal: 2,
    width: '100%',
  },
  liveWaveBar: {
    flex: 1,
    marginHorizontal: 0.5,
    maxWidth: 4,
    borderRadius: 2,
    backgroundColor: colors.brandPrimary,
    opacity: 0.9,
  },
  lockedMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  lockedTimer: {
    ...typography.sub,
    fontWeight: '700',
    color: colors.brandPrimary,
  },
  lockedHint: {
    ...typography.caption,
    fontSize: 11,
    color: colors.textSecondary,
    flex: 1,
  },
  lockedActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 14,
    paddingHorizontal: spacing.sm,
  },
  lockedDiscard: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  lockedSend: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.brandPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ── Emoji picker ── */
  emojiBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  emojiSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: spacing.lg,
    paddingHorizontal: spacing.md,
    maxHeight: '42%',
  },
  emojiSheetTitle: {
    ...typography.sub,
    textAlign: 'center',
    paddingVertical: 12,
    color: colors.textSecondary,
  },
  emojiRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  emojiCell: { flex: 1, alignItems: 'center', paddingVertical: 6 },
  emojiChar: { fontSize: 28 },
})

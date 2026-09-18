import * as Haptics from 'expo-haptics'
import React, { useCallback, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Dimensions,
  Image,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../../theme/tokens'
import { ChatMessage } from '../../types/models'
import { VoiceNoteBubble } from './VoiceNoteBubble'
import { ReplyPreview } from './ReplyPreview'
import { API_BASE_URL } from '../../config/env'
import { openAttachment } from '../../services/open-attachment'

/**
 * Convert a relative server path (e.g. /uploads/tenant/file.m4a) to an absolute
 * URL so expo-av and React Native Image can load it over the network.
 * The server's upload handler intentionally returns relative paths; this is the
 * single place we resolve them for the client.
 */
function resolveMediaUrl(url: string | null | undefined): string {
  if (!url) return ''
  const trimmed = url.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  if (trimmed.startsWith('file://') || trimmed.startsWith('content://')) return trimmed
  try {
    return new URL(trimmed, `${API_BASE_URL}/`).toString()
  } catch {
    return trimmed
  }
}

const REACTION_PICKER_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const

/**
 * Video preview — shows a film-icon placeholder with a play button overlay.
 * No native video-thumbnail module needed; avoids potential module-load crashes.
 */
function VideoThumbPreview() {
  return (
    <View style={styles.videoThumbContainer}>
      <View style={styles.videoPlaceholder}>
        <Ionicons name="film-outline" size={36} color="rgba(255,255,255,0.6)" />
      </View>
      <View style={styles.playOverlay}>
        <Ionicons name="play-circle" size={52} color="rgba(255,255,255,0.92)" />
      </View>
    </View>
  )
}

interface MessageBubbleProps {
  message: ChatMessage | { sender?: ChatMessage['sender'] | null; [key: string]: any }
  isMine: boolean
  showSender?: boolean
  onJobPress?: (jobId: string) => void
  onLongPress?: () => void
  /** When set, long-press opens emoji bar; "More" calls onLongPress (e.g. existing options sheet). */
  onReaction?: (emoji: string) => void
  /** Counts per emoji for chips under the bubble (local / optimistic until API exists). */
  reactionCounts?: Record<string, number>
  onImagePress?: (uri: string, fileName?: string | null) => void
  onSwipeReply?: (message: ChatMessage) => void
  onReplyPress?: (messageId: string) => void
}

function senderName(message: ChatMessage | { sender?: ChatMessage['sender'] | null }) {
  const sender = message.sender
  if (!sender) return 'Unknown'
  const value = `${sender.firstName || ''} ${sender.lastName || ''}`.trim()
  return value || sender.email
}

function formatMessageTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function statusIcon(status: string) {
  if (status === 'READ') return '✓✓'
  if (status === 'DELIVERED') return '✓✓'
  return '✓'
}

const SCREEN_WIDTH = Dimensions.get('window').width
// Hybrid cap: phones stay at 76 % of screen width (unchanged); tablets/large screens
// are capped at 340 px. Breakeven = 340/0.76 ≈ 447 px — all common phones (≤ 430 dp)
// stay safely below this threshold, so phone layout is identical.
const VOICE_BUBBLE_MAX_WIDTH = Math.min(Math.round(SCREEN_WIDTH * 0.76), 340)
const VOICE_BUBBLE_MIN_WIDTH = Math.round(Math.min(SCREEN_WIDTH * 0.62, 270))
const STANDARD_BUBBLE_MAX_WIDTH = Math.round(SCREEN_WIDTH * 0.82)
const REPLY_BUBBLE_MIN_WIDTH_MINE = Math.round(Math.max(270, Math.min(SCREEN_WIDTH * 0.74, 390)))
const REPLY_BUBBLE_MIN_WIDTH_OTHER = Math.round(Math.max(250, Math.min(SCREEN_WIDTH * 0.7, 370)))
const URL_SPLIT_REGEX = /((?:https?:\/\/|www\.)[^\s]+)/gi
const URL_PART_REGEX = /^(?:https?:\/\/|www\.)[^\s]+$/i

function normalizeUrl(raw: string) {
  const value = raw.trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `https://${value}`
}

function renderMessageText(textValue: string, isMine: boolean) {
  const parts = textValue.split(URL_SPLIT_REGEX)
  return parts.map((part, index) => {
    if (!part) return null
    if (URL_PART_REGEX.test(part)) {
      const url = normalizeUrl(part)
      return (
        <Text
          key={`link-${index}`}
          style={[styles.linkText, isMine && styles.linkTextMine]}
          onPress={() => Linking.openURL(url).catch(() => null)}
        >
          {part}
        </Text>
      )
    }
    return (
      <Text key={`text-${index}`} style={[styles.text, isMine && styles.textMine]}>
        {part}
      </Text>
    )
  })
}

export function MessageBubble({
  message,
  isMine,
  showSender,
  onJobPress,
  onLongPress,
  onReaction,
  reactionCounts,
  onImagePress,
  onSwipeReply,
  onReplyPress,
}: MessageBubbleProps) {
  const translateX = useRef(new Animated.Value(0)).current
  const hasTriggeredReply = useRef(false)
  const SWIPE_THRESHOLD = 60
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false)
  const pickerScale = useRef(new Animated.Value(0.88)).current
  // Per-emoji staggered pop-in animations
  const emojiAnims = useRef(
    REACTION_PICKER_EMOJIS.map(() => ({
      scale: new Animated.Value(0),
      translateY: new Animated.Value(14),
    }))
  ).current

  const openReactionPicker = useCallback(() => {
    if (onReaction) {
      setReactionPickerOpen(true)
      // Reset all values before animating
      pickerScale.setValue(0.88)
      emojiAnims.forEach(({ scale, translateY }) => {
        scale.setValue(0)
        translateY.setValue(14)
      })
      // Popup container springs in
      Animated.spring(pickerScale, {
        toValue: 1,
        friction: 6,
        tension: 140,
        useNativeDriver: true,
      }).start()
      // Each emoji pops in with a staggered jump — 35 ms apart
      emojiAnims.forEach(({ scale, translateY }, i) => {
        const delay = i * 35
        Animated.sequence([
          Animated.delay(delay),
          Animated.parallel([
            Animated.spring(scale, {
              toValue: 1,
              friction: 4,
              tension: 200,
              useNativeDriver: true,
            }),
            Animated.spring(translateY, {
              toValue: 0,
              friction: 6,
              tension: 160,
              useNativeDriver: true,
            }),
          ]),
        ]).start()
      })
    } else {
      onLongPress?.()
    }
  }, [onReaction, onLongPress, pickerScale, emojiAnims])

  const closeReactionPicker = useCallback(() => {
    setReactionPickerOpen(false)
  }, [])

  const pickReaction = useCallback(
    (emoji: string) => {
      onReaction?.(emoji)
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
      closeReactionPicker()
    },
    [onReaction, closeReactionPicker]
  )

  const reactionEntries = useMemo(() => {
    if (!reactionCounts) return []
    return Object.entries(reactionCounts).filter(([, n]) => n > 0)
  }, [reactionCounts])

  const bubblePanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderMove: (_, gesture) => {
          if (gesture.dx > 0) {
            translateX.setValue(Math.min(gesture.dx, 84))
            if (!hasTriggeredReply.current && gesture.dx > SWIPE_THRESHOLD && onSwipeReply) {
              hasTriggeredReply.current = true
              onSwipeReply(message as ChatMessage)
            }
          }
        },
        onPanResponderRelease: () => {
          hasTriggeredReply.current = false
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            speed: 24,
            bounciness: 4,
          }).start()
        },
        onPanResponderTerminate: () => {
          hasTriggeredReply.current = false
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            speed: 24,
            bounciness: 4,
          }).start()
        },
      }),
    [isMine, message, onSwipeReply, translateX]
  )

  const hasOnlyVoiceAttachment =
    !message.text &&
    !!message.attachments?.length &&
    message.attachments.every((attachment: any) => attachment.kind === 'VOICE')

  // All-media bubble (with or without caption text) — use minimal outer padding
  const hasOnlyMediaAttachment =
    !!message.attachments?.length &&
    message.attachments.every((attachment: any) => attachment.kind === 'IMAGE' || attachment.kind === 'VIDEO')

  // Photo/video with a text caption — text lives BELOW the media
  const hasMediaWithText = hasOnlyMediaAttachment && !!message.text?.trim()

  return (
    <Animated.View style={[styles.container, isMine ? styles.mineContainer : styles.otherContainer, { transform: [{ translateX }] }]}>
      {/* No side avatar for incoming messages — voice notes show their avatar inside the bubble */}
      <View
        style={[
          styles.bubbleGestureWrap,
          isMine ? styles.bubbleGestureWrapMine : styles.bubbleGestureWrapOther,
        ]}
        {...bubblePanResponder.panHandlers}
      >
        <View style={[styles.bubbleColumnWrap, isMine ? styles.bubbleColumnWrapMine : styles.bubbleColumnWrapOther]}>
      <Pressable
        style={[
          styles.bubble,
          isMine ? styles.mineBubble : styles.otherBubble,
          hasOnlyVoiceAttachment && styles.voiceOnlyBubble,
          hasOnlyMediaAttachment && styles.mediaOnlyBubble,
          message.replyTo && (isMine ? styles.replyBubbleMine : styles.replyBubbleOther),
        ]}
        onLongPress={openReactionPicker}
      >
        {showSender && !isMine && (
          <View style={styles.senderRow}>
            {message.sender?.avatar ? <Image source={{ uri: message.sender.avatar }} style={styles.senderAvatar} /> : null}
            <Text style={styles.senderName}>{senderName(message)}</Text>
          </View>
        )}
        {message.replyTo ? (
          <ReplyPreview
            isOutgoing={isMine}
            senderName={message.replyTo.senderName}
            textPreview={message.replyTo.textPreview || 'Attachment'}
            onPress={() => {
              if (message.replyTo?.messageId && onReplyPress) onReplyPress(message.replyTo.messageId)
            }}
          />
        ) : null}
        {message.jobId && (
          <Pressable
            style={[styles.jobBadge, isMine && styles.jobBadgeMine]}
            onPress={() => (onJobPress ? onJobPress(message.jobId!) : Linking.openURL(`trimpro://jobs/${message.jobId}`))}
          >
            <Ionicons name="briefcase-outline" size={12} color={isMine ? '#075E54' : colors.brandPrimary} />
            <Text style={[styles.jobBadgeText, isMine && styles.jobBadgeTextMine]}>
              {message.jobNumber || 'JOB'} • {message.jobName || 'View Job'}
            </Text>
          </Pressable>
        )}
        {/* Text rendered at top only when there is no media — captions render below the photo */}
        {message.text && !hasMediaWithText ? <Text style={[styles.text, isMine && styles.textMine]}>{renderMessageText(message.text, isMine)}</Text> : null}
        {message.attachments?.map((attachment: any, idx: number) => {
          const attachmentId = 'id' in attachment ? attachment.id : `att-${idx}`
          if (attachment.kind === 'IMAGE') {
            const imgUrl = resolveMediaUrl(attachment.url)
            return (
              <Pressable
                key={attachmentId}
                style={styles.mediaThumb}
                onPress={() => {
                  if (onImagePress) onImagePress(imgUrl, attachment.fileName || null)
                  else Linking.openURL(imgUrl)
                }}
              >
                <Image source={{ uri: imgUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              </Pressable>
            )
          }
          if (attachment.kind === 'VIDEO') {
            const vidUrl = resolveMediaUrl(attachment.url)
            return (
              <Pressable
                key={attachmentId}
                style={styles.mediaThumb}
                onPress={() => {
                  if (onImagePress) onImagePress(vidUrl, attachment.fileName || null)
                  else Linking.openURL(vidUrl)
                }}
              >
                <VideoThumbPreview />
              </Pressable>
            )
          }
          if (attachment.kind === 'VOICE') {
            return (
              <VoiceNoteBubble
                key={attachmentId}
                messageId={String(message.id || attachmentId)}
                audioUrl={resolveMediaUrl(attachment.url)}
                durationMs={attachment.durationMs || null}
                isOutgoing={isMine}
                timestamp={formatMessageTime(message.createdAt)}
                deliveryStatus={message.status}
                senderAvatarUrl={message.sender?.avatar || null}
                senderInitials={senderName(message).slice(0, 1).toUpperCase()}
                onLongPress={openReactionPicker}
              />
            )
          }
          if (attachment.kind === 'LOCATION') {
            return (
              <Pressable
                key={attachmentId}
                style={[styles.locationContainer, isMine && styles.locationContainerMine]}
                onPress={() => Linking.openURL(attachment.url)}
              >
                <Ionicons name="location" size={20} color={isMine ? '#075E54' : colors.brandPrimary} />
                <Text style={[styles.locationText, isMine && styles.locationTextMine]}>Open in Maps</Text>
                {attachment.latitude && attachment.longitude && (
                  <Text style={[styles.locationCoords, isMine && styles.locationCoordsMine]}>
                    {attachment.latitude.toFixed(4)}, {attachment.longitude.toFixed(4)}
                  </Text>
                )}
              </Pressable>
            )
          }
          if (attachment.kind === 'FILE') {
            const fileUrl = resolveMediaUrl(attachment.url)
            const ext = String(attachment.fileName || '').split('.').pop()?.toLowerCase() || ''
            const fileIcon =
              ext === 'pdf' ? 'document-text' :
              ext === 'doc' || ext === 'docx' ? 'document' :
              ext === 'xls' || ext === 'xlsx' || ext === 'csv' ? 'grid' :
              ext === 'ppt' || ext === 'pptx' ? 'easel' :
              ext === 'zip' || ext === 'rar' ? 'archive' :
              'document-outline'
            const sizeLabel = attachment.sizeBytes
              ? attachment.sizeBytes > 1024 * 1024
                ? `${(attachment.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                : `${(attachment.sizeBytes / 1024).toFixed(0)} KB`
              : null
            return (
              <Pressable
                key={attachmentId}
                style={[styles.fileContainer, isMine && styles.fileContainerMine]}
                onPress={() =>
                  void openAttachment({
                    url: fileUrl,
                    fileName: attachment.fileName,
                    mimeType: attachment.mimeType,
                  })
                }
              >
                <View style={[styles.fileIconWrap, isMine && styles.fileIconWrapMine]}>
                  <Ionicons name={fileIcon as any} size={22} color={isMine ? colors.brandPrimary : colors.surface} />
                </View>
                <View style={styles.fileInfo}>
                  <Text style={[styles.fileName, isMine && styles.fileNameMine]} numberOfLines={2}>
                    {attachment.fileName || 'File'}
                  </Text>
                  {sizeLabel ? (
                    <Text style={[styles.fileSize, isMine && styles.fileSizeMine]}>{sizeLabel}</Text>
                  ) : null}
                </View>
                <Ionicons name="open-outline" size={18} color={isMine ? '#667781' : colors.textSecondary} />
              </Pressable>
            )
          }
          return null
        })}
        {/* Caption text below photo/video — only when media + text */}
        {hasMediaWithText ? (
          <View style={[styles.mediaCaptionWrap, isMine && styles.mediaCaptionWrapMine]}>
            <Text style={[styles.text, isMine && styles.textMine]}>{renderMessageText(message.text!, isMine)}</Text>
          </View>
        ) : null}
        {!hasOnlyVoiceAttachment ? (
          <View style={[styles.footer, hasOnlyMediaAttachment && styles.footerMedia]}>
            <Text style={[styles.time, isMine && styles.timeMine]}>
              {formatMessageTime(message.createdAt)}
            </Text>
            {isMine && (
              <Text style={[styles.status, isMine && styles.statusMine]}>
                {statusIcon(message.status)}
              </Text>
            )}
          </View>
        ) : null}
      </Pressable>
      {reactionEntries.length > 0 ? (
        <View style={[styles.reactionChipsRow, isMine ? styles.reactionChipsRowMine : styles.reactionChipsRowOther]}>
          {reactionEntries.map(([emoji, count]) => (
            <View key={emoji} style={[styles.reactionChip, isMine ? styles.reactionChipMine : styles.reactionChipOther]}>
              <Text style={styles.reactionChipText}>
                {emoji}
                {count > 1 ? ` ${count}` : ''}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
        </View>
      </View>

      <Modal visible={reactionPickerOpen} transparent animationType="fade" onRequestClose={closeReactionPicker}>
        <View style={styles.reactionModalRoot}>
          <Pressable style={styles.reactionModalBackdrop} onPress={closeReactionPicker} accessibilityRole="button" />
          <Animated.View style={[styles.reactionBar, { transform: [{ scale: pickerScale }] }]}>
            <View style={styles.reactionEmojiRow}>
              {REACTION_PICKER_EMOJIS.map((emo, i) => (
                <Animated.View
                  key={emo}
                  style={{
                    transform: [
                      { scale: emojiAnims[i].scale },
                      { translateY: emojiAnims[i].translateY },
                    ],
                  }}
                >
                  <Pressable
                    style={styles.reactionEmojiHit}
                    onPress={() => pickReaction(emo)}
                  >
                    <Text style={styles.reactionEmojiLarge}>{emo}</Text>
                  </Pressable>
                </Animated.View>
              ))}
            </View>
            {onLongPress ? (
              <Pressable
                style={styles.reactionMoreRow}
                onPress={() => {
                  closeReactionPicker()
                  onLongPress()
                }}
              >
                <Ionicons name="ellipsis-horizontal" size={18} color={colors.textSecondary} />
                <Text style={styles.reactionMoreText}>More</Text>
              </Pressable>
            ) : null}
          </Animated.View>
        </View>
      </Modal>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 2,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  mineContainer: {
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
  },
  otherContainer: {
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
  },
  sideAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#dbe7ef',
    marginRight: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sideAvatarHidden: {
    opacity: 0,
  },
  sideAvatarImage: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  sideAvatarInitial: {
    ...typography.caption,
    color: '#27485a',
    fontWeight: '700',
  },
  bubble: {
    maxWidth: STANDARD_BUBBLE_MAX_WIDTH,
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  bubbleGestureWrap: {
    flex: 1,
    flexDirection: 'row',
  },
  bubbleColumnWrap: {
    flexShrink: 1,
    maxWidth: VOICE_BUBBLE_MAX_WIDTH,
  },
  bubbleColumnWrapMine: {
    alignItems: 'flex-end',
    alignSelf: 'flex-end',
  },
  bubbleColumnWrapOther: {
    alignItems: 'flex-start',
    alignSelf: 'flex-start',
  },
  bubbleGestureWrapMine: {
    justifyContent: 'flex-end',
  },
  bubbleGestureWrapOther: {
    justifyContent: 'flex-start',
  },
  voiceOnlyBubble: {
    maxWidth: VOICE_BUBBLE_MAX_WIDTH,
    minWidth: VOICE_BUBBLE_MIN_WIDTH,
    paddingHorizontal: 10,
    paddingVertical: 2,
  },
  replyBubbleMine: {
    minWidth: REPLY_BUBBLE_MIN_WIDTH_MINE,
  },
  replyBubbleOther: {
    minWidth: REPLY_BUBBLE_MIN_WIDTH_OTHER,
  },
  mineBubble: {
    backgroundColor: '#DCF8C6',
    borderBottomRightRadius: 3,
    alignSelf: 'flex-end',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#C8E7B2',
  },
  otherBubble: {
    backgroundColor: colors.surface,
    borderBottomLeftRadius: 3,
    borderWidth: 1,
    borderColor: colors.divider,
    alignSelf: 'flex-start',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  senderName: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
    marginBottom: 2,
  },
  senderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  senderAvatar: {
    width: 16,
    height: 16,
    borderRadius: 8,
  },
  jobBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(46, 74, 89, 0.12)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 4,
  },
  jobBadgeMine: {
    backgroundColor: 'rgba(7, 94, 84, 0.08)',
  },
  jobBadgeText: {
    ...typography.caption,
    color: colors.brandPrimary,
    fontWeight: '600',
    fontSize: 11,
  },
  jobBadgeTextMine: {
    color: '#075E54',
  },
  text: {
    ...typography.body,
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 20,
  },
  textMine: {
    color: '#111B21',
  },
  linkText: {
    ...typography.body,
    color: '#1D4ED8',
    textDecorationLine: 'underline',
  },
  linkTextMine: {
    color: '#027EB5',
  },
  // Minimal bubble frame for image/video messages — nearly flush to photo edges
  mediaOnlyBubble: {
    padding: 1,
    borderRadius: 16,
  },
  // Photo/video container — fills almost the full bubble with no extra margin
  mediaThumb: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 13,
    overflow: 'hidden',
    backgroundColor: '#111827',
  },
  // Caption text below photo — gets its own horizontal + vertical padding
  mediaCaptionWrap: {
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 2,
  },
  mediaCaptionWrapMine: {},
  // Footer inside a media bubble needs its own padding (outer bubble padding is 1px)
  footerMedia: {
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  // VideoThumbPreview fills its parent mediaThumb container absolutely
  videoThumbContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoPlaceholder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Legacy refs — kept so remaining code doesn't break
  mediaAttachment: { width: '100%', aspectRatio: 4 / 3, borderRadius: 13, overflow: 'hidden' },
  imageContainer: {},
  image: { width: '100%', height: '100%' },
  videoContainer: {},
  playOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locationContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 4,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  locationContainerMine: {
    backgroundColor: 'rgba(255,255,255,0.45)',
    borderColor: 'rgba(7,94,84,0.12)',
  },
  locationText: {
    ...typography.sub,
    color: colors.brandPrimary,
    fontWeight: '600',
  },
  locationTextMine: {
    color: '#075E54',
  },
  locationCoords: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 10,
  },
  locationCoordsMine: {
    color: '#667781',
  },
  fileIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: colors.brandPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  fileIconWrapMine: {
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
  fileContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 4,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  fileContainerMine: {
    backgroundColor: 'rgba(255,255,255,0.45)',
    borderColor: 'rgba(7,94,84,0.12)',
  },
  fileInfo: {
    flex: 1,
    gap: 2,
  },
  fileName: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  fileNameMine: {
    color: '#111B21',
  },
  fileSize: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 10,
  },
  fileSizeMine: {
    color: '#667781',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    marginTop: 6,
  },
  time: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 11,
  },
  timeMine: {
    color: '#667781',
  },
  status: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 11,
  },
  statusMine: {
    color: '#53BDEB',
  },
  reactionChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
    maxWidth: STANDARD_BUBBLE_MAX_WIDTH,
  },
  reactionChipsRowMine: {
    alignSelf: 'flex-end',
    justifyContent: 'flex-end',
  },
  reactionChipsRowOther: {
    alignSelf: 'flex-start',
  },
  reactionChip: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: StyleSheet.hairlineWidth,
  },
  reactionChipMine: {
    backgroundColor: '#F7FFF3',
    borderColor: '#B9DDA1',
  },
  reactionChipOther: {
    backgroundColor: colors.background,
    borderColor: colors.divider,
  },
  reactionChipText: {
    fontSize: 13,
  },
  reactionModalRoot: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  reactionModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  reactionBar: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    paddingVertical: 10,
    paddingHorizontal: 6,
    width: '100%',
    maxWidth: 360,
    zIndex: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 10,
  },
  reactionEmojiRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',       // force single row — never wrap
    justifyContent: 'space-evenly',
    alignItems: 'center',
  },
  reactionEmojiHit: {
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  reactionEmojiLarge: {
    fontSize: 30,
  },
  reactionMoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
  },
  reactionMoreText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
})

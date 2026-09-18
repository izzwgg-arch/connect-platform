import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Dimensions, Image, LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, typography } from '../../theme/tokens'
import { useVoicePlaybackController } from '../../hooks/useVoicePlaybackController'
import { computeWaveformPlaybackFrame } from '../../screens/messages/message-thread-utils'

const SPEED_STEPS = [1, 1.5, 2] as const
type SpeedStep = (typeof SPEED_STEPS)[number]

// ── Responsive inner cap ──────────────────────────────────────────────────
// On tablets / large screens (≥ 600 dp) the root Pressable gets a hard
// maxWidth: 320 so the waveform row can NEVER flex beyond that, regardless
// of how wide the outer message bubble happens to be.
// On phones (< 600 dp) no extra constraint is added — the outer bubble
// already controls the width correctly.
const _SW = Dimensions.get('window').width
const TABLET_INNER_CAP: { maxWidth: number } | null = _SW >= 600 ? { maxWidth: 320 } : null

// ── Geometry ─────────────────────────────────────────────────────────────
const AVATAR_SIZE  = 44   // outgoing left-slot: avatar / speed badge
const PLAY_SIZE    = 36   // play/pause touch area (transparent bg — icon only visually)
const PLAY_ICON    = 26   // triangle icon — larger to fill the touch area visually
const DOT_SIZE     = 10   // progress playhead diameter
const WAVE_H       = 30   // waveform fills nearly the full row height (row = 36px)
const ELEM_GAP     = 5    // gap between row elements

// META_INDENT: duration row aligns with left edge of waveform content.
// Outgoing (has avatar slot): AVATAR_SIZE + ELEM_GAP + PLAY_SIZE + ELEM_GAP = 90px
// Incoming (no avatar): PLAY_SIZE + ELEM_GAP = 41px
const META_INDENT_OUT = AVATAR_SIZE + ELEM_GAP + PLAY_SIZE + ELEM_GAP  // 90
const META_INDENT_IN  = PLAY_SIZE  + ELEM_GAP                          // 40

interface VoiceNoteBubbleProps {
  messageId: string
  audioUrl: string
  durationMs?: number | null
  isOutgoing: boolean
  timestamp: string
  deliveryStatus?: string
  senderAvatarUrl?: string | null
  senderInitials?: string
  onLongPress?: () => void
}

/**
 * 44-bar waveform — deterministic, natural speech-like amplitude pattern.
 * Bars render at their FULL natural height in ALL states (rest / played /
 * unplayed).  Color opacity is what distinguishes played from unplayed,
 * matching real WhatsApp appearance.
 */
function seededWaveform(id: string, count = 36): number[] {
  let seed = 0
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0
  return Array.from({ length: count }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const n = (seed % 1000) / 1000
    const peak = seed % 9 === 0 ? 0.95 : seed % 5 === 0 ? 0.75 : seed % 3 === 0 ? 0.55 : 0.28
    return Math.max(0.1, Math.min(1, n * 0.5 + peak * 0.5))
  })
}

/**
 * Bar height: natural speech amplitude in ALL states.
 * WhatsApp bars are NOT uniform dots at rest — they show the waveform shape.
 * Played vs unplayed is distinguished by color opacity, not height.
 */
function barH(amp: number): number {
  return amp < 0.12 ? 3 : Math.round(3 + amp * 22)  // 3 – 25 px inside 30 px track
}

function statusIcon(s?: string) {
  return s === 'READ' || s === 'DELIVERED' ? '\u{2713}\u{2713}' : '\u{2713}'
}

function formatMs(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function speedIdx(s: number) {
  const i = SPEED_STEPS.indexOf(s as SpeedStep)
  return i >= 0 ? i : 0
}

function sanitize(raw: string): string {
  if (
    raw.length > 200 ||
    raw.includes('FileNotFoundException') || raw.includes('ExoPlaybackException') ||
    raw.includes('FileDataSource') || raw.includes('MediaCodec') ||
    raw.includes('com.google.') || raw.includes('java.io.') || raw.includes('android.')
  ) return "Couldn\u2019t play audio"
  return raw.length > 80 ? "Couldn\u2019t play audio" : raw
}

// ─────────────────────────────────────────────────────────────────────────────

export function VoiceNoteBubble({
  messageId,
  audioUrl,
  durationMs,
  isOutgoing,
  timestamp,
  deliveryStatus,
  senderAvatarUrl,
  senderInitials,
  onLongPress,
}: VoiceNoteBubbleProps) {
  const {
    isPlaying, play, pause, seek, setSpeed,
    speed, positionMs, durationMs: liveDurationMs, isActiveTrack,
  } = useVoicePlaybackController(messageId)

  const bars   = useMemo(() => seededWaveform(messageId), [messageId])
  const [waveW, setWaveW] = useState(0)
  const [spdIdx, setSpdIdx] = useState(0)
  const [playErr, setPlayErr] = useState<string | null>(null)

  const hasUrl = typeof audioUrl === 'string' && audioUrl.trim().length > 0
  const effDur = Math.max(1, liveDurationMs || durationMs || 1000)
  const { progress, activeBars } = computeWaveformPlaybackFrame({
    positionMs, durationMs: effDur, barsCount: bars.length, waveformWidth: waveW,
  })

  useEffect(() => { setSpdIdx(speedIdx(speed)) }, [speed])

  const cycleSpeed = useCallback(() => {
    const next = (spdIdx + 1) % SPEED_STEPS.length
    setSpdIdx(next)
    void setSpeed(SPEED_STEPS[next])
  }, [spdIdx, setSpeed])

  const seekAt     = (x: number) => { if (waveW > 0 && hasUrl) void seek(x / waveW) }
  const onWaveLayout = (e: LayoutChangeEvent) => setWaveW(e.nativeEvent.layout.width)

  const togglePlay = async () => {
    if (!hasUrl) return
    setPlayErr(null)
    try {
      if (isPlaying) await pause()
      else await play(audioUrl.trim())
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      console.error('[VoiceNoteBubble]', { raw, messageId })
      setPlayErr(sanitize(raw))
    }
  }

  // ── Color scheme ─────────────────────────────────────────────────────────
  const out = isOutgoing

  // Colors based on bubble background (outgoing = dark, incoming = light)
  const playIconColor = out ? 'rgba(255,255,255,0.88)' : colors.brandPrimary
  const waveActive   = out ? 'rgba(255,255,255,0.40)' : 'rgba(46,74,89,0.28)'
  const waveInactive = out ? 'rgba(255,255,255,0.88)' : 'rgba(46,74,89,0.80)'
  const dotColor     = out ? '#FFFFFF' : colors.brandPrimary
  const metaColor    = out ? 'rgba(255,255,255,0.75)' : colors.textSecondary
  const spdBg        = out ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.07)'
  const spdCol       = out ? '#FFFFFF' : colors.textPrimary
  const avBg         = out ? 'rgba(255,255,255,0.18)' : '#dbe7ef'
  const avTxt        = out ? 'rgba(255,255,255,0.95)' : colors.brandPrimary
  const micBg        = out ? 'rgba(255,255,255,0.22)' : colors.brandPrimary

  const currentSpeed = SPEED_STEPS[spdIdx]
  const speedLabel   = currentSpeed === 1 ? '1\u00D7' : currentSpeed === 1.5 ? '1.5\u00D7' : '2\u00D7'
  const durLabel     = (isPlaying || positionMs > 0) ? positionMs : effDur
  const dotLeft      = Math.max(0, Math.min(100, progress * 100))

  // ── Slot logic ────────────────────────────────────────────────────────────
  //   OUTGOING: slot always on LEFT  (avatar at rest, speed badge while playing)
  //   INCOMING: slot always on RIGHT (avatar at rest, speed badge while playing)
  //   Speed badge only shows while ACTIVELY PLAYING — after finish it reverts to avatar.
  const showLeftSlot  = out       // outgoing: left slot always
  const showRightSlot = !out      // incoming: right slot always
  const metaIndent    = out ? META_INDENT_OUT : META_INDENT_IN

  const renderAvatarView = () => (
    <View style={styles.avatarSlot}>
      {senderAvatarUrl ? (
        <Image source={{ uri: senderAvatarUrl }} style={styles.avatarImg} />
      ) : (
        <View style={[styles.avatarFallback, { backgroundColor: avBg }]}>
          <Text style={[styles.avatarInitial, { color: avTxt }]}>{senderInitials || '?'}</Text>
        </View>
      )}
    </View>
  )

  // Speed badge shown only while actively playing; avatar shown when idle or finished
  const renderSlotContent = () => {
    if (isPlaying) {
      return (
        <Pressable style={[styles.avatarSlot, { backgroundColor: spdBg }]} onPress={cycleSpeed} hitSlop={6}>
          <Text style={[styles.speedText, { color: spdCol }]}>{speedLabel}</Text>
        </Pressable>
      )
    }
    return renderAvatarView()
  }

  // ── No-URL fallback ───────────────────────────────────────────────────────
  if (!hasUrl) {
    return (
      <Pressable style={[styles.root, TABLET_INNER_CAP]} onLongPress={onLongPress}>
        <View style={styles.row}>
          {showLeftSlot && (
            <View style={[styles.avatarSlot, { backgroundColor: spdBg, opacity: 0.5 }]}>
              <Ionicons name="mic-off-outline" size={16} color={metaColor} />
            </View>
          )}
          <View style={[styles.playArea, { opacity: 0.5 }]}>
            <Ionicons name="play" size={PLAY_ICON} color={playIconColor} style={styles.playOffset} />
          </View>
          <View style={styles.waveBlock} onLayout={onWaveLayout}>
            <View style={styles.waveTrack}>
              {bars.map((amp, i) => (
                <View key={i} style={styles.barCell}>
                  <View style={[styles.barFill, { height: barH(amp), backgroundColor: waveInactive }]} />
                </View>
              ))}
            </View>
          </View>
        </View>
        <View style={[styles.meta, { paddingLeft: metaIndent }]}>
          <Text style={[styles.dur, { color: metaColor }]}>–:––</Text>
          <View style={styles.metaRight}>
            <Text style={[styles.ts, { color: metaColor }]}>{timestamp}</Text>
          </View>
        </View>
      </Pressable>
    )
  }

  // ── Main render ──────────────────────────────────────────────────────────
  return (
    <Pressable style={[styles.root, TABLET_INNER_CAP]} onLongPress={onLongPress}>

      {/* ── [avatar/speed?] [play] [waveform + dot] ── */}
      <View style={styles.row}>

        {/* Left slot — outgoing only */}
        {showLeftSlot && renderSlotContent()}

        {/* Play / pause — transparent bg, icon only (matches WhatsApp) */}
        <Pressable style={styles.playArea} onPress={() => void togglePlay()} hitSlop={8}>
          <Ionicons
            name={isPlaying ? 'pause' : 'play'}
            size={PLAY_ICON}
            color={playIconColor}
            style={isPlaying ? undefined : styles.playOffset}
          />
        </Pressable>

        {/* Waveform + scrub + progress dot */}
        <View
          style={styles.waveBlock}
          onLayout={onWaveLayout}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={(e) => seekAt(e.nativeEvent.locationX)}
          onResponderMove={(e) => seekAt(e.nativeEvent.locationX)}
        >
          <View style={styles.waveTrack}>
            {bars.map((amp, i) => (
              <View key={`${messageId}-${i}`} style={styles.barCell}>
                <View style={[
                  styles.barFill,
                  {
                    height: barH(amp),
                    backgroundColor: i < activeBars ? waveActive : waveInactive,
                  },
                ]} />
              </View>
            ))}
            {/* Progress playhead */}
            <View
              style={[styles.dot, {
                width: DOT_SIZE, height: DOT_SIZE, borderRadius: DOT_SIZE / 2,
                backgroundColor: dotColor,
                top: '50%', marginTop: -(DOT_SIZE / 2),
                left: `${dotLeft}%`, marginLeft: -(DOT_SIZE / 2),
              }]}
              pointerEvents="none"
            />
          </View>
        </View>

        {/* Right slot — incoming only (avatar at rest, speed badge while playing) */}
        {showRightSlot && renderSlotContent()}

      </View>

      {/* Error hint — sanitized, never raw exception */}
      {playErr ? (
        <View style={[styles.errRow, { paddingLeft: metaIndent }]}>
          <Ionicons name="alert-circle-outline" size={11} color={metaColor} />
          <Text style={[styles.errText, { color: metaColor }]}>{playErr}</Text>
        </View>
      ) : null}

      {/* Duration | timestamp + delivery */}
      <View style={[styles.meta, { paddingLeft: metaIndent }]}>
        <Text style={[styles.dur, { color: metaColor }]}>{formatMs(durLabel)}</Text>
        <View style={styles.metaRight}>
          <Text style={[styles.ts, { color: metaColor }]}>{timestamp}</Text>
          {isOutgoing ? (
            <Text style={[styles.check, deliveryStatus === 'READ' && styles.checkRead, { color: metaColor }]}>
              {statusIcon(deliveryStatus)}
            </Text>
          ) : null}
        </View>
      </View>

    </Pressable>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { width: '100%', marginTop: 2 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ELEM_GAP,
    width: '100%',
  },

  // ── Avatar / speed-badge slot ─────────────────────────────────────────────
  avatarSlot: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
  },
  avatarImg: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
  },
  avatarFallback: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  micBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 15,
    height: 15,
    borderRadius: 7.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: -0.5,
  },

  // ── Play / pause — transparent, icon is the visual ────────────────────────
  playArea: {
    width: PLAY_SIZE,
    height: PLAY_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    // backgroundColor intentionally omitted — transparent, icon only
  },
  playOffset: { marginLeft: 2 },

  // ── Waveform ──────────────────────────────────────────────────────────────
  waveBlock: {
    flex: 1,
    height: WAVE_H,
    justifyContent: 'center',
    alignSelf: 'center',
    minWidth: 40,
  },
  waveTrack: {
    height: WAVE_H,
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    position: 'relative',
  },
  barCell: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 1,
  },
  barFill: {
    width: 3,
    borderRadius: 1.5,
    minHeight: 3,
  },

  // ── Progress dot ──────────────────────────────────────────────────────────
  dot: {
    position: 'absolute',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 4,
  },

  // ── Error ──────────────────────────────────────────────────────────────────
  errRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 3,
  },
  errText: { ...typography.caption, fontSize: 11, lineHeight: 15 },

  // ── Metadata ──────────────────────────────────────────────────────────────
  meta: {
    marginTop: 3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',  // ensure full width so space-between pushes check to true right edge
  },
  dur:   { ...typography.caption, fontSize: 11 },
  metaRight: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  ts:    { ...typography.caption, fontSize: 11 },
  check: { ...typography.caption, fontSize: 11, fontWeight: '700', marginTop: -1 },
  checkRead: { color: '#9BD0FF' },
})

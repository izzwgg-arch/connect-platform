import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Modal,
  Dimensions,
  Platform,
} from 'react-native';
import { clearAndroidLockScreenCallPresentation } from '../../sip/callkeep';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { playDtmfTone, stopAllTelephonyAudio } from '../../audio/telephonyAudio';
import { useSip } from '../../context/SipContext';
import { useIncomingNotifications } from '../../context/NotificationsContext';
import { useCallSessions } from '../../context/CallSessionManager';
import { logCallFlow } from '../../debug/callFlowDebug';
import { markCallLatency, summarizeCallLatency } from '../../debug/callLatency';
import { useTheme } from '../../context/ThemeContext';
import { CallTimer } from '../../components/call/CallTimer';
// The CallWaitingBanner is a dedicated, high-visibility Answer/Decline
// prompt that slides in when a SECOND call arrives mid-call. It sits next
// to (not instead of) the CallsDrawer so the user ALWAYS has a one-tap
// answer path even before they know the drawer exists.
import { CallWaitingBanner } from './CallWaitingBanner';
import { CallsDrawer } from './CallsDrawer';
import { TransferModal } from './TransferModal';
import { typography } from '../../theme/typography';
import { spacing } from '../../theme/spacing';

const { width } = Dimensions.get('window');

const DTMF_KEYS = [
  { digit: '1', sub: '' },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '' },
  { digit: '0', sub: '+' },
  { digit: '#', sub: '' },
];

// ─── Call control button ──────────────────────────────────────────────────────

type CtrlBtnProps = {
  icon: string;
  label: string;
  onPress: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
};

function CtrlBtn({ icon, label, onPress, active, danger, disabled }: CtrlBtnProps) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePress = () => {
    if (disabled) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.88, duration: 60, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 24 }),
    ]).start();
    onPress();
  };

  const bg = danger
    ? 'rgba(239,68,68,0.18)'
    : active
    ? 'rgba(59,130,246,0.22)'
    : 'rgba(255,255,255,0.07)';
  const iconColor = danger
    ? '#ef4444'
    : active
    ? '#60a5fa'
    : disabled
    ? 'rgba(255,255,255,0.25)'
    : 'rgba(255,255,255,0.85)';
  const border = active
    ? 'rgba(59,130,246,0.4)'
    : danger
    ? 'rgba(239,68,68,0.3)'
    : 'rgba(255,255,255,0.1)';

  return (
    <TouchableOpacity
      onPress={handlePress}
      activeOpacity={0.8}
      style={styles.ctrlWrap}
      disabled={disabled}
    >
      <Animated.View
        style={[
          styles.ctrlBtn,
          { backgroundColor: bg, borderColor: border, transform: [{ scale: scaleAnim }] },
          disabled && { opacity: 0.4 },
        ]}
      >
        <Ionicons name={icon as any} size={24} color={iconColor} />
      </Animated.View>
      <Text style={[styles.ctrlLabel, { color: active ? '#93c5fd' : 'rgba(180,195,220,0.75)' }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export function ActiveCallScreen() {
  const insets = useSafeAreaInsets();
  const sip = useSip();
  const incomingNotif = useIncomingNotifications();
  const { isDark } = useTheme();
  const callSessions = useCallSessions();

  const [showDtmf, setShowDtmf] = useState(false);
  const [dtmfInput, setDtmfInput] = useState('');
  const [showTransfer, setShowTransfer] = useState(false);

  const callState = sip.callState;
  const isConnected = callState === 'connected';
  const isDialing = callState === 'dialing';
  const isRinging = callState === 'ringing';
  // When the user just tapped Answer on the heads-up / lock screen notification,
  // `answerHandoffInviteIdRef` is set until SIP confirms. During that window we
  // render the active call as CONNECTED so the UI feels instantaneous — phone
  // apps universally do this (the transient "Connecting → Ringing → Connected"
  // micro-states are confusing when you just accepted an inbound call).
  // Once SIP actually confirms, the ref clears and `isConnected` takes over
  // naturally; if SIP fails, the call transitions to ended and CALL ENDED is
  // shown (still gated by hasBeenActiveRef below).
  const isAnswerInFlight =
    incomingNotif.answerHandoffInviteIdRef.current !== null && !isConnected;
  // Only show "ended" UI once the call has actually been *confirmed* by SIP.
  // We intentionally do NOT mark hasBeenActive from isAnswerInFlight alone,
  // because during the answer handoff SIP has not yet produced a ringing/
  // connected transition — callState is still 'idle'. If we let
  // hasBeenActiveRef flip true on answer-in-flight, the very next render
  // evaluates `(callState === 'idle')` as "ended" and flashes CALL ENDED
  // for ~1s before SIP confirms. Keeping the guard strict to real SIP
  // transitions fixes that, and we also short-circuit `isEnded` while
  // answer-in-flight as a belt-and-braces guard.
  const hasBeenActiveRef = useRef(false);
  if (
    !hasBeenActiveRef.current &&
    (isConnected || isDialing || isRinging)
  ) {
    hasBeenActiveRef.current = true;
  }
  // Multi-call-aware ended detection: even if the legacy single-call
  // `sip.callState` briefly flips to "ended"/"idle" (for example because
  // a held sibling hung up and the SIP bridge emitted a stale global
  // callState update), we must NOT dismiss the screen while the multi-call
  // manager still sees a live call (active / held / connecting / dialing /
  // ringing with SIP). Otherwise a single held-party hangup tears down
  // everything.
  const hasAnyLiveCall = callSessions.hasAnyOngoingCall;
  const isEnded =
    hasBeenActiveRef.current &&
    !isAnswerInFlight &&
    !hasAnyLiveCall &&
    (callState === 'ended' || callState === 'idle');
  // While answer-in-flight, suppress the pulse animation so the UI looks
  // settled instead of "dialing out".
  const inProgress = (isDialing || isRinging) && !isAnswerInFlight;

  // Derive a display name and number from the currently-active multi-call
  // session first, then SIP remoteParty, then the last-answered invite.
  // The multi-call pointer is authoritative when the user swaps calls —
  // SipContext only tracks one SIP session at a time and lags behind the
  // multi-call manager when a held call is resumed.
  // When the active call ends but a held call remains (auto-resume is off),
  // fall back to the top-held call's caller info so the screen keeps
  // showing who the user is about to resume instead of flashing "Connecting…"
  // or the old active party's name.
  const activeSession = callSessions.activeCall;
  const topHeldSession = callSessions.heldCalls[0] ?? null;
  const primarySession = activeSession ?? topHeldSession;
  const multiCallParty =
    primarySession?.remoteName?.trim() || primarySession?.remoteNumber || '';
  const rawParty = multiCallParty || (sip.remoteParty ?? '');
  const inviteParty = incomingNotif.answerInviteRef.current?.fromNumber ?? '';
  const effectiveParty = rawParty || inviteParty;
  const displayName = effectiveParty || (
    isAnswerInFlight
      ? ''
      : isDialing
      ? 'Dialing…'
      : isRinging
      ? 'Ringing…'
      : 'Connecting…'
  );
  const displayNumber = effectiveParty && effectiveParty !== displayName ? effectiveParty : '';

  // Initials for avatar
  const initials = effectiveParty
    ? effectiveParty
        .split(/[\s-]/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? '')
        .join('')
    : '?';

  // ── Animations ──────────────────────────────────────────────────────────────

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;
  const panelSlide = useRef(new Animated.Value(120)).current;
  const panelOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Slide panel in on mount
    Animated.parallel([
      Animated.spring(panelSlide, { toValue: 0, useNativeDriver: true, speed: 12, bounciness: 5 }),
      Animated.timing(panelOpacity, { toValue: 1, duration: 380, useNativeDriver: true }),
    ]).start();
  }, []);

  useEffect(() => {
    if (inProgress) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.parallel([
            Animated.timing(pulseAnim, { toValue: 1.18, duration: 900, useNativeDriver: true }),
            Animated.timing(glowOpacity, { toValue: 0.55, duration: 900, useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
            Animated.timing(glowOpacity, { toValue: 0.18, duration: 900, useNativeDriver: true }),
          ]),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      Animated.parallel([
        Animated.spring(pulseAnim, { toValue: 1, useNativeDriver: true }),
        Animated.timing(glowOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start();
    }
  }, [inProgress]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    // Clear lock-screen flags ONLY on unmount (not on mount).
    // Clearing on mount would hide the active call screen behind the lock screen
    // while the call is still in progress. The flags are also cleared in handleHangup
    // (before sip.hangup()) for immediate effect on the hangup tap.
    return () => {
      clearAndroidLockScreenCallPresentation();
    };
  }, []);

  useEffect(() => {
    const inviteId =
      incomingNotif.answerHandoffInviteIdRef.current ??
      incomingNotif.incomingInvite?.id ??
      incomingNotif.incomingCallUiState.inviteId ??
      null;
    logCallFlow('ACTIVE_CALL_SCREEN_MOUNT', { inviteId });
    // Latency: ActiveCallScreen mount is the authoritative "call is now
    // live to the user" moment — after this the UI is fully swapped
    // over. We mark CALL_ACTIVE_UI and eagerly print the timeline so
    // the engineer sees a complete "answer → audio" trace the instant
    // the call goes live (without waiting for hangup).
    if (inviteId) {
      markCallLatency(inviteId, 'CALL_ACTIVE_UI');
      summarizeCallLatency(inviteId, 'active');
    }
  }, []);

  // Auto-dismiss is handled by RootNavigator which removes this screen from
  // the stack when isCallActive becomes false (on 'idle'). Calling goBack()
  // here races with that and causes a crash — do nothing.

  // ── Status label ────────────────────────────────────────────────────────────

  // Show the hold badge when the LEGACY single-session is on hold OR when
  // the multi-call manager has no active call but at least one held call
  // (i.e. the active party just hung up and the previously-held party is
  // still waiting on the line). This keeps the user oriented while they
  // decide whether to press Resume.
  const showingHeldOnly = !activeSession && !!topHeldSession;
  const isHoldState = sip.onHold || showingHeldOnly;

  const statusLabel = (() => {
    if (isEnded) return 'CALL ENDED';
    if (isHoldState) return 'ON HOLD';
    if (isAnswerInFlight || callState === 'connected') return 'CONNECTED';
    if (callState === 'dialing') return 'CALLING…';
    if (callState === 'ringing') return 'RINGING…';
    return 'CONNECTING…';
  })();

  const statusColor = isEnded
    ? 'rgba(239,68,68,0.8)'
    : (isConnected || isAnswerInFlight) && !isHoldState
    ? 'rgba(52,211,153,0.8)'
    : 'rgba(136,153,187,0.8)';

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleDtmf = (digit: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    playDtmfTone(digit); // Local DTMF tone feedback
    setDtmfInput((p) => p + digit);
    sip.sendDtmf(digit); // SIP DTMF signal to PBX
  };

  const handleHangup = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    if (Platform.OS === 'android') {
      clearAndroidLockScreenCallPresentation();
    }
    // Multi-call aware hangup: hang up the active call if any; otherwise
    // fall back to hanging up the top held call (which is the one the
    // screen is currently representing after the original active party
    // dropped off). Only stop shared telephony audio when no other calls
    // remain — otherwise we'd cut audio for siblings.
    const snapActive = callSessions.activeCall;
    const snapHeld = callSessions.heldCalls;
    const target = snapActive ?? snapHeld[0] ?? null;
    if (target) {
      const willBeLast = (snapActive ? 0 : 0) + snapHeld.length + (snapActive ? 1 : 0) <= 1;
      if (willBeLast) {
        stopAllTelephonyAudio().catch(() => undefined);
      }
      await callSessions.hangup(target.id);
      return;
    }
    stopAllTelephonyAudio().catch(() => undefined);
    await sip.hangup();
  };

  const handleMute = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    sip.toggleMute();
  };

  const handleSpeaker = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    sip.cycleAudioRoute();
  };

  // Icon and label for the dynamic audio route button
  const audioRouteIcon =
    sip.audioRoute === 'speaker'
      ? 'volume-high'
      : sip.audioRoute === 'bluetooth'
      ? 'bluetooth'
      : 'volume-medium';
  const audioRouteLabel =
    sip.audioRoute === 'speaker'
      ? 'Speaker'
      : sip.audioRoute === 'bluetooth'
      ? 'Bluetooth'
      : 'Earpiece';

  // Multi-call aware Hold button.
  //
  // Behavior:
  //   - If an active call exists → put it on hold via the multi-call
  //     manager (which also mirrors to the CallSession store so the
  //     drawer reflects it immediately).
  //   - If no call is active but a held call exists → resume the top of
  //     the held stack. This is what powers the "2nd caller hangs up →
  //     press Hold to return to the first caller" flow the product spec
  //     calls for now that auto-resume is disabled.
  //   - Fallback: toggle the legacy single-session hold so the button
  //     still works for the classic single-call path.
  const handleHold = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    const snapActive = callSessions.activeCall;
    const snapHeld = callSessions.heldCalls;
    if (snapActive) {
      callSessions.holdActive();
      return;
    }
    if (snapHeld.length > 0) {
      callSessions.resume(snapHeld[0].id);
      return;
    }
    sip.toggleHold();
  };

  const handleTransferPress = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    setShowTransfer(true);
  }, []);

  const handleTransferSubmit = useCallback(
    (target: string) => {
      const activeId = callSessions.activeCall?.id;
      if (!activeId) {
        setShowTransfer(false);
        return;
      }
      const ok = callSessions.transfer(activeId, target);
      if (ok) {
        // REFER is dispatched; the PBX will bridge and tear down our
        // dialog on success. Closing the modal is enough feedback.
        setShowTransfer(false);
      } else {
        setShowTransfer(false);
      }
    },
    [callSessions],
  );

  // Button bindings for the bottom control grid.
  const holdBtnActive = sip.onHold || (!callSessions.activeCall && callSessions.heldCalls.length > 0);
  const holdBtnIcon = holdBtnActive ? 'play' : 'pause';
  const holdBtnLabel = holdBtnActive ? 'Resume' : 'Hold';
  const holdBtnDisabled =
    !isConnected &&
    !(callSessions.activeCall) &&
    callSessions.heldCalls.length === 0;

  const canTransfer = !!callSessions.activeCall;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <LinearGradient colors={['#090e18', '#0a1128', '#0e1830']} style={styles.container}>
      {/* Animated glow ring behind avatar */}
      <Animated.View
        style={[styles.glowRing, { opacity: glowOpacity, transform: [{ scale: pulseAnim }] }]}
      />

      {/* ── Top status ── */}
      <View style={[styles.topArea, { paddingTop: insets.top + 16 }]}>
        <Text style={[styles.statusText, { color: statusColor, letterSpacing: 2 }]}>
          {statusLabel}
        </Text>

        {/* Timer — only shown when connected */}
        <CallTimer
          running={isConnected && !sip.onHold}
          style={{ marginTop: 6, opacity: isConnected ? 1 : 0 }}
        />

        {/* Hold badge */}
        {isHoldState && (
          <View style={styles.holdPill}>
            <Ionicons name="pause" size={10} color="#f59e0b" style={{ marginRight: 4 }} />
            <Text style={styles.holdText}>ON HOLD</Text>
          </View>
        )}
      </View>

      {/* ── Multi-call overlays ── rendered as absolute positioned layers
          above the avatar so they're never clipped by the layout stack. */}

      {/* 1) Compact "N calls" drawer pill + dropdown (always on top). */}
      <View
        style={[styles.drawerOverlay, { top: insets.top + 10 }]}
        pointerEvents="box-none"
      >
        <CallsDrawer />
      </View>

      {/* 2) High-visibility call-waiting banner: slides in from the top
          whenever a second call rings during an active call. Gives the
          user an instant one-tap Answer / Decline path without needing
          to hunt for the drawer. */}
      <View
        style={[styles.bannerOverlay, { top: insets.top + 56 }]}
        pointerEvents="box-none"
      >
        <CallWaitingBanner />
      </View>

      {/* ── Avatar & name ── */}
      <View style={styles.avatarArea}>
        <Animated.View
          style={[styles.avatarRing, { transform: [{ scale: inProgress ? pulseAnim : 1 }] }]}
        >
          <View style={[styles.avatarInner, isEnded && { backgroundColor: 'rgba(239,68,68,0.12)' }]}>
            {isEnded ? (
              <Ionicons name="call" size={48} color={isEnded ? '#ef4444' : '#3b82f6'} style={{ transform: [{ rotate: '135deg' }] }} />
            ) : (
              <Text style={styles.avatarInitials}>{initials}</Text>
            )}
          </View>
        </Animated.View>

        <Text
          style={styles.callerName}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {isEnded ? 'Call Ended' : displayName}
        </Text>

        {displayNumber && !isEnded && (
          <Text style={styles.callerNumber}>{displayNumber}</Text>
        )}
      </View>

      {/* ── Controls card ── */}
      {!isEnded && (
        <Animated.View
          style={[
            styles.controlsCard,
            {
              opacity: panelOpacity,
              transform: [{ translateY: panelSlide }],
              paddingBottom: insets.bottom + 20,
            },
          ]}
        >
          {/* 2×3 control grid */}
          <View style={styles.ctrlGrid}>
            <CtrlBtn
              icon={sip.muted ? 'mic-off' : 'mic'}
              label={sip.muted ? 'Unmute' : 'Mute'}
              onPress={handleMute}
              active={sip.muted}
              danger={sip.muted}
            />
            <CtrlBtn
              icon={audioRouteIcon}
              label={audioRouteLabel}
              onPress={handleSpeaker}
              active={sip.audioRoute !== 'earpiece'}
            />
            <CtrlBtn
              icon="keypad"
              label="Keypad"
              onPress={() => setShowDtmf(true)}
            />
            <CtrlBtn
              icon={holdBtnIcon}
              label={holdBtnLabel}
              onPress={handleHold}
              active={holdBtnActive}
              disabled={holdBtnDisabled}
            />
            <CtrlBtn
              icon="git-network-outline"
              label="Transfer"
              onPress={handleTransferPress}
              disabled={!canTransfer}
            />
            <CtrlBtn
              icon="add"
              label="Add Call"
              onPress={() => {}}
              disabled
            />
          </View>

          {/* Divider */}
          <View style={styles.divider} />

          {/* End call button */}
          <View style={styles.endCallRow}>
            <TouchableOpacity
              style={styles.endCallBtn}
              onPress={handleHangup}
              activeOpacity={0.82}
            >
              <Ionicons
                name="call"
                size={30}
                color="#fff"
                style={{ transform: [{ rotate: '135deg' }] }}
              />
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}

      {/* Ended state — just a minimal bottom bar */}
      {isEnded && (
        <View style={[styles.endedBar, { paddingBottom: insets.bottom + 24 }]}>
          <Text style={styles.endedText}>Call ended</Text>
        </View>
      )}

      {/* ── Transfer modal (blind REFER) ── */}
      <TransferModal
        visible={showTransfer}
        title="Transfer call"
        subtitle={
          callSessions.activeCall
            ? `Transfer ${callSessions.activeCall.remoteName || callSessions.activeCall.remoteNumber || 'this call'} to…`
            : 'No active call to transfer'
        }
        onCancel={() => setShowTransfer(false)}
        onSubmit={handleTransferSubmit}
      />

      {/* ── DTMF modal ── */}
      <Modal
        visible={showDtmf}
        transparent
        animationType="slide"
        onRequestClose={() => setShowDtmf(false)}
      >
        <View style={styles.dtmfOverlay}>
          <View style={styles.dtmfSheet}>
            <View style={styles.dtmfHandle} />

            <View style={styles.dtmfHeader}>
              <Text style={styles.dtmfTitle}>Keypad</Text>
              <TouchableOpacity onPress={() => setShowDtmf(false)}>
                <Ionicons name="close" size={24} color="rgba(136,153,187,0.8)" />
              </TouchableOpacity>
            </View>

            <Text style={styles.dtmfDisplay}>{dtmfInput || ' '}</Text>

            <View style={styles.dtmfGrid}>
              {DTMF_KEYS.map(({ digit, sub }) => (
                <TouchableOpacity
                  key={digit}
                  style={styles.dtmfKey}
                  onPress={() => handleDtmf(digit)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.dtmfDigit}>{digit}</Text>
                  {sub ? <Text style={styles.dtmfSub}>{sub}</Text> : null}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      </Modal>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  glowRing: {
    position: 'absolute',
    width: 360,
    height: 360,
    borderRadius: 180,
    backgroundColor: 'rgba(59,130,246,0.09)',
    alignSelf: 'center',
    top: 80,
  },

  topArea: {
    alignItems: 'center',
    paddingHorizontal: spacing['6'],
    paddingBottom: 12,
  },

  drawerOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 50,
  },
  bannerOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 45,
  },

  statusText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
  },

  holdPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(245,158,11,0.15)',
    borderColor: 'rgba(245,158,11,0.3)',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 8,
  },
  holdText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#f59e0b',
    letterSpacing: 1,
  },

  avatarArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing['8'],
  },

  avatarRing: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 1.5,
    borderColor: 'rgba(59,130,246,0.32)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(59,130,246,0.05)',
  },

  avatarInner: {
    width: 114,
    height: 114,
    borderRadius: 57,
    backgroundColor: 'rgba(59,130,246,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  avatarInitials: {
    fontSize: 42,
    fontWeight: '700',
    color: '#3b82f6',
    letterSpacing: 1,
  },

  callerName: {
    color: '#f0f4ff',
    fontSize: 26,
    fontWeight: '600',
    marginTop: 20,
    textAlign: 'center',
    letterSpacing: -0.3,
    maxWidth: width - spacing['8'] * 2,
  },

  callerNumber: {
    color: 'rgba(136,153,187,0.75)',
    fontSize: 15,
    marginTop: 5,
    fontWeight: '400',
  },

  controlsCard: {
    backgroundColor: 'rgba(13,19,35,0.96)',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(30,45,71,0.8)',
    paddingTop: 28,
    paddingHorizontal: spacing['5'],
  },

  ctrlGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-around',
    marginBottom: 8,
  },

  ctrlWrap: {
    width: '30%',
    alignItems: 'center',
    marginBottom: 20,
  },

  ctrlBtn: {
    width: 62,
    height: 62,
    borderRadius: 31,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },

  ctrlLabel: {
    fontSize: 11,
    fontWeight: '500',
    textAlign: 'center',
  },

  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(30,45,71,0.8)',
    marginBottom: 20,
    marginHorizontal: spacing['2'],
  },

  endCallRow: {
    alignItems: 'center',
    marginBottom: 4,
  },

  endCallBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.55,
    shadowRadius: 14,
    elevation: 12,
  },

  endedBar: {
    alignItems: 'center',
    paddingTop: 28,
  },

  endedText: {
    color: 'rgba(239,68,68,0.6)',
    fontSize: 14,
    fontWeight: '500',
    letterSpacing: 0.5,
  },

  // DTMF modal
  dtmfOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'flex-end',
  },
  dtmfSheet: {
    backgroundColor: '#111827',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: spacing['6'],
    paddingBottom: 40,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1e2d47',
  },
  dtmfHandle: {
    width: 36,
    height: 4,
    backgroundColor: '#2e4068',
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 16,
  },
  dtmfHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  dtmfTitle: {
    color: '#f0f4ff',
    fontSize: 17,
    fontWeight: '700',
  },
  dtmfDisplay: {
    fontSize: 22,
    fontWeight: '300',
    letterSpacing: 4,
    textAlign: 'center',
    color: '#f0f4ff',
    height: 36,
    marginBottom: 14,
  },
  dtmfGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dtmfKey: {
    width: (width - spacing['6'] * 2) / 3,
    height: 68,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  dtmfDigit: {
    fontSize: 22,
    fontWeight: '500',
    color: '#f0f4ff',
  },
  dtmfSub: {
    fontSize: 9,
    color: 'rgba(136,153,187,0.6)',
    letterSpacing: 0.8,
  },
});

import React, { useEffect, useRef, useState } from 'react';
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
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useNavigation } from '@react-navigation/native';
import { useSip } from '../../context/SipContext';
import { useTheme } from '../../context/ThemeContext';
import { CallTimer } from '../../components/call/CallTimer';
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
  const navigation = useNavigation<any>();
  const sip = useSip();
  const { isDark } = useTheme();

  const [showDtmf, setShowDtmf] = useState(false);
  const [dtmfInput, setDtmfInput] = useState('');

  const callState = sip.callState;
  const isConnected = callState === 'connected';
  const isDialing = callState === 'dialing';
  const isRinging = callState === 'ringing';
  const isEnded = callState === 'ended' || callState === 'idle';
  const inProgress = isDialing || isRinging;

  // Derive a display name and number from remoteParty
  const rawParty = sip.remoteParty ?? '';
  const displayName = rawParty || (isDialing ? 'Dialing…' : isRinging ? 'Ringing…' : 'Unknown');
  const displayNumber = rawParty && rawParty !== displayName ? rawParty : '';

  // Initials for avatar
  const initials = rawParty
    ? rawParty
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

  // ── Auto-dismiss when call goes fully idle ──────────────────────────────────
  useEffect(() => {
    if (callState === 'idle') {
      const t = setTimeout(() => {
        try {
          if (navigation.canGoBack()) navigation.goBack();
        } catch {}
      }, 300);
      return () => clearTimeout(t);
    }
  }, [callState, navigation]);

  // ── Status label ────────────────────────────────────────────────────────────

  const statusLabel = (() => {
    if (callState === 'dialing') return 'CALLING…';
    if (callState === 'ringing') return 'RINGING…';
    if (sip.onHold) return 'ON HOLD';
    if (callState === 'connected') return 'CONNECTED';
    if (isEnded) return 'CALL ENDED';
    return 'CONNECTING…';
  })();

  const statusColor = isEnded
    ? 'rgba(239,68,68,0.8)'
    : isConnected && !sip.onHold
    ? 'rgba(52,211,153,0.8)'
    : 'rgba(136,153,187,0.8)';

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleDtmf = (digit: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setDtmfInput((p) => p + digit);
    sip.sendDtmf(digit);
  };

  const handleHangup = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    await sip.hangup();
  };

  const handleMute = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    sip.toggleMute();
  };

  const handleSpeaker = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    sip.toggleSpeaker();
  };

  const handleHold = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    sip.toggleHold();
  };

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
        {sip.onHold && (
          <View style={styles.holdPill}>
            <Ionicons name="pause" size={10} color="#f59e0b" style={{ marginRight: 4 }} />
            <Text style={styles.holdText}>ON HOLD</Text>
          </View>
        )}
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
              icon={sip.speakerOn ? 'volume-high' : 'volume-medium'}
              label="Speaker"
              onPress={handleSpeaker}
              active={sip.speakerOn}
            />
            <CtrlBtn
              icon="keypad"
              label="Keypad"
              onPress={() => setShowDtmf(true)}
            />
            <CtrlBtn
              icon={sip.onHold ? 'play' : 'pause'}
              label={sip.onHold ? 'Resume' : 'Hold'}
              onPress={handleHold}
              active={sip.onHold}
              disabled={!isConnected}
            />
            <CtrlBtn
              icon="swap-horizontal"
              label="Transfer"
              onPress={() => {}}
              disabled
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

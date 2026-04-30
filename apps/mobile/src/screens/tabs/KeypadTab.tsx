import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Dimensions,
  Alert,
  Platform,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSip } from '../../context/SipContext';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { usePresence } from '../../context/PresenceContext';
import { Avatar } from '../../components/ui/Avatar';
import { AppConfirmDialog } from '../../components/ui/AppPopup';
import { getContacts, getVoiceExtension } from '../../api/client';
import { loadLocalCallHistory } from '../../storage/callHistory';
import type { Contact, CallRecord, VoiceExtension } from '../../types';
import { spacing } from '../../theme/spacing';
import { playDtmfTone } from '../../audio/telephonyAudio';
import { ensureMicPermissionOrAlert } from '../../sip/permissions';

const { width, height: screenHeight } = Dimensions.get('window');

const KEYS = [
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

// Compact layout: tighter gutters so the keypad sits closer to the number
// display above and the call button below. Key size stays comfortable by
// clamping to a sensible min/max.
const PAD_H_PADDING = 14;
const KEY_GAP = 8;
const KEY_CELL_WIDTH = Math.floor((width - PAD_H_PADDING * 2 - KEY_GAP * 2) / 3);
const KEY_SIZE = 70;
const SHORT_SCREEN = screenHeight < 740;

type Suggestion = {
  id: string;
  kind: 'contact' | 'recent';
  label: string;
  sub: string;
  value: string;
};

function DialKey({
  digit,
  sub,
  onPress,
  onLongPress,
  disabled,
}: {
  digit: string;
  sub: string;
  onPress: (d: string) => void;
  onLongPress?: (d: string) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const opacityAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback(() => {
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 0.92,
        useNativeDriver: true,
        speed: 40,
        bounciness: 0,
      }),
      Animated.timing(opacityAnim, {
        toValue: 0.75,
        duration: 60,
        useNativeDriver: true,
      }),
    ]).start();
  }, [scaleAnim, opacityAnim]);

  const handlePressOut = useCallback(() => {
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 1,
        useNativeDriver: true,
        speed: 22,
        bounciness: 8,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 110,
        useNativeDriver: true,
      }),
    ]).start();
  }, [scaleAnim, opacityAnim]);

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onPress(digit);
  };

  const handleLongPress = () => {
    if (onLongPress) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      onLongPress(digit);
    }
  };

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={handleLongPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      hitSlop={4}
    >
      <Animated.View
        style={[
          styles.key,
          {
            width: KEY_CELL_WIDTH,
            height: KEY_SIZE,
            transform: [{ scale: scaleAnim }],
            opacity: opacityAnim,
          },
        ]}
      >
        <Text style={[styles.keyDigit, { color: colors.text }]}>{digit}</Text>
        {sub ? (
          <Text style={[styles.keySub, { color: colors.textTertiary }]}>{sub}</Text>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

function SuggestionRow({
  suggestion,
  onPress,
}: {
  suggestion: Suggestion;
  onPress: (s: Suggestion) => void;
}) {
  const { colors } = useTheme();
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const pressIn = () =>
    Animated.spring(scaleAnim, { toValue: 0.98, useNativeDriver: true, speed: 30, bounciness: 0 }).start();
  const pressOut = () =>
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 6 }).start();

  const kindColor = suggestion.kind === 'contact' ? colors.primary : colors.teal;
  const kindIcon = suggestion.kind === 'contact' ? 'person-outline' : 'time-outline';

  return (
    <Pressable onPress={() => onPress(suggestion)} onPressIn={pressIn} onPressOut={pressOut}>
      <Animated.View
        style={[
          styles.suggestion,
          {
            backgroundColor: colors.surface,
            borderColor: colors.borderSubtle,
            transform: [{ scale: scaleAnim }],
          },
        ]}
      >
        {suggestion.kind === 'contact' ? (
          <Avatar name={suggestion.label} size="sm" />
        ) : (
          <View style={[styles.suggestionIcon, { backgroundColor: kindColor + '1f' }]}>
            <Ionicons name={kindIcon} size={16} color={kindColor} />
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.suggestionLabel, { color: colors.text }]} numberOfLines={1}>
            {suggestion.label}
          </Text>
          <Text style={[styles.suggestionSub, { color: colors.textSecondary }]} numberOfLines={1}>
            {suggestion.sub}
          </Text>
        </View>
        <Ionicons name="arrow-up-outline" size={14} color={colors.textTertiary} style={styles.suggestionArrow} />
      </Animated.View>
    </Pressable>
  );
}

export function KeypadTab() {
  const { colors, isDark } = useTheme();
  const sip = useSip();
  const { token } = useAuth();
  const { setMyStatus, isDnd } = usePresence();
  const insets = useSafeAreaInsets();
  const [number, setNumber] = useState('');
  const [dialing, setDialing] = useState(false);
  // Two-tap redial: first tap fills the last-dialed number, second tap calls it
  const [redialFilled, setRedialFilled] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [recent, setRecent] = useState<CallRecord[]>([]);
  const [voice, setVoice] = useState<VoiceExtension | null>(null);
  const [dndConfirmOpen, setDndConfirmOpen] = useState(false);
  const prevCallStateRef = useRef(sip.callState);

  // Load suggestion sources on focus. Network call is best-effort — failure
  // leaves the suggestion list empty but never disables the dialer.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      loadLocalCallHistory()
        .then((h) => { if (alive) setRecent(h); })
        .catch(() => {});
      if (token) {
        getContacts(token, '')
          .then((res) => { if (alive) setContacts(res.rows ?? []); })
          .catch(() => {});
        getVoiceExtension(token)
          .then((next) => { if (alive) setVoice(next); })
          .catch(() => {});
      }
      return () => { alive = false; };
    }, [token]),
  );

  // Clear number when call ends and return to idle
  useEffect(() => {
    const prev = prevCallStateRef.current;
    prevCallStateRef.current = sip.callState;
    const wasInCall =
      prev === 'connected' || prev === 'dialing' || prev === 'ringing' || prev === 'ended';
    if (sip.callState === 'idle' && wasInCall) {
      setNumber('');
      setRedialFilled(false);
    }
  }, [sip.callState]);

  const callActive =
    sip.callState === 'connected' ||
    sip.callState === 'dialing' ||
    sip.callState === 'ringing' ||
    sip.callState === 'ended';
  const registered = sip.registrationState === 'registered';

  const handleKey = (digit: string) => {
    playDtmfTone(digit);
    if (callActive) {
      sip.sendDtmf(digit);
    } else {
      setNumber((prev) => prev + digit);
      setRedialFilled(false); // Manual typing cancels redial mode
    }
  };

  const handleLongPress = (digit: string) => {
    if (digit === '0') {
      setNumber((prev) => (prev.endsWith('+') ? prev : prev.slice(0, -1) + '+'));
    }
  };

  const handleBackspace = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setNumber((prev) => prev.slice(0, -1));
    setRedialFilled(false);
  };

  const handleLongBackspace = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setNumber('');
    setRedialFilled(false);
  };

  const confirmDnd = useCallback(() => {
    if (sip.registrationState !== 'registered') return;
    setDndConfirmOpen(true);
  }, [sip.registrationState]);

  const handleDial = async () => {
    const target = number.trim();

    // Two-tap redial: first tap fills last-dialed number, second tap calls
    if (!target) {
      const last = sip.lastDialed;
      if (!last) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        return;
      }
      setNumber(last);
      setRedialFilled(true);
      return; // Wait for second tap
    }

    await doCall(target);
  };

  const doCall = async (target: string) => {
    if (sip.registrationState !== 'registered') {
      Alert.alert(
        'Not Registered',
        'The softphone is not registered. Please check your connection in Settings.',
      );
      return;
    }

    // Cross-platform mic preflight. On Android this still calls
    // PermissionsAndroid.request(RECORD_AUDIO) exactly like before. On iOS it
    // proactively triggers the native mic prompt via react-native-webrtc's
    // getUserMedia() (already a dependency for SIP) so the user grants access
    // BEFORE jssip's audio session fails silently. Returns false + shows an
    // Alert on denial; short-circuits the call attempt in that case.
    const micOk = await ensureMicPermissionOrAlert();
    if (!micOk) return;

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setDialing(true);
    try {
      await sip.dial(target);
    } catch (e: any) {
      Alert.alert('Call Failed', e?.message || 'Could not start the call. Check your connection.');
    } finally {
      setDialing(false);
    }
  };

  const handleHangup = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    await sip.hangup();
  };

  // Format display number nicely
  const formatDisplay = (n: string): string => {
    if (!n) return '';
    // Extension (1–5 digits) — show raw
    if (n.length <= 5 && /^\d+$/.test(n)) return n;
    const digits = n.replace(/\D/g, '');
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
    if (digits.length <= 10)
      return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    return n;
  };

  // Live suggestions — contacts and recents matched against the typed number.
  const suggestions = useMemo<Suggestion[]>(() => {
    const q = number.trim();
    if (q.length < 1 || callActive) return [];
    const qDigits = q.replace(/\D/g, '');
    const qLower = q.toLowerCase();
    if (!qDigits && qLower.length < 1) return [];
    const out: Suggestion[] = [];
    const seen = new Set<string>();

    for (const c of contacts) {
      if (out.length >= 4) break;
      // Extension match — wins on exact prefix
      if (c.extension && qDigits && c.extension.startsWith(qDigits)) {
        const key = `ext:${c.extension}`;
        if (!seen.has(key)) {
          out.push({ id: `c:${c.id}:ext`, kind: 'contact', label: c.displayName, sub: `Ext ${c.extension}`, value: c.extension });
          seen.add(key);
        }
        continue;
      }
      // Phone number match
      let phoneHit: string | null = null;
      for (const p of c.phones || []) {
        const digits = (p.numberRaw || '').replace(/\D/g, '');
        if (qDigits && digits.includes(qDigits)) { phoneHit = p.numberRaw; break; }
      }
      if (phoneHit) {
        const key = `c:${c.id}:${phoneHit}`;
        if (!seen.has(key)) {
          out.push({ id: key, kind: 'contact', label: c.displayName, sub: phoneHit, value: phoneHit });
          seen.add(key);
        }
        continue;
      }
      // Name match (when user typed letters via T9, rare — at least support plain text search)
      if (qLower.length >= 2 && c.displayName.toLowerCase().includes(qLower)) {
        const primaryPhone = c.primaryPhone?.numberRaw || c.phones?.[0]?.numberRaw || c.extension || '';
        if (primaryPhone) {
          const key = `cname:${c.id}`;
          if (!seen.has(key)) {
            out.push({ id: key, kind: 'contact', label: c.displayName, sub: primaryPhone, value: primaryPhone });
            seen.add(key);
          }
        }
      }
    }

    for (const r of recent) {
      if (out.length >= 6) break;
      const dir = r.direction?.toLowerCase();
      const isInbound = dir === 'inbound' || dir === 'incoming';
      const num = isInbound ? r.fromNumber : r.toNumber;
      if (!num) continue;
      const digits = num.replace(/\D/g, '');
      if (!qDigits || !digits.includes(qDigits)) continue;
      const key = `r:${num}`;
      if (seen.has(key)) continue;
      const name = r.fromName && r.fromName.trim() && r.fromName !== num ? r.fromName : num;
      out.push({ id: `${r.id}:${num}`, kind: 'recent', label: name, sub: num, value: num });
      seen.add(key);
    }

    return out.slice(0, SHORT_SCREEN ? 2 : 3);
  }, [number, contacts, recent, callActive]);

  const handleSuggestion = (s: Suggestion) => {
    Haptics.selectionAsync().catch(() => {});
    setNumber(s.value);
    setRedialFilled(false);
  };

  const displayValue = formatDisplay(number);
  const subHint = redialFilled ? 'Tap call to dial' : null;

  const callButtonDisabled = callActive ? false : dialing;

  const callButtonColor = callActive
    ? colors.callRed
    : registered
    ? colors.callGreen
    : colors.textTertiary;

  const statusLabel = callActive
    ? sip.callState === 'connected'
      ? 'On Call'
      : sip.callState === 'dialing'
      ? 'Calling…'
      : sip.callState === 'ringing'
      ? 'Incoming…'
      : 'Ending…'
    : registered
    ? 'Ready'
    : 'Not registered';
  const userLabel = voice?.displayName?.trim() || 'Connect User';

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* ── Top bar ── */}
      <View style={[styles.topBar, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity
          style={[
            styles.readyTag,
            {
              backgroundColor: registered ? (isDnd ? colors.warningMuted : colors.successMuted) : colors.dangerMuted,
              borderColor: registered ? (isDnd ? colors.warning + '50' : colors.callGreen + '40') : colors.danger + '40',
            },
          ]}
          activeOpacity={registered ? 0.72 : 1}
          onPress={registered ? confirmDnd : undefined}
        >
          <Text
            style={[
              styles.readyTagText,
              { color: registered ? (isDnd ? colors.warning : colors.callGreen) : colors.danger },
            ]}
            numberOfLines={1}
          >
            {userLabel}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Live suggestions (contacts + recents) ── */}
      {suggestions.length > 0 && (
        <View style={styles.suggestionsWrap}>
          {suggestions.map((s) => (
            <SuggestionRow key={s.id} suggestion={s} onPress={handleSuggestion} />
          ))}
        </View>
      )}

      {/* Flex spacer — absorbs free vertical space above the keypad. */}
      <View style={styles.spacer} />

      {/* ── Display Area: sits directly above the keypad ── */}
      <View style={styles.displayArea}>
        <View style={styles.numberRow}>
          <Text
            style={[
              styles.displayText,
              {
                color: colors.text,
                fontSize:
                  displayValue.length > 14
                    ? 26
                    : displayValue.length > 10
                    ? 31
                    : displayValue.length > 6
                    ? 36
                    : 42,
              },
            ]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {displayValue || ' '}
          </Text>

        </View>

        {subHint && (
          <Text style={[styles.hintText, { color: colors.textTertiary }]} numberOfLines={1}>
            {subHint}
          </Text>
        )}

        {callActive && (
          <Text style={[styles.callStateText, { color: callButtonColor }]} numberOfLines={1}>
            {statusLabel}
          </Text>
        )}
      </View>

      {/* ── Keypad Grid ── */}
      <View style={[styles.keypad, { paddingHorizontal: PAD_H_PADDING }]}>
        <View style={styles.keyGrid}>
          {KEYS.map(({ digit, sub }) => (
            <DialKey
              key={digit}
              digit={digit}
              sub={sub}
              onPress={handleKey}
              onLongPress={handleLongPress}
              disabled={dialing}
            />
          ))}
        </View>

        {/* ── Call Button ── */}
        <View style={[styles.callRow, { paddingBottom: insets.bottom + 14 }]}>
          {number.length > 0 && (
            <TouchableOpacity
              onPress={handleBackspace}
              onLongPress={handleLongBackspace}
              delayLongPress={500}
              activeOpacity={0.75}
              style={[
                styles.deleteBtn,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.surfaceElevated,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Delete digit"
            >
              <Ionicons name="backspace-outline" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[
              styles.callBtn,
              {
                backgroundColor: callButtonColor,
                shadowColor: callButtonColor,
              },
            ]}
            onPress={callActive ? handleHangup : handleDial}
            activeOpacity={0.9}
            disabled={callButtonDisabled}
            accessibilityRole="button"
            accessibilityLabel={callActive ? 'End call' : 'Call'}
          >
            <Ionicons
              name="call"
              size={30}
              color="#fff"
              style={callActive ? { transform: [{ rotate: '135deg' }] } : undefined}
            />
          </TouchableOpacity>
        </View>
      </View>
      <AppConfirmDialog
        visible={dndConfirmOpen}
        title="Enable Do Not Disturb?"
        message="Would you like to put your phone into DND?"
        cancelLabel="Cancel"
        confirmLabel="Yes"
        onClose={() => setDndConfirmOpen(false)}
        onConfirm={() => {
          setMyStatus('dnd');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // ── Top bar ─────────────────────────────────────────
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: spacing['5'],
    paddingBottom: 4,
  },
  readyTag: {
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  readyTagText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.2,
    includeFontPadding: false,
  },

  // ── Display ──────────────────────────────────────────
  displayArea: {
    alignItems: 'center',
    paddingHorizontal: PAD_H_PADDING,
    paddingTop: 4,
    paddingBottom: 8,
  },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
    width: '100%',
    gap: 8,
  },
  displayText: {
    fontWeight: '300',
    letterSpacing: 1.5,
    textAlign: 'center',
    flex: 1,
  },
  hintText: {
    fontSize: 12,
    marginTop: 2,
    letterSpacing: 0.2,
  },
  callStateText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.3,
    marginTop: 6,
  },

  // ── Suggestions ─────────────────────────────────────
  suggestionsWrap: {
    paddingHorizontal: PAD_H_PADDING,
    paddingTop: 12,
    paddingBottom: 2,
    gap: 6,
    minHeight: SHORT_SCREEN ? 84 : 118,
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  suggestionIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestionLabel: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.15,
  },
  suggestionSub: {
    fontSize: 12,
    fontWeight: '500',
    opacity: 0.85,
    marginTop: 1,
  },
  suggestionArrow: {
    transform: [{ rotate: '45deg' }],
    opacity: 0.7,
  },

  // Flex spacer — absorbs all free vertical space and pushes the keypad block
  // down toward the bottom navigation bar for ergonomic thumb reach.
  spacer: {
    flex: 1,
    minHeight: 10,
  },

  // ── Keys ─────────────────────────────────────────────
  keypad: {
    // No flex — height determined by content; spacer above handles positioning
  },
  keyGrid: {
    width: KEY_CELL_WIDTH * 3 + KEY_GAP * 2,
    alignSelf: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    rowGap: KEY_GAP,
    columnGap: KEY_GAP,
    marginBottom: 10,
  },
  key: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyDigit: {
    fontSize: 34,
    fontWeight: '500',
    letterSpacing: 0.3,
    lineHeight: 37,
  },
  keySub: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2.0,
    marginTop: 1,
    opacity: 0.8,
  },

  // ── Call Button ─────────────────────────────────────
  callRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  deleteBtn: {
    position: 'absolute',
    right: (KEY_CELL_WIDTH - 52) / 2,
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 14,
    elevation: 10,
  },
});

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
  PermissionsAndroid,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useSip } from '../../context/SipContext';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { Avatar } from '../../components/ui/Avatar';
import { getContacts } from '../../api/client';
import { loadLocalCallHistory } from '../../storage/callHistory';
import type { Contact, CallRecord } from '../../types';
import { spacing } from '../../theme/spacing';
import { playDtmfTone } from '../../audio/telephonyAudio';

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
const PAD_H_PADDING = 28;
const KEY_GAP = 12;
const RAW_KEY_SIZE = Math.floor((width - PAD_H_PADDING * 2 - KEY_GAP * 2) / 3);
const KEY_SIZE = Math.max(66, Math.min(82, Math.floor(RAW_KEY_SIZE * 0.9)));
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
  const { colors, isDark } = useTheme();
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

  const keyBg = isDark
    ? 'rgba(255, 255, 255, 0.05)'
    : 'rgba(15, 23, 42, 0.035)';
  const keyBorder = isDark
    ? 'rgba(255, 255, 255, 0.07)'
    : 'rgba(15, 23, 42, 0.06)';

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
            width: KEY_SIZE,
            height: KEY_SIZE,
            borderRadius: KEY_SIZE / 2,
            backgroundColor: keyBg,
            borderColor: keyBorder,
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

/** Soft pulsing ring behind the call button. Cheap: single scale + opacity loop. */
function CallGlow({ color, active }: { color: string; active: boolean }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    if (!active) {
      scale.setValue(1);
      opacity.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(scale, { toValue: 1.35, duration: 1500, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0, duration: 1500, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(scale, { toValue: 1, duration: 0, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.35, duration: 0, useNativeDriver: true }),
        ]),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, opacity, scale]);

  if (!active) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFillObject,
        {
          borderRadius: 999,
          backgroundColor: color,
          transform: [{ scale }],
          opacity,
        },
      ]}
    />
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
  const insets = useSafeAreaInsets();
  const [number, setNumber] = useState('');
  const [dialing, setDialing] = useState(false);
  // Two-tap redial: first tap fills the last-dialed number, second tap calls it
  const [redialFilled, setRedialFilled] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [recent, setRecent] = useState<CallRecord[]>([]);
  const prevCallStateRef = useRef(sip.callState);
  const callScale = useRef(new Animated.Value(1)).current;

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

    if (Platform.OS === 'android') {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Microphone Permission',
            message: 'Connect needs microphone access to make calls.',
            buttonPositive: 'Allow',
          },
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          Alert.alert(
            'Microphone Required',
            'Microphone access is needed to make calls. Please enable it in Android Settings.',
          );
          return;
        }
      } catch (e) {
        console.warn('[Keypad] Mic permission error:', e);
      }
    }

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

  const callPressIn = useCallback(() => {
    Animated.spring(callScale, { toValue: 0.93, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  }, [callScale]);
  const callPressOut = useCallback(() => {
    Animated.spring(callScale, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 8 }).start();
  }, [callScale]);

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
    if (q.length < 2 || callActive) return [];
    const qDigits = q.replace(/\D/g, '');
    const qLower = q.toLowerCase();
    if (!qDigits && qLower.length < 2) return [];
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
  const registered = sip.registrationState === 'registered';

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

  const gradientTop = colors.bg;
  const gradientBottom = isDark ? colors.bgSecondary : colors.bgSecondary;

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Layered background: vertical gradient + bottom-center glow for depth. */}
      <LinearGradient
        pointerEvents="none"
        colors={[gradientTop, gradientBottom]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        pointerEvents="none"
        colors={[colors.transparent, callButtonColor + (isDark ? '1f' : '14')]}
        start={{ x: 0.5, y: 0.4 }}
        end={{ x: 0.5, y: 1 }}
        style={[StyleSheet.absoluteFill, { opacity: callActive ? 0.9 : 0.65 }]}
      />

      {/* ── Top bar ── */}
      <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
        <View style={styles.topBarSide} />
        <View style={styles.topBarActions}>
          <TouchableOpacity
            activeOpacity={0.78}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={[styles.topBarIcon, { backgroundColor: colors.surfaceElevated + 'aa', borderColor: colors.border }]}
          >
            <Ionicons name="search-outline" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.78}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={[styles.topBarIcon, { backgroundColor: colors.surfaceElevated + 'aa', borderColor: colors.border }]}
          >
            <Ionicons name="ellipsis-vertical" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Display Area ── */}
      <View style={styles.displayArea}>
        <View style={styles.numberRow}>
          <Text
            style={[
              styles.displayText,
              {
                color: colors.text,
                fontSize:
                  displayValue.length > 14
                    ? 28
                    : displayValue.length > 10
                    ? 34
                    : displayValue.length > 6
                    ? 40
                    : 46,
              },
            ]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {displayValue || ' '}
          </Text>

          {/* Backspace inline with display — only shown when something is typed. */}
          {number.length > 0 && (
            <Pressable
              onPress={handleBackspace}
              onLongPress={handleLongBackspace}
              delayLongPress={500}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={styles.backspaceBtn}
            >
              <Ionicons name="backspace-outline" size={26} color={colors.textSecondary} />
            </Pressable>
          )}
        </View>

        {subHint && (
          <Text style={[styles.hintText, { color: colors.textTertiary }]} numberOfLines={1}>
            {subHint}
          </Text>
        )}

        {!suggestions.length && (
          <View
            style={[
              styles.statusPill,
              {
                backgroundColor: registered
                  ? isDark
                    ? 'rgba(34,197,94,0.14)'
                    : 'rgba(22,163,74,0.09)'
                  : isDark
                  ? 'rgba(244,63,94,0.14)'
                  : 'rgba(225,29,72,0.09)',
                borderColor: registered ? colors.callGreen + '40' : colors.danger + '40',
              },
            ]}
          >
            <View style={[styles.statusDot, { backgroundColor: registered ? colors.callGreen : colors.danger }]} />
            <Text style={[styles.statusText, { color: registered ? colors.callGreen : colors.danger }]} numberOfLines={1}>
              {statusLabel}
            </Text>
            {sip.lastError && !callActive && (
              <Text style={[styles.statusText, { color: colors.danger, marginLeft: 6 }]} numberOfLines={1}>
                · {sip.lastError}
              </Text>
            )}
          </View>
        )}
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
          <View style={styles.callBtnWrap}>
            <CallGlow color={callButtonColor} active={registered && !callActive} />
            <Animated.View style={{ transform: [{ scale: callScale }] }}>
              <TouchableOpacity
                style={[
                  styles.callBtn,
                  {
                    backgroundColor: callButtonColor,
                    shadowColor: callButtonColor,
                  },
                ]}
                onPress={callActive ? handleHangup : handleDial}
                onPressIn={callPressIn}
                onPressOut={callPressOut}
                activeOpacity={0.9}
                disabled={callButtonDisabled}
                accessibilityRole="button"
                accessibilityLabel={callActive ? 'End call' : 'Call'}
              >
                <Ionicons
                  name="call"
                  size={32}
                  color="#fff"
                  style={callActive ? { transform: [{ rotate: '135deg' }] } : undefined}
                />
              </TouchableOpacity>
            </Animated.View>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // ── Top bar ─────────────────────────────────────────
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing['5'],
    paddingBottom: 2,
  },
  topBarSide: { width: 40, height: 40 },
  topBarActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  topBarIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Display ──────────────────────────────────────────
  displayArea: {
    alignItems: 'center',
    paddingHorizontal: PAD_H_PADDING,
    paddingTop: 4,
    paddingBottom: 6,
  },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    width: '100%',
    gap: 8,
  },
  displayText: {
    fontWeight: '300',
    letterSpacing: 1.5,
    textAlign: 'center',
    flex: 1,
  },
  backspaceBtn: {
    padding: 4,
  },
  hintText: {
    fontSize: 12,
    marginTop: 2,
    letterSpacing: 0.2,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 8,
    gap: 6,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },

  // ── Suggestions ─────────────────────────────────────
  suggestionsWrap: {
    paddingHorizontal: PAD_H_PADDING,
    paddingTop: 6,
    paddingBottom: 2,
    gap: 6,
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
    minHeight: 6,
  },

  // ── Keys ─────────────────────────────────────────────
  keypad: {
    // No flex — height determined by content; spacer above handles positioning
  },
  keyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: KEY_GAP,
    columnGap: KEY_GAP,
    marginBottom: 14,
  },
  key: {
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyDigit: {
    fontSize: 30,
    fontWeight: '500',
    letterSpacing: 0.3,
    lineHeight: 34,
  },
  keySub: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 2.0,
    marginTop: 1,
    opacity: 0.8,
  },

  // ── Call Button ─────────────────────────────────────
  callRow: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBtnWrap: {
    width: 78,
    height: 78,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 18,
    elevation: 10,
  },
});

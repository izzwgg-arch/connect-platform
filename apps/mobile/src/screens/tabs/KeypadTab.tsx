import React, { useRef, useState, useCallback, useEffect } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSip } from '../../context/SipContext';
import { useTheme } from '../../context/ThemeContext';
import { typography } from '../../theme/typography';
import { spacing } from '../../theme/spacing';
import { playDtmfTone } from '../../audio/telephonyAudio';

const { width } = Dimensions.get('window');

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

// Key size: 3 keys per row with comfortable gutters.
// Scaled to ~88% of the maximum possible size for better one-handed ergonomics.
const PAD_H_PADDING = spacing['6'] as number ?? 24;
const KEY_GAP = 12;
const KEY_SIZE = Math.floor((width - PAD_H_PADDING * 2 - KEY_GAP * 2) / 3 * 0.88);

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
        toValue: 0.90,
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
        speed: 20,
        bounciness: 6,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 100,
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
    ? 'rgba(255, 255, 255, 0.07)'
    : 'rgba(0, 0, 0, 0.04)';
  const keyBorder = isDark
    ? 'rgba(255, 255, 255, 0.09)'
    : 'rgba(0, 0, 0, 0.07)';

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
            height: KEY_SIZE * 0.74,
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

export function KeypadTab() {
  const { colors, isDark } = useTheme();
  const sip = useSip();
  const insets = useSafeAreaInsets();
  const [number, setNumber] = useState('');
  const [dialing, setDialing] = useState(false);
  // Two-tap redial: first tap fills the last-dialed number, second tap calls it
  const [redialFilled, setRedialFilled] = useState(false);
  const prevCallStateRef = useRef(sip.callState);

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

  // Format display number nicely
  const formatDisplay = (n: string): string => {
    if (!n) return '';
    // Extension (1–5 digits) — show raw
    if (n.length <= 5 && /^\d+$/.test(n)) return n;
    const digits = n.replace(/\D/g, '');
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    if (digits.length <= 10)
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    return n;
  };

  const displayValue = formatDisplay(number);
  const registered = sip.registrationState === 'registered';

  // When redialFilled, show a subtle "tap to call" cue under the number
  const subHint = redialFilled ? 'Tap call to dial' : null;

  const callButtonDisabled = callActive
    ? false
    : dialing;

  const callButtonColor = callActive
    ? colors.callRed
    : registered
    ? colors.callGreen
    : colors.textTertiary;

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>

      {/* ── Display Area ── */}
      <View style={[styles.displayArea, { paddingTop: insets.top + 8 }]}>

        {/* Number input */}
        <View style={styles.numberRow}>
          <Text
            style={[
              styles.displayText,
              {
                color: colors.text,
                fontSize:
                  displayValue.length > 14
                    ? 24
                    : displayValue.length > 10
                    ? 30
                    : displayValue.length > 6
                    ? 36
                    : 44,
              },
            ]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {displayValue || ' '}
          </Text>

          {/* Backspace button — inline with display */}
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

        {/* Redial cue — only shown after first tap auto-filled the number */}
        {subHint && (
          <Text style={[styles.hintText, { color: colors.textTertiary }]} numberOfLines={1}>
            {subHint}
          </Text>
        )}

        {/* SIP registration status pill */}
        <View style={[
          styles.statusPill,
          {
            backgroundColor: registered
              ? (isDark ? 'rgba(46,125,50,0.22)' : 'rgba(46,125,50,0.10)')
              : (isDark ? 'rgba(183,28,28,0.22)' : 'rgba(183,28,28,0.10)'),
          },
        ]}>
          <View style={[styles.statusDot, { backgroundColor: registered ? colors.callGreen : colors.danger }]} />
          <Text style={[styles.statusText, { color: registered ? colors.callGreen : colors.danger }]}>
            {callActive
              ? sip.callState === 'connected'
                ? 'On Call'
                : sip.callState === 'dialing'
                ? 'Calling…'
                : sip.callState === 'ringing'
                ? 'Incoming…'
                : 'Ending…'
              : registered
              ? 'Ready'
              : 'Not registered'}
          </Text>
          {sip.lastError && !callActive && (
            <Text style={[styles.statusText, { color: colors.danger, marginLeft: 6 }]} numberOfLines={1}>
              · {sip.lastError}
            </Text>
          )}
        </View>
      </View>

      {/* Flex spacer — pushes the entire keypad block down toward the bottom nav */}
      <View style={styles.spacer} />

      {/* ── Keypad Grid ── */}
      <View style={[styles.keypad, { paddingHorizontal: PAD_H_PADDING, paddingBottom: insets.bottom + 16 }]}>
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

        {/* ── Action Row ── */}
        <View style={styles.actionRow}>

          {/* Left spacer / clear all */}
          <View style={styles.actionSide}>
            {number.length > 1 && (
              <TouchableOpacity
                onPress={() => setNumber('')}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                style={[styles.ghostBtn, { borderColor: colors.border }]}
              >
                <Ionicons name="close" size={20} color={colors.textTertiary} />
              </TouchableOpacity>
            )}
          </View>

          {/* Call / Hangup button */}
          <TouchableOpacity
            style={[
              styles.callBtn,
              {
                backgroundColor: callButtonColor,
                shadowColor: callButtonColor,
              },
            ]}
            onPress={callActive ? handleHangup : handleDial}
            activeOpacity={0.82}
            disabled={callButtonDisabled}
          >
            <Ionicons
              name={callActive ? 'call' : 'call'}
              size={30}
              color="#fff"
              style={callActive ? { transform: [{ rotate: '135deg' }] } : undefined}
            />
          </TouchableOpacity>

          {/* Right spacer (balanced) */}
          <View style={styles.actionSide} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // ── Display ──────────────────────────────────────────
  displayArea: {
    alignItems: 'center',
    paddingHorizontal: PAD_H_PADDING,
    paddingBottom: 10,
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
    borderRadius: 20,
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
    fontWeight: '600',
    letterSpacing: 0.3,
  },

  // Flexible spacer — absorbs all free vertical space and pushes the keypad
  // block down toward the bottom navigation bar for ergonomic thumb reach.
  spacer: {
    flex: 1,
    minHeight: 8,
  },

  // ── Keys ─────────────────────────────────────────────
  keypad: {
    // No flex — size is determined by content; spacer above handles positioning
  },
  keyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: KEY_GAP,
    columnGap: KEY_GAP,
    marginBottom: 18,
  },
  key: {
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyDigit: {
    fontSize: 23,
    fontWeight: '400',
    letterSpacing: 0.5,
    lineHeight: 27,
  },
  keySub: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1.8,
    marginTop: 1,
  },

  // ── Action Row ───────────────────────────────────────
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  actionSide: {
    width: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBtn: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 9,
  },
});

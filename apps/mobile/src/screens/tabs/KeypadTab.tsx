import React, { useRef, useState } from 'react';
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
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSip } from '../../context/SipContext';
import { useTheme } from '../../context/ThemeContext';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/spacing';

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

function DialKey({ digit, sub, onPress, onLongPress }: {
  digit: string;
  sub: string;
  onPress: (d: string) => void;
  onLongPress?: (d: string) => void;
}) {
  const { colors, isDark } = useTheme();
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.88, duration: 70, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 8 }),
    ]).start();
    onPress(digit);
  };

  const handleLongPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onLongPress?.(digit);
  };

  const KEY_SIZE = Math.floor((width - spacing['8'] * 2 - spacing['5'] * 2) / 3);

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        onPress={handlePress}
        onLongPress={handleLongPress}
        activeOpacity={0.75}
        style={[
          styles.key,
          {
            width: KEY_SIZE,
            height: KEY_SIZE * 0.78,
            backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : colors.surfaceElevated,
            borderColor: isDark ? 'rgba(255,255,255,0.06)' : colors.border,
          },
        ]}
      >
        <Text style={[typography.dialpadKey as any, { color: colors.text }]}>{digit}</Text>
        {sub ? (
          <Text style={[typography.dialpadSub as any, { color: colors.textTertiary, marginTop: 1 }]}>
            {sub}
          </Text>
        ) : null}
      </TouchableOpacity>
    </Animated.View>
  );
}

export function KeypadTab() {
  const { colors, isDark } = useTheme();
  const sip = useSip();
  const insets = useSafeAreaInsets();
  const [number, setNumber] = useState('');
  const [dialing, setDialing] = useState(false);

  const callActive =
    sip.callState === 'connected' ||
    sip.callState === 'dialing' ||
    sip.callState === 'ringing' ||
    sip.callState === 'ended';

  const handleKey = (digit: string) => {
    if (callActive) {
      sip.sendDtmf(digit);
    } else {
      setNumber((prev) => prev + digit);
    }
  };

  const handleLongPress = (digit: string) => {
    if (digit === '0') setNumber((prev) => prev + '+');
    if (digit === '1') {
      // Voicemail shortcut
    }
  };

  const handleBackspace = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setNumber((prev) => prev.slice(0, -1));
  };

  const handleDial = async () => {
    const target = number.trim();
    if (!target) return;
    if (sip.registrationState !== 'registered') {
      Alert.alert('Not Registered', 'The softphone is not registered. Please check your connection in Settings.');
      return;
    }

    // Request microphone permission before dialing (Android)
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
    await sip.hangup();
  };

  // Format display number nicely
  const formatDisplay = (n: string): string => {
    const digits = n.replace(/\D/g, '');
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    if (digits.length <= 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    return n; // For non-NANP or ext numbers, show as-is
  };

  const isExtension = number.length > 0 && number.length <= 5 && /^\d+$/.test(number);
  const displayValue = isExtension ? number : formatDisplay(number);

  const registered = sip.registrationState === 'registered';
  const KEY_SIZE = Math.floor((width - spacing['8'] * 2 - spacing['5'] * 2) / 3);

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Display area */}
      <View style={[styles.displayArea, { paddingTop: insets.top + 20 }]}>
        <Text
          style={[
            styles.displayText,
            {
              color: colors.text,
              fontSize: displayValue.length > 12 ? 28 : displayValue.length > 8 ? 34 : 40,
            },
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {displayValue || ' '}
        </Text>

        {/* Status indicator */}
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: registered ? colors.success : colors.danger }]} />
          <Text style={[typography.caption, { color: colors.textSecondary }]}>
            {registered ? 'Ready' : 'Not registered'}
          </Text>
          {sip.lastError && !callActive && (
            <Text style={[typography.caption, { color: colors.danger, marginLeft: 8 }]} numberOfLines={1}>
              • {sip.lastError}
            </Text>
          )}
          {callActive && (
            <Text style={[typography.caption, { color: colors.warning, marginLeft: 8 }]}>
              •{' '}
              {sip.callState === 'connected'
                ? 'On Call'
                : sip.callState === 'dialing'
                ? 'Calling…'
                : sip.callState === 'ringing'
                ? 'Ringing…'
                : 'Ending…'}
            </Text>
          )}
        </View>
      </View>

      {/* Keypad */}
      <View style={[styles.keypad, { paddingHorizontal: spacing['8'] }]}>
        {/* Keys in rows of 3 */}
        <View style={styles.keyGrid}>
          {KEYS.map(({ digit, sub }) => (
            <View key={digit} style={styles.keyWrapper}>
              <DialKey digit={digit} sub={sub} onPress={handleKey} onLongPress={handleLongPress} />
            </View>
          ))}
        </View>

        {/* Bottom row: clear, call, backspace */}
        <View style={[styles.bottomRow, { paddingHorizontal: 0 }]}>
          {/* Clear */}
          {number.length > 0 ? (
            <TouchableOpacity
              style={[styles.clearBtn, { width: KEY_SIZE * 0.6, height: KEY_SIZE * 0.6 }]}
              onPress={() => setNumber('')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="close-circle-outline" size={28} color={colors.textTertiary} />
            </TouchableOpacity>
          ) : (
            <View style={{ width: KEY_SIZE * 0.6 }} />
          )}

          {/* Call / Hangup */}
          <TouchableOpacity
            style={[
              styles.callBtn,
              {
                backgroundColor: callActive ? colors.callRed : registered ? colors.callGreen : colors.textTertiary,
                shadowColor: callActive ? colors.callRed : colors.callGreen,
              },
            ]}
            onPress={callActive ? handleHangup : handleDial}
            activeOpacity={0.85}
            disabled={!callActive && !number.trim()}
          >
            <Ionicons
              name="call"
              size={28}
              color="#fff"
              style={callActive ? { transform: [{ rotate: '135deg' }] } : {}}
            />
          </TouchableOpacity>

          {/* Backspace */}
          {number.length > 0 ? (
            <TouchableOpacity
              style={[styles.clearBtn, { width: KEY_SIZE * 0.6, height: KEY_SIZE * 0.6 }]}
              onPress={handleBackspace}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="backspace-outline" size={24} color={colors.textTertiary} />
            </TouchableOpacity>
          ) : (
            <View style={{ width: KEY_SIZE * 0.6 }} />
          )}
        </View>
      </View>

      {/* Bottom safe padding */}
      <View style={{ height: insets.bottom + 90 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  displayArea: {
    alignItems: 'center',
    paddingHorizontal: spacing['8'],
    paddingBottom: spacing['6'],
  },
  displayText: {
    fontWeight: '300',
    letterSpacing: 2,
    textAlign: 'center',
    minHeight: 52,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  keypad: {
    flex: 1,
    justifyContent: 'center',
  },
  keyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: spacing['5'],
  },
  keyWrapper: {
    width: '33.33%',
    alignItems: 'center',
    marginBottom: spacing['3'],
  },
  key: {
    borderRadius: radius['2xl'],
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing['4'],
  },
  clearBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 100,
  },
  callBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
});

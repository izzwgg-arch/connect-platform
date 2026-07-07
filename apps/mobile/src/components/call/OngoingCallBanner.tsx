import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// Reuse the existing call-timer formatting so the banner clock matches the
// ActiveCallScreen timer exactly (mm:ss / h:mm:ss).
import { formatDuration } from '../../hooks/useCallTimer';

type Props = {
  /** Show the banner (an ongoing call exists AND the ActiveCall screen is not focused). */
  visible: boolean;
  /** Display name/number of the ongoing call. */
  name: string;
  /** Epoch ms when the call connected, or null while still connecting. */
  connectedAt: number | null;
  /** Re-open the ActiveCall screen. */
  onPress: () => void;
};

/**
 * A persistent, tappable "ongoing call" pill shown over the tabs when the user
 * has minimized (backed out of) a live call. Tapping it restores the
 * ActiveCall screen; the SIP session keeps running the whole time.
 */
export function OngoingCallBanner({ visible, name, connectedAt, onPress }: Props) {
  const insets = useSafeAreaInsets();
  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {
    if (!visible || !connectedAt) return undefined;
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [visible, connectedAt]);

  if (!visible) return null;

  const elapsedSec = connectedAt ? Math.max(0, Math.floor((nowTs - connectedAt) / 1000)) : 0;
  const timerText = connectedAt ? formatDuration(elapsedSec) : 'Connecting…';

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { top: insets.top + 6 }]}
    >
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onPress}
        style={styles.pill}
        accessibilityRole="button"
        accessibilityLabel={`Ongoing call with ${name}. Tap to return to the call.`}
      >
        <View style={styles.iconWrap}>
          <Ionicons name="call" size={14} color="#052e16" />
        </View>
        <Text style={styles.name} numberOfLines={1}>
          {name || 'Ongoing call'}
        </Text>
        <Text style={styles.timer}>{timerText}</Text>
        <Ionicons name="chevron-up" size={16} color="#052e16" style={styles.chevron} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 60,
    elevation: 20,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '92%',
    backgroundColor: '#22c55e',
    borderRadius: 999,
    paddingLeft: 8,
    paddingRight: 14,
    paddingVertical: 8,
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 12,
  },
  iconWrap: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    flexShrink: 1,
    color: '#052e16',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  timer: {
    color: '#052e16',
    fontSize: 13,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  chevron: {
    marginLeft: 2,
  },
});

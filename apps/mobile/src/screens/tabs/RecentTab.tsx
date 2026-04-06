import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useSip } from '../../context/SipContext';
import { Avatar } from '../../components/ui/Avatar';
import { EmptyState } from '../../components/ui/EmptyState';
import { HeaderBar } from '../../components/HeaderBar';
import { getCallHistory } from '../../api/client';
import type { CallRecord } from '../../types';
import { typography } from '../../theme/typography';
import { spacing } from '../../theme/spacing';

function formatDuration(sec: number): string {
  if (sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffH = diffMs / 3600000;
    if (diffH < 1) return `${Math.round(diffMs / 60000)}m ago`;
    if (diffH < 24) return `${Math.floor(diffH)}h ago`;
    if (diffH < 48) return 'Yesterday';
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

function CallRow({ call, onCall }: { call: CallRecord; onCall: (number: string) => void }) {
  const { colors } = useTheme();

  const isInbound = call.direction === 'inbound' || call.direction === 'INBOUND';
  const isMissed = call.durationSec === 0 && isInbound;
  const displayNumber = isInbound ? call.fromNumber : call.toNumber;
  const displayName = displayNumber; // Would resolve from contacts in production

  const iconName = isMissed
    ? 'call-outline'
    : isInbound
    ? 'call-outline'
    : 'call-outline';

  const iconColor = isMissed
    ? colors.danger
    : isInbound
    ? colors.success
    : colors.primary;

  const arrowIcon = isInbound ? 'arrow-down-outline' : 'arrow-up-outline';

  return (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: colors.borderSubtle }]}
      activeOpacity={0.7}
    >
      <Avatar name={displayName} size="md" />
      <View style={styles.rowInfo}>
        <View style={styles.nameRow}>
          <Ionicons name={arrowIcon as any} size={12} color={iconColor} style={{ marginRight: 4 }} />
          <Text style={[typography.labelLg, { color: isMissed ? colors.danger : colors.text }]} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={[typography.caption, { color: colors.textTertiary }]}>
            {formatTimestamp(call.startedAt)}
          </Text>
          {call.durationSec > 0 && (
            <Text style={[typography.caption, { color: colors.textTertiary, marginLeft: 8 }]}>
              • {formatDuration(call.durationSec)}
            </Text>
          )}
          {isMissed && (
            <Text style={[typography.caption, { color: colors.danger, marginLeft: 8 }]}>• Missed</Text>
          )}
        </View>
      </View>
      <TouchableOpacity
        style={[styles.callBtn, { backgroundColor: colors.primaryMuted, borderColor: colors.primary + '30' }]}
        onPress={() => onCall(displayNumber)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="call-outline" size={17} color={colors.primary} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

export function RecentTab() {
  const { colors } = useTheme();
  const { token } = useAuth();
  const sip = useSip();
  const insets = useSafeAreaInsets();

  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'missed'>('all');

  useFocusEffect(
    useCallback(() => {
      if (!token) return;
      setLoading(true);
      getCallHistory(token)
        .then((data) => setCalls(data))
        .catch(() => setCalls([]))
        .finally(() => setLoading(false));
    }, [token])
  );

  const handleCall = (number: string) => {
    if (sip.registrationState === 'registered') {
      sip.dial(number);
    }
  };

  const filtered = calls.filter((c) => {
    if (filter === 'missed') {
      const isInbound = c.direction === 'inbound' || c.direction === 'INBOUND';
      return isInbound && c.durationSec === 0;
    }
    return true;
  });

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <HeaderBar title="Recent Calls" />

      {/* Filter chips */}
      <View style={[styles.filterRow, { borderBottomColor: colors.border }]}>
        {(['all', 'missed'] as const).map((f) => (
          <TouchableOpacity
            key={f}
            style={[
              styles.filterChip,
              {
                backgroundColor: filter === f ? colors.primary : colors.surfaceElevated,
                borderColor: filter === f ? colors.primary : colors.border,
              },
            ]}
            onPress={() => setFilter(f)}
            activeOpacity={0.75}
          >
            {f === 'missed' && (
              <View style={[styles.filterDot, { backgroundColor: filter === f ? '#fff' : colors.danger }]} />
            )}
            <Text style={[typography.labelSm, { color: filter === f ? '#fff' : colors.textSecondary }]}>
              {f === 'all' ? 'All' : 'Missed'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.loadingArea}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[typography.body, { color: colors.textSecondary, marginTop: 12 }]}>
            Loading call history…
          </Text>
        </View>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="time-outline"
          title="No recent calls"
          subtitle={filter === 'missed' ? 'No missed calls found.' : 'Your call history will appear here.'}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <CallRow call={item} onCall={handleCall} />}
          contentContainerStyle={{ paddingBottom: insets.bottom + 90 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing['4'],
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    gap: 5,
  },
  filterDot: { width: 6, height: 6, borderRadius: 3 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['4'],
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowInfo: { flex: 1, marginLeft: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  callBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  loadingArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

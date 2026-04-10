import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
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
import { loadLocalCallHistory, mergeCallRecords } from '../../storage/callHistory';
import type { CallRecord } from '../../types';
import { typography } from '../../theme/typography';
import { spacing } from '../../theme/spacing';

function isInboundCall(call: CallRecord): boolean {
  const d = call.direction?.toLowerCase();
  return d === 'inbound' || d === 'incoming';
}

function isMissedCall(call: CallRecord): boolean {
  if (call.disposition === 'missed') return true;
  if (call.disposition === 'busy') return true;
  // Fallback: inbound with zero talk time
  return isInboundCall(call) && call.durationSec === 0 && !call.disposition;
}

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
    if (diffH < 1) {
      const mins = Math.round(diffMs / 60000);
      return mins <= 0 ? 'Just now' : `${mins}m ago`;
    }
    if (diffH < 24) return `${Math.floor(diffH)}h ago`;
    if (diffH < 48) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function CallRow({ call, onCall }: { call: CallRecord; onCall: (number: string) => void }) {
  const { colors } = useTheme();

  const inbound = isInboundCall(call);
  const missed = isMissedCall(call);
  const displayNumber = inbound ? call.fromNumber : call.toNumber;
  const displayName = call.fromName && call.fromName !== call.fromNumber
    ? call.fromName
    : displayNumber || '—';

  const arrowIcon: any = inbound ? 'arrow-down-outline' : 'arrow-up-outline';
  const rowColor = missed ? colors.danger : inbound ? colors.success : colors.primary;

  return (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: colors.borderSubtle }]}
      activeOpacity={0.7}
      onPress={() => onCall(displayNumber)}
    >
      <View style={[styles.iconBubble, { backgroundColor: rowColor + '18' }]}>
        <Ionicons name={arrowIcon} size={16} color={rowColor} />
      </View>

      <View style={styles.rowInfo}>
        <Text
          style={[typography.labelLg, { color: missed ? colors.danger : colors.text }]}
          numberOfLines={1}
        >
          {displayName}
        </Text>
        <View style={styles.metaRow}>
          <Text style={[typography.caption, { color: colors.textTertiary }]}>
            {formatTimestamp(call.startedAt)}
          </Text>
          {call.durationSec > 0 && (
            <Text style={[typography.caption, { color: colors.textTertiary, marginLeft: 6 }]}>
              · {formatDuration(call.durationSec)}
            </Text>
          )}
          {missed && (
            <Text style={[typography.caption, { color: colors.danger, marginLeft: 6 }]}>
              · Missed
            </Text>
          )}
          {call.disposition === 'busy' && !missed && (
            <Text style={[typography.caption, { color: colors.warning, marginLeft: 6 }]}>
              · Busy
            </Text>
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
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'all' | 'missed'>('all');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      // 1. Show local history immediately (no network needed)
      const local = await loadLocalCallHistory();
      if (local.length > 0) {
        setCalls(local);
        // Only show loading spinner if we have nothing local to show yet
        setLoading(false);
      }

      // 2. Fetch from server and merge
      if (token) {
        try {
          const remote = await getCallHistory(token);
          if (remote.length > 0) {
            const merged = mergeCallRecords(remote, local);
            setCalls(merged);
          } else if (local.length === 0) {
            // Both empty — no error, just empty state
            setCalls([]);
          }
        } catch {
          // API failed — local history is still shown, no error shown
          if (local.length === 0) {
            setError('Could not load call history from server.');
          }
        }
      }

      setLoading(false);
      setRefreshing(false);
    },
    [token],
  );

  // Reload every time this tab gains focus (catches calls that just ended)
  useFocusEffect(
    useCallback(() => {
      load(false);
    }, [load]),
  );

  // Also reload 3 seconds after a call ends (gives the append a moment to settle)
  const { callState } = useSip();
  const prevCallRef = useRef(callState);
  useEffect(() => {
    const prev = prevCallRef.current;
    prevCallRef.current = callState;
    if (callState === 'idle' && (prev === 'ended' || prev === 'connected')) {
      const t = setTimeout(() => load(false), 3000);
      return () => clearTimeout(t);
    }
  }, [callState, load]);

  const handleCall = (number: string) => {
    if (!number) return;
    if (sip.registrationState === 'registered') {
      sip.dial(number);
    }
  };

  const filtered = calls.filter((c) => {
    if (filter === 'missed') return isMissedCall(c);
    return true;
  });

  const missedCount = calls.filter(isMissedCall).length;

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
            <Text style={[typography.labelSm, { color: filter === f ? '#fff' : colors.textSecondary }]}>
              {f === 'all' ? 'All' : 'Missed'}
            </Text>
            {f === 'missed' && missedCount > 0 && (
              <View style={[styles.badge, { backgroundColor: filter === f ? 'rgba(255,255,255,0.3)' : colors.danger }]}>
                <Text style={styles.badgeText}>{missedCount > 99 ? '99+' : missedCount}</Text>
              </View>
            )}
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
      ) : error ? (
        <EmptyState
          icon="alert-circle-outline"
          title="Could not load calls"
          subtitle={error}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="time-outline"
          title={filter === 'missed' ? 'No missed calls' : 'No recent calls'}
          subtitle={
            filter === 'missed'
              ? 'All your calls were answered.'
              : 'Your call history will appear here after your first call.'
          }
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <CallRow call={item} onCall={handleCall} />}
          contentContainerStyle={{ paddingBottom: insets.bottom + 90 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load(true)}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
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
    gap: 6,
  },
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#fff',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['4'],
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBubble: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  rowInfo: { flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  callBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginLeft: 8,
  },
  loadingArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  PanResponder,
  TextInput,
  Modal,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useSip } from '../../context/SipContext';
import { Avatar } from '../../components/ui/Avatar';
import { EmptyState } from '../../components/ui/EmptyState';
import { HorizontalFilterScroll } from '../../components/ui/HorizontalFilterScroll';
import { getCallHistory } from '../../api/client';
import { loadLocalCallHistory, mergeCallRecords } from '../../storage/callHistory';
import type { CallRecord } from '../../types';
import { typography } from '../../theme/typography';
import { teamFilterChipColors } from '../../theme/filterChipColors';
import { radius, spacing } from '../../theme/spacing';

type CallFilter = 'all' | 'missed' | 'incoming' | 'outgoing';
type CallKind = 'missed' | 'incoming' | 'outgoing' | 'internal' | 'voicemail';

type CallGroup = {
  type: 'group';
  id: string;
  calls: CallRecord[];
  canonicalNumber: string;
  displayName: string;
  kind: CallKind;
  latestAt: string;
  earliestAt: string;
  count: number;
  totalDurationSec: number;
  maxDurationSec: number;
  unknown: boolean;
};

type TimelineItem =
  | { type: 'section'; id: string; title: string }
  | CallGroup;

function isInboundCall(call: CallRecord): boolean {
  const d = call.direction?.toLowerCase();
  return d === 'inbound' || d === 'incoming';
}

function isInternalDirection(call: CallRecord): boolean {
  const d = call.direction?.toLowerCase();
  if (d === 'internal') return true;
  const fromIsExt = /^\d{2,5}$/.test((call.fromNumber || '').trim());
  const toIsExt = /^\d{2,5}$/.test((call.toNumber || '').trim());
  return fromIsExt && toIsExt;
}

type NormalizedDisposition =
  | 'answered'
  | 'answered_elsewhere'
  | 'voicemail'
  | 'missed'
  | 'no_answer'
  | 'busy'
  | 'canceled'
  | 'declined'
  | 'failed'
  | 'unknown';

function normalizeDisposition(call: CallRecord): NormalizedDisposition {
  const raw = (call.disposition || '').toString().trim().toLowerCase();
  if (!raw) {
    if (isInboundCall(call) && call.durationSec === 0) return 'missed';
    if (!isInboundCall(call) && call.durationSec === 0) return 'canceled';
    return call.durationSec > 0 ? 'answered' : 'unknown';
  }
  if (raw === 'answered' || raw === 'answer') return 'answered';
  if (raw.includes('answered_elsewhere') || raw.includes('answered elsewhere')) return 'answered_elsewhere';
  if (raw === 'voicemail' || raw === 'vm' || raw.includes('voicemail')) return 'voicemail';
  if (raw === 'missed') return 'missed';
  if (raw === 'no_answer' || raw === 'noanswer' || raw.includes('no answer')) return 'no_answer';
  if (raw === 'busy') return 'busy';
  if (raw === 'canceled' || raw === 'cancelled') return 'canceled';
  if (raw === 'declined' || raw === 'rejected') return 'declined';
  if (raw === 'failed') return 'failed';
  return 'unknown';
}

function callKind(call: CallRecord): CallKind {
  const disposition = normalizeDisposition(call);
  if (disposition === 'voicemail') return 'voicemail';
  if (disposition === 'missed' || disposition === 'no_answer' || (isInboundCall(call) && call.durationSec === 0)) return 'missed';
  if (isInternalDirection(call)) return 'internal';
  return isInboundCall(call) ? 'incoming' : 'outgoing';
}

function canonicalNumber(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  // Short code / extension: keep as-is so 103 != 103xxxx
  if (/^\d{2,5}$/.test(trimmed)) return trimmed;
  // Otherwise reduce to digits for dedup
  const digits = trimmed.replace(/\D/g, '');
  return digits || trimmed;
}

function formatDuration(sec: number): string {
  if (sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTimeOfDay(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatFullDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function sectionLabel(iso: string): string {
  const d = new Date(iso);
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = startOf(new Date());
  const day = startOf(d);
  if (day === today) return 'Today';
  if (day === today - 86400000) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function dayKey(iso: string): number {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function callDisplayNumber(call: CallRecord): string {
  return isInboundCall(call) ? call.fromNumber : call.toNumber;
}

function callDisplayName(call: CallRecord): string {
  const number = callDisplayNumber(call);
  return call.fromName && call.fromName !== call.fromNumber ? call.fromName : number || 'Unknown';
}

function isUnknownCaller(call: CallRecord): boolean {
  const number = callDisplayNumber(call);
  const name = call.fromName;
  return !name || name === number || name.trim() === '';
}

function kindAccent(kind: CallKind, colors: ReturnType<typeof useTheme>['colors']): string {
  switch (kind) {
    case 'missed': return colors.danger;
    case 'incoming': return colors.teal;
    case 'outgoing': return colors.success;
    case 'internal': return colors.purple;
    case 'voicemail': return colors.indigo;
  }
}

function kindIcon(kind: CallKind): keyof typeof Ionicons.glyphMap {
  switch (kind) {
    case 'missed': return 'call-outline';
    case 'incoming': return 'arrow-down';
    case 'outgoing': return 'arrow-up';
    case 'internal': return 'swap-horizontal-outline';
    case 'voicemail': return 'recording-outline';
  }
}

function kindLabel(kind: CallKind): string {
  switch (kind) {
    case 'missed': return 'Missed';
    case 'incoming': return 'Incoming';
    case 'outgoing': return 'Outgoing';
    case 'internal': return 'Internal';
    case 'voicemail': return 'Voicemail';
  }
}

/**
 * Fold consecutive calls (ordered newest → oldest) that share the same day,
 * canonical number, and kind. Preserves every underlying CallRecord inside
 * `calls` so the detail sheet can still list individual attempts.
 */
function buildGroups(rows: CallRecord[]): CallGroup[] {
  const groups: CallGroup[] = [];
  for (const call of rows) {
    const kind = callKind(call);
    const number = canonicalNumber(callDisplayNumber(call));
    const day = dayKey(call.startedAt);
    const prev = groups[groups.length - 1];
    const canJoin =
      prev &&
      prev.kind === kind &&
      prev.canonicalNumber === number &&
      dayKey(prev.latestAt) === day;
    if (canJoin) {
      prev.calls.push(call);
      prev.count += 1;
      prev.totalDurationSec += Math.max(0, call.durationSec || 0);
      prev.maxDurationSec = Math.max(prev.maxDurationSec, Math.max(0, call.durationSec || 0));
      if (new Date(call.startedAt).getTime() < new Date(prev.earliestAt).getTime()) {
        prev.earliestAt = call.startedAt;
      }
    } else {
      groups.push({
        type: 'group',
        id: `grp:${kind}:${number}:${day}:${call.id}`,
        calls: [call],
        canonicalNumber: number,
        displayName: callDisplayName(call),
        kind,
        latestAt: call.startedAt,
        earliestAt: call.startedAt,
        count: 1,
        totalDurationSec: Math.max(0, call.durationSec || 0),
        maxDurationSec: Math.max(0, call.durationSec || 0),
        unknown: isUnknownCaller(call),
      });
    }
  }
  return groups;
}

export function RecentTab() {
  const { colors } = useTheme();
  const { token } = useAuth();
  const sip = useSip();
  const insets = useSafeAreaInsets();

  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<CallFilter>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [detailGroup, setDetailGroup] = useState<CallGroup | null>(null);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      // 1. Show local history immediately (no network needed)
      const local = await loadLocalCallHistory();
      if (local.length > 0) {
        setCalls(local);
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
            setCalls([]);
          }
        } catch {
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

  useFocusEffect(
    useCallback(() => {
      load(false);
    }, [load]),
  );

  // Reload 3 seconds after a call ends (gives the append a moment to settle)
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

  const handleCall = useCallback((number: string) => {
    if (!number) return;
    if (sip.registrationState === 'registered') {
      sip.dial(number);
    }
  }, [sip]);

  const handleMessage = useCallback((group: CallGroup) => {
    Alert.alert('Message', `Open Chat to message ${group.displayName}.`);
  }, []);

  const handleAddContact = useCallback((group: CallGroup) => {
    Alert.alert('Add to contacts', `Saving ${group.displayName} to contacts is coming soon.`);
  }, []);

  const todayCount = useMemo(() => {
    const today = dayKey(new Date().toISOString());
    return calls.filter((c) => dayKey(c.startedAt) === today).length;
  }, [calls]);

  const timeline = useMemo<TimelineItem[]>(() => {
    const q = query.trim().toLowerCase();
    const filtered = calls
      .filter((call) => {
        if (filter === 'all') return true;
        return callKind(call) === filter;
      })
      .filter((call) => {
        if (!q) return true;
        return (
          callDisplayName(call).toLowerCase().includes(q) ||
          callDisplayNumber(call).toLowerCase().includes(q) ||
          call.fromNumber.toLowerCase().includes(q) ||
          call.toNumber.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    const groups = buildGroups(filtered);
    const out: TimelineItem[] = [];
    let current = '';
    for (const group of groups) {
      const label = sectionLabel(group.latestAt);
      if (label !== current) {
        current = label;
        out.push({ type: 'section', id: `section:${label}`, title: label });
      }
      out.push(group);
    }
    return out;
  }, [calls, filter, query]);

  const emptyIcon: keyof typeof Ionicons.glyphMap = query.trim() ? 'search-outline' : 'time-outline';
  const emptyTitle = query.trim()
    ? 'No matching calls'
    : filter === 'all'
      ? 'No recent calls'
      : 'No calls in this view';
  const emptySubtitle = query.trim()
    ? 'Try a different name, number, or extension.'
    : filter === 'all'
      ? 'Your call history will appear here.'
      : 'Try another filter or search.';

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerTitleWrap}>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>Recent Calls</Text>
          <Text style={[styles.headerSub, { color: colors.textSecondary }]} numberOfLines={1}>
            {todayCount > 0 ? `Today · ${todayCount} ${todayCount === 1 ? 'call' : 'calls'}` : `${calls.length} total calls`}
          </Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.78}
          style={[styles.headerIcon, { backgroundColor: colors.surfaceElevated + 'cc', borderColor: colors.border }]}
        >
          <Ionicons name="options-outline" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <View style={[styles.searchBox, { backgroundColor: colors.surfaceElevated + 'cc', borderColor: colors.border }]}>
        <Ionicons name="search-outline" size={17} color={colors.textTertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search name, number, or extension"
          placeholderTextColor={colors.textTertiary}
          style={[styles.searchInput, { color: colors.text }]}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
          </TouchableOpacity>
        )}
      </View>

      <HorizontalFilterScroll marginBottom={spacing['3']}>
        <FilterChip id="all" label="All" value={filter} color={colors.primary} onPress={setFilter} />
        <FilterChip id="missed" label="Missed" value={filter} color={colors.danger} onPress={setFilter} />
        <FilterChip id="incoming" label="Incoming" value={filter} color={colors.teal} onPress={setFilter} />
        <FilterChip id="outgoing" label="Outgoing" value={filter} color={colors.success} onPress={setFilter} />
      </HorizontalFilterScroll>

      {loading ? (
        <View style={styles.loadingArea}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[typography.body, { color: colors.textSecondary, marginTop: 12 }]}>
            Loading call history…
          </Text>
        </View>
      ) : error ? (
        <EmptyState icon="alert-circle-outline" title="Could not load calls" subtitle={error} />
      ) : timeline.length === 0 ? (
        <EmptyState icon={emptyIcon} title={emptyTitle} subtitle={emptySubtitle} />
      ) : (
        <FlatList
          data={timeline}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) =>
            item.type === 'section' ? (
              <Text style={[styles.sectionLabel, { color: colors.textTertiary }]}>{item.title}</Text>
            ) : (
              <CallCard
                group={item}
                onOpen={() => setDetailGroup(item)}
                onCall={() => handleCall(item.canonicalNumber || callDisplayNumber(item.calls[0]))}
                onMessage={() => handleMessage(item)}
                onMore={() =>
                  Alert.alert(item.displayName, `${kindLabel(item.kind)} · ${formatFullDateTime(item.latestAt)}`, [
                    { text: 'Call back', onPress: () => handleCall(item.canonicalNumber || callDisplayNumber(item.calls[0])) },
                    { text: 'Message', onPress: () => handleMessage(item) },
                    { text: 'Add to contacts', onPress: () => handleAddContact(item) },
                    { text: 'Cancel', style: 'cancel' },
                  ])
                }
              />
            )
          }
          contentContainerStyle={{ paddingBottom: insets.bottom + 100, paddingHorizontal: spacing['5'] }}
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

      <CallDetailModal
        group={detailGroup}
        onClose={() => setDetailGroup(null)}
        onCall={handleCall}
        onMessage={() => detailGroup && handleMessage(detailGroup)}
        onAddContact={() => detailGroup && handleAddContact(detailGroup)}
      />
    </View>
  );
}

const FilterChip = memo(function FilterChip({
  id,
  label,
  value,
  color,
  onPress,
}: {
  id: CallFilter;
  label: string;
  value: CallFilter;
  color: string;
  onPress: (next: CallFilter) => void;
}) {
  const { colors } = useTheme();
  const active = value === id;
  const surface = teamFilterChipColors(active, color, colors);
  return (
    <TouchableOpacity
      activeOpacity={0.76}
      onPress={() => onPress(id)}
      style={[styles.filterChip, surface]}
    >
      <Text
        numberOfLines={1}
        style={[styles.filterText, { color: active ? color : colors.textSecondary }]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
});

function KindBadge({ kind, accent }: { kind: CallKind; accent: string }) {
  return (
    <View style={[styles.kindBadge, { backgroundColor: accent + '1f', borderColor: accent + '40' }]}>
      <Ionicons name={kindIcon(kind)} size={10} color={accent} />
      <Text style={[styles.kindBadgeText, { color: accent }]} numberOfLines={1}>
        {kindLabel(kind)}
      </Text>
    </View>
  );
}

function UnknownAvatar({ size = 40 }: { size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.surfaceElevated,
        borderWidth: 1,
        borderColor: colors.borderSubtle,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ionicons name="call-outline" size={Math.round(size * 0.45)} color={colors.textTertiary} />
    </View>
  );
}

const CallCard = memo(function CallCard({
  group,
  onOpen,
  onCall,
  onMessage,
  onMore,
}: {
  group: CallGroup;
  onOpen: () => void;
  onCall: () => void;
  onMessage: () => void;
  onMore: () => void;
}) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const accent = kindAccent(group.kind, colors);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dx) > 14 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderMove: (_, gesture) => {
          translateX.setValue(Math.max(-92, Math.min(gesture.dx, 82)));
        },
        onPanResponderRelease: (_, gesture) => {
          const action = gesture.dx > 54 ? 'call' : gesture.dx < -54 ? 'message' : null;
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
          if (action === 'call') onCall();
          if (action === 'message') onMessage();
        },
      }),
    [onCall, onMessage, translateX],
  );

  const pressIn = useCallback(() => {
    Animated.spring(scale, { toValue: 0.98, speed: 30, bounciness: 0, useNativeDriver: true }).start();
  }, [scale]);
  const pressOut = useCallback(() => {
    Animated.spring(scale, { toValue: 1, speed: 25, bounciness: 4, useNativeDriver: true }).start();
  }, [scale]);

  /**
   * Subtitle copy avoids the noisy "Missed call · Missed call · ..." pattern:
   * when a caller was attempted multiple times we show "{n} calls" as the only
   * secondary signal; the accent-tinted badge already conveys the kind.
   */
  const subtitle = useMemo(() => {
    if (group.count > 1) {
      return `${group.count} calls`;
    }
    if (group.kind === 'missed') return 'Missed';
    const duration = formatDuration(group.maxDurationSec);
    if (group.kind === 'voicemail') return duration ? `Voicemail · ${duration}` : 'Voicemail';
    if (duration) return `${kindLabel(group.kind)} · ${duration}`;
    return kindLabel(group.kind);
  }, [group]);

  const primaryCall = group.calls[0];
  const primaryName = group.displayName;

  return (
    <View style={styles.swipeWrap}>
      <View style={styles.swipeBg}>
        <View style={[styles.swipeHint, { backgroundColor: colors.successMuted }]}>
          <Ionicons name="call-outline" size={16} color={colors.success} />
        </View>
        <View style={[styles.swipeHint, { backgroundColor: colors.tealMuted }]}>
          <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.teal} />
        </View>
      </View>
      <Animated.View style={{ transform: [{ translateX }, { scale }] }} {...panResponder.panHandlers}>
        <TouchableOpacity
          activeOpacity={0.92}
          onPress={onOpen}
          onPressIn={pressIn}
          onPressOut={pressOut}
          onLongPress={onMore}
          style={[
            styles.card,
            {
              backgroundColor: colors.surface,
              borderColor: colors.borderSubtle,
            },
          ]}
        >
          <View style={styles.avatarWrap}>
            {group.unknown ? (
              <UnknownAvatar size={44} />
            ) : (
              <Avatar name={primaryName || callDisplayNumber(primaryCall) || 'Unknown'} size="md" />
            )}
          </View>

          <View style={styles.info}>
            <Text style={[styles.nameText, { color: colors.text }]} numberOfLines={1}>
              {primaryName}
            </Text>
            <View style={styles.metaRow}>
              <Ionicons name={kindIcon(group.kind)} size={13} color={accent} style={styles.kindIcon} />
              <Text style={[styles.metaText, { color: colors.textSecondary }]} numberOfLines={1}>
                {subtitle}
              </Text>
            </View>
          </View>

          <View style={styles.rightCol}>
            <Text style={[styles.timeText, { color: colors.textTertiary }]} numberOfLines={1}>
              {formatTimeOfDay(group.latestAt)}
            </Text>
            <View style={styles.actionRow}>
              <TouchableOpacity
                onPress={onMessage}
                activeOpacity={0.74}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                style={[styles.actionBtn, { backgroundColor: colors.tealMuted, borderColor: colors.teal + '33' }]}
              >
                <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.teal} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onCall}
                activeOpacity={0.74}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                style={[
                  styles.actionBtn,
                  styles.actionBtnPrimary,
                  { backgroundColor: colors.primary, borderColor: colors.primary, shadowColor: colors.primary },
                ]}
              >
                <Ionicons name="call" size={17} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
});

function CallDetailModal({
  group,
  onClose,
  onCall,
  onMessage,
  onAddContact,
}: {
  group: CallGroup | null;
  onClose: () => void;
  onCall: (number: string) => void;
  onMessage: () => void;
  onAddContact: () => void;
}) {
  const { colors } = useTheme();
  if (!group) {
    return (
      <Modal visible={false} transparent animationType="slide" onRequestClose={onClose}>
        <View />
      </Modal>
    );
  }
  const accent = kindAccent(group.kind, colors);
  const target = group.canonicalNumber || callDisplayNumber(group.calls[0]);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.modalBackdrop, { backgroundColor: colors.overlay }]}>
        <View style={[styles.detailSheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.sheetHandleWrap}>
            <View style={[styles.sheetHandle, { backgroundColor: colors.borderLight }]} />
          </View>
          <TouchableOpacity style={styles.closeButton} onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={20} color={colors.textSecondary} />
          </TouchableOpacity>

          <View style={styles.detailHeader}>
            <View style={[styles.avatarRingLarge, { borderColor: accent + '55' }]}>
              {group.unknown ? <UnknownAvatar size={72} /> : <Avatar name={group.displayName} size="xl" />}
            </View>
            <Text style={[typography.h2, { color: colors.text, marginTop: 14, textAlign: 'center' }]} numberOfLines={1}>
              {group.displayName}
            </Text>
            <Text style={[typography.bodySm, { color: colors.textSecondary, textAlign: 'center' }]} numberOfLines={1}>
              {target}
            </Text>
            <View style={{ marginTop: 10 }}>
              <KindBadge kind={group.kind} accent={accent} />
            </View>
          </View>

          <View style={styles.detailActions}>
            <TouchableOpacity
              style={[styles.detailAction, { backgroundColor: colors.successMuted }]}
              onPress={() => {
                onCall(target);
                onClose();
              }}
            >
              <Ionicons name="call" size={18} color={colors.success} />
              <Text style={[styles.detailActionText, { color: colors.success }]}>Call</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.detailAction, { backgroundColor: colors.tealMuted }]}
              onPress={() => {
                onMessage();
                onClose();
              }}
            >
              <Ionicons name="chatbubble" size={18} color={colors.teal} />
              <Text style={[styles.detailActionText, { color: colors.teal }]}>Message</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.detailAction, { backgroundColor: colors.primaryMuted }]}
              onPress={() => {
                onAddContact();
                onClose();
              }}
            >
              <Ionicons name="person-add" size={18} color={colors.primary} />
              <Text style={[styles.detailActionText, { color: colors.primary }]}>Add</Text>
            </TouchableOpacity>
          </View>

          <Text style={[styles.attemptsHeader, { color: colors.textTertiary }]}>
            Attempts · {group.count}
          </Text>
          <ScrollView style={styles.attemptsList} contentContainerStyle={{ paddingBottom: spacing['4'] }}>
            {group.calls.map((call) => {
              const kind = callKind(call);
              const c = kindAccent(kind, colors);
              const duration = formatDuration(call.durationSec);
              return (
                <View
                  key={call.id}
                  style={[styles.attemptRow, { borderColor: colors.borderSubtle, backgroundColor: colors.surfaceElevated }]}
                >
                  <View style={[styles.attemptDot, { backgroundColor: c }]} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.attemptLabel, { color: colors.text }]} numberOfLines={1}>
                      {kindLabel(kind)}
                      {duration ? ` · ${duration}` : ''}
                    </Text>
                    <Text style={[styles.attemptTime, { color: colors.textSecondary }]} numberOfLines={1}>
                      {formatFullDateTime(call.startedAt)}
                    </Text>
                  </View>
                  <Ionicons name={kindIcon(kind)} size={14} color={c} />
                </View>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  header: {
    paddingHorizontal: spacing['5'],
    paddingBottom: spacing['3'],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitleWrap: { flex: 1, minWidth: 0, paddingRight: spacing['3'] },
  headerTitle: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  headerSub: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '500',
    marginTop: 2,
  },
  headerIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  searchBox: {
    height: 44,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 14,
    marginHorizontal: spacing['5'],
    marginBottom: spacing['3'],
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 14.5,
    letterSpacing: 0,
    paddingVertical: 0,
  },

  /**
   * Android clips the bottom curve of fully-rounded bordered pills when the
   * pill has a fixed `height` — the hidden font-metrics padding inside
   * `<Text>` pushes the text past the border box. Use `paddingVertical`
   * instead of `height`, and turn off `includeFontPadding` on the label.
   * Never set `overflow: 'hidden'` — that also clips the rounded corners.
   */
  filterChip: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  filterText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
    textAlign: 'center',
    includeFontPadding: false,
    textAlignVertical: 'center',
  },

  sectionLabel: {
    marginTop: spacing['4'],
    marginBottom: spacing['2'],
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    opacity: 0.7,
  },

  swipeWrap: { overflow: 'hidden', borderRadius: 18, marginBottom: 10 },
  swipeBg: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  swipeHint: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 72,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 1,
  },

  avatarWrap: {
    marginRight: 12,
  },
  avatarRingLarge: {
    position: 'relative',
    borderWidth: 2,
    borderRadius: 999,
    padding: 3,
    alignSelf: 'center',
  },

  info: { flex: 1, minWidth: 0 },
  nameText: {
    fontSize: 15.5,
    lineHeight: 20,
    fontWeight: '800',
    letterSpacing: -0.15,
    marginBottom: 3,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kindIcon: { opacity: 0.9 },
  metaText: {
    flexShrink: 1,
    fontSize: 12.5,
    lineHeight: 16,
    fontWeight: '600',
    opacity: 0.8,
  },

  kindBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.full,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  kindBadgeText: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.25,
  },

  rightCol: {
    alignSelf: 'stretch',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingTop: 2,
    paddingBottom: 2,
    marginLeft: 10,
  },
  timeText: {
    fontSize: 11.5,
    lineHeight: 15,
    fontWeight: '700',
    opacity: 0.7,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  actionBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnPrimary: {
    width: 38,
    height: 38,
    borderRadius: 19,
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },

  loadingArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  detailSheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    paddingHorizontal: spacing['5'],
    paddingBottom: spacing['8'],
    paddingTop: spacing['3'],
    maxHeight: '85%',
  },
  sheetHandleWrap: { alignItems: 'center', marginBottom: 10 },
  sheetHandle: { width: 42, height: 5, borderRadius: 999 },
  closeButton: { position: 'absolute', top: 18, right: 18, zIndex: 2 },
  detailHeader: { alignItems: 'center', paddingTop: spacing['3'] },
  detailActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: spacing['5'],
    marginBottom: spacing['4'],
  },
  detailAction: {
    flex: 1,
    borderRadius: radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 5,
  },
  detailActionText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.2 },

  attemptsHeader: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    marginBottom: spacing['2'],
    opacity: 0.7,
  },
  attemptsList: {
    maxHeight: 260,
  },
  attemptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 8,
  },
  attemptDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  attemptLabel: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: -0.1,
  },
  attemptTime: {
    fontSize: 12,
    fontWeight: '500',
    marginTop: 2,
    opacity: 0.85,
  },
});

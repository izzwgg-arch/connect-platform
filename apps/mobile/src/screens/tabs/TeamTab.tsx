import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, FlatList, PanResponder, RefreshControl, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useSip } from '../../context/SipContext';
import { EmptyState } from '../../components/ui/EmptyState';
import { Avatar } from '../../components/ui/Avatar';
import { PulseDot } from '../../components/ui/PulseDot';
import { getTeamDirectory } from '../../api/client';
import { subscribeToBLF, type LiveTelephonyState } from '../../api/realtime';
import type { LiveCall, TeamDirectoryMember, TeamPresence } from '../../types';
import { typography } from '../../theme/typography';
import { radius, spacing } from '../../theme/spacing';

type TeamFilter = 'all' | TeamPresence;

function involvedExtensions(call: LiveCall): string[] {
  const out = new Set<string>();
  const add = (value: string | null | undefined) => {
    const v = String(value || '').trim();
    if (/^\d{2,6}$/.test(v)) out.add(v);
  };
  (call.extensions || []).forEach(add);
  add(call.from);
  add(call.to);
  add(call.connectedLine);
  return [...out];
}

function livePresence(member: TeamDirectoryMember, live: LiveTelephonyState | null): TeamPresence {
  if (!live) return member.presence;
  const active = new Set<string>();
  const ringing = new Set<string>();
  for (const call of live.calls.values()) {
    const belongsToTenant = !member.tenantId || !call.tenantId || call.tenantId === member.tenantId;
    if (!belongsToTenant) continue;
    const exts = involvedExtensions(call);
    if (call.state === 'up' || call.state === 'held') exts.forEach((ext) => active.add(ext));
    if (call.state === 'ringing' || call.state === 'dialing') exts.forEach((ext) => ringing.add(ext));
  }
  if (ringing.has(member.extension)) return 'ringing';
  if (active.has(member.extension)) return 'on_call';

  const direct = [...live.extensions.values()].find((ext) =>
    ext.extension === member.extension && (!member.tenantId || !ext.tenantId || ext.tenantId === member.tenantId),
  );
  const state = String(direct?.status || '').toLowerCase();
  if (['idle', 'not_inuse', 'registered', '0'].includes(state)) return 'available';
  if (['ringing'].includes(state)) return 'ringing';
  if (['inuse', 'busy', 'onhold', '1', '2', '3'].includes(state)) return 'on_call';
  return 'offline';
}

function presenceMeta(presence: TeamPresence, colors: ReturnType<typeof useTheme>['colors']) {
  if (presence === 'available') return colors.success;
  if (presence === 'ringing') return colors.warning;
  if (presence === 'on_call') return colors.danger;
  return colors.textTertiary;
}

function presenceLabel(presence: TeamPresence): string {
  if (presence === 'on_call') return 'On call';
  return presence.charAt(0).toUpperCase() + presence.slice(1);
}

function formatElapsed(startedAt: string | null | undefined, now: number): string | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return null;
  const total = Math.max(0, Math.floor((now - start) / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function activeCallStartedAt(member: TeamDirectoryMember, live: LiveTelephonyState | null): string | null {
  if (!live) return null;
  for (const call of live.calls.values()) {
    const belongsToTenant = !member.tenantId || !call.tenantId || call.tenantId === member.tenantId;
    if (!belongsToTenant || (call.state !== 'up' && call.state !== 'held')) continue;
    if (involvedExtensions(call).includes(member.extension)) return call.answeredAt || call.startedAt;
  }
  return null;
}

function isDisplayableMember(member: TeamDirectoryMember): boolean {
  if (!/^\d{3}$/.test(member.extension)) return false;
  const n = member.name.trim().toLowerCase();
  return !(
    n === 'pbx user' ||
    /^pbx user\s+\d+$/.test(n) ||
    n.includes('invite lifecycle') ||
    n.includes('provisioning') ||
    n.includes('smoke') ||
    n.includes('system') ||
    n.includes('test') ||
    n === 'voice user' ||
    /^voice user\s+\d+$/.test(n)
  );
}

export function TeamTab() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const sip = useSip();
  const [members, setMembers] = useState<TeamDirectoryMember[]>([]);
  const [live, setLive] = useState<LiveTelephonyState | null>(null);
  const [liveStatus, setLiveStatus] = useState('connecting');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TeamFilter>('all');
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (!token) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setMembers(await getTeamDirectory(token));
    } catch {
      setError('Could not load team directory.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    load(false);
  }, [load]);

  useEffect(() => {
    if (!token) return undefined;
    return subscribeToBLF(token, setLive, setLiveStatus);
  }, [token]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const enriched = useMemo(() => members
    .map((member) => ({ ...member, presence: livePresence(member, live) }))
    .filter(isDisplayableMember), [live, members]);

  const counts = useMemo(() => ({
    all: enriched.length,
    available: enriched.filter((m) => m.presence === 'available').length,
    on_call: enriched.filter((m) => m.presence === 'on_call').length,
    ringing: enriched.filter((m) => m.presence === 'ringing').length,
    offline: enriched.filter((m) => m.presence === 'offline').length,
  }), [enriched]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return enriched
      .filter((member) => filter === 'all' || member.presence === filter)
      .filter((member) =>
        !q ||
        member.name.toLowerCase().includes(q) ||
        member.extension.includes(q) ||
        (member.email || '').toLowerCase().includes(q),
      );
  }, [enriched, filter, query]);

  const callExtension = useCallback((extension: string) => {
    if (sip.registrationState === 'registered') sip.dial(extension);
  }, [sip]);

  const messageMember = useCallback((member: TeamDirectoryMember) => {
    Alert.alert('Message', `Chat actions for ${member.name} will open from Chat.`);
  }, []);

  const showQuickActions = useCallback((member: TeamDirectoryMember) => {
    Alert.alert(member.name, `Extension ${member.extension}`, [
      { text: 'Call', onPress: () => callExtension(member.extension) },
      { text: 'Message', onPress: () => messageMember(member) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [callExtension, messageMember]);

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View>
          <View style={styles.headerTitleRow}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>Team</Text>
            <Text style={[styles.headerAccent, { color: colors.primary }]}>VLS</Text>
          </View>
          <View style={styles.subtitleRow}>
            <PulseDot color={colors.success} size={7} active={liveStatus === 'connected'} />
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>Live BLF presence</Text>
          </View>
        </View>
        <View
          style={[
            styles.liveBadge,
            {
              backgroundColor: liveStatus === 'connected' ? colors.successMuted : colors.warningMuted,
              shadowColor: liveStatus === 'connected' ? colors.success : colors.warning,
              borderColor: liveStatus === 'connected' ? colors.success + '30' : colors.warning + '30',
            },
          ]}
        >
          <PulseDot color={liveStatus === 'connected' ? colors.success : colors.warning} size={8} active={liveStatus !== 'disconnected'} />
        </View>
      </View>
      <View style={styles.searchRow}>
        <View style={[styles.searchBox, { backgroundColor: colors.surfaceElevated + 'cc', borderColor: colors.border }]}>
          <Ionicons name="search-outline" size={17} color={colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search name or extension..."
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
        <TouchableOpacity
          activeOpacity={0.75}
          style={[styles.filterButton, { backgroundColor: colors.surfaceElevated + 'cc', borderColor: colors.border }]}
        >
          <Ionicons name="options-outline" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
      <View style={styles.summaryRow}>
        <SummaryChip label="All" value={counts.all} color={colors.primary} active={filter === 'all'} onPress={() => setFilter('all')} />
        <SummaryChip label="Available" value={counts.available} color={colors.success} active={filter === 'available'} onPress={() => setFilter('available')} />
        <SummaryChip label="On Call" value={counts.on_call} color={colors.danger} active={filter === 'on_call'} onPress={() => setFilter('on_call')} />
        <SummaryChip label="Ringing" value={counts.ringing} color={colors.warning} active={filter === 'ringing'} onPress={() => setFilter('ringing')} />
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[typography.body, { color: colors.textSecondary, marginTop: 12 }]}>Loading team...</Text>
        </View>
      ) : error ? (
        <EmptyState icon="alert-circle-outline" title="Could not load team" subtitle={error} />
      ) : visible.length === 0 ? (
        <EmptyState icon="people-outline" title="No team members found." subtitle="Try another search or status filter." />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.primary} />}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            return (
              <TeamMemberRow
                member={item}
                elapsed={formatElapsed(activeCallStartedAt(item, live), now)}
                onPress={() => showQuickActions(item)}
                onCall={() => callExtension(item.extension)}
                onMessage={() => messageMember(item)}
              />
            );
          }}
        />
      )}
      <TouchableOpacity
        activeOpacity={0.82}
        onPress={() => Alert.alert('Invite user', 'User invite actions will open from the web admin tools.')}
        style={[
          styles.fab,
          {
            backgroundColor: colors.primary + 'ee',
            borderColor: colors.white + '24',
            shadowColor: colors.primary,
          },
        ]}
      >
        <Ionicons name="person-add-outline" size={23} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const SummaryChip = memo(function SummaryChip({
  label,
  value,
  color,
  active,
  onPress,
}: {
  label: string;
  value: number;
  color: string;
  active: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      activeOpacity={0.76}
      onPress={onPress}
      style={[
        styles.summaryChip,
        {
          backgroundColor: active ? color + '18' : colors.transparent,
          borderColor: active ? color + '38' : colors.borderSubtle,
        },
      ]}
    >
      <PulseDot color={color} size={6} active={label === 'Ringing' && value > 0} />
      <Text style={[styles.summaryValue, { color }]}>{value}</Text>
      <Text style={[styles.summaryLabel, { color: active ? color : colors.textSecondary }]}>{label}</Text>
    </TouchableOpacity>
  );
});

type TeamRowProps = {
  member: TeamDirectoryMember & { presence: TeamPresence };
  elapsed: string | null;
  onPress: () => void;
  onCall: () => void;
  onMessage: () => void;
};

const TeamMemberRow = memo(function TeamMemberRow({ member, elapsed, onPress, onCall, onMessage }: TeamRowProps) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const tone = presenceMeta(member.presence, colors);
  const statusText = member.presence === 'on_call' && elapsed ? `On Call ${elapsed}` : presenceLabel(member.presence);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 14 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderMove: (_, gesture) => {
      translateX.setValue(Math.max(-104, Math.min(gesture.dx, 88)));
    },
    onPanResponderRelease: (_, gesture) => {
      const action = gesture.dx > 54 ? 'call' : gesture.dx < -54 ? 'message' : null;
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      if (action === 'call') onCall();
      if (action === 'message') onMessage();
    },
  }), [onCall, onMessage, translateX]);

  const pressIn = useCallback(() => {
    Animated.spring(scale, { toValue: 0.98, speed: 30, bounciness: 0, useNativeDriver: true }).start();
  }, [scale]);
  const pressOut = useCallback(() => {
    Animated.spring(scale, { toValue: 1, speed: 25, bounciness: 4, useNativeDriver: true }).start();
  }, [scale]);

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
          activeOpacity={0.9}
          onPress={onPress}
          onPressIn={pressIn}
          onPressOut={pressOut}
          style={[styles.row, { borderBottomColor: colors.borderSubtle, backgroundColor: colors.bg }]}
        >
          <View style={[styles.avatarWrap, member.presence === 'on_call' ? { shadowColor: colors.danger, shadowOpacity: 0.22, shadowRadius: 10, elevation: 4 } : null]}>
            <Avatar name={member.name} size="md" />
            <View style={[styles.presenceBadge, { borderColor: colors.bg }]}>
              <PulseDot color={tone} size={9} active={member.presence === 'available' || member.presence === 'ringing'} />
            </View>
          </View>
          <View style={styles.info}>
            <View style={styles.nameLine}>
              <Text style={[styles.memberName, { color: colors.text }]} numberOfLines={1}>{member.name}</Text>
              <View style={[styles.extPill, { backgroundColor: colors.primaryMuted, borderColor: colors.primary + '25' }]}>
                <Text style={[styles.extText, { color: colors.primary }]}>#{member.extension}</Text>
              </View>
            </View>
            <Text style={[styles.emailText, { color: colors.textSecondary }]} numberOfLines={1}>
              {member.email || member.title || member.department || 'Connect extension'}
            </Text>
          </View>
          <View style={styles.rightCol}>
            <Text style={[styles.statusText, { color: tone }]} numberOfLines={1}>{statusText}</Text>
            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.iconButton} onPress={onMessage} activeOpacity={0.72}>
                <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.iconButton} onPress={onCall} activeOpacity={0.72}>
                <Ionicons name="call-outline" size={17} color={colors.success} />
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    paddingHorizontal: spacing['5'],
    paddingBottom: spacing['3'],
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  headerTitle: {
    fontSize: 27,
    lineHeight: 33,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  headerAccent: {
    fontSize: 25,
    lineHeight: 31,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 2,
  },
  subtitle: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.1,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['5'],
    gap: 10,
    marginBottom: spacing['3'],
  },
  searchBox: {
    flex: 1,
    height: 40,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    letterSpacing: 0,
    paddingVertical: 0,
  },
  filterButton: {
    width: 40,
    height: 40,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing['5'],
    paddingBottom: spacing['2'],
  },
  summaryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  summaryValue: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: -0.1,
  },
  summaryLabel: {
    fontSize: 11,
    fontWeight: '700',
  },
  list: { paddingHorizontal: spacing['5'], paddingTop: spacing['1'], paddingBottom: 104 },
  liveBadge: {
    width: 38,
    height: 38,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 5,
  },
  swipeWrap: {
    overflow: 'hidden',
  },
  swipeBg: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  swipeHint: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 72,
    paddingVertical: 8,
  },
  avatarWrap: {
    marginRight: 11,
    borderRadius: 20,
  },
  presenceBadge: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 15,
    height: 15,
    borderRadius: 8,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  memberName: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800',
    letterSpacing: -0.15,
  },
  emailText: {
    fontSize: 12,
    lineHeight: 16,
    opacity: 0.6,
  },
  extPill: {
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  extText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.1,
  },
  rightCol: {
    width: 92,
    alignSelf: 'stretch',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingTop: 4,
    paddingBottom: 3,
    marginLeft: 8,
  },
  statusText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '800',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fab: {
    position: 'absolute',
    right: 22,
    bottom: 92,
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 18,
    elevation: 6,
  },
});

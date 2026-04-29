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
import { HorizontalFilterScroll } from '../../components/ui/HorizontalFilterScroll';
import { getTeamDirectory } from '../../api/client';
import { subscribeToBLF, type LiveTelephonyState } from '../../api/realtime';
import type { LiveCall, TeamDirectoryMember, TeamPresence } from '../../types';
import { typography } from '../../theme/typography';
import { teamFilterChipColors } from '../../theme/filterChipColors';
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

function presenceColor(presence: TeamPresence, colors: ReturnType<typeof useTheme>['colors']) {
  if (presence === 'available') return colors.success;
  if (presence === 'ringing') return colors.warning;
  if (presence === 'on_call') return colors.danger;
  return colors.textTertiary;
}

function presenceLabel(presence: TeamPresence): string {
  if (presence === 'on_call') return 'On Call';
  return presence.charAt(0).toUpperCase() + presence.slice(1);
}

/**
 * Lower weight = higher in list (available first, ringing, on_call, offline).
 */
function presenceWeight(presence: TeamPresence): number {
  if (presence === 'available') return 0;
  if (presence === 'ringing') return 1;
  if (presence === 'on_call') return 2;
  return 3;
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
    return subscribeToBLF(token, setLive);
  }, [token]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const enriched = useMemo(() => members
    .map((member) => ({ ...member, presence: livePresence(member, live) }))
    .filter(isDisplayableMember), [live, members]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = enriched
      .filter((member) => filter === 'all' || member.presence === filter)
      .filter((member) =>
        !q ||
        member.name.toLowerCase().includes(q) ||
        member.extension.includes(q) ||
        (member.email || '').toLowerCase().includes(q),
      );
    // Sort: presence-first, then by extension number (numeric).
    return [...filtered].sort((a, b) => {
      const wa = presenceWeight(a.presence);
      const wb = presenceWeight(b.presence);
      if (wa !== wb) return wa - wb;
      const ea = parseInt(a.extension || '0', 10);
      const eb = parseInt(b.extension || '0', 10);
      if (Number.isFinite(ea) && Number.isFinite(eb) && ea !== eb) return ea - eb;
      return a.name.localeCompare(b.name);
    });
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
        <View style={styles.headerTitleWrap}>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>Team</Text>
        </View>
      </View>

      <View style={styles.searchRow}>
        <View style={[styles.searchBox, { backgroundColor: colors.surfaceElevated + 'cc', borderColor: colors.border }]}>
          <Ionicons name="search-outline" size={17} color={colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search name or extension"
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
      </View>

      <HorizontalFilterScroll marginBottom={spacing['3']}>
        <SummaryChip id="all" label="All" color={colors.primary} active={filter === 'all'} onPress={setFilter} />
        <SummaryChip id="available" label="Available" color={colors.success} active={filter === 'available'} onPress={setFilter} />
        <SummaryChip id="on_call" label="On Call" color={colors.danger} active={filter === 'on_call'} onPress={setFilter} />
        <SummaryChip id="ringing" label="Ringing" color={colors.warning} active={filter === 'ringing'} onPress={setFilter} />
        <SummaryChip id="offline" label="Offline" color={colors.textTertiary} active={filter === 'offline'} onPress={setFilter} />
      </HorizontalFilterScroll>

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
              <TeamMemberCard
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
    </View>
  );
}

const SummaryChip = memo(function SummaryChip({
  id,
  label,
  color,
  active,
  onPress,
}: {
  id: TeamFilter;
  label: string;
  color: string;
  active: boolean;
  onPress: (next: TeamFilter) => void;
}) {
  const { colors } = useTheme();
  const surface = teamFilterChipColors(active, color, colors);
  return (
    <TouchableOpacity
      activeOpacity={0.76}
      onPress={() => onPress(id)}
      style={[styles.filterChip, surface]}
    >
      <Text numberOfLines={1} style={[styles.filterText, { color: active ? color : colors.textSecondary }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
});

type TeamCardProps = {
  member: TeamDirectoryMember & { presence: TeamPresence };
  elapsed: string | null;
  onPress: () => void;
  onCall: () => void;
  onMessage: () => void;
};

const TeamMemberCard = memo(function TeamMemberCard({ member, elapsed, onPress, onCall, onMessage }: TeamCardProps) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const tone = presenceColor(member.presence, colors);
  const statusText = member.presence === 'on_call' && elapsed ? `On Call · ${elapsed}` : presenceLabel(member.presence);
  const pulseActive = member.presence === 'available' || member.presence === 'ringing' || member.presence === 'on_call';
  const onCallAccent = member.presence === 'on_call';

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 14 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderMove: (_, gesture) => {
      translateX.setValue(Math.max(-112, Math.min(gesture.dx, 86)));
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
          activeOpacity={0.92}
          onPress={onPress}
          onPressIn={pressIn}
          onPressOut={pressOut}
          style={[
            styles.card,
            {
              backgroundColor: colors.surface,
              borderColor: onCallAccent ? colors.danger + '33' : colors.borderSubtle,
              shadowColor: '#000',
            },
          ]}
        >
          <View
            style={[
              styles.avatarWrap,
              onCallAccent
                ? { shadowColor: colors.danger, shadowOpacity: 0.25, shadowRadius: 10, elevation: 4 }
                : null,
            ]}
          >
            <Avatar name={member.name} size="md" />
            <View style={[styles.presenceBadge, { borderColor: colors.surface, backgroundColor: colors.surface }]}>
              <PulseDot color={tone} size={10} active={pulseActive} />
            </View>
          </View>

          <View style={styles.info}>
            <View style={styles.nameLine}>
              <Text style={[styles.nameText, { color: colors.text }]} numberOfLines={1}>
                {member.name}
              </Text>
            </View>
            <Text style={[styles.metaText, { color: colors.textSecondary }]} numberOfLines={1}>
              {`Ext ${member.extension}${member.email ? ' · ' + member.email : member.department ? ' · ' + member.department : ''}`}
            </Text>
            <View
              style={[
                styles.statusPill,
                {
                  backgroundColor: tone + '18',
                  borderColor: tone + '40',
                },
              ]}
            >
              <View style={[styles.statusDot, { backgroundColor: tone }]} />
              <Text style={[styles.statusPillText, { color: tone }]} numberOfLines={1}>
                {statusText}
              </Text>
            </View>
          </View>

          <View style={styles.actionRow}>
            <TouchableOpacity
              onPress={onMessage}
              activeOpacity={0.74}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              style={[styles.actionBtn, { backgroundColor: colors.tealMuted, borderColor: colors.teal + '33' }]}
            >
              <Ionicons name="chatbubble-ellipses-outline" size={17} color={colors.teal} />
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
              <Ionicons name="call" size={18} color="#fff" />
            </TouchableOpacity>
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
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  headerTitleWrap: { flex: 1, minWidth: 0 },
  headerTitle: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.8,
  },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['5'],
    marginBottom: spacing['3'],
  },
  searchBox: {
    flex: 1,
    height: 44,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 14,
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

  list: { paddingHorizontal: spacing['5'], paddingTop: spacing['1'], paddingBottom: 120 },

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
    minHeight: 76,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 1,
  },

  avatarWrap: {
    marginRight: 12,
    borderRadius: 20,
  },
  presenceBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },

  info: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 2 },
  nameText: {
    flex: 1,
    minWidth: 0,
    fontSize: 15.5,
    lineHeight: 20,
    fontWeight: '800',
    letterSpacing: -0.15,
  },
  metaText: {
    fontSize: 12.5,
    lineHeight: 16,
    opacity: 0.7,
    marginBottom: 5,
  },
  statusPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusPillText: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.2,
  },

  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 10,
  },
  actionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnPrimary: {
    width: 40,
    height: 40,
    borderRadius: 20,
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
});

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, FlatList, PanResponder, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Audio } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useSip } from '../../context/SipContext';
import { EmptyState } from '../../components/ui/EmptyState';
import { HeaderBar } from '../../components/HeaderBar';
import { SearchBar } from '../../components/ui/SearchBar';
import { Avatar } from '../../components/ui/Avatar';
import { FilterPills, type FilterPillOption } from '../../components/ui/FilterPills';
import { getVoicemails, markVoicemailListened } from '../../api/client';
import { subscribeToVoicemail } from '../../api/realtime';
import type { Voicemail } from '../../types';
import { typography } from '../../theme/typography';
import { radius, spacing } from '../../theme/spacing';

type VoicemailTabFilter = 'all' | 'new' | 'urgent' | 'old';

function formatDuration(sec: number): string {
  const safe = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const diffH = (Date.now() - date.getTime()) / 3600000;
  if (diffH < 1) return 'Just now';
  if (diffH < 24) return `${Math.floor(diffH)}h ago`;
  if (diffH < 48) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function VoicemailTab() {
  const { colors } = useTheme();
  const { token } = useAuth();
  const sip = useSip();
  const [rows, setRows] = useState<Voicemail[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [progress, setProgress] = useState<{ position: number; duration: number }>({ position: 0, duration: 0 });
  const [tab, setTab] = useState<VoicemailTabFilter>('all');
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (!token) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await getVoicemails(token);
      setRows(data.voicemails);
    } catch {
      setError('Could not load voicemail.');
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
    return subscribeToVoicemail(() => load(true));
  }, [load, token]);

  useEffect(() => () => {
    sound?.unloadAsync().catch(() => undefined);
  }, [sound]);

  const stats = useMemo(() => {
    const urgent = rows.filter((vm) => vm.folder === 'urgent').length;
    const unread = rows.filter((vm) => !vm.listened).length;
    return { urgent, unread, total: rows.length };
  }, [rows]);

  const tabOptions = useMemo<FilterPillOption<VoicemailTabFilter>[]>(() => [
    { id: 'all', label: 'All', count: rows.length, tone: 'primary' },
    { id: 'new', label: 'New', count: stats.unread, tone: 'success' },
    { id: 'urgent', label: 'Urgent', count: stats.urgent, tone: 'danger' },
    { id: 'old', label: 'Old', count: rows.filter((vm) => vm.folder === 'old').length, tone: 'neutral' },
  ], [rows, stats]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((vm) => {
        if (tab === 'new') return !vm.listened;
        if (tab === 'urgent') return vm.folder === 'urgent';
        if (tab === 'old') return vm.folder === 'old';
        return true;
      })
      .filter((vm) =>
        !q ||
        vm.callerId.toLowerCase().includes(q) ||
        (vm.callerName || '').toLowerCase().includes(q) ||
        vm.extension.includes(q) ||
        (vm.transcription || '').toLowerCase().includes(q),
      );
  }, [query, rows, tab]);

  const updatePlayback = useCallback((status: any) => {
    if (!status?.isLoaded) return;
    const duration = Math.max(0, Math.floor((status.durationMillis || 0) / 1000));
    const position = Math.max(0, Math.floor((status.positionMillis || 0) / 1000));
    setProgress({ position, duration });
    if (status.didJustFinish) setActiveId(null);
  }, []);

  const play = useCallback(async (vm: Voicemail) => {
    if (!token || !vm.streamUrl) return;
    if (activeId === vm.id && sound) {
      await sound.pauseAsync().catch(() => undefined);
      setActiveId(null);
      return;
    }
    if (sound) await sound.unloadAsync().catch(() => undefined);
    const next = new Audio.Sound();
    await next.loadAsync({ uri: vm.streamUrl });
    next.setOnPlaybackStatusUpdate(updatePlayback);
    await next.playAsync();
    setSound(next);
    setActiveId(vm.id);
    setProgress({ position: 0, duration: vm.durationSec });
    if (!vm.listened) {
      markVoicemailListened(token, vm.id, true).catch(() => undefined);
      setRows((current) => current.map((row) => row.id === vm.id ? { ...row, listened: true } : row));
    }
  }, [activeId, sound, token, updatePlayback]);

  const toggleListened = useCallback((vm: Voicemail) => {
    if (!token) return;
    const next = !vm.listened;
    markVoicemailListened(token, vm.id, next).catch(() => undefined);
    setRows((current) => current.map((row) => row.id === vm.id ? { ...row, listened: next } : row));
  }, [token]);

  const callBack = useCallback((vm: Voicemail) => {
    if (sip.registrationState === 'registered' && vm.callerId) sip.dial(vm.callerId);
  }, [sip]);

  const messageCaller = useCallback((vm: Voicemail) => {
    Alert.alert('Message', `Open Chat to message ${vm.callerName || vm.callerId}.`);
  }, []);

  const showMore = useCallback((vm: Voicemail) => {
    Alert.alert(vm.callerName || vm.callerId || 'Voicemail', 'Voicemail actions', [
      { text: vm.listened ? 'Mark unread' : 'Mark read', onPress: () => toggleListened(vm) },
      { text: 'Delete', style: 'destructive', onPress: () => Alert.alert('Delete', 'Delete is not available from mobile yet.') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [toggleListened]);

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <HeaderBar title="Voicemail" subtitle={`${stats.unread} new · ${stats.total} total`} />
      <View style={styles.searchRow}>
        <View style={styles.searchGrow}>
          <SearchBar value={query} onChangeText={setQuery} placeholder="Search caller, extension, transcript..." />
        </View>
        <TouchableOpacity
          activeOpacity={0.75}
          style={[styles.filterButton, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
        >
          <Ionicons name="options-outline" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
      <FilterPills options={tabOptions} value={tab} onChange={setTab} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[typography.body, { color: colors.textSecondary, marginTop: 12 }]}>Loading voicemail...</Text>
        </View>
      ) : error ? (
        <EmptyState icon="alert-circle-outline" title="Could not load voicemail" subtitle={error} />
      ) : filtered.length === 0 ? (
        <EmptyState icon="recording-outline" title="No voicemails yet." subtitle="New voicemail messages will appear here." />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.primary} />}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <VoicemailRow
              vm={item}
              active={activeId === item.id}
              expanded={expandedId === item.id}
              progress={activeId === item.id ? progress : { position: 0, duration: item.durationSec }}
              onPress={() => setExpandedId((current) => current === item.id ? null : item.id)}
              onPlay={() => play(item)}
              onCall={() => callBack(item)}
              onMessage={() => messageCaller(item)}
              onMore={() => showMore(item)}
              onToggleRead={() => toggleListened(item)}
            />
          )}
        />
      )}
      <TouchableOpacity
        activeOpacity={0.82}
        onPress={() => load(true)}
        style={[
          styles.fab,
          {
            backgroundColor: colors.primary + 'ee',
            borderColor: colors.white + '24',
            shadowColor: colors.primary,
          },
        ]}
      >
        <Ionicons name="recording-outline" size={24} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

type VoicemailRowProps = {
  vm: Voicemail;
  active: boolean;
  expanded: boolean;
  progress: { position: number; duration: number };
  onPress: () => void;
  onPlay: () => void;
  onCall: () => void;
  onMessage: () => void;
  onMore: () => void;
  onToggleRead: () => void;
};

function VoicemailRow({ vm, active, expanded, progress, onPress, onPlay, onCall, onMessage, onMore, onToggleRead }: VoicemailRowProps) {
  const { colors } = useTheme();
  const translateX = useRef(new Animated.Value(0)).current;
  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderMove: (_, gesture) => {
      if (gesture.dx < 0) translateX.setValue(Math.max(gesture.dx, -144));
    },
    onPanResponderRelease: (_, gesture) => {
      Animated.spring(translateX, {
        toValue: gesture.dx < -52 ? -144 : 0,
        useNativeDriver: true,
      }).start();
    },
  }), [translateX]);

  const resetSwipe = useCallback(() => {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
  }, [translateX]);

  return (
    <View style={styles.swipeWrap}>
      <View style={styles.swipeActions}>
        <TouchableOpacity
          style={[styles.swipeAction, { backgroundColor: colors.primaryMuted }]}
          onPress={() => {
            onToggleRead();
            resetSwipe();
          }}
        >
          <Ionicons name={vm.listened ? 'mail-unread-outline' : 'checkmark-done-outline'} size={16} color={colors.primary} />
          <Text style={[styles.swipeText, { color: colors.primary }]}>{vm.listened ? 'Unread' : 'Read'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.swipeAction, { backgroundColor: colors.dangerMuted }]}
          onPress={() => {
            Alert.alert('Delete', 'Delete is not available from mobile yet.');
            resetSwipe();
          }}
        >
          <Ionicons name="trash-outline" size={16} color={colors.danger} />
          <Text style={[styles.swipeText, { color: colors.danger }]}>Delete</Text>
        </TouchableOpacity>
      </View>
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        <TouchableOpacity
          activeOpacity={0.82}
          onPress={onPress}
          style={[
            styles.row,
            {
              borderBottomColor: colors.borderSubtle,
              backgroundColor: colors.bg,
            },
          ]}
        >
          <Avatar name={vm.callerName || vm.callerId || 'Unknown'} size="sm" />
          <View style={styles.info}>
            <View style={styles.titleRow}>
              <Text style={[styles.nameText, { color: colors.text }]} numberOfLines={1}>
                {vm.callerName || vm.callerId || 'Unknown caller'}
              </Text>
              {!vm.listened && (
                <View style={[styles.newBadge, { backgroundColor: colors.primaryMuted, borderColor: colors.primary + '33' }]}>
                  <Text style={[styles.newText, { color: colors.primary }]}>NEW</Text>
                </View>
              )}
            </View>
            <Text style={[styles.metaText, { color: colors.textSecondary }]} numberOfLines={1}>
              {vm.callerId} · ext {vm.extension}
            </Text>
            <View style={styles.player}>
              <TouchableOpacity
                style={[styles.playButton, { backgroundColor: active ? colors.primary : colors.primaryMuted }]}
                onPress={onPlay}
                activeOpacity={0.75}
              >
                <Ionicons name={active ? 'pause' : 'play'} size={12} color={active ? '#fff' : colors.primary} />
              </TouchableOpacity>
              <Waveform active={active} progress={progress} duration={vm.durationSec} />
              <Text style={[styles.durationText, { color: colors.textTertiary }]}>{formatDuration(vm.durationSec)}</Text>
            </View>
            {expanded && (
              <Text style={[styles.transcript, { color: colors.textSecondary }]} numberOfLines={4}>
                {vm.transcription || 'No transcript available'}
              </Text>
            )}
          </View>
          <View style={styles.rightCol}>
            <Text style={[styles.dateText, { color: colors.textTertiary }]}>{formatTime(vm.receivedAt)}</Text>
            <View style={styles.rowActions}>
              <TouchableOpacity style={[styles.iconButton, { backgroundColor: colors.successMuted }]} onPress={onCall}>
                <Ionicons name="call-outline" size={14} color={colors.success} />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.iconButton, { backgroundColor: colors.tealMuted }]} onPress={onMessage}>
                <Ionicons name="chatbubble-ellipses-outline" size={14} color={colors.teal} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.moreButton} onPress={onMore}>
                <Ionicons name="ellipsis-horizontal" size={17} color={colors.textTertiary} />
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

function Waveform({ active, progress, duration }: { active: boolean; progress: { position: number; duration: number }; duration: number }) {
  const { colors } = useTheme();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      pulse.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 420, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 420, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  const pct = active
    ? Math.min(1, (progress.position || 0) / Math.max(1, progress.duration || duration || 1))
    : 0;
  const bars = [0.35, 0.65, 0.45, 0.82, 0.5, 0.7, 0.38, 0.58, 0.78, 0.42, 0.62, 0.5];

  return (
    <View style={styles.waveBars}>
      {bars.map((height, idx) => {
        const filled = idx / bars.length <= pct;
        const animatedHeight = pulse.interpolate({
          inputRange: [0, 1],
          outputRange: [10 + height * 9, 8 + ((idx % 3) + 1) * 5],
        });
        return (
          <Animated.View
            key={`${idx}-${height}`}
            style={[
              styles.waveBar,
              {
                height: active && filled ? animatedHeight : 10 + height * 9,
                backgroundColor: filled ? colors.primary : colors.borderLight,
                opacity: filled ? 0.9 : 0.55,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing['4'],
  },
  searchGrow: { flex: 1 },
  filterButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -4,
    marginVertical: spacing['2'],
  },
  list: { paddingHorizontal: spacing['4'], paddingTop: spacing['1'], paddingBottom: 96 },
  swipeWrap: {
    overflow: 'hidden',
  },
  swipeActions: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: 144,
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'flex-end',
  },
  swipeAction: {
    width: 72,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  swipeText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 68,
    paddingVertical: 7,
    gap: 10,
  },
  playButton: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 1 },
  nameText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 19,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  metaText: {
    fontSize: 12,
    lineHeight: 15,
    opacity: 0.6,
  },
  newBadge: {
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  newText: {
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  player: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 3,
  },
  waveBars: {
    height: 20,
    flex: 1,
    maxWidth: 132,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  waveBar: {
    width: 3,
    borderRadius: 2,
  },
  durationText: {
    fontSize: 10,
    fontWeight: '600',
    minWidth: 26,
  },
  transcript: {
    marginTop: 8,
    fontSize: 12,
    lineHeight: 17,
    opacity: 0.72,
  },
  rightCol: {
    width: 92,
    alignSelf: 'stretch',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingTop: 2,
    paddingBottom: 1,
  },
  dateText: {
    fontSize: 11,
    fontWeight: '600',
    opacity: 0.5,
    textAlign: 'right',
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconButton: {
    width: 25,
    height: 25,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreButton: {
    width: 22,
    height: 25,
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { TabParamList } from '../../navigation/types';
import { useAuth } from '../../context/AuthContext';
import { useSip } from '../../context/SipContext';
import { Avatar } from '../../components/ui/Avatar';
import {
  API_BASE,
  buildVoicemailStreamUri,
  getVoicemails,
  markVoicemailListened,
  mobileQueryKeys,
  probeVoicemailStreamStatus,
  voicemailQueryUserScope,
} from '../../api/client';
import { consumeVoicemailScopeKeyChange } from '../../api/voicemailClientScope';
import { subscribeToVoicemail } from '../../api/realtime';
import type { Voicemail } from '../../types';
import { spacing } from '../../theme/spacing';

type PrimaryFilter = 'all' | 'new' | 'urgent' | 'old';
type DateFilter = 'any' | 'today' | 'week';

const VM = {
  bg: '#07111f',
  bg2: '#0a1628',
  card: '#101b2f',
  card2: '#14223a',
  cardMuted: '#0d1728',
  border: '#1d304d',
  borderSoft: 'rgba(148, 163, 184, 0.12)',
  text: '#f5f8ff',
  text2: '#a9b8d4',
  text3: '#64748b',
  primary: '#3b82f6',
  primarySoft: 'rgba(59, 130, 246, 0.16)',
  cyan: '#06b6d4',
  cyanSoft: 'rgba(6, 182, 212, 0.14)',
  green: '#22c55e',
  greenSoft: 'rgba(34, 197, 94, 0.14)',
  red: '#fb7185',
  redSoft: 'rgba(251, 113, 133, 0.16)',
  orange: '#f59e0b',
  orangeSoft: 'rgba(245, 158, 11, 0.16)',
  purple: '#a78bfa',
  shadow: '#000000',
};

function formatDuration(sec: number): string {
  const safe = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diffH = (now - date.getTime()) / 3600000;
  if (Number.isNaN(date.getTime())) return '';
  if (diffH < 1) return 'Just now';
  if (diffH < 24) return `${Math.floor(diffH)}h ago`;
  if (diffH < 48) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function callerLabel(vm: Voicemail): string {
  return vm.callerName?.trim() || vm.callerId?.trim() || 'Unknown caller';
}

function hasTranscript(vm: Voicemail): boolean {
  return Boolean(vm.transcription?.trim());
}

function statusFor(vm: Voicemail): 'urgent' | 'new' | 'old' {
  if (vm.folder === 'urgent') return 'urgent';
  if (!vm.listened) return 'new';
  return 'old';
}

function dateMatches(vm: Voicemail, filter: DateFilter): boolean {
  if (filter === 'any') return true;
  const received = new Date(vm.receivedAt).getTime();
  if (Number.isNaN(received)) return true;
  const age = Date.now() - received;
  if (filter === 'today') return age <= 24 * 60 * 60 * 1000;
  return age <= 7 * 24 * 60 * 60 * 1000;
}

export function VoicemailTab() {
  const route = useRoute<RouteProp<TabParamList, 'Voicemail'>>();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const sip = useSip();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Voicemail[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [progress, setProgress] = useState<{ position: number; duration: number }>({ position: 0, duration: 0 });
  const [primaryFilter, setPrimaryFilter] = useState<PrimaryFilter>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('any');
  const [transcriptOnly, setTranscriptOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [menuVm, setMenuVm] = useState<Voicemail | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const removeVoicemailRowEverywhere = useCallback(
    (id: string) => {
      setRows((r) => r.filter((x) => x.id !== id));
      if (!token) return;
      queryClient.setQueryData(mobileQueryKeys.voicemails("all", token), (prev: unknown) => {
        if (!prev || typeof prev !== "object") return prev;
        const p = prev as { voicemails?: Voicemail[]; totals?: Record<string, number> };
        if (!Array.isArray(p.voicemails)) return prev;
        return { ...p, voicemails: p.voicemails.filter((v) => v.id !== id) };
      });
    },
    [queryClient, token],
  );

  const voicemailQuery = useQuery({
    queryKey: mobileQueryKeys.voicemails('all', token),
    enabled: Boolean(token),
    queryFn: () => getVoicemails(token!),
    staleTime: 3 * 60 * 1000,
    gcTime: 20 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!token) {
      consumeVoicemailScopeKeyChange("_");
      setRows([]);
      return;
    }
    const sk = voicemailQueryUserScope(token);
    if (consumeVoicemailScopeKeyChange(sk)) {
      setRows([]);
    }
  }, [token]);

  useEffect(() => {
    const nextRows = voicemailQuery.data?.voicemails;
    if (nextRows !== undefined) setRows(nextRows);
  }, [voicemailQuery.data]);

  // When opened from a voicemail push notification, expand and highlight
  // the specific voicemail. Reset the primary filter to 'all' so the
  // entry is always visible regardless of the current filter state.
  const notifVoicemailId = (route.params as { voicemailId?: string } | undefined)?.voicemailId;
  useEffect(() => {
    if (!notifVoicemailId || rows.length === 0) return;
    const exists = rows.some((vm) => vm.id === notifVoicemailId);
    if (!exists) return;
    setPrimaryFilter('all');
    setExpandedId(notifVoicemailId);
  }, [notifVoicemailId, rows]);

  const loading = voicemailQuery.isLoading && rows.length === 0;
  const refreshing = voicemailQuery.isRefetching;
  const error = voicemailQuery.error && rows.length === 0 ? 'Could not load voicemail.' : null;
  const refetchVoicemail = voicemailQuery.refetch;
  const load = useCallback(() => {
    refetchVoicemail().catch(() => undefined);
  }, [refetchVoicemail]);

  useFocusEffect(
    useCallback(() => {
      if (!voicemailQuery.data || voicemailQuery.isStale) load();
    }, [load, voicemailQuery.data, voicemailQuery.isStale]),
  );

  useEffect(() => {
    if (!token) return undefined;
    return subscribeToVoicemail(() => load());
  }, [load, token]);

  useEffect(() => () => {
    sound?.unloadAsync().catch(() => undefined);
  }, [sound]);

  useEffect(() => {
    if (!playbackError) return undefined;
    const timer = setTimeout(() => setPlaybackError(null), 3200);
    return () => clearTimeout(timer);
  }, [playbackError]);

  const stats = useMemo(() => {
    const urgent = rows.filter((vm) => vm.folder === 'urgent').length;
    const unread = rows.filter((vm) => !vm.listened).length;
    const old = rows.filter((vm) => vm.folder === 'old' || vm.listened).length;
    const transcripts = rows.filter(hasTranscript).length;
    return { urgent, unread, old, transcripts, total: rows.length };
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((vm) => {
        if (primaryFilter === 'new') return !vm.listened;
        if (primaryFilter === 'urgent') return vm.folder === 'urgent';
        if (primaryFilter === 'old') return vm.folder === 'old' || vm.listened;
        return true;
      })
      .filter((vm) => !transcriptOnly || hasTranscript(vm))
      .filter((vm) => dateMatches(vm, dateFilter))
      .filter((vm) =>
        !q ||
        vm.callerId.toLowerCase().includes(q) ||
        (vm.callerName || '').toLowerCase().includes(q) ||
        vm.extension.includes(q) ||
        (vm.transcription || '').toLowerCase().includes(q),
      );
  }, [dateFilter, primaryFilter, query, rows, transcriptOnly]);

  const activeVoicemail = useMemo(
    () => rows.find((vm) => vm.id === activeId) ?? null,
    [activeId, rows],
  );

  const selectionMode = selectedIds.length > 0;

  const updatePlayback = useCallback((status: any) => {
    if (!status?.isLoaded) return;
    const duration = Math.max(0, Math.floor((status.durationMillis || 0) / 1000));
    const position = Math.max(0, Math.floor((status.positionMillis || 0) / 1000));
    setProgress({ position, duration });
    if (status.didJustFinish) setActiveId(null);
  }, []);

  const play = useCallback(async (vm: Voicemail) => {
    if (!token) {
      setPlaybackError('This voicemail cannot be played yet.');
      return;
    }
    const streamUri = buildVoicemailStreamUri(token, vm.id);
    try {
      if (activeId === vm.id && sound) {
        await sound.pauseAsync();
        setActiveId(null);
        return;
      }
      if (sound) await sound.unloadAsync().catch(() => undefined);
      const next = new Audio.Sound();
      await next.loadAsync(
        { uri: streamUri, headers: { Authorization: `Bearer ${token}` } },
        { shouldPlay: true },
      );
      next.setOnPlaybackStatusUpdate(updatePlayback);
      setSound(next);
      setActiveId(vm.id);
      setProgress({ position: 0, duration: vm.durationSec });
      if (!vm.listened) {
        markVoicemailListened(token, vm.id, true)
          .then(() => queryClient.invalidateQueries({ queryKey: ['mobile', 'voicemails'] }).catch(() => undefined))
          .catch(() => undefined);
        setRows((current) => current.map((row) => row.id === vm.id ? { ...row, listened: true } : row));
      }
    } catch {
      const st = await probeVoicemailStreamStatus(token, vm.id);
      if (st === 403) {
        setPlaybackError('This voicemail is not available for your account.');
        removeVoicemailRowEverywhere(vm.id);
        setActiveId(null);
        return;
      }
      setPlaybackError('Could not play voicemail audio.');
      setActiveId(null);
    }
  }, [activeId, queryClient, removeVoicemailRowEverywhere, sound, token, updatePlayback]);

  const toggleListened = useCallback((vm: Voicemail) => {
    if (!token) return;
    const next = !vm.listened;
    markVoicemailListened(token, vm.id, next)
      .then(() => queryClient.invalidateQueries({ queryKey: ['mobile', 'voicemails'] }).catch(() => undefined))
      .catch(() => undefined);
    setRows((current) => current.map((row) => row.id === vm.id ? { ...row, listened: next } : row));
  }, [queryClient, token]);

  const markSelectedRead = useCallback(async () => {
    if (!token || selectedIds.length === 0) return;
    const selected = rows.filter((vm) => selectedIds.includes(vm.id) && !vm.listened);
    setRows((current) => current.map((row) => selectedIds.includes(row.id) ? { ...row, listened: true } : row));
    setSelectedIds([]);
    await Promise.all(selected.map((vm) => markVoicemailListened(token, vm.id, true).catch(() => undefined)));
    queryClient.invalidateQueries({ queryKey: ['mobile', 'voicemails'] }).catch(() => undefined);
  }, [queryClient, rows, selectedIds, token]);

  const callBack = useCallback((vm: Voicemail) => {
    if (sip.registrationState === 'registered' && vm.callerId) sip.dial(vm.callerId);
  }, [sip]);

  const messageCaller = useCallback((vm: Voicemail) => {
    Alert.alert('Message', `Open Chat to message ${callerLabel(vm)}.`);
  }, []);

  const downloadVoicemail = useCallback(async (vm: Voicemail) => {
    if (!token) return;
    try {
      const safeId = vm.id.replace(/[^a-zA-Z0-9_-]/g, '');
      const uri = `${FileSystem.documentDirectory}voicemail-${safeId || Date.now()}.wav`;
      const url = `${API_BASE}/voice/voicemail/${encodeURIComponent(vm.id)}/download`;
      await FileSystem.downloadAsync(url, uri, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setPlaybackError('Voicemail downloaded.');
    } catch {
      setPlaybackError('Could not download voicemail.');
    }
  }, [token]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }, []);

  const clearAdvancedFilters = useCallback(() => {
    setPrimaryFilter('all');
    setDateFilter('any');
    setTranscriptOnly(false);
  }, []);

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + spacing['4'] }]}>
        <Text style={styles.title}>Voicemail</Text>
        <Text style={styles.subtitle}>{stats.unread} new · {stats.total} total</Text>
      </View>

      <VoicemailSearchHeader
        query={query}
        onQueryChange={setQuery}
        onOpenFilters={() => setFilterSheetOpen(true)}
        activeAdvancedCount={(transcriptOnly ? 1 : 0) + (dateFilter !== 'any' ? 1 : 0)}
      />

      <VoicemailFilterChips
        value={primaryFilter}
        stats={stats}
        transcriptOnly={transcriptOnly}
        dateFilter={dateFilter}
        onChange={setPrimaryFilter}
        onClearAdvanced={clearAdvancedFilters}
      />

      {selectionMode && (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionText}>{selectedIds.length} selected</Text>
          <TouchableOpacity style={styles.selectionButton} onPress={markSelectedRead} activeOpacity={0.8}>
            <Ionicons name="checkmark-done-outline" size={16} color={VM.text} />
            <Text style={styles.selectionButtonText}>Mark read</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.selectionIconButton} onPress={() => setSelectedIds([])} activeOpacity={0.8}>
            <Ionicons name="close" size={18} color={VM.text2} />
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <VoicemailSkeletonList />
      ) : error ? (
        <VoicemailState
          icon="alert-circle-outline"
          title="Could not load voicemail"
          subtitle={error}
          actionLabel="Retry"
          onAction={load}
        />
      ) : filtered.length === 0 ? (
        <VoicemailState
          icon={rows.length === 0 ? 'recording-outline' : 'search-outline'}
          title={rows.length === 0 ? 'No voicemails yet.' : 'No voicemails match your filters.'}
          subtitle={rows.length === 0 ? 'New messages will appear here as soon as they arrive.' : 'Try clearing search or changing the active filters.'}
          actionLabel={rows.length === 0 ? 'Refresh' : 'Clear filters'}
          onAction={rows.length === 0 ? load : clearAdvancedFilters}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          bounces={false}
          alwaysBounceVertical={false}
          overScrollMode="never"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={VM.primary} />}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: activeVoicemail ? 164 : spacing['5'] },
          ]}
          renderItem={({ item }) => (
            <VoicemailCard
              vm={item}
              active={activeId === item.id}
              selected={selectedIds.includes(item.id)}
              selectionMode={selectionMode}
              expanded={expandedId === item.id}
              progress={activeId === item.id ? progress : { position: 0, duration: item.durationSec }}
              onPress={() => {
                if (selectionMode) toggleSelected(item.id);
                else setExpandedId((current) => current === item.id ? null : item.id);
              }}
              onLongPress={() => toggleSelected(item.id)}
              onPlay={() => play(item)}
              onCall={() => callBack(item)}
              onMessage={() => messageCaller(item)}
              onMore={() => setMenuVm(item)}
            />
          )}
        />
      )}

      {activeVoicemail && (
        <VoicemailMiniPlayer
          vm={activeVoicemail}
          progress={progress}
          onToggle={() => play(activeVoicemail)}
          onCall={() => callBack(activeVoicemail)}
          bottom={Math.max(insets.bottom, 8) + 72}
        />
      )}

      {playbackError && (
        <View style={[styles.snackbar, { bottom: Math.max(insets.bottom, 8) + (activeVoicemail ? 150 : 86) }]}>
          <Ionicons name="warning-outline" size={16} color={VM.orange} />
          <Text style={styles.snackbarText}>{playbackError}</Text>
        </View>
      )}

      <VoicemailFilterSheet
        visible={filterSheetOpen}
        primaryFilter={primaryFilter}
        dateFilter={dateFilter}
        transcriptOnly={transcriptOnly}
        stats={stats}
        onPrimaryChange={setPrimaryFilter}
        onDateChange={setDateFilter}
        onTranscriptChange={setTranscriptOnly}
        onClear={clearAdvancedFilters}
        onClose={() => setFilterSheetOpen(false)}
      />

      <VoicemailActionMenu
        vm={menuVm}
        onClose={() => setMenuVm(null)}
        onToggleRead={(vm) => {
          setMenuVm(null);
          toggleListened(vm);
        }}
        onDownload={(vm) => {
          setMenuVm(null);
          downloadVoicemail(vm);
        }}
      />
    </View>
  );
}

function VoicemailSearchHeader({
  query,
  activeAdvancedCount,
  onQueryChange,
  onOpenFilters,
}: {
  query: string;
  activeAdvancedCount: number;
  onQueryChange: (next: string) => void;
  onOpenFilters: () => void;
}) {
  return (
    <View style={styles.searchRow}>
      <View style={styles.searchBox}>
        <Ionicons name="search" size={18} color={VM.text3} />
        <TextInput
          value={query}
          onChangeText={onQueryChange}
          placeholder="Search caller, extension, transcript..."
          placeholderTextColor={VM.text3}
          style={styles.searchInput}
          selectionColor={VM.primary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>
      <TouchableOpacity style={styles.filterButton} onPress={onOpenFilters} activeOpacity={0.8}>
        <Ionicons name="options-outline" size={20} color={VM.text} />
        {activeAdvancedCount > 0 && <View style={styles.filterDot} />}
      </TouchableOpacity>
    </View>
  );
}

function VoicemailFilterChips({
  value,
  stats,
  transcriptOnly,
  dateFilter,
  onChange,
  onClearAdvanced,
}: {
  value: PrimaryFilter;
  stats: { unread: number; urgent: number; old: number; total: number; transcripts: number };
  transcriptOnly: boolean;
  dateFilter: DateFilter;
  onChange: (next: PrimaryFilter) => void;
  onClearAdvanced: () => void;
}) {
  const options: Array<{ id: PrimaryFilter; label: string; count: number; color: string }> = [
    { id: 'all', label: 'All', count: stats.total, color: VM.primary },
    { id: 'new', label: 'New', count: stats.unread, color: VM.green },
    { id: 'urgent', label: 'Urgent', count: stats.urgent, color: VM.orange },
    { id: 'old', label: 'Old', count: stats.old, color: VM.text2 },
  ];

  return (
    <View style={styles.chipWrap}>
      {options.map((item) => (
        <FilterChip
          key={item.id}
          label={item.label}
          count={item.count}
          active={value === item.id}
          color={item.color}
          onPress={() => onChange(item.id)}
        />
      ))}
      {(transcriptOnly || dateFilter !== 'any') && (
        <TouchableOpacity style={styles.advancedChip} onPress={onClearAdvanced} activeOpacity={0.8}>
          <Ionicons name="close-circle" size={14} color={VM.cyan} />
          <Text style={styles.advancedChipText}>
            {transcriptOnly ? 'Transcript' : ''}{transcriptOnly && dateFilter !== 'any' ? ' · ' : ''}{dateFilter !== 'any' ? (dateFilter === 'today' ? 'Today' : '7 days') : ''}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function FilterChip({ label, count, active, color, onPress }: { label: string; count: number; active: boolean; color: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[
        styles.filterChip,
        active && { backgroundColor: `${color}24`, borderColor: `${color}66` },
      ]}
      onPress={onPress}
      activeOpacity={0.78}
    >
      <Text style={[styles.filterLabel, { color: active ? color : VM.text2 }]}>{label}</Text>
      <Text style={[styles.filterCount, { color: active ? color : VM.text3 }]}>{count > 99 ? '99+' : count}</Text>
    </TouchableOpacity>
  );
}

type VoicemailCardProps = {
  vm: Voicemail;
  active: boolean;
  selected: boolean;
  selectionMode: boolean;
  expanded: boolean;
  progress: { position: number; duration: number };
  onPress: () => void;
  onLongPress: () => void;
  onPlay: () => void;
  onCall: () => void;
  onMessage: () => void;
  onMore: () => void;
};

function VoicemailCard({
  vm,
  active,
  selected,
  selectionMode,
  expanded,
  progress,
  onPress,
  onLongPress,
  onPlay,
  onCall,
  onMessage,
  onMore,
}: VoicemailCardProps) {
  const status = statusFor(vm);
  const urgent = status === 'urgent';
  const unread = status === 'new';
  const muted = status === 'old';
  const accent = urgent ? VM.orange : unread ? VM.primary : VM.text3;
  const transcript = vm.transcription?.trim();

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onPress}
      onLongPress={onLongPress}
      style={[
        styles.card,
        urgent && styles.cardUrgent,
        unread && styles.cardNew,
        muted && styles.cardMuted,
        selected && styles.cardSelected,
      ]}
    >
      <View style={styles.cardTop}>
        {selectionMode ? (
          <View style={[styles.selectCircle, selected && styles.selectCircleActive]}>
            {selected && <Ionicons name="checkmark" size={16} color={VM.text} />}
          </View>
        ) : (
          <Avatar name={callerLabel(vm)} size="md" />
        )}

        <View style={styles.cardInfo}>
          <View style={styles.cardTitleRow}>
            <Text style={[styles.callerName, muted && styles.mutedText]} numberOfLines={1}>
              {callerLabel(vm)}
            </Text>
            <StatusBadge status={status} />
          </View>
          <Text style={styles.mailboxText} numberOfLines={1}>
            {vm.callerId || 'Unknown number'} · ext {vm.extension}
          </Text>
        </View>

        <View style={styles.cardRight}>
          <Text style={styles.timeText}>{formatTime(vm.receivedAt)}</Text>
          <Text style={styles.durationPill}>{formatDuration(vm.durationSec)}</Text>
        </View>
      </View>

      <View style={styles.playerRow}>
        <TouchableOpacity
          style={[styles.playButton, active && { backgroundColor: VM.primary }]}
          onPress={onPlay}
          activeOpacity={0.78}
        >
          <Ionicons name={active ? 'pause' : 'play'} size={17} color={active ? VM.text : VM.primary} />
        </TouchableOpacity>
        <Waveform active={active} progress={progress} duration={vm.durationSec} accent={accent} />
      </View>

      {transcript && (
        <Text style={styles.transcriptPreview} numberOfLines={expanded ? 8 : 2}>
          {transcript}
        </Text>
      )}

      <View style={styles.actionRow}>
        <TouchableOpacity style={[styles.actionButton, styles.callButton]} onPress={onCall} activeOpacity={0.8}>
          <Ionicons name="call" size={17} color={VM.green} />
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionButton, styles.chatButton]} onPress={onMessage} activeOpacity={0.8}>
          <Ionicons name="chatbubble-ellipses-outline" size={17} color={VM.cyan} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.moreButton} onPress={onMore} activeOpacity={0.8}>
          <Ionicons name="ellipsis-horizontal" size={20} color={VM.text2} />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

function StatusBadge({ status }: { status: 'urgent' | 'new' | 'old' }) {
  const color = status === 'urgent' ? VM.orange : status === 'new' ? VM.primary : VM.text3;
  const bg = status === 'urgent' ? VM.orangeSoft : status === 'new' ? VM.primarySoft : 'rgba(100, 116, 139, 0.12)';
  return (
    <View style={[styles.statusBadge, { backgroundColor: bg, borderColor: `${color}55` }]}>
      <Text style={[styles.statusText, { color }]}>{status === 'urgent' ? 'URGENT' : status === 'new' ? 'NEW' : 'OLD'}</Text>
    </View>
  );
}

function Waveform({
  active,
  progress,
  duration,
  accent,
}: {
  active: boolean;
  progress: { position: number; duration: number };
  duration: number;
  accent: string;
}) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      pulse.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 480, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 480, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  const pct = active
    ? Math.min(1, (progress.position || 0) / Math.max(1, progress.duration || duration || 1))
    : 0;
  const bars = [0.42, 0.72, 0.5, 0.9, 0.58, 0.78, 0.44, 0.62, 0.86, 0.52, 0.74, 0.48, 0.66, 0.82, 0.46, 0.7];

  return (
    <View style={styles.waveBars}>
      {bars.map((height, idx) => {
        const filled = idx / bars.length <= pct;
        const animatedHeight = pulse.interpolate({
          inputRange: [0, 1],
          outputRange: [10 + height * 15, 8 + ((idx % 4) + 1) * 5],
        });
        return (
          <Animated.View
            key={`${idx}-${height}`}
            style={[
              styles.waveBar,
              {
                height: active && filled ? animatedHeight : 10 + height * 15,
                backgroundColor: filled || active ? accent : 'rgba(148, 163, 184, 0.24)',
                opacity: filled ? 0.95 : 0.55,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

function VoicemailMiniPlayer({
  vm,
  progress,
  bottom,
  onToggle,
  onCall,
}: {
  vm: Voicemail;
  progress: { position: number; duration: number };
  bottom: number;
  onToggle: () => void;
  onCall: () => void;
}) {
  const duration = Math.max(1, progress.duration || vm.durationSec || 1);
  const pct = Math.min(1, (progress.position || 0) / duration);
  return (
    <View style={[styles.miniPlayer, { bottom }]}>
      <TouchableOpacity style={styles.miniPlay} onPress={onToggle} activeOpacity={0.8}>
        <Ionicons name="pause" size={18} color={VM.text} />
      </TouchableOpacity>
      <View style={styles.miniInfo}>
        <Text style={styles.miniTitle} numberOfLines={1}>{callerLabel(vm)}</Text>
        <View style={styles.miniProgressTrack}>
          <View style={[styles.miniProgressFill, { width: `${pct * 100}%` }]} />
        </View>
        <Text style={styles.miniTime}>{formatDuration(progress.position)} / {formatDuration(duration)}</Text>
      </View>
      <TouchableOpacity style={styles.miniCall} onPress={onCall} activeOpacity={0.8}>
        <Ionicons name="call" size={18} color={VM.green} />
      </TouchableOpacity>
    </View>
  );
}

function VoicemailActionMenu({
  vm,
  onClose,
  onToggleRead,
  onDownload,
}: {
  vm: Voicemail | null;
  onClose: () => void;
  onToggleRead: (vm: Voicemail) => void;
  onDownload: (vm: Voicemail) => void;
}) {
  const visible = Boolean(vm);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.menuBackdrop} onPress={onClose}>
        <Pressable style={styles.actionMenu} onPress={() => undefined}>
          {vm && (
            <>
              <View style={styles.actionMenuHeader}>
                <Text style={styles.actionMenuTitle} numberOfLines={1}>{callerLabel(vm)}</Text>
                <Text style={styles.actionMenuSubtitle} numberOfLines={1}>
                  {vm.callerId || 'Unknown number'} · {formatDuration(vm.durationSec)}
                </Text>
              </View>
              <MenuAction
                icon={vm.listened ? 'mail-unread-outline' : 'checkmark-done-outline'}
                label={vm.listened ? 'Mark unread' : 'Mark read'}
                onPress={() => onToggleRead(vm)}
              />
              <MenuAction
                icon="download-outline"
                label="Download"
                onPress={() => onDownload(vm)}
              />
              <MenuAction
                icon="archive-outline"
                label="Archive unavailable"
                muted
                onPress={() => {
                  onClose();
                  Alert.alert('Archive', 'Archive is not supported by the current voicemail API.');
                }}
              />
              <MenuAction
                icon="trash-outline"
                label="Delete unavailable"
                danger
                muted
                onPress={() => {
                  onClose();
                  Alert.alert('Delete', 'Delete is not supported by the current voicemail API.');
                }}
              />
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function MenuAction({
  icon,
  label,
  danger,
  muted,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  danger?: boolean;
  muted?: boolean;
  onPress: () => void;
}) {
  const color = danger ? VM.red : muted ? VM.text3 : VM.text;
  return (
    <TouchableOpacity style={styles.menuAction} activeOpacity={0.78} onPress={onPress}>
      <View style={[styles.menuActionIcon, { backgroundColor: danger ? VM.redSoft : 'rgba(148, 163, 184, 0.10)' }]}>
        <Ionicons name={icon} size={18} color={danger ? VM.red : muted ? VM.text3 : VM.cyan} />
      </View>
      <Text style={[styles.menuActionText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function VoicemailFilterSheet({
  visible,
  primaryFilter,
  dateFilter,
  transcriptOnly,
  stats,
  onPrimaryChange,
  onDateChange,
  onTranscriptChange,
  onClear,
  onClose,
}: {
  visible: boolean;
  primaryFilter: PrimaryFilter;
  dateFilter: DateFilter;
  transcriptOnly: boolean;
  stats: { unread: number; urgent: number; old: number; total: number; transcripts: number };
  onPrimaryChange: (next: PrimaryFilter) => void;
  onDateChange: (next: DateFilter) => void;
  onTranscriptChange: (next: boolean) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Voicemail filters</Text>
          <TouchableOpacity onPress={onClose} style={styles.sheetClose}>
            <Ionicons name="close" size={20} color={VM.text2} />
          </TouchableOpacity>
        </View>

        <Text style={styles.sheetSection}>Status</Text>
        <View style={styles.sheetGrid}>
          {([
            ['all', 'All', stats.total],
            ['new', 'New', stats.unread],
            ['urgent', 'Urgent', stats.urgent],
            ['old', 'Old', stats.old],
          ] as Array<[PrimaryFilter, string, number]>).map(([id, label, count]) => (
            <TouchableOpacity
              key={id}
              style={[styles.sheetOption, primaryFilter === id && styles.sheetOptionActive]}
              onPress={() => onPrimaryChange(id)}
              activeOpacity={0.8}
            >
              <Text style={[styles.sheetOptionText, primaryFilter === id && styles.sheetOptionTextActive]}>{label}</Text>
              <Text style={styles.sheetOptionCount}>{count}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.sheetSection}>Content</Text>
        <TouchableOpacity
          style={[styles.sheetRow, transcriptOnly && styles.sheetOptionActive]}
          onPress={() => onTranscriptChange(!transcriptOnly)}
          activeOpacity={0.8}
        >
          <View>
            <Text style={[styles.sheetOptionText, transcriptOnly && styles.sheetOptionTextActive]}>Has transcript</Text>
            <Text style={styles.sheetHint}>{stats.transcripts} messages include transcription</Text>
          </View>
          <Ionicons name={transcriptOnly ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={transcriptOnly ? VM.cyan : VM.text3} />
        </TouchableOpacity>

        <Text style={styles.sheetSection}>Date range</Text>
        <View style={styles.sheetGrid}>
          {([
            ['any', 'Any time'],
            ['today', 'Last 24h'],
            ['week', 'Last 7 days'],
          ] as Array<[DateFilter, string]>).map(([id, label]) => (
            <TouchableOpacity
              key={id}
              style={[styles.sheetOption, dateFilter === id && styles.sheetOptionActive]}
              onPress={() => onDateChange(id)}
              activeOpacity={0.8}
            >
              <Text style={[styles.sheetOptionText, dateFilter === id && styles.sheetOptionTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.unsupportedBox}>
          <Ionicons name="lock-closed-outline" size={16} color={VM.text3} />
          <Text style={styles.unsupportedText}>Saved / archived filters are hidden because the current mobile voicemail API does not expose archive state.</Text>
        </View>

        <TouchableOpacity style={styles.clearButton} onPress={onClear} activeOpacity={0.8}>
          <Text style={styles.clearButtonText}>Clear filters</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

function VoicemailSkeletonList() {
  return (
    <View style={styles.list}>
      {Array.from({ length: 5 }).map((_, idx) => (
        <View key={idx} style={styles.skeletonCard}>
          <View style={styles.skeletonAvatar} />
          <View style={styles.skeletonBody}>
            <View style={[styles.skeletonLine, { width: '60%' }]} />
            <View style={[styles.skeletonLine, { width: '42%' }]} />
            <View style={styles.skeletonWave}>
              {Array.from({ length: 12 }).map((__, barIdx) => <View key={barIdx} style={[styles.skeletonBar, { height: 10 + (barIdx % 4) * 4 }]} />)}
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

function VoicemailState({
  icon,
  title,
  subtitle,
  actionLabel,
  onAction,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <View style={styles.stateWrap}>
      <View style={styles.stateIcon}>
        <Ionicons name={icon} size={28} color={VM.primary} />
      </View>
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateSubtitle}>{subtitle}</Text>
      <TouchableOpacity style={styles.stateButton} onPress={onAction} activeOpacity={0.82}>
        <Text style={styles.stateButtonText}>{actionLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: VM.bg,
  },
  header: {
    alignItems: 'center',
    paddingHorizontal: spacing['5'],
    paddingBottom: spacing['4'],
  },
  title: {
    color: VM.text,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.7,
  },
  subtitle: {
    marginTop: 3,
    color: VM.text2,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['5'],
    gap: spacing['3'],
    marginBottom: spacing['3'],
  },
  searchBox: {
    flex: 1,
    height: 54,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: VM.border,
    backgroundColor: VM.card,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['4'],
    gap: spacing['3'],
  },
  searchInput: {
    flex: 1,
    color: VM.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '600',
  },
  filterButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: VM.border,
    backgroundColor: VM.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterDot: {
    position: 'absolute',
    top: 11,
    right: 12,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: VM.cyan,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing['2'],
    paddingHorizontal: spacing['5'],
    marginBottom: spacing['3'],
  },
  filterChip: {
    minHeight: 38,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: VM.borderSoft,
    backgroundColor: 'rgba(16, 27, 47, 0.78)',
    paddingHorizontal: spacing['3'],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['2'],
  },
  filterLabel: {
    fontSize: 13,
    fontWeight: '800',
    includeFontPadding: false,
  },
  filterCount: {
    fontSize: 12,
    fontWeight: '800',
    includeFontPadding: false,
  },
  advancedChip: {
    minHeight: 38,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: `${VM.cyan}44`,
    backgroundColor: VM.cyanSoft,
    paddingHorizontal: spacing['3'],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['1.5'],
  },
  advancedChipText: {
    color: VM.cyan,
    fontSize: 12,
    fontWeight: '800',
  },
  selectionBar: {
    marginHorizontal: spacing['5'],
    marginBottom: spacing['3'],
    minHeight: 48,
    borderRadius: 18,
    backgroundColor: VM.card2,
    borderWidth: 1,
    borderColor: VM.border,
    paddingHorizontal: spacing['3'],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['2'],
  },
  selectionText: {
    flex: 1,
    color: VM.text,
    fontSize: 14,
    fontWeight: '800',
  },
  selectionButton: {
    height: 34,
    borderRadius: 15,
    paddingHorizontal: spacing['3'],
    backgroundColor: VM.primary,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['1.5'],
  },
  selectionButtonText: {
    color: VM.text,
    fontSize: 12,
    fontWeight: '800',
  },
  selectionIconButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
  },
  list: {
    paddingHorizontal: spacing['5'],
    paddingTop: spacing['1'],
  },
  card: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: VM.borderSoft,
    backgroundColor: VM.card,
    padding: spacing['4'],
    marginBottom: spacing['3'],
    shadowColor: VM.shadow,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.16,
    shadowRadius: 24,
    elevation: 5,
  },
  cardNew: {
    borderColor: `${VM.primary}44`,
    backgroundColor: '#111f37',
  },
  cardUrgent: {
    borderColor: `${VM.orange}66`,
    backgroundColor: '#1c1a22',
  },
  cardMuted: {
    backgroundColor: VM.cardMuted,
    opacity: 0.92,
  },
  cardSelected: {
    borderColor: VM.primary,
    backgroundColor: '#132745',
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['3'],
  },
  selectCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 2,
    borderColor: VM.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectCircleActive: {
    backgroundColor: VM.primary,
    borderColor: VM.primary,
  },
  cardInfo: {
    flex: 1,
    minWidth: 0,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['2'],
  },
  callerName: {
    flex: 1,
    color: VM.text,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '800',
    letterSpacing: -0.25,
  },
  mutedText: {
    color: VM.text2,
  },
  mailboxText: {
    marginTop: 2,
    color: VM.text2,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  cardRight: {
    alignItems: 'flex-end',
    gap: spacing['1.5'],
  },
  timeText: {
    color: VM.text3,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
  },
  durationPill: {
    color: VM.text2,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(148, 163, 184, 0.10)',
    overflow: 'hidden',
  },
  statusBadge: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  statusText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '900',
    letterSpacing: 0.5,
    includeFontPadding: false,
  },
  playerRow: {
    marginTop: spacing['4'],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['3'],
  },
  playButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: VM.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  waveBars: {
    flex: 1,
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  waveBar: {
    flex: 1,
    maxWidth: 6,
    borderRadius: 3,
  },
  transcriptPreview: {
    marginTop: spacing['3'],
    color: VM.text2,
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '500',
  },
  actionRow: {
    marginTop: spacing['4'],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing['2'],
  },
  actionButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callButton: {
    backgroundColor: VM.greenSoft,
  },
  chatButton: {
    backgroundColor: VM.cyanSoft,
  },
  moreButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(148, 163, 184, 0.10)',
  },
  miniPlayer: {
    position: 'absolute',
    left: spacing['5'],
    right: spacing['5'],
    minHeight: 72,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: `${VM.primary}55`,
    backgroundColor: '#0f213c',
    padding: spacing['3'],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['3'],
    shadowColor: VM.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 24,
    elevation: 10,
  },
  miniPlay: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: VM.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniInfo: {
    flex: 1,
    minWidth: 0,
  },
  miniTitle: {
    color: VM.text,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
  },
  miniProgressTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(148, 163, 184, 0.20)',
    marginTop: 8,
    overflow: 'hidden',
  },
  miniProgressFill: {
    height: 5,
    borderRadius: 3,
    backgroundColor: VM.cyan,
  },
  miniTime: {
    marginTop: 5,
    color: VM.text2,
    fontSize: 11,
    fontWeight: '700',
  },
  miniCall: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: VM.greenSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  snackbar: {
    position: 'absolute',
    left: spacing['5'],
    right: spacing['5'],
    minHeight: 44,
    borderRadius: 16,
    backgroundColor: '#211827',
    borderWidth: 1,
    borderColor: `${VM.orange}55`,
    paddingHorizontal: spacing['3'],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['2'],
  },
  snackbarText: {
    flex: 1,
    color: VM.text,
    fontSize: 13,
    fontWeight: '700',
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.58)',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing['5'],
    paddingBottom: spacing['8'],
  },
  actionMenu: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: VM.border,
    backgroundColor: '#0d182b',
    padding: spacing['3'],
    shadowColor: VM.shadow,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.35,
    shadowRadius: 28,
    elevation: 14,
  },
  actionMenuHeader: {
    paddingHorizontal: spacing['2'],
    paddingBottom: spacing['3'],
    marginBottom: spacing['1'],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: VM.border,
  },
  actionMenuTitle: {
    color: VM.text,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '900',
  },
  actionMenuSubtitle: {
    color: VM.text3,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
    marginTop: 2,
  },
  menuAction: {
    minHeight: 52,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['2'],
    gap: spacing['3'],
  },
  menuActionIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuActionText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '800',
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.58)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: VM.bg2,
    borderTopWidth: 1,
    borderColor: VM.border,
    paddingHorizontal: spacing['5'],
    paddingTop: spacing['3'],
    paddingBottom: spacing['8'],
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 42,
    height: 5,
    borderRadius: 3,
    backgroundColor: VM.border,
    marginBottom: spacing['4'],
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing['4'],
  },
  sheetTitle: {
    flex: 1,
    color: VM.text,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  sheetClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(148, 163, 184, 0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetSection: {
    color: VM.text3,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: spacing['2'],
    marginTop: spacing['2'],
  },
  sheetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing['2'],
    marginBottom: spacing['2'],
  },
  sheetOption: {
    minHeight: 44,
    minWidth: '47%',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: VM.borderSoft,
    backgroundColor: VM.card,
    paddingHorizontal: spacing['3'],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetOptionActive: {
    borderColor: `${VM.cyan}66`,
    backgroundColor: VM.cyanSoft,
  },
  sheetOptionText: {
    color: VM.text2,
    fontSize: 14,
    fontWeight: '800',
  },
  sheetOptionTextActive: {
    color: VM.text,
  },
  sheetOptionCount: {
    color: VM.text3,
    fontSize: 12,
    fontWeight: '900',
  },
  sheetRow: {
    minHeight: 58,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: VM.borderSoft,
    backgroundColor: VM.card,
    paddingHorizontal: spacing['3'],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetHint: {
    color: VM.text3,
    fontSize: 12,
    marginTop: 2,
    fontWeight: '600',
  },
  unsupportedBox: {
    marginTop: spacing['3'],
    borderRadius: 16,
    borderWidth: 1,
    borderColor: VM.borderSoft,
    backgroundColor: 'rgba(148, 163, 184, 0.08)',
    padding: spacing['3'],
    flexDirection: 'row',
    gap: spacing['2'],
  },
  unsupportedText: {
    flex: 1,
    color: VM.text3,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600',
  },
  clearButton: {
    marginTop: spacing['4'],
    height: 48,
    borderRadius: 18,
    backgroundColor: VM.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearButtonText: {
    color: VM.text,
    fontSize: 14,
    fontWeight: '900',
  },
  skeletonCard: {
    borderRadius: 24,
    backgroundColor: VM.card,
    padding: spacing['4'],
    marginBottom: spacing['3'],
    flexDirection: 'row',
    gap: spacing['3'],
    borderWidth: 1,
    borderColor: VM.borderSoft,
  },
  skeletonAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
  },
  skeletonBody: {
    flex: 1,
    gap: spacing['2'],
  },
  skeletonLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
  },
  skeletonWave: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: spacing['2'],
  },
  skeletonBar: {
    width: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
  },
  stateWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing['8'],
    paddingBottom: spacing['20'],
  },
  stateIcon: {
    width: 64,
    height: 64,
    borderRadius: 24,
    backgroundColor: VM.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing['4'],
  },
  stateTitle: {
    color: VM.text,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '900',
    textAlign: 'center',
  },
  stateSubtitle: {
    marginTop: spacing['2'],
    color: VM.text2,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '600',
    textAlign: 'center',
  },
  stateButton: {
    marginTop: spacing['5'],
    height: 46,
    borderRadius: 18,
    paddingHorizontal: spacing['5'],
    backgroundColor: VM.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateButtonText: {
    color: VM.text,
    fontSize: 14,
    fontWeight: '900',
  },
});

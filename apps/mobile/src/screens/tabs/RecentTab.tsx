import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { markRecentsSeen } from '../../navigation/badges';
import * as Haptics from 'expo-haptics';
import {
  Animated,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  PanResponder,
  Platform,
  TextInput,
  Modal,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useSip } from '../../context/SipContext';
import { Avatar, colorForName } from '../../components/ui/Avatar';
import { EmptyState } from '../../components/ui/EmptyState';
import { HorizontalFilterScroll } from '../../components/ui/HorizontalFilterScroll';
import { AppActionSheet } from '../../components/ui/AppPopup';
import { showAppAlert } from '../../components/ui/appAlert';
import { getCallHistory, getContacts, getVoiceExtension, mobileQueryKeys } from '../../api/client';
import { loadLocalCallHistory, mergeCallRecords } from '../../storage/callHistory';
import {
  normalizeCallerIdentity,
  callerDisplayLines,
  callbackNumber,
  suggestedContactName,
  phoneMatchKey,
  type CallerDirection,
  type NormalizedCallerIdentity,
} from '../../calls/callerIdentity';
import { useQueryClient } from '@tanstack/react-query';
import { AddContactModal, type AddContactPrefill } from '../../components/AddContactModal';
import type { CallRecord } from '../../types';
import { typography } from '../../theme/typography';
import { teamFilterChipColors } from '../../theme/filterChipColors';
import { radius, spacing } from '../../theme/spacing';

type CallFilter = 'all' | 'missed' | 'incoming' | 'outgoing';
type CallKind = 'missed' | 'incoming' | 'outgoing' | 'internal' | 'voicemail' | 'answered_elsewhere';

type CallGroup = {
  type: 'group';
  id: string;
  calls: CallRecord[];
  canonicalNumber: string;
  displayName: string;
  /** External phone number shown as the row's secondary line (null when the
   *  primary line is already the number, or there is no usable number). */
  secondaryNumber: string | null;
  /** Ring-group / context prefix badge (e.g. "Sales"), null when absent. */
  prefixBadge: string | null;
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
  if (disposition === 'answered_elsewhere') return 'answered_elsewhere';
  // HARD RULE (Izzy, 2026-07-28): a call the USER placed can never be "missed"
  // — only INBOUND calls can. A bad upstream disposition (e.g. the far side
  // not answering an outbound call recorded as "missed") must still render as
  // a plain outgoing call. Server-side fix exists too; this is the belt.
  if (
    isInboundCall(call) &&
    (disposition === 'missed' || disposition === 'no_answer' || call.durationSec === 0)
  ) {
    return 'missed';
  }
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

function callDirectionKind(call: CallRecord): CallerDirection {
  if (isInternalDirection(call)) return 'internal';
  if (isInboundCall(call)) return 'inbound';
  return 'outbound';
}

/**
 * Build the normalized caller identity for a recent-call row using the shared
 * caller-identity helper. This keeps the external number, ring-group prefix,
 * and caller name separate so the number is never hidden behind a name.
 *
 * Handles two record shapes:
 *   - new records: `fromName` carries the PBX CallerID name (may include the
 *     "Prefix:Caller" ring-group form), `fromNumber` carries the real number.
 *   - legacy local records: the raw SIP display name was stored in
 *     `fromNumber` (e.g. "New Tires:New Tires:") with no `fromName`.
 */
/** The logged-in user's own extension identity, so it is never shown as the
 *  remote party (e.g. the "Home" extension name on outbound/inbound rows). */
type SelfIdentity = { names: string[]; numbers: string[] };

function callIdentity(call: CallRecord, self?: SelfIdentity): NormalizedCallerIdentity {
  const legacyDisplayInNumber =
    (!call.fromName || !call.fromName.trim()) &&
    isInboundCall(call) &&
    (call.fromNumber || '').includes(':');
  return normalizeCallerIdentity({
    number: legacyDisplayInNumber ? '' : call.fromNumber,
    displayName: legacyDisplayInNumber ? call.fromNumber : call.fromName,
    toNumber: call.toNumber,
    direction: callDirectionKind(call),
    selfNames: self?.names,
    selfExtensionNumbers: self?.numbers,
    ringGroupPrefix: call.fromPrefix,
    tenantId: call.tenantId,
  });
}

function callDisplayNumber(call: CallRecord, self?: SelfIdentity): string {
  const id = callIdentity(call, self);
  return id.externalNumber || id.extensionNumber || id.rawSipCallerId || (isInboundCall(call) ? call.fromNumber : call.toNumber);
}

function callDisplayName(call: CallRecord, self?: SelfIdentity): string {
  return callerDisplayLines(callIdentity(call, self)).primary;
}

function isUnknownCaller(call: CallRecord, self?: SelfIdentity): boolean {
  const lines = callerDisplayLines(callIdentity(call, self));
  return lines.primary === 'Unknown';
}

function kindAccent(kind: CallKind, colors: ReturnType<typeof useTheme>['colors']): string {
  switch (kind) {
    case 'missed': return colors.danger;
    case 'incoming': return colors.teal;
    case 'outgoing': return colors.success;
    case 'internal': return colors.purple;
    case 'voicemail': return colors.indigo;
    case 'answered_elsewhere': return colors.textSecondary;
  }
}

function kindIcon(kind: CallKind): keyof typeof Ionicons.glyphMap {
  switch (kind) {
    case 'missed': return 'call-outline';
    case 'incoming': return 'arrow-down';
    case 'outgoing': return 'arrow-up';
    case 'internal': return 'swap-horizontal-outline';
    case 'voicemail': return 'recording-outline';
    case 'answered_elsewhere': return 'phone-portrait-outline';
  }
}

function kindLabel(kind: CallKind): string {
  switch (kind) {
    case 'missed': return 'Missed';
    case 'incoming': return 'Incoming';
    case 'outgoing': return 'Outgoing';
    case 'internal': return 'Internal';
    case 'voicemail': return 'Voicemail';
    case 'answered_elsewhere': return 'Answered on another device';
  }
}

/**
 * Fold consecutive calls (ordered newest → oldest) that share the same day,
 * canonical number, and kind. Preserves every underlying CallRecord inside
 * `calls` so the detail sheet can still list individual attempts.
 */
function buildGroups(
  rows: CallRecord[],
  resolveContactName?: (number: string | null) => string | null,
  self?: SelfIdentity,
): CallGroup[] {
  const groups: CallGroup[] = [];
  for (const call of rows) {
    const kind = callKind(call);
    const number = canonicalNumber(callDisplayNumber(call, self));
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
      const identity = callIdentity(call, self);
      const resolvedName = resolveContactName?.(identity.externalNumber) ?? null;
      const lines = callerDisplayLines(
        resolvedName ? { ...identity, displayName: resolvedName } : identity,
      );
      groups.push({
        type: 'group',
        id: `grp:${kind}:${number}:${day}:${call.id}`,
        calls: [call],
        canonicalNumber: number,
        displayName: lines.primary,
        secondaryNumber: lines.secondary,
        prefixBadge: lines.prefixBadge,
        kind,
        latestAt: call.startedAt,
        earliestAt: call.startedAt,
        count: 1,
        totalDurationSec: Math.max(0, call.durationSec || 0),
        maxDurationSec: Math.max(0, call.durationSec || 0),
        unknown: isUnknownCaller(call, self),
      });
    }
  }
  return groups;
}

export function RecentTab() {
  const { colors } = useTheme();
  const { token } = useAuth();
  const nav = useNavigation<any>();
  const sip = useSip();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<CallFilter>('all');
  const [query, setQuery] = useState('');
  const [detailGroup, setDetailGroup] = useState<CallGroup | null>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [menuGroup, setMenuGroup] = useState<CallGroup | null>(null);
  const [addContactPrefill, setAddContactPrefill] = useState<AddContactPrefill | null>(null);

  const callHistoryQuery = useQuery({
    queryKey: mobileQueryKeys.callHistory,
    enabled: Boolean(token),
    queryFn: async () => {
      const local = await loadLocalCallHistory();
      if (!token) return local;
      const remote = await getCallHistory(token);
      return mergeCallRecords(remote, local);
    },
    staleTime: 3 * 60 * 1000,
    gcTime: 20 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  // Tenant contacts — used to (a) resolve a saved contact name onto recent-call
  // rows and (b) dedupe before creating a new contact from a recent call.
  const contactsQuery = useQuery({
    queryKey: mobileQueryKeys.contacts(''),
    enabled: Boolean(token),
    queryFn: () => getContacts(token!, ''),
    staleTime: 3 * 60 * 1000,
    gcTime: 20 * 60 * 1000,
    // Refetch on mount when stale so a contact added elsewhere (Contacts tab /
    // Add-to-Contacts) — which invalidates this same key — shows its name on the
    // recent-call rows the next time the tab opens, instead of waiting for gc.
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  // canonical phone key → saved contact display name. Using phoneMatchKey (not a
  // raw digit string) means a contact stored as "+1 347-971-8687" still matches a
  // CDR's national "3479718687" — the directory holds a mix of 10- and 11-digit
  // forms, so an exact digit match would silently fail to resolve the name.
  const contactNameByDigits = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contactsQuery.data?.rows ?? []) {
      for (const p of c.phones ?? []) {
        const key = phoneMatchKey(p.numberRaw);
        if (key && !map.has(key)) map.set(key, c.displayName);
      }
    }
    return map;
  }, [contactsQuery.data]);

  const resolveContactName = useCallback(
    (number: string | null): string | null => {
      const key = phoneMatchKey(number);
      if (!key) return null;
      return contactNameByDigits.get(key) ?? null;
    },
    [contactNameByDigits],
  );

  // The logged-in user's own extension, so its name (e.g. "Home") is never
  // shown as the remote party on a call row.
  const voiceExtensionQuery = useQuery({
    queryKey: ['mobile', 'voiceExtension'],
    enabled: Boolean(token),
    queryFn: () => getVoiceExtension(token!),
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  const self = useMemo<SelfIdentity>(() => {
    const v = voiceExtensionQuery.data;
    const names = [v?.displayName].filter((x): x is string => Boolean(x && x.trim()));
    const numbers = [v?.extensionNumber, v?.sipUsername?.replace(/_\d+$/, '')].filter(
      (x): x is string => Boolean(x && x.trim()),
    );
    return { names, numbers };
  }, [voiceExtensionQuery.data]);

  const calls = callHistoryQuery.data ?? [];
  const loading = callHistoryQuery.isLoading && calls.length === 0;
  // Spinner shows ONLY on a user pull-to-refresh; background/focus refetches stay silent.
  const [refreshing, setRefreshing] = useState(false);
  const error = callHistoryQuery.error && calls.length === 0 ? 'Could not load call history from server.' : null;
  const refetchCallHistory = callHistoryQuery.refetch;
  const load = useCallback(() => {
    refetchCallHistory().catch(() => undefined);
  }, [refetchCallHistory]);
  const onUserRefresh = useCallback(() => {
    setRefreshing(true);
    refetchCallHistory().catch(() => undefined).finally(() => setRefreshing(false));
  }, [refetchCallHistory]);

  useFocusEffect(
    useCallback(() => {
      // Viewing Recents clears the missed-call tab badge (Izzy 2026-07-28).
      markRecentsSeen(queryClient);
      if (!callHistoryQuery.data || callHistoryQuery.isStale) load();
    }, [callHistoryQuery.data, callHistoryQuery.isStale, load, queryClient]),
  );

  // Reload 3 seconds after a call ends (gives the append a moment to settle)
  const { callState } = useSip();
  const prevCallRef = useRef(callState);
  useEffect(() => {
    const prev = prevCallRef.current;
    prevCallRef.current = callState;
    if (callState === 'idle' && (prev === 'ended' || prev === 'connected')) {
      const t = setTimeout(() => load(), 3000);
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
    const number = (group.canonicalNumber || '').trim();
    if (!number) {
      showAppAlert('Message', `No number is available for ${group.displayName}.`);
      return;
    }
    // Internal calls (extension ↔ extension) open a DM; everything else SMS.
    const kind = group.kind === 'internal' ? 'internal' : 'external';
    nav.navigate('Chat', { composeNumber: number, composeName: group.displayName, composeKind: kind });
  }, [nav]);

  // Stable renderItem (freeze investigation 2026-07-28): an inline closure
  // defeats CallCard's memo on every parent render — new data landing then
  // re-renders every mounted row (measured view storms).
  const renderRecentItem = useCallback(({ item }: { item: any }) =>
    item.type === 'section' ? (
      <Text style={[styles.sectionLabel, { color: colors.textTertiary }]}>{item.title}</Text>
    ) : (
      <CallCard
        group={item}
        onOpen={() => setDetailGroup(item)}
        onCall={() => handleCall(item.canonicalNumber || callDisplayNumber(item.calls[0]))}
        onMessage={() => handleMessage(item)}
        onMore={() => setMenuGroup(item)}
      />
    ), [colors.textTertiary, handleCall, handleMessage]);

  const handleAddContact = useCallback(
    (group: CallGroup) => {
      const primaryCall = group.calls[0];
      const identity = callIdentity(primaryCall, self);
      const number = callbackNumber(identity);

      // No usable external/extension number — cannot create a contact.
      if (!number) {
        showAppAlert(
          'No phone number',
          'This recent call has no usable phone number, so it can’t be saved as a contact.',
        );
        return;
      }

      // Dedupe: if a contact already has this number, don't open the form.
      const existingName = resolveContactName(number);
      if (existingName) {
        showAppAlert('Already in contacts', `${existingName} already has this number.`);
        return;
      }

      // Open the editable contact form pre-filled with the external number and
      // a caller name only when the PBX delivered a real caller ID (never the
      // user's own extension name). The user reviews/edits and adds details.
      const suggested = suggestedContactName(identity);
      const first = suggested ? suggested.split(/\s+/)[0] : '';
      const last = suggested ? suggested.split(/\s+/).slice(1).join(' ') : '';
      setMenuGroup(null);
      setDetailGroup(null);
      setAddContactPrefill({ phone: number, firstName: first, lastName: last });
    },
    [resolveContactName, self],
  );

  const handleContactCreated = useCallback(
    (saved?: { displayName: string }) => {
      setAddContactPrefill(null);
      queryClient
        .invalidateQueries({ queryKey: mobileQueryKeys.contacts('') })
        .catch(() => undefined);
      if (saved?.displayName) {
        showAppAlert('Saved', `${saved.displayName} added to contacts.`);
      }
    },
    [queryClient],
  );

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
          callDisplayName(call, self).toLowerCase().includes(q) ||
          callDisplayNumber(call, self).toLowerCase().includes(q) ||
          call.fromNumber.toLowerCase().includes(q) ||
          call.toNumber.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    const groups = buildGroups(filtered, resolveContactName, self);
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
  }, [calls, filter, query, resolveContactName, self]);

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
          onPress={() => setFilterMenuOpen(true)}
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
          // iOS needs bounce enabled for pull-to-refresh; Android unchanged
          // (see IOS_WORK_ANDROID_GUARDRAILS.md).
          bounces={Platform.OS === 'ios'}
          alwaysBounceVertical={Platform.OS === 'ios'}
          overScrollMode="never"
          renderItem={renderRecentItem}
          contentContainerStyle={{ paddingBottom: spacing['5'], paddingHorizontal: spacing['5'] }}
          initialNumToRender={10}
          maxToRenderPerBatch={8}
          updateCellsBatchingPeriod={60}
          windowSize={5}
          removeClippedSubviews
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onUserRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surface}
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
      <AppActionSheet
        visible={filterMenuOpen}
        title="Filter calls"
        message="Choose which calls to show."
        onClose={() => setFilterMenuOpen(false)}
        actions={[
          { label: 'All', icon: filter === 'all' ? 'checkmark-circle' : 'ellipse-outline', onPress: () => setFilter('all') },
          { label: 'Missed', icon: filter === 'missed' ? 'checkmark-circle' : 'call-outline', onPress: () => setFilter('missed') },
          { label: 'Incoming', icon: filter === 'incoming' ? 'checkmark-circle' : 'arrow-down-outline', onPress: () => setFilter('incoming') },
          { label: 'Outgoing', icon: filter === 'outgoing' ? 'checkmark-circle' : 'arrow-up-outline', onPress: () => setFilter('outgoing') },
        ]}
      />
      <AppActionSheet
        visible={Boolean(menuGroup)}
        title={menuGroup?.displayName}
        message={menuGroup ? `${kindLabel(menuGroup.kind)} · ${formatFullDateTime(menuGroup.latestAt)}` : undefined}
        onClose={() => setMenuGroup(null)}
        actions={[
          {
            label: 'Call back',
            icon: 'call-outline',
            onPress: () => menuGroup && handleCall(menuGroup.canonicalNumber || callDisplayNumber(menuGroup.calls[0])),
          },
          { label: 'Message', icon: 'chatbubble-ellipses-outline', onPress: () => menuGroup && handleMessage(menuGroup) },
          { label: 'Add to contacts', icon: 'person-add-outline', onPress: () => menuGroup && handleAddContact(menuGroup) },
        ]}
      />
      <AddContactModal
        visible={Boolean(addContactPrefill)}
        prefill={addContactPrefill ?? undefined}
        title="Add to Contacts"
        onClose={() => setAddContactPrefill(null)}
        onCreated={handleContactCreated}
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

function UnknownAvatar({ size = 40, seed = '' }: { size?: number; seed?: string }) {
  // Same hash-colored circle as named contacts (seeded by the number) with a
  // person glyph — matches the Avatar component's unknown-number treatment so
  // unknown callers no longer look like a washed-out dead state.
  const [bg] = colorForName(seed || 'Unknown');
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ionicons name="person" size={Math.round(size * 0.55)} color="#fff" />
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

  // Right = Call (green), Left = Message (teal). Directional, rubber-banded drag
  // that only claims the gesture once it is clearly horizontal (so it never
  // fights the list's vertical scroll on iOS), arms with a light haptic and
  // commits with a firmer one, then springs cleanly back.
  const ACTION_THRESHOLD = 64;
  const MAX_DRAG = 104;
  const armedRef = useRef<null | 'call' | 'message'>(null);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.7,
        onPanResponderGrant: () => {
          armedRef.current = null;
        },
        onPanResponderMove: (_, gesture) => {
          let dx = gesture.dx;
          if (dx > ACTION_THRESHOLD) dx = ACTION_THRESHOLD + (dx - ACTION_THRESHOLD) * 0.35;
          else if (dx < -ACTION_THRESHOLD) dx = -ACTION_THRESHOLD + (dx + ACTION_THRESHOLD) * 0.35;
          translateX.setValue(Math.max(-MAX_DRAG, Math.min(dx, MAX_DRAG)));
          const armed =
            gesture.dx > ACTION_THRESHOLD ? 'call' : gesture.dx < -ACTION_THRESHOLD ? 'message' : null;
          if (armed !== armedRef.current) {
            armedRef.current = armed;
            if (armed) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
            }
          }
        },
        onPanResponderRelease: (_, gesture) => {
          const action =
            gesture.dx > ACTION_THRESHOLD ? 'call' : gesture.dx < -ACTION_THRESHOLD ? 'message' : null;
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            speed: 18,
            bounciness: 8,
          }).start();
          armedRef.current = null;
          if (action) {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
            // Defer so the row visibly springs back before we navigate away.
            setTimeout(() => {
              if (action === 'call') onCall();
              else onMessage();
            }, 10);
          }
        },
        onPanResponderTerminate: () => {
          armedRef.current = null;
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
        },
      }),
    [onCall, onMessage, translateX],
  );

  const callHintOpacity = translateX.interpolate({
    inputRange: [0, ACTION_THRESHOLD],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const callHintScale = translateX.interpolate({
    inputRange: [0, ACTION_THRESHOLD],
    outputRange: [0.6, 1],
    extrapolate: 'clamp',
  });
  const msgHintOpacity = translateX.interpolate({
    inputRange: [-ACTION_THRESHOLD, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const msgHintScale = translateX.interpolate({
    inputRange: [-ACTION_THRESHOLD, 0],
    outputRange: [1, 0.6],
    extrapolate: 'clamp',
  });

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

  // Special dispositions render as a compact colored status tag (not plain
  // meta text) so the full phrase stays on one row with a clean 2026 look.
  const dispositionTag = useMemo<
    { label: string; icon: keyof typeof Ionicons.glyphMap; color: string; bg: string; border: string } | null
  >(() => {
    if (group.count > 1) return null;
    if (group.kind === 'answered_elsewhere') {
      return {
        label: 'Answered on another device',
        icon: 'swap-horizontal',
        color: '#a5b4fc',
        bg: 'rgba(99,102,241,0.14)',
        border: 'rgba(99,102,241,0.34)',
      };
    }
    return null;
  }, [group.kind, group.count]);

  const primaryCall = group.calls[0];
  const primaryName = group.displayName;

  return (
    <View style={styles.swipeWrap}>
      <View style={styles.swipeBg}>
        <Animated.View
          style={[
            styles.swipeHint,
            {
              backgroundColor: colors.successMuted,
              opacity: callHintOpacity,
              transform: [{ scale: callHintScale }],
            },
          ]}
        >
          <Ionicons name="call" size={18} color={colors.success} />
        </Animated.View>
        <Animated.View
          style={[
            styles.swipeHint,
            {
              backgroundColor: colors.tealMuted,
              opacity: msgHintOpacity,
              transform: [{ scale: msgHintScale }],
            },
          ]}
        >
          <Ionicons name="chatbubble-ellipses" size={18} color={colors.teal} />
        </Animated.View>
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
              <UnknownAvatar size={44} seed={callDisplayNumber(primaryCall) || group.displayName} />
            ) : (
              <Avatar name={primaryName || callDisplayNumber(primaryCall) || 'Unknown'} size="md" />
            )}
          </View>

          <View style={styles.info}>
            <View style={styles.nameRow}>
              {group.prefixBadge ? (
                <View style={[styles.prefixBadge, { backgroundColor: accent + '1f', borderColor: accent + '40' }]}>
                  <Text style={[styles.prefixBadgeText, { color: accent }]} numberOfLines={1}>
                    {group.prefixBadge}
                  </Text>
                </View>
              ) : null}
              <Text style={[styles.nameText, { color: colors.text }]} numberOfLines={1}>
                {primaryName}
              </Text>
            </View>
            {group.secondaryNumber ? (
              <Text style={[styles.numberText, { color: colors.textSecondary }]} numberOfLines={1}>
                {group.secondaryNumber}
              </Text>
            ) : null}
            <View style={styles.metaRow}>
              {dispositionTag ? (
                <View style={[styles.statusTag, { backgroundColor: dispositionTag.bg, borderColor: dispositionTag.border }]}>
                  <Text style={[styles.statusTagText, { color: dispositionTag.color }]} numberOfLines={1}>
                    {dispositionTag.label}
                  </Text>
                </View>
              ) : (
                <>
                  <Ionicons name={kindIcon(group.kind)} size={13} color={accent} style={styles.kindIcon} />
                  <Text style={[styles.metaText, { color: colors.textSecondary }]} numberOfLines={1}>
                    {subtitle}
                  </Text>
                </>
              )}
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
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={[styles.actionBtn, { backgroundColor: colors.tealMuted, borderColor: colors.teal + '33' }]}
              >
                <Ionicons name="chatbubble-ellipses-outline" size={15} color={colors.teal} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onCall}
                activeOpacity={0.74}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={[
                  styles.actionBtn,
                  styles.actionBtnPrimary,
                  { backgroundColor: colors.primary, borderColor: colors.primary, shadowColor: colors.primary },
                ]}
              >
                <Ionicons name="call" size={16} color="#fff" />
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
  const [copiedNumber, setCopiedNumber] = useState(false);
  // Reset the "Copied" flash whenever a different call's sheet opens.
  useEffect(() => { setCopiedNumber(false); }, [group?.id]);
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
              {group.unknown ? <UnknownAvatar size={72} seed={group.displayName} /> : <Avatar name={group.displayName} size="xl" />}
            </View>
            <Text style={[typography.h2, { color: colors.text, marginTop: 14, textAlign: 'center' }]} numberOfLines={1}>
              {group.displayName}
            </Text>
            {/* Tap the number to copy it (Izzy 2026-07-28). */}
            <TouchableOpacity
              activeOpacity={0.6}
              onPress={() => {
                if (!target) return;
                Clipboard.setStringAsync(String(target)).catch(() => undefined);
                setCopiedNumber(true);
                setTimeout(() => setCopiedNumber(false), 1400);
              }}
            >
              <Text style={[typography.bodySm, { color: copiedNumber ? colors.success : colors.textSecondary, textAlign: 'center' }]} numberOfLines={1}>
                {copiedNumber ? 'Copied to clipboard' : target}
              </Text>
            </TouchableOpacity>
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
          <ScrollView
            style={styles.attemptsList}
            contentContainerStyle={{ paddingBottom: spacing['4'] }}
            bounces={false}
            alwaysBounceVertical={false}
            overScrollMode="never"
          >
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
    height: 36,
    paddingHorizontal: 16,
    borderRadius: 18,
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
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  nameText: {
    flexShrink: 1,
    fontSize: 15.5,
    lineHeight: 20,
    fontWeight: '800',
    letterSpacing: -0.15,
  },
  numberText: {
    fontSize: 12.5,
    lineHeight: 16,
    fontWeight: '600',
    opacity: 0.9,
    marginBottom: 2,
  },
  prefixBadge: {
    flexShrink: 0,
    maxWidth: '52%',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  prefixBadgeText: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.2,
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
  statusTag: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2.5,
  },
  statusTagText: {
    flexShrink: 1,
    fontSize: 10.5,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: -0.1,
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
    gap: 6,
    marginTop: 6,
  },
  actionBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnPrimary: {
    width: 34,
    height: 34,
    borderRadius: 17,
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

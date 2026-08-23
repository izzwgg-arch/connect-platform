import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Modal,
  NativeModules,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { TabParamList } from '../../navigation/types';
import { useAuth } from '../../context/AuthContext';
import { useSip } from '../../context/SipContext';
import { useTheme } from '../../context/ThemeContext';
import { showAppAlert } from '../../components/ui/appAlert';
import type { AppColors } from '../../theme/colors';
import { Avatar } from '../../components/ui/Avatar';
import {
  API_BASE,
  buildVoicemailStreamUri,
  getVoicemails,
  markVoicemailListened,
  deleteVoicemail,
  mobileQueryKeys,
  probeVoicemailStreamStatus,
  voicemailQueryUserScope,
} from '../../api/client';
import { useVoicemailAudioCache } from '../../hooks/useVoicemailAudioCache';
import { hasActiveSipSession } from '../../sip/sipClientSingleton';
import { consumeVoicemailScopeKeyChange } from '../../api/voicemailClientScope';
import { subscribeToVoicemail } from '../../api/realtime';
import { vmBadgeQueryKey } from '../../navigation/badges';
import { useContactNameResolver } from '../../contacts/useContactNameResolver';
import type { Voicemail } from '../../types';
import { spacing } from '../../theme/spacing';

type PrimaryFilter = 'all' | 'new' | 'urgent' | 'old';
type DateFilter = 'any' | 'today' | 'week';

// Instant paint: the last-seen voicemail list is cached on disk per user so the
// page renders immediately on open while React Query refetches in the
// background — instead of showing a long skeleton on every cold start.
const VM_LIST_CACHE_PREFIX = 'cc_vm_list_';
const VM_LIST_CACHE_MAX = 300;

// Locally-authoritative read/unread overrides, persisted per user. Once a
// voicemail is listened or marked read on this device it renders READ forever
// here, even if a background refetch briefly returns a stale server copy with
// listened:false (eventual-consistency race). Mirrored to AsyncStorage so the
// override survives an app restart too.
const VM_READ_OVERRIDES_PREFIX = 'cc_vm_read_ov_';

// Theme-driven palette. Derived from the app theme so the screen follows
// light/dark mode instead of being hardcoded dark. The keys mirror the old
// `VM` constant so every existing `VM.*` / `styles.*` reference keeps working.
function makeVmPalette(c: AppColors, isDark: boolean) {
  return {
    bg: c.bg,
    bg2: c.bgSecondary,
    card: c.surface,
    card2: c.surfaceElevated,
    cardMuted: c.surfaceHigh,
    // SOLID (fully opaque) state fills for cards. Translucent tints let the
    // card's elevation shadow bleed through the body, which renders as an ugly
    // muddy "card-behind-a-card" frame in light mode. These stay opaque.
    cardNewBg: isDark ? '#13203b' : '#eaf1fd',
    cardUrgentBg: isDark ? '#2c2012' : '#fff3e6',
    cardOldBg: isDark ? '#0e1626' : '#f3f6fb',
    cardSelectedBg: isDark ? '#16284c' : '#e3edfc',
    border: c.border,
    borderSoft: c.borderSubtle,
    text: c.text,
    text2: c.textSecondary,
    text3: c.textTertiary,
    primary: c.primary,
    primarySoft: c.primaryMuted,
    // ⛔ Ink for text sitting ON a primary-filled button. NEVER VM.text there:
    // VM.text is near-black in light mode, which rendered the Refresh /
    // Clear-filters buttons as dark-on-blue (Izzy 2026-08-23, screenshot).
    // White reads on the brand blue in BOTH themes.
    primaryInk: '#ffffff',
    cyan: c.teal,
    cyanSoft: c.tealMuted,
    green: c.success,
    greenSoft: c.successMuted,
    red: c.danger,
    redSoft: c.dangerMuted,
    orange: c.warning,
    orangeSoft: c.warningMuted,
    purple: c.purple,
    shadow: c.black,
    // Unplayed waveform bars — a soft, neutral track that the accent fill
    // reveals over as audio plays.
    waveTrack: isDark ? 'rgba(148, 163, 184, 0.30)' : 'rgba(100, 116, 139, 0.24)',
  };
}

type VmPalette = ReturnType<typeof makeVmPalette>;
type VmStyles = ReturnType<typeof makeStyles>;

// File-local theme context so the many sub-components can read the themed
// palette + stylesheet without prop-drilling. Sub-components destructure
// `{ VM, styles }` which shadows the names their bodies already use.
const VmThemeContext = React.createContext<{ VM: VmPalette; styles: VmStyles } | null>(null);
function useVm(): { VM: VmPalette; styles: VmStyles } {
  const ctx = React.useContext(VmThemeContext);
  if (!ctx) throw new Error('useVm must be used within VoicemailTab');
  return ctx;
}

function formatDuration(sec: number): string {
  const safe = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const diffMin = diffMs / 60000;
  const diffH = diffMs / 3600000;
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${Math.floor(diffMin)}m ago`;
  if (diffH < 24) return `${Math.floor(diffH)}h ago`;
  if (diffH < 48) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Exact wall-clock time the voicemail was received (e.g. "2:34 PM"). Shown on
// every card underneath the relative label so each voicemail always carries a
// concrete timestamp, not just "2h ago" / a bare date.
function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Combined relative-date + clock-time, rendered in a single tag in the card's
// bottom-left (e.g. "Jul 2 · 9:00 AM" or "2h ago · 9:00 AM").
function formatDateTimeTag(iso: string): string {
  const rel = formatTime(iso);
  const clock = formatClockTime(iso);
  if (rel && clock) return `${rel} · ${clock}`;
  return rel || clock;
}

function callerLabel(vm: Voicemail): string {
  return vm.callerName?.trim() || vm.callerId?.trim() || 'Unknown caller';
}

function hasTranscript(vm: Voicemail): boolean {
  return Boolean(vm.transcription?.trim());
}

type VmStatus = 'urgent' | 'new' | 'read' | 'old';

function statusFor(vm: Voicemail): VmStatus {
  if (vm.folder === 'urgent') return 'urgent';
  // A listened voicemail reads READ (calm green), distinct from an archived
  // OLD message. This never reverts once set locally (see read-overrides).
  if (vm.listened) return 'read';
  // Archived-but-unlistened messages keep the muted OLD label.
  if (vm.folder === 'old') return 'old';
  return 'new';
}

function dateMatches(vm: Voicemail, filter: DateFilter): boolean {
  if (filter === 'any') return true;
  const received = new Date(vm.receivedAt).getTime();
  if (Number.isNaN(received)) return true;
  const age = Date.now() - received;
  if (filter === 'today') return age <= 24 * 60 * 60 * 1000;
  return age <= 7 * 24 * 60 * 60 * 1000;
}

/**
 * Stable content signature for a voicemail list. Used to skip redundant
 * `setRows` calls when a background refetch returns the same content (a new
 * array reference but identical data), which otherwise churns the whole list
 * and the audio-preload effect on every 15s poll.
 */
function voicemailListSignature(list: Voicemail[]): string {
  let sig = String(list.length);
  for (const v of list) {
    sig += `|${v.id}:${v.listened ? 1 : 0}:${v.folder}:${v.transcription ? 1 : 0}`;
  }
  return sig;
}

export function VoicemailTab() {
  const route = useRoute<RouteProp<TabParamList, 'Voicemail'>>();
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const sip = useSip();
  const { colors, isDark } = useTheme();
  const VM = useMemo(() => makeVmPalette(colors, isDark), [colors, isDark]);
  // Contact-name backfill (Izzy 2026-07-28): saved names replace raw caller ids.
  const resolveContactName = useContactNameResolver();
  const styles = useMemo(() => makeStyles(VM), [VM]);
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Voicemail[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  // A single shared 0→1 progress value driven directly by the audio status
  // callback. The fill is animated on the JS thread between status ticks so it
  // tracks the real playback position smoothly and exactly in sync — no
  // optimistic guessing, no per-second jumps.
  const progressAnim = useRef(new Animated.Value(0)).current;
  const [primaryFilter, setPrimaryFilter] = useState<PrimaryFilter>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('any');
  const [transcriptOnly, setTranscriptOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [menuVm, setMenuVm] = useState<Voicemail | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  // Brief "Number copied" confirmation toast (Fix 4).
  const [copied, setCopied] = useState(false);
  // Spinner state that ONLY reflects a user-initiated pull-to-refresh. Background
  // polls/refetches must not flash the RefreshControl while the user is reading
  // or playing a voicemail.
  const [userRefreshing, setUserRefreshing] = useState(false);
  // Latest activeId, read inside the polling callback without re-subscribing.
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  // Latest rows, read inside the background poll to detect new mail without
  // re-subscribing the interval every time the list changes.
  const rowsRef = useRef<Voicemail[]>([]);
  useEffect(() => { rowsRef.current = rows; }, [rows]);
  // Latest loaded sound, mirrored into a ref so `play` can stay referentially
  // stable (so memoized VoicemailCards don't all re-render every time the
  // active sound changes) while still reading the current player synchronously.
  const soundRef = useRef<Audio.Sound | null>(null);
  useEffect(() => { soundRef.current = sound; }, [sound]);
  // Last list content actually applied to `rows`, to drop no-op refetches.
  const appliedVmSigRef = useRef<string>('');

  // Locally-authoritative read/unread override sets (see VM_READ_OVERRIDES_PREFIX).
  // These are applied on top of every server/disk-cache row set so a listened
  // voicemail can never flip back to NEW because of a stale refetch.
  const readOverridesRef = useRef<Set<string>>(new Set());
  const unreadOverridesRef = useRef<Set<string>>(new Set());

  const applyReadOverrides = useCallback((list: Voicemail[]): Voicemail[] => {
    const read = readOverridesRef.current;
    const unread = unreadOverridesRef.current;
    if (read.size === 0 && unread.size === 0) return list;
    return list.map((vm) => {
      if (read.has(vm.id) && !vm.listened) return { ...vm, listened: true };
      if (unread.has(vm.id) && vm.listened) return { ...vm, listened: false };
      return vm;
    });
  }, []);

  const persistReadOverrides = useCallback(() => {
    if (!token) return;
    const key = `${VM_READ_OVERRIDES_PREFIX}${voicemailQueryUserScope(token)}`;
    const payload = JSON.stringify({
      read: Array.from(readOverridesRef.current),
      unread: Array.from(unreadOverridesRef.current),
    });
    AsyncStorage.setItem(key, payload).catch(() => undefined);
  }, [token]);

  const markReadOverride = useCallback((ids: string[], read: boolean) => {
    for (const id of ids) {
      if (read) {
        readOverridesRef.current.add(id);
        unreadOverridesRef.current.delete(id);
      } else {
        unreadOverridesRef.current.add(id);
        readOverridesRef.current.delete(id);
      }
    }
    persistReadOverrides();
  }, [persistReadOverrides]);

  /**
   * Move the tab-bar badge NOW by `delta` unread messages.
   *
   * WHY (Izzy 2026-07-31, "the badge doesn't update"): the badge reads
   * `unreadTotals` from its OWN query (`vmBadgeQueryKey`), which is a different
   * cache from this screen's voicemail list. Marking a message read used to
   * invalidate that query immediately — i.e. BEFORE the PATCH telling the server
   * the message was read had been sent. The refetch won the race, read the
   * pre-change count back off the server, and the badge then sat wrong until its
   * next scheduled poll up to 3 minutes later.
   *
   * So: adjust the badge cache optimistically here (instant, and it matches what
   * the user just saw happen), and let callers reconcile with the server AFTER
   * the mutation resolves via refreshBadgeFromServer(). Callers must pass a delta
   * they actually know to be true — count only rows whose real read state flips.
   */
  const adjustBadgeUnread = useCallback((delta: number) => {
    if (!delta) return;
    queryClient.setQueryData(vmBadgeQueryKey(token), (prev: unknown) => {
      const p = prev as { unreadTotals?: Record<string, number> } | undefined;
      if (!p?.unreadTotals) return prev;
      const inbox = Math.max(0, (p.unreadTotals.inbox ?? 0) + delta);
      return { ...p, unreadTotals: { ...p.unreadTotals, inbox } };
    });
  }, [queryClient, token]);

  /** Reconcile the badge with the server. Call AFTER a mutation resolves. */
  const refreshBadgeFromServer = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: vmBadgeQueryKey(token) }).catch(() => undefined);
  }, [queryClient, token]);

  // Tear down any in-progress voicemail playback. Extracted so it can be
  // reused when a call becomes active (a playing voicemail must never keep
  // playing over a live call). Returns a promise that resolves once the
  // sound is actually paused+unloaded — callers that are about to grab the
  // audio session for something else (e.g. dialing a callback) should await
  // this instead of firing it and moving on. Letting the two run in parallel
  // means the OS audio HAL ends up juggling two competing session requests
  // (the voicemail player's teardown and the call's mic/route setup) at
  // once, which measurably slows the call down — observed ~1.5s versus
  // ~0.85s from tap to INVITE on-device when playback was still active.
  const stopPlayback = useCallback(async () => {
    const s = soundRef.current;
    soundRef.current = null;
    setSound(null);
    activeIdRef.current = null;
    setActiveId(null);
    if (s) {
      s.setOnPlaybackStatusUpdate(null);
      try {
        await s.pauseAsync();
      } catch {
        /* ignore — best-effort */
      }
      try {
        await s.unloadAsync();
      } catch {
        /* ignore — best-effort */
      }
    }
  }, []);

  // Bounded audio preload/cache: downloads top-5 unread/newest voicemails to
  // cacheDirectory so Play starts from a local file instead of a cold API fetch.
  const audioCache = useVoicemailAudioCache(rows, token);

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

  // Patch the cached voicemail list in place (read flag, etc.) instead of
  // invalidating the whole query. Invalidation forces a full multi-folder
  // network refetch — and firing it on Play is exactly why playback "loads"
  // before it plays. A cache patch keeps the UI consistent with no refetch.
  const patchVoicemailCache = useCallback(
    (predicate: (v: Voicemail) => boolean, patch: Partial<Voicemail>) => {
      if (!token) return;
      queryClient.setQueryData(mobileQueryKeys.voicemails('all', token), (prev: unknown) => {
        if (!prev || typeof prev !== 'object') return prev;
        const p = prev as { voicemails?: Voicemail[] };
        if (!Array.isArray(p.voicemails)) return prev;
        return { ...p, voicemails: p.voicemails.map((v) => (predicate(v) ? { ...v, ...patch } : v)) };
      });
    },
    [queryClient, token],
  );

  const voicemailQuery = useQuery({
    queryKey: mobileQueryKeys.voicemails('all', token),
    enabled: Boolean(token),
    // maxPagesPerFolder: 2 (2026-07-30) — the uncapped fetch pulled up to 30
    // pages × 100 voicemails × 3 folders (~90 requests) on EVERY list load,
    // saturating the network for seconds; audio preloads and tap-to-play
    // streams queued behind it, which is exactly the "5 seconds to start
    // playing" complaint. 200 per folder is far beyond what the list renders.
    queryFn: () => getVoicemails(token!, { maxPagesPerFolder: 2 }),
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
    if (nextRows === undefined) return;
    // Skip if a background refetch returned identical content (new array ref,
    // same data). This prevents the list + audio-preload churn that surfaced as
    // repeated "loading" flashes while reading/playing.
    const sig = voicemailListSignature(nextRows);
    if (sig === appliedVmSigRef.current) return;
    appliedVmSigRef.current = sig;
    // Apply local read/unread overrides so a listened voicemail never reverts
    // to NEW because the server round-tripped a stale copy.
    setRows(applyReadOverrides(nextRows));
  }, [applyReadOverrides, voicemailQuery.data]);

  // Hydrate from the on-disk cache so the list paints instantly on open.
  // Only seeds when we don't already have rows (fresh query data wins).
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    const key = `${VM_LIST_CACHE_PREFIX}${voicemailQueryUserScope(token)}`;
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (cancelled || !raw) return;
        try {
          const cached = JSON.parse(raw) as Voicemail[];
          if (Array.isArray(cached) && cached.length > 0) {
            setRows((cur) => (cur.length ? cur : applyReadOverrides(cached)));
          }
        } catch {
          /* ignore corrupt cache */
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [applyReadOverrides, token]);

  // Hydrate the persisted read/unread overrides, then re-apply them over any
  // rows already on screen so a listened voicemail stays READ across restarts.
  useEffect(() => {
    if (!token) {
      readOverridesRef.current = new Set();
      unreadOverridesRef.current = new Set();
      return undefined;
    }
    let cancelled = false;
    const key = `${VM_READ_OVERRIDES_PREFIX}${voicemailQueryUserScope(token)}`;
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (cancelled || !raw) return;
        try {
          const parsed = JSON.parse(raw) as { read?: string[]; unread?: string[] };
          readOverridesRef.current = new Set(parsed.read ?? []);
          unreadOverridesRef.current = new Set(parsed.unread ?? []);
          setRows((cur) => applyReadOverrides(cur));
        } catch {
          /* ignore corrupt overrides */
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [applyReadOverrides, token]);

  // Persist the freshest list to disk for the next cold start.
  useEffect(() => {
    if (!token) return;
    const next = voicemailQuery.data?.voicemails;
    if (!next) return;
    const key = `${VM_LIST_CACHE_PREFIX}${voicemailQueryUserScope(token)}`;
    AsyncStorage.setItem(key, JSON.stringify(next.slice(0, VM_LIST_CACHE_MAX))).catch(() => undefined);
  }, [token, voicemailQuery.data]);

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
  const refreshing = userRefreshing;
  const error = voicemailQuery.error && rows.length === 0 ? 'Could not load voicemail.' : null;
  const refetchVoicemail = voicemailQuery.refetch;
  const load = useCallback(() => {
    refetchVoicemail().catch(() => undefined);
  }, [refetchVoicemail]);
  // Explicit pull-to-refresh: shows the spinner, then clears it when done.
  const onUserRefresh = useCallback(() => {
    setUserRefreshing(true);
    refetchVoicemail().catch(() => undefined).finally(() => setUserRefreshing(false));
  }, [refetchVoicemail]);

  // Cheap background check: fetch only page 1 of each folder (instead of a full
  // multi-page mailbox resync) and only escalate to the expensive full `load()`
  // when that shows something the current list doesn't already have. A mailbox
  // with thousands of voicemails previously re-fetched EVERY page of EVERY
  // folder on every 15s tick, which saturated the connection pool to the API
  // host and starved every other tab's own requests (observed: reload
  // appearing "stuck" on Recent/Contacts/Team while Voicemail resynced).
  const lightPollVoicemails = useCallback(async () => {
    if (!token) return;
    try {
      const light = await getVoicemails(token, { maxPagesPerFolder: 1 });
      const known = rowsRef.current;
      const knownIds = new Set(known.map((vm) => vm.id));
      const hasNewVoicemail = light.voicemails.some((vm) => !knownIds.has(vm.id));
      // Folder totals are a cheap secondary signal: if the server now reports
      // more messages than we've ever loaded, something changed even if it
      // didn't surface on page 1 (e.g. a message landed straight in "old").
      const combinedTotal = light.totals.inbox + light.totals.urgent + light.totals.old;
      const totalsGrew = known.length > 0 && combinedTotal > known.length;
      if (hasNewVoicemail || totalsGrew) load();
    } catch {
      /* transient poll error — the next 15s tick retries */
    }
  }, [load, token]);

  useFocusEffect(
    useCallback(() => {
      if (!voicemailQuery.data || voicemailQuery.isStale) {
        load();
      } else {
        // Fresh-looking cache can still be missing a voicemail that landed in
        // the last minutes (observed 2026-07-29: VM arrived 20:52, tab opened
        // 20:54, list — and therefore the preloader — never saw it, so Play
        // fell to the slow remote stream). The light poll fetches only page 1
        // per folder and escalates to a full load() only when it finds
        // something new, so an always-on-focus check is cheap.
        void lightPollVoicemails();
      }
    }, [load, lightPollVoicemails, voicemailQuery.data, voicemailQuery.isStale]),
  );

  // Only poll while this tab is actually focused — it previously kept polling
  // (and, worse, kept fully resyncing) in the background on every other tab.
  useFocusEffect(
    useCallback(() => {
      if (!token) return undefined;
      return subscribeToVoicemail(() => {
        // Never refetch while a voicemail is actively playing — it churns the
        // list and interrupts playback. The poll resumes once playback stops.
        if (activeIdRef.current) return;
        lightPollVoicemails();
      });
    }, [lightPollVoicemails, token]),
  );

  useEffect(() => () => {
    sound?.unloadAsync().catch(() => undefined);
  }, [sound]);

  useEffect(() => {
    if (!playbackError) return undefined;
    const timer = setTimeout(() => setPlaybackError(null), 3200);
    return () => clearTimeout(timer);
  }, [playbackError]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  // Any active call must silence a playing voicemail. Covers inbound
  // answered/connected and a new outbound call started mid-playback. The
  // callback button (`callBack`) also awaits playback teardown before
  // dialing; this effect is the catch-all for every other path.
  const callIsActive =
    sip.callState === 'dialing' || sip.callState === 'ringing' || sip.callState === 'connected';
  useEffect(() => {
    if (callIsActive && activeIdRef.current) {
      stopPlayback();
    }
  }, [callIsActive, stopPlayback]);

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

  const selectionMode = selectedIds.length > 0;

  // Select-all operates on what the user can actually SEE (the filtered list),
  // never the whole unfiltered set — selecting rows hidden behind a filter and
  // then deleting them would destroy voicemails the user never looked at.
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((vm) => selectedIds.includes(vm.id));
  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) =>
      filtered.length > 0 && filtered.every((vm) => prev.includes(vm.id))
        ? []
        : filtered.map((vm) => vm.id),
    );
  }, [filtered]);

  // Build a status listener bound to a specific voicemail. The audio engine is
  // the single source of truth: we flip to "playing" the instant the audio
  // actually starts, advance the fill to the real position on every tick, and
  // clear everything the instant it finishes — so the visuals can never drift
  // out of sync with the sound.
  const makeStatusHandler = useCallback((vmId: string, fallbackDurationSec: number) => (status: any) => {
    if (!status?.isLoaded) return;

    // Finish FIRST, and exclusively (2026-07-30): the old order started the
    // per-update glide AND the finish-reset on the same Animated.Value in the
    // same tick — they fought, and the fill kept "traveling" after the audio
    // had already ended. Now the finish path snaps the bar to full (visibly
    // completing in sync with the sound), then clears it — and returns so no
    // glide can race it.
    if (status.didJustFinish) {
      activeIdRef.current = null;
      setActiveId(null);
      progressAnim.stopAnimation(() => {
        Animated.sequence([
          Animated.timing(progressAnim, { toValue: 1, duration: 80, useNativeDriver: false }),
          Animated.delay(140),
          Animated.timing(progressAnim, { toValue: 0, duration: 180, useNativeDriver: false }),
        ]).start();
      });
      return;
    }

    // Real decoded duration when the engine knows it (always true for local /
    // pre-warmed files); the server's claimed duration only as a last resort —
    // it is frequently wrong for streams, which is what made the bar pace
    // ahead of / behind the audio.
    const durMs = status.durationMillis || fallbackDurationSec * 1000 || 1;
    const posMs = status.positionMillis || 0;
    const pct = Math.max(0, Math.min(1, posMs / Math.max(1, durMs)));
    // Glide to the latest position over roughly one update interval so the fill
    // moves continuously instead of stepping.
    Animated.timing(progressAnim, {
      toValue: pct,
      duration: status.isPlaying ? 90 : 0,
      useNativeDriver: false,
    }).start();

    if (status.isPlaying && activeIdRef.current !== vmId) {
      activeIdRef.current = vmId;
      setActiveId(vmId);
    }
  }, [progressAnim]);

  const play = useCallback(async (vm: Voicemail) => {
    if (!token) {
      setPlaybackError('This voicemail cannot be played yet.');
      return;
    }

    // Toggle-off: tap the active voicemail to pause. Read live values from
    // refs so this callback can stay referentially stable.
    const currentSound = soundRef.current;
    if (activeIdRef.current === vm.id && currentSound) {
      await currentSound.pauseAsync().catch(() => undefined);
      activeIdRef.current = null;
      setActiveId(null);
      return;
    }

    // Tear down the previous sound in the background — do NOT await it, or the
    // next (cached) load is needlessly delayed by the old player's release.
    if (currentSound) {
      currentSound.setOnPlaybackStatusUpdate(null);
      currentSound.unloadAsync().catch(() => undefined);
    }

    const localUri  = audioCache.getLocalUri(vm.id);
    const remoteUri = buildVoicemailStreamUri(token, vm.id);
    const startMs   = Date.now();
    console.log(`[VOICEMAIL_AUDIO] play_tap vmId=${vm.id} hasCache=${!!localUri}`);

    const markListened = () => {
      if (!vm.listened) {
        markReadOverride([vm.id], true);
        setRows((current) => current.map((row) => row.id === vm.id ? { ...row, listened: true } : row));
        patchVoicemailCache((row) => row.id === vm.id, { listened: true });
        // Guarded by `!vm.listened` above, so this row really was unread — the
        // badge must drop by exactly one, immediately (Izzy 2026-07-31).
        adjustBadgeUnread(-1);
        // If the server reports the read state was NOT persisted (the listener
        // holds "see everybody's voicemails" but isn't this mailbox's owner),
        // undo the optimistic flip so the previewer's screen matches the real
        // owner's unread state.
        markVoicemailListened(token, vm.id, true)
          .then((res) => {
            if (res?.readStateSkipped) {
              markReadOverride([vm.id], false);
              setRows((current) => current.map((row) => row.id === vm.id ? { ...row, listened: false } : row));
              patchVoicemailCache((row) => row.id === vm.id, { listened: false });
              adjustBadgeUnread(1);
            }
          })
          .catch(() => undefined)
          .finally(() => refreshBadgeFromServer());
      }
    };

    // Empty voicemails (zero-duration, no recording on the server) have no
    // audio to play. Streaming one would just hang on a tiny error body for
    // seconds. A 0:00 duration is a reliable signal, so fail fast instantly —
    // no spinner, no doomed network attempt. (We also bail if the preloader
    // already probed and found no valid audio.)
    if (!localUri && ((vm.durationSec ?? 0) <= 0 || audioCache.preloadStatus(vm.id) === 'error')) {
      console.log(`[VOICEMAIL_AUDIO] play_skip_empty vmId=${vm.id}`);
      setPlaybackError('This voicemail has no audio to play.');
      return;
    }

    progressAnim.setValue(0);

    // Ensure the iOS audio session is in a loud playback state before we start.
    // A prior voice-note recording (allowsRecordingIOS) or the expo-av default
    // (playsInSilentModeIOS:false) would otherwise route voicemail audio to the
    // quiet earpiece / silence it under the Ring/Silent switch.
    //
    // AWAITED with a 250ms cap (2026-07-30): fire-and-forget RACED the playback
    // start below, and when it lost — reliably right after a phone call, when
    // the session is still in quiet call mode — the whole voicemail played
    // through the earpiece pipeline at whisper volume ("speaker is really
    // low"). The mode switch takes ~10-30ms; the cap keeps play effectively
    // instant even if the audio session is being slow.
    await Promise.race([
      Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      }).catch(() => undefined),
      new Promise<void>((r) => setTimeout(r, 250)),
    ]);

    // Flip to the playing state the instant the button is tapped — for EVERY
    // path (pre-warmed, cached, or remote stream). There is no spinner: the
    // pause icon shows immediately and the waveform fill begins moving as soon
    // as the audio engine reports a real position. If a load ultimately fails,
    // the catch blocks below revert this optimistic state.
    activeIdRef.current = vm.id;
    setActiveId(vm.id);

    const onStatus = makeStatusHandler(vm.id, vm.durationSec ?? 0);

    // Playback-stall watchdog (RSBK101 2026-08-04): a leaked "phantom call"
    // (ghost-ring Telecom Connection nothing terminated) makes Android refuse
    // media playback — expo-av then loads fine but never starts, and because
    // the playing state above is optimistic and play errors were swallowed,
    // the user saw a pause icon with a frozen waveform and no explanation,
    // recurring until they reinstalled the APK (only a process kill cleared
    // the phantom). If the engine reports zero progress shortly after start:
    // sweep stale Telecom connections + reset audio mode (gated on zero live
    // SIP sessions so a real call is untouchable), retry once, and if it
    // still won't move, revert the UI and say so instead of faking playback.
    const armStallWatchdog = (path: string) => {
      const snd = soundRef.current;
      if (!snd) return;
      const stalled = async (): Promise<boolean> => {
        try {
          const st: any = await snd.getStatusAsync();
          if (st?.isLoaded && (st.isPlaying || (st.positionMillis ?? 0) > 0)) return false;
        } catch { /* unloaded / broken player counts as stalled */ }
        return true;
      };
      // Bail whenever the user paused, switched voicemails, playback finished
      // (all of those clear/replace activeId), or a newer sound took over.
      const superseded = () => activeIdRef.current !== vm.id || soundRef.current !== snd;
      const giveUp = () => {
        console.warn(`[VOICEMAIL_AUDIO] playback_stalled_final vmId=${vm.id} path=${path}`);
        activeIdRef.current = null;
        setActiveId(null);
        setPlaybackError('Could not start audio playback. Please try again.');
      };
      setTimeout(async () => {
        if (superseded() || !(await stalled())) return;
        console.warn(`[VOICEMAIL_AUDIO] playback_stalled vmId=${vm.id} path=${path} — engine reports no progress after start`);
        if (Platform.OS === 'android' && !hasActiveSipSession()) {
          try {
            const mod = (NativeModules as any)?.IncomingCallUi;
            if (typeof mod?.telecomTerminateStale === 'function') {
              mod.telecomTerminateStale('voicemail_playback_stalled');
            }
            setTimeout(() => { try { mod?.resetCallAudioState?.(); } catch { /* ignore */ } }, 400);
          } catch { /* best effort */ }
          setTimeout(() => {
            if (superseded()) return;
            snd.playAsync().catch(() => undefined);
            setTimeout(async () => {
              if (superseded()) return;
              if (await stalled()) giveUp();
              else console.log(`[VOICEMAIL_AUDIO] playback_recovered vmId=${vm.id} path=${path} — stale-call sweep unblocked audio`);
            }, 1500);
          }, 1000);
          return;
        }
        giveUp();
      }, 2000);
    };

    const loadFrom = async (uri: string, isLocal: boolean, timeoutMs: number) => {
      console.log(`[VOICEMAIL_AUDIO] load_async_start vmId=${vm.id} isLocal=${isLocal} elapsedMs=${Date.now() - startMs}`);
      const next = new Audio.Sound();
      next.setOnPlaybackStatusUpdate(onStatus);
      const source = isLocal ? { uri } : { uri, headers: { Authorization: `Bearer ${token}` } };
      try {
        await Promise.race([
          next.loadAsync(source, { shouldPlay: true, progressUpdateIntervalMillis: 80 }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('load_timeout')), timeoutMs)),
        ]);
      } catch (err) {
        next.setOnPlaybackStatusUpdate(null);
        next.unloadAsync().catch(() => undefined);
        throw err;
      }
      console.log(`[VOICEMAIL_AUDIO] load_async_done vmId=${vm.id} isLocal=${isLocal} elapsedMs=${Date.now() - startMs}`);
      soundRef.current = next;
      setSound(next);
      markListened();
      return next;
    };

    // ── Path A0: a fully-decoded sound was pre-warmed → play INSTANTLY ─────────
    // No loadAsync, no decode wait: just attach the listener and replay from 0.
    const warm = audioCache.takeSound(vm.id);
    if (warm) {
      warm.setOnPlaybackStatusUpdate(onStatus);
      soundRef.current = warm;
      setSound(warm);
      markListened();
      try {
        // Already decoded and sitting at position 0 — playAsync starts it
        // immediately (no stop/seek round-trip like replayAsync). Fire it
        // without awaiting so nothing blocks the audio from starting; the
        // stall watchdog owns the UI if it never actually starts (a silent
        // `.catch(() => undefined)` here is how the phantom-call wedge stayed
        // invisible — at least leave the rejection in the log).
        warm.playAsync().catch((err: any) =>
          console.warn(`[VOICEMAIL_AUDIO] prewarm_play_rejected vmId=${vm.id} error=${String(err?.message ?? err)}`),
        );
        console.log(`[VOICEMAIL_AUDIO] play_prewarmed vmId=${vm.id} elapsedMs=${Date.now() - startMs}`);
        armStallWatchdog('prewarm');
        return;
      } catch (warmErr: any) {
        // Pre-warmed instance went bad — discard and fall through to a load.
        // Keep the optimistic active state; the load paths below continue it.
        warm.setOnPlaybackStatusUpdate(null);
        warm.unloadAsync().catch(() => undefined);
        soundRef.current = null;
        console.warn(`[VOICEMAIL_AUDIO] prewarm_play_failed vmId=${vm.id} error=${String(warmErr?.message ?? warmErr)}`);
      }
    }

    // ── Path A: play from preloaded local file ────────────────────────────────
    // Cached audio loads in ~100ms. The active state is already set above, so
    // the pause icon is already showing; the status handler drives the fill
    // once the audio engine reports the real position a moment later.
    if (localUri) {
      try {
        await loadFrom(localUri, true, 6000);
        armStallWatchdog('cache');
        return;
      } catch (cacheErr: any) {
        // Corrupt cache — fall back to the (slower) remote stream. Keep the
        // optimistic active state; the remote catch reverts it only on failure.
        console.warn(`[VOICEMAIL_AUDIO] cache_play_failed vmId=${vm.id} error=${String(cacheErr?.message ?? cacheErr)}`);
      }
    } else {
      console.log(`[VOICEMAIL_AUDIO] play_stream_fallback vmId=${vm.id} preloadStatus=${audioCache.preloadStatus(vm.id)} elapsedMs=${Date.now() - startMs}`);
      // ── Path A2 (Android): cache miss → download the RAW file now ──────────
      // The remote stream below waits on the server's ffmpeg transcode (seconds
      // of silence after tapping Play — Izzy 2026-07-29). The raw download the
      // preloader already uses is far faster and Android MediaPlayer decodes it
      // directly, so fetch-then-play-local beats streaming. Any failure falls
      // through to the remote stream exactly as before. iOS keeps streaming:
      // its only playable source IS the transcoded MP3, so there is no faster
      // file to fetch.
      if (Platform.OS !== 'ios') {
        try {
          const downloaded = await audioCache.ensureLocal(vm, 5000);
          if (downloaded) {
            await loadFrom(downloaded, true, 6000);
            console.log(`[VOICEMAIL_AUDIO] play_downloaded_raw vmId=${vm.id} elapsedMs=${Date.now() - startMs}`);
            armStallWatchdog('raw_download');
            return;
          }
        } catch (rawErr: any) {
          console.warn(`[VOICEMAIL_AUDIO] raw_download_play_failed vmId=${vm.id} error=${String(rawErr?.message ?? rawErr)}`);
        }
      }
    }

    // ── Path B: stream from remote (cache miss or cache_play_failed) ──────────
    // No local file: this fetches over the network. The pause state is already
    // showing (set optimistically above) and the fill stays at 0 until the
    // audio actually starts — no spinner. We only revert the active state if
    // the stream genuinely fails.
    try {
      await loadFrom(remoteUri, false, 8000);
      armStallWatchdog('stream');
    } catch {
      activeIdRef.current = null;
      setActiveId(null);
      const st = await probeVoicemailStreamStatus(token, vm.id);
      if (st === 403) {
        setPlaybackError('This voicemail is not available for your account.');
        removeVoicemailRowEverywhere(vm.id);
        return;
      }
      setPlaybackError('Could not play voicemail audio.');
    }
  }, [adjustBadgeUnread, audioCache, makeStatusHandler, markReadOverride, patchVoicemailCache, progressAnim, refreshBadgeFromServer, removeVoicemailRowEverywhere, token]);

  const toggleListened = useCallback((vm: Voicemail) => {
    if (!token) return;
    const next = !vm.listened;
    const prev = vm.listened;
    markReadOverride([vm.id], next);
    setRows((current) => current.map((row) => row.id === vm.id ? { ...row, listened: next } : row));
    patchVoicemailCache((row) => row.id === vm.id, { listened: next });
    // `prev` is the real read state, so this delta is known-correct: going
    // listened means one fewer unread, going unlistened means one more.
    adjustBadgeUnread(next ? -1 : 1);
    // Revert if the server refused to change read state (previewer isn't the
    // mailbox owner) — read/unread belongs to the owning extension only.
    markVoicemailListened(token, vm.id, next)
      .then((res) => {
        if (res?.readStateSkipped) {
          markReadOverride([vm.id], prev);
          setRows((current) => current.map((row) => row.id === vm.id ? { ...row, listened: prev } : row));
          patchVoicemailCache((row) => row.id === vm.id, { listened: prev });
          adjustBadgeUnread(next ? 1 : -1);
        }
      })
      .catch(() => undefined)
      // Reconcile only once the server has actually been told — invalidating
      // before this point is what made the badge stick at the old count.
      .finally(() => refreshBadgeFromServer());
  }, [adjustBadgeUnread, markReadOverride, patchVoicemailCache, refreshBadgeFromServer, token]);

  const markSelectedRead = useCallback(async () => {
    if (!token || selectedIds.length === 0) return;
    const ids = selectedIds;
    const selected = rows.filter((vm) => ids.includes(vm.id) && !vm.listened);
    markReadOverride(ids, true);
    setRows((current) => current.map((row) => ids.includes(row.id) ? { ...row, listened: true } : row));
    patchVoicemailCache((row) => ids.includes(row.id), { listened: true });
    setSelectedIds([]);
    const results = await Promise.all(
      selected.map(async (vm) => {
        const res = await markVoicemailListened(token, vm.id, true).catch(() => undefined);
        return { id: vm.id, skipped: !!res?.readStateSkipped };
      }),
    );
    // Undo the optimistic read for any mailbox the caller doesn't own (server
    // left it unread for the real owner).
    const skippedIds = results.filter((r) => r.skipped).map((r) => r.id);
    if (skippedIds.length > 0) {
      markReadOverride(skippedIds, false);
      setRows((current) => current.map((row) => skippedIds.includes(row.id) ? { ...row, listened: false } : row));
      patchVoicemailCache((row) => skippedIds.includes(row.id), { listened: false });
    }
    refreshBadgeFromServer();
  }, [markReadOverride, patchVoicemailCache, refreshBadgeFromServer, rows, selectedIds, token]);

  /**
   * Bulk mark-unread. Mirror of markSelectedRead: only rows currently listened
   * can become unread, so the badge delta is exactly that subset's length.
   */
  const markSelectedUnread = useCallback(async () => {
    if (!token || selectedIds.length === 0) return;
    const ids = selectedIds;
    const selected = rows.filter((vm) => ids.includes(vm.id) && vm.listened);
    markReadOverride(ids, false);
    setRows((current) => current.map((row) => ids.includes(row.id) ? { ...row, listened: false } : row));
    patchVoicemailCache((row) => ids.includes(row.id), { listened: false });
    adjustBadgeUnread(selected.length);
    setSelectedIds([]);
    const results = await Promise.all(
      selected.map(async (vm) => {
        const res = await markVoicemailListened(token, vm.id, false).catch(() => undefined);
        return { id: vm.id, skipped: !!res?.readStateSkipped };
      }),
    );
    const skippedIds = results.filter((r) => r.skipped).map((r) => r.id);
    if (skippedIds.length > 0) {
      markReadOverride(skippedIds, true);
      setRows((current) => current.map((row) => skippedIds.includes(row.id) ? { ...row, listened: true } : row));
      patchVoicemailCache((row) => skippedIds.includes(row.id), { listened: true });
      adjustBadgeUnread(-skippedIds.length);
    }
    refreshBadgeFromServer();
  }, [adjustBadgeUnread, markReadOverride, patchVoicemailCache, refreshBadgeFromServer, rows, selectedIds, token]);

  /**
   * Bulk delete, behind a confirmation. Rows are removed optimistically and
   * restored per-id if the server refuses (a previewer who does not own the
   * mailbox gets a 403). Unread rows that go away also leave the badge, so the
   * delta is the unread subset's length.
   */
  const deleteSelected = useCallback(() => {
    if (!token || selectedIds.length === 0) return;
    const ids = [...selectedIds];
    const doomed = rows.filter((vm) => ids.includes(vm.id));
    const unreadCount = doomed.filter((vm) => !vm.listened).length;
    showAppAlert(
      ids.length === 1 ? 'Delete voicemail?' : `Delete ${ids.length} voicemails?`,
      'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setSelectedIds([]);
            setRows((current) => current.filter((row) => !ids.includes(row.id)));
            patchVoicemailCache(() => false, {});
            for (const id of ids) removeVoicemailRowEverywhere(id);
            adjustBadgeUnread(-unreadCount);
            void Promise.all(
              ids.map(async (id) => {
                const ok = await deleteVoicemail(token, id).then(() => true).catch(() => false);
                return { id, ok };
              }),
            ).then((results) => {
              const failed = results.filter((r) => !r.ok).map((r) => r.id);
              if (failed.length > 0) {
                // Could not delete (not the mailbox owner, or offline) — pull the
                // truth back from the server rather than guessing what survived.
                const restored = doomed.filter((vm) => failed.includes(vm.id));
                setRows((current) => [...restored, ...current]);
                adjustBadgeUnread(restored.filter((vm) => !vm.listened).length);
                showAppAlert(
                  'Some voicemails were not deleted',
                  failed.length === 1
                    ? 'One message could not be deleted. You can only delete messages from your own mailbox.'
                    : `${failed.length} messages could not be deleted. You can only delete messages from your own mailbox.`,
                );
              }
              refreshBadgeFromServer();
              load();
            });
          },
        },
      ],
    );
  }, [adjustBadgeUnread, load, patchVoicemailCache, refreshBadgeFromServer, removeVoicemailRowEverywhere, rows, selectedIds, token]);

  /** Single-row delete from the three-dots menu. Same rules as the bulk path. */
  const deleteOne = useCallback((vm: Voicemail) => {
    if (!token) return;
    showAppAlert('Delete voicemail?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setRows((current) => current.filter((row) => row.id !== vm.id));
          removeVoicemailRowEverywhere(vm.id);
          if (!vm.listened) adjustBadgeUnread(-1);
          deleteVoicemail(token, vm.id)
            .catch(() => {
              setRows((current) => [vm, ...current]);
              if (!vm.listened) adjustBadgeUnread(1);
              showAppAlert('Could not delete', 'You can only delete messages from your own mailbox.');
            })
            .finally(() => {
              refreshBadgeFromServer();
              load();
            });
        },
      },
    ]);
  }, [adjustBadgeUnread, load, refreshBadgeFromServer, removeVoicemailRowEverywhere, token]);

  // Stop any playing voicemail before dialing so the callback audio isn't
  // talking over the recording (Fix 3). The SIP call-state effect above is the
  // catch-all for inbound / mid-call scenarios.
  const callBack = useCallback(async (vm: Voicemail) => {
    if (sip.registrationState === 'registered' && vm.callerId) {
      // Await the teardown so the call's own audio-session/mic setup never
      // races the still-unloading voicemail player (see stopPlayback above).
      await stopPlayback();
      sip.dial(vm.callerId);
    }
  }, [sip, stopPlayback]);

  // Tap the caller number to copy just the number to the clipboard (Fix 4).
  const copyNumber = useCallback(async (number: string) => {
    const n = (number || '').trim();
    if (!n) return;
    await Clipboard.setStringAsync(n).catch(() => undefined);
    setCopied(true);
  }, []);

  // Seek within the active voicemail from a waveform tap/scrub (Fix 6). Only
  // the active card wires this up, so `soundRef` is always the playing sound.
  const seekTo = useCallback(async (fraction: number) => {
    const s = soundRef.current;
    if (!s) return;
    const f = Math.max(0, Math.min(1, fraction));
    try {
      const st = await s.getStatusAsync();
      if (!st.isLoaded || !st.durationMillis) return;
      await s.setPositionAsync(Math.floor(f * st.durationMillis));
      progressAnim.setValue(f);
    } catch {
      /* ignore transient seek errors */
    }
  }, [progressAnim]);

  const messageCaller = useCallback((vm: Voicemail) => {
    const number = vm.callerId?.trim();
    if (!number) {
      showAppAlert('Message', 'No number is available for this caller.');
      return;
    }
    // Hand off to the Chat tab, which resolves the number to an existing/new
    // SMS thread (external numbers) or DM (internal extensions) and opens it.
    // A short digit-only caller id is an internal extension → force a DM.
    const kind = /^\d{2,6}$/.test(number) ? 'internal' : 'external';
    nav.navigate('Chat', { composeNumber: number, composeName: vm.callerName ?? undefined, composeKind: kind });
  }, [nav]);

  const downloadVoicemail = useCallback(async (vm: Voicemail) => {
    if (!token) return;
    try {
      // Human-findable filename: caller + date, e.g.
      // "Voicemail 5551234567 2026-07-28.wav".
      const caller = (vm.callerId || 'unknown').replace(/[^a-zA-Z0-9+]/g, '');
      const day = (vm.receivedAt || '').slice(0, 10) || 'undated';
      const fileName = `Voicemail ${caller} ${day}.wav`;
      const tmpUri = `${FileSystem.cacheDirectory}vm-dl-${vm.id.replace(/[^a-zA-Z0-9_-]/g, '') || Date.now()}.wav`;
      const url = `${API_BASE}/voice/voicemail/${encodeURIComponent(vm.id)}/download`;
      await FileSystem.downloadAsync(url, tmpUri, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const downloadsModule = (NativeModules as { ConnectDownloads?: { saveToDownloads: (src: string, name: string, mime: string) => Promise<string> } }).ConnectDownloads;
      if (Platform.OS === 'android' && downloadsModule?.saveToDownloads) {
        // Publish into the PUBLIC Downloads folder so the file shows up in
        // the system Files app — the app sandbox is invisible to the user.
        await downloadsModule.saveToDownloads(tmpUri, fileName, 'audio/x-wav');
        FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => undefined);
        setPlaybackError('Saved to Downloads.');
        return;
      }
      // ── iOS: hand it to the share sheet so the user can "Save to Files" ────
      // (Izzy 2026-07-31: "downloading voicemails is not working... it should
      // always download on the download page in files".) Previously this
      // branch copied the file into documentDirectory — the app's PRIVATE
      // sandbox — and reported "Voicemail downloaded." The file was real but
      // invisible: iOS has no public Downloads folder an app can write to, and
      // nothing surfaced it in the Files app. The supported route is the share
      // sheet, whose "Save to Files" lets the user drop it in iCloud Drive or
      // On My iPhone. Copy under the human-readable name first so the saved
      // file isn't called "vm-dl-<id>.wav".
      const namedUri = `${FileSystem.cacheDirectory}${encodeURIComponent(fileName)}`;
      await FileSystem.copyAsync({ from: tmpUri, to: namedUri }).catch(() => undefined);
      const shareSource = (await FileSystem.getInfoAsync(namedUri)).exists ? namedUri : tmpUri;
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(shareSource, {
          mimeType: 'audio/x-wav',
          UTI: 'public.audio',
          dialogTitle: fileName,
        });
        return;
      }
      // Last resort (sharing unavailable): keep the old sandbox copy so the
      // file at least exists, and say so honestly rather than claiming success.
      await FileSystem.copyAsync({ from: tmpUri, to: `${FileSystem.documentDirectory}${fileName}` });
      setPlaybackError('Saved inside the app — sharing unavailable.');
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
    <VmThemeContext.Provider value={{ VM, styles }}>
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
          <View style={styles.selectionCountChip}>
            <Text style={styles.selectionCountText}>{selectedIds.length}</Text>
          </View>
          {/* numberOfLines + no flex: with `flex: 1` this label was squeezed by
              the five action buttons and wrapped mid-word ("selec / ted") on a
              normal-width phone (Izzy 2026-08-01). It now keeps its natural
              width on one line and the spacer below pushes the actions right. */}
          <Text style={styles.selectionText} numberOfLines={1}>selected</Text>
          <View style={styles.selectionSpacer} />

          <TouchableOpacity
            style={styles.selectionActionOutline}
            onPress={toggleSelectAll}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={allVisibleSelected ? 'Deselect all' : 'Select all'}
          >
            <Ionicons
              name={allVisibleSelected ? 'square-outline' : 'checkbox-outline'}
              size={18}
              color={VM.text2}
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.selectionActionFilled}
            onPress={markSelectedRead}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Mark selected as read"
          >
            <Ionicons name="mail-open-outline" size={18} color="#ffffff" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.selectionActionOutline}
            onPress={markSelectedUnread}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Mark selected as unread"
          >
            <Ionicons name="mail-unread-outline" size={18} color={VM.text2} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.selectionActionDanger}
            onPress={deleteSelected}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Delete selected"
          >
            <Ionicons name="trash-outline" size={18} color={VM.red} />
          </TouchableOpacity>

          <View style={styles.selectionDivider} />

          <TouchableOpacity
            style={styles.selectionActionGhost}
            onPress={() => setSelectedIds([])}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Cancel selection"
          >
            <Ionicons name="close" size={18} color={VM.text3} />
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
          // PERF (freeze investigation 2026-07-28): voicemail rows are HEAVY
          // (~60 waveform bar views each). The FlatList defaults pre-render
          // ~21 screens' worth (windowSize=21) — with a 3,000-message mailbox
          // that built thousands of views on first visit and stalled the JS
          // thread for seconds (measured: 4.7s stall, 119x topLayout storm).
          // Keep the render window tight; scrolling fills in ahead lazily.
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          updateCellsBatchingPeriod={60}
          windowSize={5}
          removeClippedSubviews
          // iOS needs the list to be able to bounce for pull-to-refresh to fire;
          // Android's RefreshControl works without it. Gate on iOS so Android is
          // byte-for-byte unchanged (see IOS_WORK_ANDROID_GUARDRAILS.md).
          bounces={Platform.OS === 'ios'}
          alwaysBounceVertical={Platform.OS === 'ios'}
          overScrollMode="never"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onUserRefresh} tintColor={VM.primary} colors={[VM.primary]} progressBackgroundColor={colors.surface} />}
          contentContainerStyle={[styles.list, { paddingBottom: spacing['5'] }]}
          renderItem={({ item }) => (
            <VoicemailCard
              vm={item}
              resolvedName={resolveContactName(item.callerId)}
              active={activeId === item.id}
              selected={selectedIds.includes(item.id)}
              selectionMode={selectionMode}
              expanded={expandedId === item.id}
              progressAnim={progressAnim}
              onPress={() => {
                if (selectionMode) toggleSelected(item.id);
                else {
                  setExpandedId((current) => {
                    const next = current === item.id ? null : item.id;
                    // Expanding signals an imminent Play — download + decode now
                    // so the audio starts the instant Play is tapped.
                    if (next) audioCache.warm(item);
                    return next;
                  });
                }
              }}
              onLongPress={() => toggleSelected(item.id)}
              onPlay={() => play(item)}
              onCall={() => callBack(item)}
              onMessage={() => messageCaller(item)}
              onMore={() => setMenuVm(item)}
              onCopyNumber={copyNumber}
              onSeek={seekTo}
            />
          )}
        />
      )}

      {playbackError && (
        <View style={[styles.snackbar, { bottom: Math.max(insets.bottom, 8) + 86 }]}>
          <Ionicons name="warning-outline" size={16} color={VM.orange} />
          <Text style={styles.snackbarText}>{playbackError}</Text>
        </View>
      )}

      {copied && (
        <View style={[styles.snackbar, { borderColor: `${VM.green}55`, bottom: Math.max(insets.bottom, 8) + 138 }]}>
          <Ionicons name="checkmark-circle" size={16} color={VM.green} />
          <Text style={styles.snackbarText}>Number copied</Text>
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
        onDelete={(vm) => {
          setMenuVm(null);
          deleteOne(vm);
        }}
      />
    </View>
    </VmThemeContext.Provider>
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
  const { VM, styles } = useVm();
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
  const { VM, styles } = useVm();
  const options: Array<{ id: PrimaryFilter; label: string; count: number; color: string }> = [
    { id: 'all', label: 'All', count: stats.total, color: VM.primary },
    { id: 'new', label: 'New', count: stats.unread, color: VM.green },
    { id: 'urgent', label: 'Urgent', count: stats.urgent, color: VM.orange },
    { id: 'old', label: 'Old', count: stats.old, color: VM.text2 },
  ];

  return (
    <>
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
      </View>
      {(transcriptOnly || dateFilter !== 'any') && (
        <View style={styles.advancedChipRow}>
          <TouchableOpacity style={styles.advancedChip} onPress={onClearAdvanced} activeOpacity={0.8}>
            <Ionicons name="close-circle" size={14} color={VM.cyan} />
            <Text style={styles.advancedChipText}>
              {transcriptOnly ? 'Transcript' : ''}{transcriptOnly && dateFilter !== 'any' ? ' · ' : ''}{dateFilter !== 'any' ? (dateFilter === 'today' ? 'Today' : '7 days') : ''}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </>
  );
}

function FilterChip({ label, count, active, color, onPress }: { label: string; count: number; active: boolean; color: string; onPress: () => void }) {
  const { VM, styles } = useVm();
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
  /** Saved-contact name for the caller (contact backfill, Izzy 2026-07-28). */
  resolvedName?: string | null;
  // The shared progress driver, handed only to the active card. It's a stable
  // ref so the card re-renders just once (when it becomes active) while the
  // fill keeps animating off-thread in sync with the audio.
  progressAnim: Animated.Value;
  onPress: () => void;
  onLongPress: () => void;
  onPlay: () => void;
  onCall: () => void;
  onMessage: () => void;
  onMore: () => void;
  onCopyNumber: (number: string) => void;
  onSeek: (fraction: number) => void;
};

const VoicemailCard = memo(function VoicemailCard({
  vm,
  resolvedName,
  active,
  selected,
  selectionMode,
  expanded,
  progressAnim,
  onPress,
  onLongPress,
  onPlay,
  onCall,
  onMessage,
  onMore,
  onCopyNumber,
  onSeek,
}: VoicemailCardProps) {
  const { VM, styles } = useVm();
  const status = statusFor(vm);
  const urgent = status === 'urgent';
  const unread = status === 'new';
  // READ and archived OLD both get the muted card treatment.
  const muted = status === 'old' || status === 'read';
  // Played-portion color. Urgent stays orange; everything else (incl. already
  // heard) uses the brand blue so the fill always reads clearly against the
  // neutral track instead of washing out to gray.
  const accent = urgent ? VM.orange : VM.primary;
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
          <Avatar name={resolvedName || callerLabel(vm)} size="md" />
        )}

        <View style={styles.cardInfo}>
          <View style={styles.cardTitleRow}>
            <Text style={[styles.callerName, muted && styles.mutedText]} numberOfLines={1}>
              {resolvedName || callerLabel(vm)}
            </Text>
          </View>
          <Text style={styles.mailboxText} numberOfLines={1}>
            {vm.callerId ? (
              <Text
                style={styles.mailboxNumber}
                onPress={() => onCopyNumber(vm.callerId)}
                suppressHighlighting
              >
                {vm.callerId}
              </Text>
            ) : (
              'Unknown number'
            )}
            {` · ext ${vm.extension}`}
          </Text>
        </View>

        <View style={styles.cardRight}>
          <StatusBadge status={status} />
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
        <Waveform
          active={active}
          progressAnim={progressAnim}
          accent={accent}
          onSeek={active ? onSeek : undefined}
        />
      </View>

      {transcript && (
        <Text style={styles.transcriptPreview} numberOfLines={expanded ? 8 : 2}>
          {transcript}
        </Text>
      )}

      <View style={styles.actionRow}>
        <View style={styles.dateTimeTag}>
          <Ionicons name="time-outline" size={12} color={VM.text3} />
          <Text style={styles.dateTimeTagText} numberOfLines={1}>
            {formatDateTimeTag(vm.receivedAt)}
          </Text>
        </View>
        <View style={styles.actionButtons}>
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
      </View>
    </TouchableOpacity>
  );
}, (a, b) =>
  // Re-render only when this card's own visual data changes. Callback props are
  // intentionally excluded: they're either referentially stable (play/callBack)
  // or close over the immutable `vm`, so skipping on their identity is safe and
  // is what keeps the active player's waveform in sync with the audio.
  a.vm === b.vm &&
  a.active === b.active &&
  a.selected === b.selected &&
  a.selectionMode === b.selectionMode &&
  a.expanded === b.expanded,
);

function StatusBadge({ status }: { status: VmStatus }) {
  const { VM, styles } = useVm();
  const color =
    status === 'urgent' ? VM.orange
    : status === 'new' ? VM.primary
    : status === 'read' ? VM.green
    : VM.text3;
  const bg =
    status === 'urgent' ? VM.orangeSoft
    : status === 'new' ? VM.primarySoft
    : status === 'read' ? VM.greenSoft
    : 'rgba(100, 116, 139, 0.12)';
  const label =
    status === 'urgent' ? 'URGENT'
    : status === 'new' ? 'NEW'
    : status === 'read' ? 'READ'
    : 'OLD';
  return (
    <View style={[styles.statusBadge, { backgroundColor: bg, borderColor: `${color}55` }]}>
      <Text style={[styles.statusText, { color }]}>{label}</Text>
    </View>
  );
}

// A fixed, organic-looking bar pattern (normalised 0..1 heights). Static by
// design — a real audio player shows a steady waveform and reveals the
// "played" portion left-to-right, rather than randomly jiggling.
const WAVE_BARS = [
  0.30, 0.55, 0.42, 0.78, 0.60, 0.88, 0.50, 0.70, 0.38, 0.62, 0.82, 0.46,
  0.66, 0.92, 0.54, 0.74, 0.40, 0.58, 0.84, 0.48, 0.68, 0.36, 0.60, 0.50,
];

function Waveform({
  active,
  progressAnim,
  accent,
  onSeek,
}: {
  active: boolean;
  progressAnim: Animated.Value;
  accent: string;
  // When provided (only for the active card), tapping or dragging on the wave
  // seeks playback to that position (Fix 6).
  onSeek?: (fraction: number) => void;
}) {
  const { VM, styles } = useVm();
  const [width, setWidth] = useState(0);

  // Live values read inside the (stable) PanResponder so it never needs to be
  // recreated as width / active / onSeek change.
  const widthRef = useRef(0);
  const onSeekRef = useRef(onSeek);
  useEffect(() => { onSeekRef.current = onSeek; }, [onSeek]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !!onSeekRef.current,
      onMoveShouldSetPanResponder: () => !!onSeekRef.current,
      onPanResponderGrant: (e) => {
        const w = widthRef.current;
        if (w > 0 && onSeekRef.current) {
          onSeekRef.current(Math.max(0, Math.min(1, e.nativeEvent.locationX / w)));
        }
      },
      onPanResponderMove: (e) => {
        const w = widthRef.current;
        if (w > 0 && onSeekRef.current) {
          onSeekRef.current(Math.max(0, Math.min(1, e.nativeEvent.locationX / w)));
        }
      },
    }),
  ).current;

  // PERF: memoized — each call builds ~60 <View> bars. Rebuilding them on
  // every row re-render was a large share of the view-update storms that froze
  // the JS thread with a 3,000-message mailbox (2026-07-28).
  const trackBars = React.useMemo(
    () =>
      WAVE_BARS.map((h, idx) => (
        <View
          key={idx}
          style={[styles.waveBar, { height: 4 + h * 24, backgroundColor: VM.waveTrack, opacity: 0.9 }]}
        />
      )),
    [VM.waveTrack],
  );
  const accentBars = React.useMemo(
    () =>
      WAVE_BARS.map((h, idx) => (
        <View
          key={idx}
          style={[styles.waveBar, { height: 4 + h * 24, backgroundColor: accent, opacity: 1 }]}
        />
      )),
    [accent],
  );

  return (
    <View
      style={styles.waveBars}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        // Guard: identical (±1px) re-layouts must not touch state — a state
        // update here re-renders 60 bar views and can re-trigger layout,
        // feeding the exact onLayout storm this file's perf notes describe.
        if (Math.abs(w - widthRef.current) < 1) return;
        widthRef.current = w;
        setWidth(w);
      }}
      {...panResponder.panHandlers}
    >
      {/* Unplayed track */}
      <View style={styles.waveRow}>{trackBars}</View>

      {/* Played portion, clipped to the live playback position. Driven by the
          shared Animated value so it glides in lockstep with the audio. */}
      {active && width > 0 && (
        <Animated.View
          style={[
            styles.waveOverlay,
            {
              width: progressAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [0, width],
                extrapolate: 'clamp',
              }),
            },
          ]}
        >
          <View style={[styles.waveRow, { width }]}>{accentBars}</View>
        </Animated.View>
      )}
    </View>
  );
}

function VoicemailActionMenu({
  vm,
  onClose,
  onToggleRead,
  onDownload,
  onDelete,
}: {
  vm: Voicemail | null;
  onClose: () => void;
  onToggleRead: (vm: Voicemail) => void;
  onDownload: (vm: Voicemail) => void;
  onDelete: (vm: Voicemail) => void;
}) {
  const { VM, styles } = useVm();
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
                icon="trash-outline"
                label="Delete"
                danger
                onPress={() => onDelete(vm)}
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
  const { VM, styles } = useVm();
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
  const { VM, styles } = useVm();
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
  const { styles } = useVm();
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
  const { VM, styles } = useVm();
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

function makeStyles(VM: VmPalette) {
  return StyleSheet.create({
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
    gap: spacing['2'],
    paddingHorizontal: spacing['5'],
    marginBottom: spacing['3'],
  },
  filterChip: {
    flex: 1,
    minHeight: 38,
    borderRadius: 16,
    borderWidth: 1,
    // Outline-style idle chips (Izzy 2026-07-28): transparent with a visible
    // pill border, matching Recent/Team/Chat — the old solid `cardMuted` fill
    // read as flat white cards in light mode.
    borderColor: VM.border,
    backgroundColor: 'transparent',
    paddingHorizontal: spacing['2'],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  filterLabel: {
    fontSize: 12.5,
    fontWeight: '800',
    includeFontPadding: false,
  },
  filterCount: {
    fontSize: 11.5,
    fontWeight: '800',
    includeFontPadding: false,
  },
  advancedChipRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing['5'],
    marginBottom: spacing['3'],
    marginTop: -spacing['1'],
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
    // NOT flex:1 — that let the five action buttons squeeze it until "selected"
    // wrapped onto two lines. Natural width, never shrinks, never wraps.
    flexShrink: 0,
    color: VM.text2,
    fontSize: 13,
    fontWeight: '700',
  },
  /** Takes the slack so the action buttons stay right-aligned. */
  selectionSpacer: {
    flex: 1,
    minWidth: spacing['2'],
  },
  // Count badge — carries the number so the label stays quiet and the row has
  // one clear anchor instead of four competing solid pills.
  selectionCountChip: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    paddingHorizontal: spacing['1.5'],
    backgroundColor: VM.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectionCountText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  // One filled accent (the primary action), everything else recedes — the old
  // bar painted all three actions solid blue, including Delete, which rendered
  // red text on a blue pill and failed contrast outright in light mode.
  selectionActionFilled: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: VM.primary,
    borderWidth: 1,
    borderColor: VM.primary,
  },
  selectionActionOutline: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: VM.border,
  },
  selectionActionDanger: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: VM.redSoft,
    borderWidth: 1,
    borderColor: VM.redSoft,
  },
  selectionActionGhost: {
    width: 32,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectionDivider: {
    width: 1,
    height: 22,
    backgroundColor: VM.borderSoft,
    marginHorizontal: spacing['0.5'],
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
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 2,
  },
  cardNew: {
    borderColor: `${VM.primary}44`,
    backgroundColor: VM.cardNewBg,
  },
  cardUrgent: {
    borderColor: `${VM.orange}66`,
    backgroundColor: VM.cardUrgentBg,
  },
  cardMuted: {
    backgroundColor: VM.cardOldBg,
  },
  cardSelected: {
    borderColor: VM.primary,
    backgroundColor: VM.cardSelectedBg,
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
  mailboxNumber: {
    color: VM.primary,
    textDecorationLine: 'underline',
  },
  cardRight: {
    alignItems: 'flex-end',
    gap: spacing['1.5'],
  },
  dateTimeTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['1'],
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(148, 163, 184, 0.10)',
    flexShrink: 1,
  },
  dateTimeTagText: {
    color: VM.text3,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
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
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  waveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: '100%',
    gap: 3,
  },
  waveOverlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  waveBar: {
    flex: 1,
    borderRadius: 2,
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
    justifyContent: 'space-between',
    gap: spacing['2'],
  },
  actionButtons: {
    flexDirection: 'row',
    alignItems: 'center',
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
    backgroundColor: VM.card2,
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
    backgroundColor: VM.card2,
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
    backgroundColor: VM.card2,
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
    color: VM.primaryInk,
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
    color: VM.primaryInk,
    fontSize: 14,
    fontWeight: '900',
  },
  });
}

import React, { useRef, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Platform,
  Keyboard,
  AppState,
} from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { getChatThreads, getVoicemails, mobileQueryKeys } from '../api/client';
import { loadRecentsSeen, recentsSeenQueryKey, vmBadgeQueryKey } from './badges';
import { autoSyncPhoneContacts } from '../contacts/autoSyncPhoneContacts';
import { TeamTab } from '../screens/tabs/TeamTab';
import { ContactTab } from '../screens/tabs/ContactTab';
import { KeypadTab } from '../screens/tabs/KeypadTab';
import { RecentTab } from '../screens/tabs/RecentTab';
import { ChatTab } from '../screens/tabs/ChatTab';
import { VoicemailTab } from '../screens/tabs/VoicemailTab';
import { SettingsScreen } from '../screens/SettingsScreen';
import { DEFAULT_LAUNCH_TAB, getLaunchTab, type LaunchTabId } from '../config/launchTab';
import type { TabParamList } from './types';

const Tab = createBottomTabNavigator<TabParamList>();

const TAB_CONFIG: Array<{
  name: keyof TabParamList;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconActive: keyof typeof Ionicons.glyphMap;
}> = [
  { name: 'Team', label: 'Team', icon: 'people-outline', iconActive: 'people' },
  { name: 'Contact', label: 'Contacts', icon: 'person-outline', iconActive: 'person' },
  { name: 'Recent', label: 'Recent', icon: 'time-outline', iconActive: 'time' },
  { name: 'Keypad', label: 'Keypad', icon: 'keypad-outline', iconActive: 'keypad' },
  { name: 'Chat', label: 'Chat', icon: 'chatbubbles-outline', iconActive: 'chatbubbles' },
  { name: 'Voicemail', label: 'Voicemail', icon: 'recording-outline', iconActive: 'recording' },
  { name: 'Settings', label: 'Settings', icon: 'settings-outline', iconActive: 'settings' },
];

type TabItemProps = {
  route: { name: string };
  isFocused: boolean;
  onPress: () => void;
  badge?: number;
};

function TabItem({ route, isFocused, onPress, badge }: TabItemProps) {
  const { colors } = useTheme();
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  const config = TAB_CONFIG.find((t) => t.name === route.name);

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: isFocused ? 1.05 : 1,
        useNativeDriver: true,
        speed: 20,
        bounciness: 8,
      }),
      Animated.timing(glowAnim, {
        toValue: isFocused ? 1 : 0,
        duration: 200,
        useNativeDriver: false,
      }),
    ]).start();
  }, [isFocused]);

  if (!config) return null;

  const iconName = isFocused ? config.iconActive : config.icon;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.tabItem}
      accessibilityRole="button"
      accessibilityLabel={config.label}
    >
      <Animated.View
        style={[
          styles.tabIconWrap,
          {
            backgroundColor: glowAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [colors.transparent, colors.tabActiveGlow],
            }),
          },
        ]}
      >
        <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
          <Ionicons
            name={iconName}
            size={22}
            color={isFocused ? colors.tabActive : colors.tabInactive}
          />
        </Animated.View>
        {!!badge && badge > 0 && (
          <View
            style={[
              styles.badge,
              { backgroundColor: colors.danger },
            ]}
          >
            <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
          </View>
        )}
      </Animated.View>
      {/* One line, always (Izzy 2026-07-31: "Contacts"/"Voicemail"/"Settings"
          were wrapping to a second row on iPhone). Seven tabs across a narrow
          screen leaves ~53pt per label, and the 10pt font needs ~57pt for
          "Voicemail". numberOfLines={1} stops the wrap and adjustsFontSizeToFit
          shrinks only the labels that need it (down to 8pt) instead of
          shortening the words — so the row height never changes and the labels
          stay readable on the smallest phones. */}
      <Text
        style={[
          styles.tabLabel,
          {
            color: isFocused ? colors.tabActive : colors.tabInactive,
            fontWeight: isFocused ? '600' : '500',
          },
        ]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
        ellipsizeMode="clip"
allowFontScaling={false}
      >
        {config.label}
      </Text>
    </TouchableOpacity>
  );
}

/** True while the soft keyboard is on screen. */
function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const showEvt = Platform.OS === 'android' ? 'keyboardDidShow' : 'keyboardWillShow';
    const hideEvt = Platform.OS === 'android' ? 'keyboardDidHide' : 'keyboardWillHide';
    const showSub = Keyboard.addListener(showEvt, () => setVisible(true));
    const hideSub = Keyboard.addListener(hideEvt, () => setVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
  return visible;
}

/**
 * Live unread counts for the tab badges (Izzy 2026-07-28). Chat rides the
 * already-preloaded thread cache (zero extra requests, instant clear when a
 * thread is read); Voicemail uses a light page-1 totals fetch; Recent counts
 * missed calls newer than the last Recents view (cleared on tab focus by
 * RecentTab via markRecentsSeen).
 */
function useTabBadges(): { Chat: number; Voicemail: number; Recent: number } {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    void loadRecentsSeen(queryClient);
  }, [queryClient]);

  const chatQuery = useQuery({
    queryKey: mobileQueryKeys.chatThreads,
    enabled: Boolean(token),
    queryFn: () => getChatThreads(token!),
    staleTime: 30 * 1000,
    gcTime: 20 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const chatUnread = Array.isArray(chatQuery.data)
    ? (chatQuery.data as Array<{ unread?: number }>).filter((t) => (t?.unread ?? 0) > 0).length
    : 0;

  const vmQuery = useQuery({
    queryKey: vmBadgeQueryKey(token),
    enabled: Boolean(token),
    queryFn: () => getVoicemails(token!, { maxPagesPerFolder: 1 }),
    staleTime: 60 * 1000,
    refetchInterval: 3 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
  // UNLISTENED count, not folder totals (Izzy 2026-07-31). Listening to a
  // voicemail sets listened=true but leaves the row in "inbox", so the old
  // `totals`-based badge stayed at the full count forever while the list
  // header correctly showed "2 new, 2 old". `unreadTotals` comes from the
  // server's listened=false count; it is absent on older API builds, in which
  // case the badge reads 0 rather than a wrong number.
  // Count the unread rows we actually FETCHED, not the server's whole-mailbox
  // totals (Izzy 2026-08-01). `unreadTotals` is honest but useless: Landau
  // ext 101 has 6,179 unlistened messages going back to September 2025, of which
  // only 15 arrived in the last 30 days. The list header therefore read
  // "0 new · 270 total" while the tab badge showed "9+" — the two disagreed
  // because they counted different things, and no amount of listening could
  // ever clear the badge by hand.
  //
  // The badge now counts the same recent window the app itself shows (page 1 of
  // each folder), so "New 0" in the header and an empty badge always agree.
  // A historical backlog stays visible in the Old/All filters where it belongs.
  const vmRows: any[] = Array.isArray((vmQuery.data as any)?.voicemails)
    ? (vmQuery.data as any).voicemails
    : [];
  const vmNew = vmRows.reduce(
    (n, v) => (v && v.listened === false && v.folder !== 'old' ? n + 1 : n),
    0,
  );

  // Subscribe to the caches without fetching — RecentTab owns the fetches.
  // MUST carry a cache-echo queryFn (2026-07-30): with no queryFn at all,
  // any code path that touches these keys (e.g. dndMissedCalls invalidating
  // callHistory) made React Query log a "No queryFn was passed" ERROR pair on
  // a loop — a render storm that re-created the row PanResponders mid-gesture
  // and killed the Recents/Contacts swipe actions after the first use.
  const historyQuery = useQuery<any>({
    queryKey: mobileQueryKeys.callHistory,
    enabled: false,
    queryFn: async () => queryClient.getQueryData(mobileQueryKeys.callHistory) ?? null,
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const seenQuery = useQuery<number>({
    queryKey: recentsSeenQueryKey,
    enabled: false,
    queryFn: async () => (queryClient.getQueryData(recentsSeenQueryKey) as number | undefined) ?? 0,
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const seenAt = typeof seenQuery.data === 'number' ? seenQuery.data : 0;
  let missedNew = 0;
  const historyRows: any[] = Array.isArray(historyQuery.data)
    ? (historyQuery.data as any[])
    : Array.isArray((historyQuery.data as any)?.calls)
      ? (historyQuery.data as any).calls
      : [];
  for (const r of historyRows) {
    const startedMs = Date.parse(String(r?.startedAt ?? ''));
    if (!Number.isFinite(startedMs) || startedMs <= seenAt) continue;
    const dir = String(r?.direction ?? '').toLowerCase();
    const disp = String(r?.disposition ?? '').toLowerCase();
    const inbound = dir === 'inbound' || dir === 'incoming';
    if (inbound && (disp === 'missed' || disp === 'no_answer' || (r?.durationSec ?? 1) === 0)) {
      missedNew += 1;
    }
  }

  return { Chat: chatUnread, Voicemail: vmNew, Recent: missedNew };
}

function CustomTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const badges = useTabBadges();

  // Hide the whole tab bar while typing so it never floats above the keyboard.
  if (keyboardVisible) return null;

  return (
    <View
      style={[
        styles.tabBar,
        {
          backgroundColor: colors.tabBar,
          borderTopColor: colors.tabBarBorder,
          paddingBottom: insets.bottom > 0 ? insets.bottom - 4 : 8,
        },
      ]}
    >
      {state.routes.map((route, index) => {
        const isFocused = state.index === index;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        return (
          <TabItem
            key={route.key}
            route={route}
            isFocused={isFocused}
            onPress={onPress}
            badge={(badges as Record<string, number>)[route.name] ?? 0}
          />
        );
      })}
    </View>
  );
}

/**
 * Warms the chat thread list into the React Query cache before the Chat tab is
 * ever opened. The bottom-tab navigator uses `lazy: true`, so `ChatTab` (and its
 * `threadsQuery`) does not mount until the user first taps Chat — which is why
 * the list used to flash a loading spinner on first open every app session. By
 * prefetching here (TabNavigator is always mounted while signed in) the same
 * cached data is ready the instant ChatTab mounts, so its `threadsQuery`
 * (refetchOnMount:false) shows it immediately and never spins. Re-warmed on
 * foreground so the preloaded list isn't stale. Keys/options mirror ChatTab so
 * it is literally the same cache entry.
 */
function useChatThreadsPreload() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!token) return;
    const prefetch = () => {
      queryClient
        .prefetchQuery({
          queryKey: mobileQueryKeys.chatThreads,
          queryFn: () => getChatThreads(token),
          staleTime: 30 * 1000,
          gcTime: 20 * 60 * 1000,
        })
        .catch(() => undefined);
    };
    prefetch();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') prefetch();
    });
    return () => sub.remove();
  }, [token, queryClient]);
}

/**
 * Silent phone-book → Connect contact delta-sync (Izzy 2026-07-28). Runs on
 * sign-in and every app foreground; no-ops without contacts permission; only
 * imports contacts ADDED after the first baseline run. After an import the
 * contacts cache is invalidated so names backfill across Recents / Chat /
 * Voicemail immediately.
 */
function usePhoneContactAutoSync() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!token) return;
    const run = () => {
      autoSyncPhoneContacts(token)
        .then((outcome) => {
          if (outcome.ran && !outcome.baselined && outcome.imported > 0) {
            queryClient.invalidateQueries({ queryKey: mobileQueryKeys.contacts('') }).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    };
    run();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => sub.remove();
  }, [token, queryClient]);
}

export function TabNavigator() {
  useChatThreadsPreload();
  usePhoneContactAutoSync();
  // User-chosen startup tab (Settings → Preferences → Launch Screen).
  // initialRouteName is read by react-navigation exactly once at mount, so the
  // preference must be loaded BEFORE the navigator renders — hence the
  // one-frame null while AsyncStorage answers (single-digit ms; the app is
  // still behind the splash/auth transition at that point). Everything after
  // mount (deep links, call screens, badges) is unaffected.
  const [initialTab, setInitialTab] = useState<LaunchTabId | null>(null);
  useEffect(() => {
    let cancelled = false;
    getLaunchTab()
      .then((t) => { if (!cancelled) setInitialTab(t); })
      .catch(() => { if (!cancelled) setInitialTab(DEFAULT_LAUNCH_TAB); });
    return () => { cancelled = true; };
  }, []);
  if (initialTab === null) return null;
  return (
    <Tab.Navigator
      initialRouteName={initialTab}
      tabBar={(props) => <CustomTabBar {...props} />}
      detachInactiveScreens={false}
      screenOptions={{
        headerShown: false,
        lazy: true,
        unmountOnBlur: false,
        // Freeze blurred tabs (react-freeze via react-native-screens): when
        // the user sweeps across tabs, every previously-visited tab kept
        // rendering its list fill-batches in the background — the combined
        // layout storm blocked the JS thread for 0.5–2.4s per sweep (the
        // "freezing when navigating", [JS_LAG] topLayout storms,
        // 2026-07-29). A frozen tab does zero render work until refocused;
        // its useFocusEffect hooks already re-sync data on focus.
        freezeOnBlur: true,
      }}
    >
      <Tab.Screen name="Team" component={TeamTab} />
      <Tab.Screen name="Contact" component={ContactTab} />
      <Tab.Screen name="Recent" component={RecentTab} />
      <Tab.Screen name="Keypad" component={KeypadTab} />
      <Tab.Screen name="Chat" component={ChatTab} />
      <Tab.Screen name="Voicemail" component={VoicemailTab} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 2,
  },
  tabIconWrap: {
    width: 42,
    height: 32,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  tabLabel: {
    fontSize: 10,
    letterSpacing: 0.3,
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 4,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  badgeText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '700',
  },
});

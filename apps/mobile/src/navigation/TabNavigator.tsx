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
import { TeamTab } from '../screens/tabs/TeamTab';
import { ContactTab } from '../screens/tabs/ContactTab';
import { KeypadTab } from '../screens/tabs/KeypadTab';
import { RecentTab } from '../screens/tabs/RecentTab';
import { ChatTab } from '../screens/tabs/ChatTab';
import { VoicemailTab } from '../screens/tabs/VoicemailTab';
import { SettingsScreen } from '../screens/SettingsScreen';
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
      <Text
        style={[
          styles.tabLabel,
          {
            color: isFocused ? colors.tabActive : colors.tabInactive,
            fontWeight: isFocused ? '600' : '500',
          },
        ]}
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
  const vmTotals: any = (vmQuery.data as any)?.totals;
  const vmNew = vmTotals ? Math.max(0, (vmTotals.inbox ?? 0) + (vmTotals.urgent ?? 0)) : 0;

  // Subscribe to the caches without fetching — RecentTab owns the fetches.
  const historyQuery = useQuery<any>({ queryKey: mobileQueryKeys.callHistory, enabled: false });
  const seenQuery = useQuery<number>({ queryKey: recentsSeenQueryKey, enabled: false });
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

export function TabNavigator() {
  useChatThreadsPreload();
  return (
    <Tab.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      detachInactiveScreens={false}
      screenOptions={{
        headerShown: false,
        lazy: true,
        unmountOnBlur: false,
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

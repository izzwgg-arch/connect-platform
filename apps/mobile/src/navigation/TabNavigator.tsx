import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Platform,
} from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useTheme } from '../context/ThemeContext';
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
  { name: 'Keypad', label: 'Keypad', icon: 'keypad-outline', iconActive: 'keypad' },
  { name: 'Recent', label: 'Recent', icon: 'time-outline', iconActive: 'time' },
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

function CustomTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

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
          />
        );
      })}
    </View>
  );
}

export function TabNavigator() {
  return (
    <Tab.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Team" component={TeamTab} />
      <Tab.Screen name="Contact" component={ContactTab} />
      <Tab.Screen name="Keypad" component={KeypadTab} />
      <Tab.Screen name="Recent" component={RecentTab} />
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

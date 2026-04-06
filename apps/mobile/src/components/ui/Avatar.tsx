import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { typography } from '../../theme/typography';

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

const SIZES: Record<AvatarSize, number> = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 52,
  xl: 72,
  '2xl': 96,
};

const FONT_SIZES: Record<AvatarSize, number> = {
  xs: 9,
  sm: 12,
  md: 15,
  lg: 20,
  xl: 28,
  '2xl': 36,
};

const AVATAR_COLORS = [
  ['#3b82f6', '#1d4ed8'],
  ['#06b6d4', '#0e7490'],
  ['#8b5cf6', '#6d28d9'],
  ['#f43f5e', '#be123c'],
  ['#10b981', '#047857'],
  ['#f59e0b', '#b45309'],
  ['#ec4899', '#9d174d'],
  ['#6366f1', '#4338ca'],
];

function colorForName(name: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const pair = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  return [pair[0], pair[1]];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return (name.slice(0, 2) || '??').toUpperCase();
}

type Props = {
  name: string;
  size?: AvatarSize;
  online?: boolean;
  status?: 'available' | 'online' | 'busy' | 'away' | 'offline' | 'oncall' | 'dnd';
};

export function Avatar({ name, size = 'md', online, status }: Props) {
  const { colors } = useTheme();
  const dim = SIZES[size];
  const fontSize = FONT_SIZES[size];
  const [bg] = colorForName(name);

  const statusColor = status
    ? {
        available: colors.presenceOnline,
        online: colors.presenceOnline,
        busy: colors.presenceBusy,
        away: colors.presenceAway,
        offline: colors.presenceOffline,
        oncall: colors.presenceOnCall,
        dnd: colors.presenceDnd,
      }[status] ?? colors.presenceOffline
    : online
    ? colors.presenceOnline
    : null;

  const badgeSize = Math.max(8, Math.round(dim * 0.28));

  return (
    <View style={{ width: dim, height: dim }}>
      <View
        style={[
          styles.circle,
          {
            width: dim,
            height: dim,
            borderRadius: dim / 2,
            backgroundColor: bg,
          },
        ]}
      >
        <Text style={{ fontSize, fontWeight: '700', color: '#fff', letterSpacing: 0.5 }}>
          {initials(name)}
        </Text>
      </View>
      {statusColor && (
        <View
          style={[
            styles.badge,
            {
              width: badgeSize,
              height: badgeSize,
              borderRadius: badgeSize / 2,
              backgroundColor: statusColor,
              borderColor: colors.bg,
              bottom: 0,
              right: 0,
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    borderWidth: 2,
  },
});

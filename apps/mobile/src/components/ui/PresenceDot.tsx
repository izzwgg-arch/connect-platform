import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { PresenceStatus } from '../../context/PresenceContext';

type Props = { status: PresenceStatus; size?: number };

export function PresenceDot({ status, size = 10 }: Props) {
  const { colors } = useTheme();

  const colorMap: Record<PresenceStatus, string> = {
    available: colors.presenceOnline,
    busy: colors.presenceBusy,
    dnd: colors.presenceDnd,
    away: colors.presenceAway,
    offline: colors.presenceOffline,
  };

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colorMap[status] ?? colors.presenceOffline,
      }}
    />
  );
}

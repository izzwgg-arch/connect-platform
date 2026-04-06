import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';

type BadgeVariant = 'primary' | 'success' | 'danger' | 'warning' | 'neutral';

type Props = {
  count?: number;
  dot?: boolean;
  variant?: BadgeVariant;
  max?: number;
};

export function Badge({ count, dot, variant = 'danger', max = 99 }: Props) {
  const { colors } = useTheme();

  const bg: Record<BadgeVariant, string> = {
    primary: colors.primary,
    success: colors.success,
    danger: colors.danger,
    warning: colors.warning,
    neutral: colors.textTertiary,
  };

  if (dot) {
    return <View style={[styles.dot, { backgroundColor: bg[variant] }]} />;
  }

  if (count === undefined || count <= 0) return null;

  const label = count > max ? `${max}+` : String(count);

  return (
    <View style={[styles.badge, { backgroundColor: bg[variant] }]}>
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});

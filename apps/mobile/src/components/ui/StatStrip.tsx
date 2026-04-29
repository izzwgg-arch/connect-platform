import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { radius, shadow, spacing } from '../../theme/spacing';

export type StatTone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

export type StatItem = {
  label: string;
  value: string | number;
  tone?: StatTone;
};

type Props = {
  items: StatItem[];
};

export function StatStrip({ items }: Props) {
  const { colors, isDark } = useTheme();

  const toneColor = (t?: StatTone): string => {
    switch (t) {
      case 'success': return colors.success;
      case 'warning': return colors.warning;
      case 'danger': return colors.danger;
      case 'neutral': return colors.textSecondary;
      default: return colors.primary;
    }
  };

  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
        },
        isDark ? shadow.none : shadow.sm,
      ]}
    >
      {items.map((item, idx) => {
        const tone = toneColor(item.tone);
        return (
          <React.Fragment key={`${item.label}-${idx}`}>
            {idx > 0 && <View style={[styles.divider, { backgroundColor: colors.borderSubtle }]} />}
            <View style={styles.cell}>
              <View style={[styles.accent, { backgroundColor: tone }]} />
              <Text style={[styles.value, { color: colors.text }]}>{item.value}</Text>
              <Text style={[styles.label, { color: colors.textSecondary }]} numberOfLines={1}>{item.label}</Text>
            </View>
          </React.Fragment>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    borderRadius: radius.xl,
    borderWidth: 1,
    marginHorizontal: spacing['4'],
    marginBottom: spacing['2'],
    paddingVertical: 12,
  },
  cell: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  accent: {
    width: 20,
    height: 3,
    borderRadius: 2,
    marginBottom: 6,
    opacity: 0.9,
  },
  value: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.4,
    lineHeight: 24,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    marginVertical: 6,
  },
});

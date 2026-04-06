import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme } from '../../context/ThemeContext';

type ChipVariant = 'success' | 'danger' | 'warning' | 'neutral' | 'primary' | 'teal';

type Props = {
  label: string;
  variant?: ChipVariant;
  onPress?: () => void;
  active?: boolean;
};

export function Chip({ label, variant = 'neutral', onPress, active }: Props) {
  const { colors } = useTheme();

  const config: Record<ChipVariant, { bg: string; text: string; border: string }> = {
    success: { bg: colors.successMuted, text: colors.successText, border: colors.success },
    danger: { bg: colors.dangerMuted, text: colors.dangerText, border: colors.danger },
    warning: { bg: colors.warningMuted, text: colors.warningText, border: colors.warning },
    neutral: { bg: colors.surfaceElevated, text: colors.textSecondary, border: colors.border },
    primary: { bg: colors.primaryMuted, text: colors.primary, border: colors.primary },
    teal: { bg: colors.tealMuted, text: colors.teal, border: colors.teal },
  };

  const c = config[variant];

  const inner = (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: active ? c.bg : colors.surfaceElevated,
          borderColor: active ? c.border : colors.border,
        },
      ]}
    >
      <Text style={[styles.text, { color: active ? c.text : colors.textSecondary }]}>
        {label}
      </Text>
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
        {inner}
      </TouchableOpacity>
    );
  }

  return inner;
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    marginRight: 8,
    marginBottom: 4,
  },
  text: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
});

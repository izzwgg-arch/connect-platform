import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/colors';
import { teamFilterChipColors } from '../../theme/filterChipColors';
import { radius, spacing } from '../../theme/spacing';
import { HorizontalFilterScroll } from './HorizontalFilterScroll';

export type FilterPillOption<T extends string> = {
  id: T;
  label: string;
  /**
   * Kept in the type for callers that still pass counts — but the pill UI
   * intentionally ignores it. Filter pills are label-only on mobile.
   */
  count?: number;
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
};

type Props<T extends string> = {
  options: FilterPillOption<T>[];
  value: T;
  onChange: (next: T) => void;
};

type PillTone = FilterPillOption<'all'>['tone'];

function accentForTone(tone: PillTone, colors: AppColors): string {
  switch (tone) {
    case 'success': return colors.success;
    case 'warning': return colors.warning;
    case 'danger': return colors.danger;
    case 'neutral': return colors.indigo;
    default: return colors.primary;
  }
}

export function FilterPills<T extends string>({ options, value, onChange }: Props<T>) {
  const { colors } = useTheme();

  return (
    <HorizontalFilterScroll paddingHorizontal={spacing['4']} marginBottom={spacing['2']}>
      {options.map((opt) => {
        const active = opt.id === value;
        const tone = opt.tone ?? 'primary';
        const accent = accentForTone(tone, colors);
        const surface = teamFilterChipColors(active, accent, colors);
        const labelColor = active ? accent : colors.textSecondary;

        return (
          <TouchableOpacity
            key={opt.id}
            onPress={() => onChange(opt.id)}
            activeOpacity={0.76}
            style={[styles.pill, surface]}
          >
            <Text style={[styles.label, { color: labelColor }]} numberOfLines={1}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </HorizontalFilterScroll>
  );
}

const styles = StyleSheet.create({
  /**
   * Android clips the bottom curve of fully-rounded bordered pills when the
   * pill has a fixed `height` — hidden font-metrics padding inside `<Text>`
   * pushes the glyphs past the border box. Use `paddingVertical` instead,
   * and turn off `includeFontPadding` on the label.
   * Never set `overflow: 'hidden'` — that also clips the rounded corners.
   */
  pill: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
    textAlign: 'center',
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
});

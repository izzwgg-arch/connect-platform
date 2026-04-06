import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { radius, shadow, spacing } from '../../theme/spacing';

type Props = {
  children: React.ReactNode;
  style?: ViewStyle;
  elevated?: boolean;
  noPadding?: boolean;
  bordered?: boolean;
};

export function Card({ children, style, elevated, noPadding, bordered = true }: Props) {
  const { colors } = useTheme();

  return (
    <View
      style={[
        styles.base,
        {
          backgroundColor: elevated ? colors.surfaceElevated : colors.surface,
          borderColor: bordered ? colors.border : colors.transparent,
          borderWidth: bordered ? 1 : 0,
          padding: noPadding ? 0 : spacing['4'],
        },
        elevated ? shadow.md : {},
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.xl,
    marginBottom: spacing['3'],
  },
});

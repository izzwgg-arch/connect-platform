import React from 'react';
import {
  TouchableOpacity,
  Text,
  ActivityIndicator,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { typography } from '../../theme/typography';
import { radius, spacing } from '../../theme/spacing';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'sm' | 'md' | 'lg';

type Props = {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  icon?: React.ReactNode;
  style?: ViewStyle;
};

const HEIGHT: Record<ButtonSize, number> = { sm: 36, md: 44, lg: 52 };
const H_PAD: Record<ButtonSize, number> = { sm: 14, md: 20, lg: 24 };
const FONT_SIZE: Record<ButtonSize, number> = { sm: 13, md: 14, lg: 16 };

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = false,
  icon,
  style,
}: Props) {
  const { colors } = useTheme();

  const bgMap: Record<ButtonVariant, string> = {
    primary: colors.primary,
    secondary: colors.primaryMuted,
    ghost: colors.transparent,
    danger: colors.danger,
    success: colors.success,
  };

  const textMap: Record<ButtonVariant, string> = {
    primary: '#fff',
    secondary: colors.primary,
    ghost: colors.primary,
    danger: '#fff',
    success: '#fff',
  };

  const borderMap: Record<ButtonVariant, string | undefined> = {
    primary: undefined,
    secondary: colors.primary,
    ghost: undefined,
    danger: undefined,
    success: undefined,
  };

  const isDisabled = disabled || loading;

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.75}
      style={[
        styles.base,
        {
          height: HEIGHT[size],
          paddingHorizontal: H_PAD[size],
          backgroundColor: bgMap[variant],
          borderColor: borderMap[variant],
          borderWidth: borderMap[variant] ? 1.5 : 0,
          opacity: isDisabled ? 0.5 : 1,
          borderRadius: radius.lg,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={textMap[variant]} />
      ) : (
        <View style={styles.inner}>
          {icon && <View style={styles.iconWrap}>{icon}</View>}
          <Text
            style={[
              styles.label,
              { color: textMap[variant], fontSize: FONT_SIZE[size] },
            ]}
          >
            {label}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconWrap: {
    marginRight: 8,
  },
  label: {
    fontWeight: '600',
    letterSpacing: 0.1,
  },
});

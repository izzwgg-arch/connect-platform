import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { typography } from '../../theme/typography';

type Props = {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
};

export function EmptyState({ icon = 'file-tray-outline', title, subtitle, action }: Props) {
  const { colors } = useTheme();

  return (
    <View style={styles.container}>
      <View style={[styles.iconWrap, { backgroundColor: colors.primaryDim }]}>
        <Ionicons name={icon} size={32} color={colors.textTertiary} />
      </View>
      <Text style={[typography.h3, { color: colors.text, marginTop: 16, textAlign: 'center' }]}>
        {title}
      </Text>
      {subtitle && (
        <Text
          style={[typography.body, { color: colors.textSecondary, textAlign: 'center', marginTop: 8 }]}
        >
          {subtitle}
        </Text>
      )}
      {action && <View style={{ marginTop: 20 }}>{action}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

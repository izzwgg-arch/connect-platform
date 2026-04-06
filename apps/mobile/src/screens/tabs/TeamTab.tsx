import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { EmptyState } from '../../components/ui/EmptyState';
import { HeaderBar } from '../../components/HeaderBar';

export function TeamTab() {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <HeaderBar title="Team" />
      <EmptyState
        icon="people-outline"
        title="Team directory unavailable"
        subtitle="Your team's extension presence will appear here once it's configured for your organization."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});

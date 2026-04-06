import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { EmptyState } from '../../components/ui/EmptyState';
import { HeaderBar } from '../../components/HeaderBar';

export function ContactTab() {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <HeaderBar title="Contacts" />
      <EmptyState
        icon="person-outline"
        title="No contacts yet"
        subtitle="Contact syncing will appear here once it's connected to your directory."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});

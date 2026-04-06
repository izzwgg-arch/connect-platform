import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { EmptyState } from '../../components/ui/EmptyState';
import { HeaderBar } from '../../components/HeaderBar';

export function ChatTab() {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <HeaderBar title="Chat" />
      <EmptyState
        icon="chatbubbles-outline"
        title="No conversations"
        subtitle="Messaging will appear here once it's enabled for your account."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { EmptyState } from '../../components/ui/EmptyState';
import { HeaderBar } from '../../components/HeaderBar';

export function VoicemailTab() {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <HeaderBar title="Voicemail" />
      <EmptyState
        icon="recording-outline"
        title="No voicemails"
        subtitle="New voicemail messages will appear here once voicemail is configured on your extension."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});

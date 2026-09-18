import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { AppScreen } from '../../components/AppScreen'
import { MoreStackParamList } from '../../types/navigation'
import { useOutboxCount } from '../../hooks/useOutboxCount'
import { Card } from '../../components/Card'
import { colors, spacing, typography } from '../../theme/tokens'
import { Ionicons } from '@expo/vector-icons'

type Props = NativeStackScreenProps<MoreStackParamList, 'MoreHome'>

export function MoreScreen({ navigation }: Props) {
  const outboxCount = useOutboxCount()
  return (
    <AppScreen>
      <View style={styles.header}>
        <Text style={styles.title}>More</Text>
        <Text style={styles.subtitle}>Additional tools and profile settings.</Text>
      </View>
      <Card>
        <MenuButton label="Requests" icon="document-text-outline" onPress={() => navigation.navigate('Requests')} />
        <MenuButton label="Issues" icon="alert-circle-outline" onPress={() => navigation.navigate('Issues')} />
        <MenuButton label="Calls" icon="call-outline" onPress={() => navigation.navigate('Calls')} />
        <MenuButton label={`Outbox${outboxCount > 0 ? ` (${outboxCount})` : ''}`} icon="cloud-upload-outline" onPress={() => navigation.navigate('Outbox')} />
        <MenuButton label="Profile" icon="person-outline" onPress={() => navigation.navigate('Profile')} />
      </Card>
    </AppScreen>
  )
}

function MenuButton({
  label,
  icon,
  onPress,
}: {
  label: string
  icon: keyof typeof Ionicons.glyphMap
  onPress: () => void
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.menuButton, pressed && styles.menuButtonPressed]}
      onPress={onPress}
      android_ripple={{ color: 'rgba(15,23,42,0.08)' }}
    >
      <Ionicons name={icon} size={18} color={colors.textSecondary} />
      <Text style={styles.menuText}>{label}</Text>
      <Ionicons name="chevron-forward-outline" size={16} color={colors.muted} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  header: { paddingTop: spacing.sm, paddingBottom: spacing.sm },
  title: { ...typography.h2, color: colors.textPrimary },
  subtitle: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  menuButton: {
    minHeight: 48,
    borderRadius: 10,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  menuButtonPressed: {
    opacity: 0.9,
  },
  menuText: { ...typography.body, color: colors.textPrimary, fontWeight: '600', flex: 1 },
})


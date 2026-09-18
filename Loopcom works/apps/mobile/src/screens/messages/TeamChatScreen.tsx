import React, { useEffect } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { apiRequest } from '../../api/client'
import { MessagesStackParamList } from '../../types/navigation'
import { colors, typography } from '../../theme/tokens'

type Props = NativeStackScreenProps<MessagesStackParamList, 'TeamChat'>

export function TeamChatScreen({ navigation }: Props) {
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const data = await apiRequest<{ conversationId: string }>('/api/messages/team/ensure', 'POST', {})
        if (!mounted) return
        navigation.replace('MessageThread', { conversationId: data.conversationId })
      } catch {
        if (!mounted) return
      }
    })()
    return () => {
      mounted = false
    }
  }, [navigation])

  return (
    <View style={styles.container}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.text}>Opening Team Chat...</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: colors.background,
  },
  text: {
    ...typography.body,
    color: colors.textSecondary,
  },
})

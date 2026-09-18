import React, { useMemo, useState } from 'react'
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Ionicons } from '@expo/vector-icons'
import { AppScreen } from '../../components/AppScreen'
import { apiRequest } from '../../api/client'
import { Conversation } from '../../types/models'
import { MessagesStackParamList } from '../../types/navigation'
import { colors, shadows, spacing, typography } from '../../theme/tokens'
import { ConversationRow } from '../../components/chat/ConversationRow'
import { StartMessageSheet } from '../../components/chat/StartMessageSheet'
import { EmptyState } from '../../components/EmptyState'

interface ConversationsResponse {
  conversations: Conversation[]
}

interface UsersResponse {
  users: Array<{
    id: string
    firstName?: string | null
    lastName?: string | null
    email: string
  }>
}

type Props = NativeStackScreenProps<MessagesStackParamList, 'MessagesList'>

export function MessagesScreen({ navigation }: Props) {
  const queryClient = useQueryClient()
  const [showNewMessageSheet, setShowNewMessageSheet] = useState(false)

  const conversationsQuery = useQuery({
    queryKey: ['mobile-chat-conversations'],
    queryFn: () => apiRequest<ConversationsResponse>('/api/messages/conversations'),
    refetchInterval: 20_000,
  })

  const usersQuery = useQuery({
    queryKey: ['mobile-chat-users'],
    queryFn: () => apiRequest<UsersResponse>('/api/messages/users'),
    refetchInterval: 60_000,
  })

  const createDmMutation = useMutation({
    mutationFn: async (userId: string) => apiRequest<{ conversationId: string }>('/api/messages/dm', 'POST', { userId }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['mobile-chat-conversations'] })
      setShowNewMessageSheet(false)
      navigation.navigate('MessageThread', { conversationId: result.conversationId })
    },
  })

  const teamEnsureMutation = useMutation({
    mutationFn: async () => apiRequest<{ conversationId: string }>('/api/messages/team/ensure', 'POST', {}),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['mobile-chat-conversations'] })
      setShowNewMessageSheet(false)
      navigation.navigate('MessageThread', { conversationId: result.conversationId })
    },
  })

  const conversationSections = useMemo(() => {
    const rows = conversationsQuery.data?.conversations || []
    const pinned = rows.find((c) => c.pinned)
    const others = rows.filter((c) => !c.pinned)
    const ordered = pinned ? [pinned, ...others] : others
    const regular = ordered.filter((conversation) => conversation.type !== 'JOB_THREAD')
    const jobGroups = new Map<string, Conversation[]>()

    for (const conversation of ordered) {
      if (conversation.type !== 'JOB_THREAD') continue
      const key = conversation.jobId || conversation.id
      const group = jobGroups.get(key) || []
      group.push(conversation)
      jobGroups.set(key, group)
    }

    return [
      ...(regular.length > 0 ? [{ key: 'regular', title: null, data: regular }] : []),
      ...Array.from(jobGroups.entries()).map(([key, data]) => ({
        key: `job-${key}`,
        title: `Job ${data[0].jobNumber || ''}${data[0].jobTitle ? ` — ${data[0].jobTitle}` : ''}`.trim(),
        data,
      })),
    ]
  }, [conversationsQuery.data?.conversations])

  const userOptions = useMemo(() => usersQuery.data?.users || [], [usersQuery.data?.users])

  return (
    <AppScreen>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Messages</Text>
          <Text style={styles.subtitle}>Team chat and direct messages</Text>
        </View>
        <Pressable style={styles.fab} onPress={() => setShowNewMessageSheet(true)}>
          <Ionicons name="create-outline" size={24} color={colors.surface} />
        </Pressable>
      </View>

      <SectionList
        style={styles.list}
        sections={conversationSections}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={conversationsQuery.isRefetching}
            onRefresh={() => conversationsQuery.refetch()}
          />
        }
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) =>
          section.title ? (
            <View style={styles.sectionHeader}>
              <Ionicons name="briefcase-outline" size={16} color={colors.brandPrimary} />
              <Text style={styles.sectionTitle} numberOfLines={1}>{section.title}</Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          conversationsQuery.isLoading ? null : (
            <EmptyState icon="chatbubbles-outline" title="No conversations yet" description="Start a new message to begin chatting." />
          )
        }
        renderItem={({ item }) => (
          <ConversationRow
            conversation={item}
            onPress={() => navigation.navigate('MessageThread', { conversationId: item.id })}
          />
        )}
      />

      <StartMessageSheet
        visible={showNewMessageSheet}
        users={userOptions}
        onClose={() => setShowNewMessageSheet(false)}
        onSelectUser={(userId) => createDmMutation.mutate(userId)}
        onSelectTeam={() => teamEnsureMutation.mutate()}
      />
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: '#F0F2F5',
  },
  title: {
    ...typography.h2,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  subtitle: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  fab: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#00A884',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.card,
  },
  listContent: {
    paddingBottom: spacing.xl,
  },
  list: {
    backgroundColor: colors.surface,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    backgroundColor: '#F7F8F8',
  },
  sectionTitle: {
    ...typography.caption,
    color: '#075E54',
    fontWeight: '700',
    flex: 1,
  },
})

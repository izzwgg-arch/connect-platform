import React, { useMemo, useState } from 'react'
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { InfiniteData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AppScreen } from '../../components/AppScreen'
import { EmptyState } from '../../components/EmptyState'
import { apiRequest } from '../../api/client'
import { JobsStackParamList } from '../../types/navigation'
import { colors, spacing, typography } from '../../theme/tokens'
import { useAuth } from '../../auth/AuthContext'
import { useMobilePermissions } from '../../hooks/useMobilePermissions'
import {
  listRequestDrafts,
  LocalRequestDraft,
  setRequestDraftPublishState,
} from '../../drafts/storage'
import { formatScheduledAt } from '../../utils/schedule'
import { publishRequestDraft } from '../../services/publish-request-draft'

type Props = NativeStackScreenProps<JobsStackParamList, 'RequestsHome'>

interface MobileRequestListItem {
  id: string
  firstName: string
  lastName: string
  status: string
  isUrgent?: boolean
  notes?: string | null
  createdAt: string
  createdBy: {
    firstName: string
    lastName: string
  } | null
}

interface RequestsListResponse {
  leads: MobileRequestListItem[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export function RequestsListScreen({ navigation }: Props) {
  const { token } = useAuth()
  const { canViewRequests } = useMobilePermissions()
  const allowViewRequests = canViewRequests()
  const queryClient = useQueryClient()
  const [isPullRefreshing, setIsPullRefreshing] = useState(false)
  const [localDrafts, setLocalDrafts] = useState<LocalRequestDraft[]>([])

  const reloadLocalDrafts = React.useCallback(async () => {
    setLocalDrafts(await listRequestDrafts())
  }, [])

  const query = useInfiniteQuery({
    queryKey: ['mobile-requests-list'],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      apiRequest<RequestsListResponse>(`/api/leads?page=${pageParam}&limit=20`),
    refetchInterval: 8000,
    refetchOnWindowFocus: true,
    enabled: allowViewRequests,
    getNextPageParam: (lastPage) => {
      const { page, totalPages } = lastPage.pagination
      return page < totalPages ? page + 1 : undefined
    },
  })
  const urgentMutation = useMutation({
    mutationFn: ({ requestId, isUrgent }: { requestId: string; isUrgent: boolean }) =>
      apiRequest<{ lead: MobileRequestListItem }>(`/api/requests/${requestId}/urgent`, 'PATCH', { isUrgent }),
    onSuccess: (result) => {
      const request = result?.lead
      if (!request?.id) return
      queryClient.setQueryData<InfiniteData<RequestsListResponse>>(['mobile-requests-list'], (existing) => {
        if (!existing) return existing
        return {
          ...existing,
          pages: existing.pages.map((page) => ({
            ...page,
            leads: (page.leads || []).map((lead) => (lead.id === request.id ? { ...lead, isUrgent: request.isUrgent } : lead)),
          })),
        }
      })
      queryClient.setQueryData<{ lead: { id: string; isUrgent?: boolean } }>(
        ['mobile-request-detail', request.id],
        (existing) =>
          existing?.lead
            ? {
                ...existing,
                lead: {
                  ...existing.lead,
                  isUrgent: request.isUrgent,
                },
              }
            : existing
      )
    },
  })

  useFocusEffect(
    React.useCallback(() => {
      if (!allowViewRequests) return () => {}
      void query.refetch()
      void reloadLocalDrafts()
      return () => {}
    }, [allowViewRequests, query.refetch, reloadLocalDrafts])
  )

  const handlePullRefresh = React.useCallback(async () => {
    setIsPullRefreshing(true)
    try {
      await Promise.all([query.refetch(), reloadLocalDrafts()])
    } finally {
      setIsPullRefreshing(false)
    }
  }, [query.refetch, reloadLocalDrafts])

  const requests = useMemo(
    () => (query.data?.pages || []).flatMap((page) => page.leads || []),
    [query.data]
  )

  const publishDraftMutation = useMutation({
    mutationFn: async (draft: LocalRequestDraft) => publishRequestDraft(draft),
    onSuccess: async ({ requestId, attachmentErrors }) => {
      await reloadLocalDrafts()
      void queryClient.invalidateQueries({ queryKey: ['mobile-requests-list'] })
      navigation.navigate('RequestDetail', { requestId })
      if (attachmentErrors.length > 0) {
        Alert.alert('Published with warnings', `Request was published, but ${attachmentErrors.length} attachment(s) failed.`)
      } else {
        Alert.alert('Published', 'Request uploaded successfully.')
      }
    },
    onError: async (error: any, draft) => {
      await setRequestDraftPublishState(draft.id, 'publishFailed', error?.message || 'Failed to publish request')
      await reloadLocalDrafts()
      Alert.alert('Publish failed', error?.message || 'Unable to publish this request.')
    },
  })

  if (!allowViewRequests) {
    return (
      <AppScreen>
        <View style={styles.loadingWrap}>
          <EmptyState
            icon="lock-closed-outline"
            title="Access restricted"
            description="You don't have permission to view requests."
          />
        </View>
      </AppScreen>
    )
  }

  if (query.isLoading && requests.length === 0) {
    return (
      <AppScreen>
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.brandPrimary} />
          <Text style={styles.loadingText}>Loading requests...</Text>
        </View>
      </AppScreen>
    )
  }

  if (query.isError && requests.length === 0) {
    return (
      <AppScreen>
        <View style={styles.loadingWrap}>
          <EmptyState
            icon="alert-circle-outline"
            title="Failed to load requests"
            description="Please try again."
          />
          <Pressable style={styles.retryButton} onPress={() => void query.refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </AppScreen>
    )
  }

  return (
    <AppScreen>
      <FlatList
        data={requests}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={isPullRefreshing}
            onRefresh={() => void handlePullRefresh()}
          />
        }
        ListHeaderComponent={
          <View style={styles.headerWrap}>
            <View style={styles.headerRow}>
              <Text style={styles.headerTitle}>Requests</Text>
              <Pressable
                style={styles.newButton}
                onPress={() => navigation.navigate('RequestCreate')}
              >
                <Text style={styles.newButtonText}>New Request</Text>
              </Pressable>
            </View>
            <Text style={styles.sectionLabel}>Local drafts</Text>
            {localDrafts.length === 0 ? (
              <Text style={styles.localDraftEmpty}>No unpublished request drafts on this phone.</Text>
            ) : (
              localDrafts.map((draft) => (
                <View key={draft.id} style={styles.localDraftCard}>
                  <View style={styles.requestHeadRow}>
                    <Text style={styles.requestName}>
                      {draft.firstName || 'Unfinished'} {draft.lastName || 'request'}
                    </Text>
                    <Text style={styles.localBadge}>{draft.publishState === 'publishFailed' ? 'Publish failed' : 'Local draft'}</Text>
                  </View>
                  <Text style={styles.requestMeta}>
                    {draft.kind === 'MEASURING' ? 'Measuring request' : 'Request'} · {formatScheduledAt(draft.scheduledAt)}
                  </Text>
                  <Text style={styles.requestMeta}>
                    {draft.publishState === 'publishFailed'
                      ? 'Local draft · Publish failed'
                      : draft.publishState === 'readyToPublish'
                        ? 'Local draft · Ready to publish'
                        : 'Local draft · Unpublished'}
                  </Text>
                  <Text style={styles.requestMeta}>
                    {draft.clientMode === 'existing'
                      ? `Existing client: ${draft.selectedClientName || 'Not selected'}`
                      : 'New client request'}
                  </Text>
                  {(draft.notes || '').trim() ? (
                    <Text numberOfLines={2} style={styles.requestNotes}>
                      {draft.notes}
                    </Text>
                  ) : null}
                  {draft.publishError ? <Text style={styles.publishError}>{draft.publishError}</Text> : null}
                  <View style={styles.requestActionRow}>
                    <Pressable style={styles.urgentButton} onPress={() => navigation.navigate('RequestCreate', { draftId: draft.id })}>
                      <Text style={styles.urgentButtonText}>Edit</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.urgentButton, (!token || publishDraftMutation.isPending) && styles.disabledAction]}
                      onPress={() => publishDraftMutation.mutate(draft)}
                      disabled={!token || publishDraftMutation.isPending}
                    >
                      <Text style={styles.urgentButtonText}>
                        {publishDraftMutation.isPending ? 'Publishing...' : 'Publish'}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[styles.urgentButton, styles.deleteDraftButton]}
                      onPress={() => {
                        Alert.alert('Delete local draft', 'Remove this unpublished request draft from this phone?', [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Delete',
                            style: 'destructive',
                            onPress: () => {
                              void deleteRequestDraft(draft.id).then(reloadLocalDrafts)
                            },
                          },
                        ])
                      }}
                    >
                      <Text style={[styles.urgentButtonText, styles.deleteDraftButtonText]}>Delete</Text>
                    </Pressable>
                  </View>
                </View>
              ))
            )}
            <Text style={styles.sectionLabel}>Published requests</Text>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon="document-text-outline"
            title="No requests yet"
            description="Create a request to get started."
          />
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.requestCard}
            onPress={() => navigation.navigate('RequestDetail', { requestId: item.id })}
          >
            <View style={styles.requestHeadRow}>
              <Text style={styles.requestName}>
                {item.firstName} {item.lastName}
              </Text>
              {item.isUrgent ? <Text style={styles.urgentBadge}>URGENT</Text> : null}
            </View>
            <Text style={styles.requestMeta}>
              {item.status} · {new Date(item.createdAt).toLocaleDateString()}
              {item.createdBy ? ` · Created by ${item.createdBy.firstName} ${item.createdBy.lastName}` : ''}
            </Text>
            {item.notes ? (
              <Text numberOfLines={2} style={styles.requestNotes}>
                {item.notes}
              </Text>
            ) : null}
            <View style={styles.requestActionRow}>
              <Pressable
                style={[styles.urgentButton, item.isUrgent && styles.urgentButtonActive]}
                onPress={(event) => {
                  event.stopPropagation?.()
                  urgentMutation.mutate({ requestId: item.id, isUrgent: !item.isUrgent })
                }}
              >
                <Text style={[styles.urgentButtonText, item.isUrgent && styles.urgentButtonTextActive]}>
                  {item.isUrgent ? 'Unmark Urgent' : 'Mark Urgent'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        )}
        ListFooterComponent={
          query.hasNextPage ? (
            <Pressable
              style={styles.loadMoreButton}
              onPress={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              <Text style={styles.loadMoreText}>
                {query.isFetchingNextPage ? 'Loading...' : 'Load more'}
              </Text>
            </Pressable>
          ) : null
        }
      />
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  loadingText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  retryButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.brandPrimary,
    borderRadius: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: {
    ...typography.sub,
    color: colors.surface,
    fontWeight: '600',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  headerWrap: {
    gap: spacing.xs,
  },
  headerTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  newButton: {
    backgroundColor: colors.brandPrimary,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  newButtonText: {
    ...typography.sub,
    color: colors.surface,
    fontWeight: '600',
  },
  requestCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.md,
  },
  localDraftCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D7E2EA',
    padding: spacing.md,
  },
  requestHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  requestName: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  urgentBadge: {
    ...typography.caption,
    color: '#B91C1C',
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontWeight: '700',
  },
  requestMeta: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  localBadge: {
    ...typography.caption,
    color: '#175CD3',
    backgroundColor: '#EFF8FF',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontWeight: '700',
  },
  requestNotes: {
    ...typography.caption,
    color: colors.textPrimary,
    marginTop: spacing.xs,
  },
  publishError: {
    ...typography.caption,
    color: '#B42318',
    marginTop: spacing.xs,
  },
  requestActionRow: {
    marginTop: spacing.xs,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    flexWrap: 'wrap',
  },
  urgentButton: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 8,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    backgroundColor: colors.surface,
  },
  urgentButtonActive: {
    borderColor: '#FCA5A5',
    backgroundColor: '#FEF2F2',
  },
  deleteDraftButton: {
    borderColor: '#FECACA',
    backgroundColor: '#FEF2F2',
  },
  deleteDraftButtonText: {
    color: '#B42318',
  },
  disabledAction: {
    opacity: 0.6,
  },
  sectionLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginTop: spacing.xs,
  },
  localDraftEmpty: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  urgentButtonText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  urgentButtonTextActive: {
    color: '#B91C1C',
  },
  loadMoreButton: {
    alignSelf: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.divider,
    backgroundColor: colors.surface,
  },
  loadMoreText: {
    ...typography.sub,
    color: colors.textPrimary,
  },
})

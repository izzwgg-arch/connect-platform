import React, { useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useQuery } from '@tanstack/react-query'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { AppScreen } from '../../components/AppScreen'
import { apiRequest } from '../../api/client'
import { Conversation, Job } from '../../types/models'
import { SyncBanner } from '../../components/SyncBanner'
import { useOnlineState } from '../../hooks/useOnlineState'
import { useOutboxCount } from '../../hooks/useOutboxCount'
import { colors, radius, spacing, typography } from '../../theme/tokens'
import { JobsStackParamList } from '../../types/navigation'
import { EmptyState } from '../../components/EmptyState'
import { JobCard } from '../../components/JobCard'
import { SectionHeader } from '../../components/SectionHeader'
import {
  PRODUCTION_STAGES,
  ProductionStageId,
  WORK_QUEUES,
  WorkQueueId,
  countByQueue,
  countByStage,
  filterJobsForProductionLine,
} from '../../lib/productionLine'

type Props = NativeStackScreenProps<JobsStackParamList, 'JobsList'>

interface JobsResponse {
  jobs: Job[]
}

interface ConversationsResponse {
  conversations: Conversation[]
}

export function JobsScreen({ navigation }: Props) {
  const isOnline = useOnlineState()
  const outboxCount = useOutboxCount()
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null)
  const [queueFilter, setQueueFilter] = useState<WorkQueueId>('do_now')
  const [stageFilter, setStageFilter] = useState<ProductionStageId | 'all'>('all')

  const jobsQuery = useQuery({
    queryKey: ['mobile-jobs-assigned'],
    queryFn: async () => {
      const data = await apiRequest<JobsResponse>('/api/mobile/jobs?limit=100&filter=assigned')
      setLastSyncAt(new Date())
      return data
    },
    refetchInterval: 60_000,
  })

  const conversationsQuery = useQuery({
    queryKey: ['mobile-conversations'],
    queryFn: () => apiRequest<ConversationsResponse>('/api/messages/conversations?assigned=me'),
    refetchInterval: 45_000,
  })

  const jobs = useMemo(() => {
    const list = jobsQuery.data?.jobs ?? []
    const byId = new Map<string, Job>()
    for (const job of list) {
      if (job?.id && !byId.has(job.id)) byId.set(job.id, job)
    }
    return Array.from(byId.values())
  }, [jobsQuery.data])

  const queueCounts = useMemo(() => countByQueue(jobs), [jobs])
  const stageCounts = useMemo(() => countByStage(jobs), [jobs])

  const visibleJobs = useMemo(
    () => filterJobsForProductionLine(jobs, { queue: queueFilter, stage: stageFilter }),
    [jobs, queueFilter, stageFilter]
  )

  const unreadMessagesByJob = useMemo(() => {
    const map = new Map<string, number>()
    const rows = conversationsQuery.data?.conversations ?? []
    for (const row of rows) {
      const jobId = (row as any).jobId as string | undefined
      if (!jobId) continue
      map.set(jobId, Number(row.unreadCount || 0))
    }
    return map
  }, [conversationsQuery.data?.conversations])

  const onRefresh = async () => {
    await Promise.all([jobsQuery.refetch(), conversationsQuery.refetch()])
  }

  const emptyCopy = useMemo(() => {
    if (queueFilter === 'do_now') {
      return {
        title: 'Nothing to do right now',
        description: 'No urgent assigned jobs. Check Today or the production line.',
      }
    }
    if (queueFilter === 'today') {
      return {
        title: 'No jobs today',
        description: 'Nothing on your schedule for today.',
      }
    }
    if (queueFilter === 'waiting') {
      return {
        title: 'Nothing waiting',
        description: 'No assigned jobs are waiting on the next step.',
      }
    }
    if (queueFilter === 'done') {
      return {
        title: 'No finished jobs',
        description: 'Completed, cancelled, and invoiced jobs will show here.',
      }
    }
    return {
      title: 'No assigned jobs',
      description: 'You have no assigned jobs yet.',
    }
  }, [queueFilter])

  return (
    <AppScreen>
      <FlatList
        data={visibleJobs}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={jobsQuery.isRefetching || conversationsQuery.isRefetching}
            onRefresh={() => void onRefresh()}
          />
        }
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <SyncBanner
              isOnline={isOnline}
              isSyncing={jobsQuery.isFetching || conversationsQuery.isFetching}
              lastSyncAt={lastSyncAt}
              outboxCount={outboxCount}
            />
            <SectionHeader title="My production line" />
            <Text style={styles.subtitle}>
              {visibleJobs.length} shown · {queueCounts.do_now} do now · {queueCounts.today} today
            </Text>

            <Text style={styles.filterLabel}>My queue</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              {WORK_QUEUES.map((item) => {
                const active = queueFilter === item.id
                const count = queueCounts[item.id]
                return (
                  <Pressable
                    key={item.id}
                    onPress={() => {
                      setQueueFilter(item.id)
                      if (item.id === 'done') setStageFilter('all')
                    }}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {item.label}
                      {item.id !== 'all' ? ` (${count})` : count ? ` (${count})` : ''}
                    </Text>
                  </Pressable>
                )
              })}
            </ScrollView>

            <Text style={styles.filterLabel}>Production line</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              <Pressable
                onPress={() => setStageFilter('all')}
                style={[styles.chip, stageFilter === 'all' && styles.chipActive]}
              >
                <Text style={[styles.chipText, stageFilter === 'all' && styles.chipTextActive]}>
                  All stages
                </Text>
              </Pressable>
              {PRODUCTION_STAGES.filter((stage) =>
                queueFilter === 'done' ? stage.id === 'done' : stage.id !== 'done'
              ).map((stage) => {
                const active = stageFilter === stage.id
                const count = stageCounts[stage.id]
                return (
                  <Pressable
                    key={stage.id}
                    onPress={() => setStageFilter(stage.id)}
                    style={[
                      styles.chip,
                      active && styles.chipActive,
                      stage.id === 'blocked' && styles.chipBlocked,
                      active && stage.id === 'blocked' && styles.chipBlockedActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        active && styles.chipTextActive,
                        stage.id === 'blocked' && !active && styles.chipBlockedText,
                      ]}
                    >
                      {stage.label} ({count})
                    </Text>
                  </Pressable>
                )
              })}
            </ScrollView>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon="briefcase-outline"
            title={emptyCopy.title}
            description={emptyCopy.description}
          />
        }
        renderItem={({ item }) => (
          <View style={styles.stackItem}>
            <JobCard
              job={item}
              onPress={() => navigation.navigate('JobDetail', { jobId: item.id })}
              hasUnreadMessages={(unreadMessagesByJob.get(item.id) || 0) > 0}
              hasNewMedia={false}
              hasOpenIssue={false}
              showNextAction
            />
          </View>
        )}
      />
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  listHeader: { gap: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.md },
  subtitle: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: -4,
    marginBottom: spacing.xs,
  },
  filterLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: spacing.xs,
  },
  chipRow: {
    gap: spacing.xs,
    paddingVertical: 2,
    paddingRight: spacing.md,
  },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  chipActive: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  chipBlocked: {
    borderColor: 'rgba(194,65,12,0.35)',
  },
  chipBlockedActive: {
    backgroundColor: '#C2410C',
    borderColor: '#C2410C',
  },
  chipText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  chipTextActive: {
    color: '#FFFFFF',
  },
  chipBlockedText: {
    color: '#C2410C',
  },
  stackItem: { marginBottom: spacing.sm },
})

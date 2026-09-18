import React, { useState, useMemo } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View, Alert } from 'react-native'
import { useQuery } from '@tanstack/react-query'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Ionicons } from '@expo/vector-icons'
import { AppScreen } from '../../components/AppScreen'
import { apiRequest } from '../../api/client'
import { Job } from '../../types/models'
import { colors, radius, spacing, typography } from '../../theme/tokens'
import { EmptyState } from '../../components/EmptyState'
import { JobCard } from '../../components/JobCard'
import { Card } from '../../components/Card'
import { useMobilePermissions } from '../../hooks/useMobilePermissions'
import { JobsStackParamList } from '../../types/navigation'

type Props = NativeStackScreenProps<JobsStackParamList, 'AllJobsList'>

interface JobsResponse {
  jobs: Array<Job & {
    client: {
      id: string
      name: string
      companyName: string | null
    }
    assignments: Array<{
      id: string
      role: string | null
      user: {
        id: string
        firstName: string
        lastName: string
      }
    }>
    _count: {
      tasks: number
      issues: number
    }
  }>
  pagination: {
    total: number
    totalPages: number
    page: number
    limit: number
  }
}

const JOB_STATUSES = [
  { value: 'all', label: 'All Status' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'QUOTE', label: 'Quote' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'MEASURED', label: 'Measured' },
  { value: 'NEED_TO_ORDER', label: 'Need to order' },
  { value: 'ORDERED', label: 'Ordered' },
  { value: 'INSTALLATION_COMPLETE', label: 'Installation Complete' },
  { value: 'NEED_TOUCH_UPS', label: 'Need touch ups' },
  { value: 'FINISHING_COMPLETE', label: 'Finishing Complete' },
  { value: 'ON_HOLD', label: 'On Hold' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'INVOICED', label: 'Invoiced' },
]

export function AllJobsScreen({ navigation }: Props) {
  const { canViewAllJobs, canCreateJobs } = useMobilePermissions()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [searchDebounce, setSearchDebounce] = useState('')

  // Check if user has permission to view all jobs
  if (!canViewAllJobs()) {
    return (
      <AppScreen>
        <View style={styles.errorContainer}>
          <Ionicons name="lock-closed-outline" size={48} color={colors.textSecondary} />
          <Text style={styles.errorTitle}>Access Denied</Text>
          <Text style={styles.errorText}>You don't have permission to view all jobs.</Text>
        </View>
      </AppScreen>
    )
  }

  // Debounce search
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setSearchDebounce(search)
      setPage(1)
    }, 500)
    return () => clearTimeout(timer)
  }, [search])

  const jobsQuery = useQuery({
    queryKey: ['all-jobs', searchDebounce, statusFilter, page],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (searchDebounce) params.append('search', searchDebounce)
      if (statusFilter && statusFilter !== 'all') {
        params.append('status', statusFilter)
      }
      params.append('page', String(page))
      params.append('limit', '50')

      const data = await apiRequest<JobsResponse>(`/api/jobs?${params.toString()}`)
      return data
    },
    refetchInterval: 60_000,
  })

  const pagination = jobsQuery.data?.pagination

  const handleRefresh = () => {
    jobsQuery.refetch()
  }

  const handleLoadMore = () => {
    if (pagination && page < pagination.totalPages) {
      setPage((p) => p + 1)
    }
  }

  const jobs = useMemo(() => {
    const jobList = jobsQuery.data?.jobs ?? []
    // Transform jobs to match JobCard expected format
    return jobList.map((job) => ({
      ...job,
      client: job.client,
      address: job.addresses?.[0] || null,
    }))
  }, [jobsQuery.data])

  return (
    <AppScreen>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={styles.searchContainer}>
            <Ionicons name="search-outline" size={20} color={colors.textSecondary} style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search jobs..."
              placeholderTextColor={colors.textPrimary}
              value={search}
              onChangeText={setSearch}
            />
            {search.length > 0 && (
              <Pressable
                onPress={() => {
                  setSearch('')
                  setPage(1)
                }}
                style={styles.clearButton}
              >
                <Ionicons name="close-circle" size={20} color={colors.textSecondary} />
              </Pressable>
            )}
          </View>
          {canCreateJobs() && (
            <Pressable
              style={styles.createButton}
              onPress={() => navigation.navigate('CreateJob')}
            >
              <Ionicons name="add-circle" size={24} color={colors.brandPrimary} />
            </Pressable>
          )}
        </View>
      </View>

      <Card style={styles.filterCard}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={JOB_STATUSES}
          keyExtractor={(item) => item.value}
          renderItem={({ item }) => (
            <Pressable
              style={[styles.filterChip, statusFilter === item.value && styles.filterChipActive]}
              onPress={() => {
                setStatusFilter(item.value)
                setPage(1)
              }}
            >
              <Text style={[styles.filterChipText, statusFilter === item.value && styles.filterChipTextActive]}>{item.label}</Text>
            </Pressable>
          )}
          contentContainerStyle={styles.filterChipsContainer}
        />
      </Card>

      <FlatList
        data={jobs}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={jobsQuery.isRefetching} onRefresh={handleRefresh} />}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          jobsQuery.isLoading ? (
            <View style={styles.loadingContainer}>
              <Text style={styles.loadingText}>Loading jobs...</Text>
            </View>
          ) : (
            <EmptyState icon="briefcase-outline" title="No jobs found" description={searchDebounce ? 'Try adjusting your search terms.' : 'No jobs match your filters.'} />
          )
        }
        ListFooterComponent={
          pagination && pagination.totalPages > 1 ? (
            <View style={styles.paginationInfo}>
              <Text style={styles.paginationText}>
                Page {pagination.page} of {pagination.totalPages} • {pagination.total} total jobs
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.jobItem}>
            <JobCard
              job={item as Job}
              onPress={() => navigation.navigate('AdminJobDetail', { jobId: item.id })}
              hasUnreadMessages={false}
              hasNewMedia={false}
              hasOpenIssue={(item._count?.issues || 0) > 0}
            />
          </View>
        )}
        contentContainerStyle={styles.listContent}
      />
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  createButton: {
    padding: spacing.xs,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    paddingHorizontal: spacing.md,
    height: 44,
  },
  searchIcon: {
    marginRight: spacing.sm,
  },
  searchInput: {
    flex: 1,
    ...typography.sub,
    color: colors.textPrimary,
    padding: 0,
  },
  clearButton: {
    padding: spacing.xs,
  },
  filterCard: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  filterChipsContainer: {
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
    marginRight: spacing.xs,
  },
  filterChipActive: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  filterChipText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: '#E6C98B',
  },
  listContent: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  jobItem: {
    marginBottom: spacing.sm,
  },
  loadingContainer: {
    padding: spacing.xl,
    alignItems: 'center',
  },
  loadingText: {
    ...typography.sub,
    color: colors.textSecondary,
  },
  paginationInfo: {
    padding: spacing.md,
    alignItems: 'center',
  },
  paginationText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  errorTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  errorText: {
    ...typography.sub,
    color: colors.textSecondary,
    textAlign: 'center',
  },
})

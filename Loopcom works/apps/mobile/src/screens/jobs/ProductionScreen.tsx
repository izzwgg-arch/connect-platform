import React, { useMemo, useState } from 'react'
import {
  Dimensions,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useQuery } from '@tanstack/react-query'
import { Ionicons } from '@expo/vector-icons'
import { AppScreen } from '../../components/AppScreen'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { apiRequest } from '../../api/client'
import { colors, radius, spacing, typography } from '../../theme/tokens'
import {
  PRODUCTION_BOARD_COLUMNS,
  getProductionInfo,
  type ProductionBoardColumn,
} from '../../lib/productionBoard'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { JobsStackParamList } from '../../types/navigation'

type Props = NativeStackScreenProps<JobsStackParamList, 'Production'>

interface ProductionJob {
  id: string
  jobNumber: string
  title: string
  status: string
  priority: number
  scheduledStart: string | null
  scheduledEnd: string | null
  estimateAmount: string | null
  actualAmount: string | null
  client: { id: string; name: string; companyName: string | null } | null
  assignments: Array<{ id: string; user: { id: string; firstName: string; lastName: string } }>
  addresses: Array<{ id: string; street: string | null; city: string | null; state: string | null; zipCode: string | null }>
  production: {
    stage: string
    nextAction: string
    board: ProductionBoardColumn
    boardLabel: string
    isActive: boolean
    isOnHold: boolean
    isArchived: boolean
  }
}

interface ProductionCounts {
  activeProduction: number
  needToOrder: number
  ordered: number
  inProgress: number
  needTouchUps: number
  onHold: number
  readyForInstallation: number
  completed: number
}

interface ProductionResponse {
  jobs: ProductionJob[]
  counts: ProductionCounts
}

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All Status' },
  { value: 'QUOTE', label: 'Quote' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'MEASURED', label: 'Measured' },
  { value: 'NEED_TO_ORDER', label: 'Need to order' },
  { value: 'ORDERED', label: 'Ordered' },
  { value: 'INSTALLATION_COMPLETE', label: 'Installation complete' },
  { value: 'NEED_TOUCH_UPS', label: 'Need touch ups' },
  { value: 'FINISHING_COMPLETE', label: 'Finishing complete' },
  { value: 'ON_HOLD', label: 'On Hold' },
]

const SUMMARY_CARDS: Array<{ key: keyof ProductionCounts; label: string }> = [
  { key: 'activeProduction', label: 'Active' },
  { key: 'needToOrder', label: 'Need to Order' },
  { key: 'ordered', label: 'Ordered' },
  { key: 'inProgress', label: 'In Progress' },
  { key: 'needTouchUps', label: 'Touch-Ups' },
  { key: 'onHold', label: 'On Hold' },
  { key: 'readyForInstallation', label: 'Ready' },
  { key: 'completed', label: 'Completed' },
]

const COLUMN_WIDTH = Math.min(280, Dimensions.get('window').width * 0.78)
const COLUMN_MAX_HEIGHT = 420

function formatDateShort(value: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function ProductionScreen({ navigation }: Props) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [archiveView, setArchiveView] = useState(false)

  const query = useQuery({
    queryKey: ['production-board', archiveView],
    queryFn: () =>
      apiRequest<ProductionResponse>(`/api/production${archiveView ? '?view=archive' : ''}`),
    refetchInterval: 60_000,
  })

  const jobs = query.data?.jobs ?? []
  const counts = query.data?.counts

  const visibleJobs = useMemo(() => {
    const term = search.trim().toLowerCase()
    return jobs.filter((job) => {
      if (statusFilter !== 'all' && job.status !== statusFilter) return false
      if (!term) return true
      const address = job.addresses?.[0]
      const haystack = [
        job.jobNumber,
        job.title,
        job.client?.companyName,
        job.client?.name,
        address?.street,
        address?.city,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(term)
    })
  }, [jobs, search, statusFilter])

  const onHoldJobs = useMemo(() => visibleJobs.filter((j) => j.production.isOnHold), [visibleJobs])

  const columns = useMemo(
    () =>
      PRODUCTION_BOARD_COLUMNS.map((col) => ({
        ...col,
        jobs: visibleJobs.filter((j) => j.production.board === col.id),
      })),
    [visibleJobs]
  )

  return (
    <AppScreen padded={false}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} />}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Summary */}
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={SUMMARY_CARDS}
          keyExtractor={(item) => item.key}
          contentContainerStyle={styles.summaryRow}
          renderItem={({ item }) => (
            <Card style={styles.summaryCard}>
              <Text style={styles.summaryValue}>{counts ? counts[item.key] : '—'}</Text>
              <Text style={styles.summaryLabel}>{item.label}</Text>
            </Card>
          )}
        />

        {/* Search + Archive toggle */}
        <View style={styles.controlsRow}>
          <View style={styles.searchBox}>
            <Ionicons name="search-outline" size={18} color={colors.textSecondary} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search jobs, client, address..."
              placeholderTextColor={colors.muted}
              value={search}
              onChangeText={setSearch}
            />
          </View>
          <Pressable
            style={[styles.archiveButton, archiveView && styles.archiveButtonActive]}
            onPress={() => setArchiveView((v) => !v)}
          >
            <Ionicons
              name="archive-outline"
              size={16}
              color={archiveView ? colors.surface : colors.brandPrimary}
            />
            <Text style={[styles.archiveButtonText, archiveView && styles.archiveButtonTextActive]}>
              {archiveView ? 'Board' : 'Archive'}
            </Text>
          </Pressable>
        </View>

        {!archiveView && (
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            data={STATUS_FILTERS}
            keyExtractor={(item) => item.value}
            contentContainerStyle={styles.chipsRow}
            renderItem={({ item }) => (
              <Pressable
                style={[styles.filterChip, statusFilter === item.value && styles.filterChipActive]}
                onPress={() => setStatusFilter(item.value)}
              >
                <Text style={[styles.filterChipText, statusFilter === item.value && styles.filterChipTextActive]}>
                  {item.label}
                </Text>
              </Pressable>
            )}
          />
        )}

        {query.isLoading ? (
          <View style={styles.loadingWrap}>
            <Text style={styles.loadingText}>Loading production board...</Text>
          </View>
        ) : archiveView ? (
          <View style={styles.archiveList}>
            {visibleJobs.length === 0 ? (
              <EmptyState icon="archive-outline" title="Nothing here" description="No completed, cancelled, or invoiced jobs match these filters." />
            ) : (
              visibleJobs.map((job) => (
                <ProductionCard key={job.id} job={job} onPress={() => navigation.navigate('AdminJobDetail', { jobId: job.id })} />
              ))
            )}
          </View>
        ) : (
          <>
            {onHoldJobs.length > 0 && (
              <View style={styles.onHoldSection}>
                <View style={styles.onHoldHeader}>
                  <Ionicons name="warning-outline" size={16} color="#C2410C" />
                  <Text style={styles.onHoldTitle}>On Hold / Attention Needed</Text>
                  <View style={styles.onHoldCount}>
                    <Text style={styles.onHoldCountText}>{onHoldJobs.length}</Text>
                  </View>
                </View>
                <FlatList
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  data={onHoldJobs}
                  keyExtractor={(item) => item.id}
                  contentContainerStyle={styles.onHoldRow}
                  renderItem={({ item }) => (
                    <View style={{ width: COLUMN_WIDTH }}>
                      <ProductionCard job={item} onPress={() => navigation.navigate('AdminJobDetail', { jobId: item.id })} />
                    </View>
                  )}
                />
              </View>
            )}

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.boardRow}>
              {columns.map((col) => (
                <View key={col.id} style={[styles.column, { width: COLUMN_WIDTH }]}>
                  <View style={styles.columnHeader}>
                    <Text style={styles.columnTitle}>{col.label}</Text>
                    <View style={styles.columnCount}>
                      <Text style={styles.columnCountText}>{col.jobs.length}</Text>
                    </View>
                  </View>
                  <ScrollView style={{ maxHeight: COLUMN_MAX_HEIGHT }} nestedScrollEnabled>
                    {col.jobs.length === 0 ? (
                      <Text style={styles.noJobs}>No jobs</Text>
                    ) : (
                      col.jobs.map((job) => (
                        <ProductionCard
                          key={job.id}
                          job={job}
                          onPress={() => navigation.navigate('AdminJobDetail', { jobId: job.id })}
                        />
                      ))
                    )}
                  </ScrollView>
                </View>
              ))}
            </ScrollView>
          </>
        )}
      </ScrollView>
    </AppScreen>
  )
}

function ProductionCard({ job, onPress }: { job: ProductionJob; onPress: () => void }) {
  const address = job.addresses?.[0]
  const clientName = job.client?.companyName || job.client?.name
  const crewNames = job.assignments.map((a) => a.user.firstName).filter(Boolean)
  const dueLabel = formatDateShort(job.scheduledEnd)
  const isHighPriority = Number(job.priority) >= 4
  const amount = job.estimateAmount || job.actualAmount
  const info = getProductionInfo(job.status)

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.jobCard, pressed && styles.jobCardPressed]}>
      <View style={styles.jobCardTop}>
        <Text style={styles.jobNumber}>{job.jobNumber}</Text>
        {isHighPriority && (
          <View style={styles.priorityBadge}>
            <Text style={styles.priorityBadgeText}>P{job.priority}</Text>
          </View>
        )}
      </View>
      {job.title ? (
        <Text style={styles.jobTitle} numberOfLines={1}>
          {job.title}
        </Text>
      ) : null}
      {address?.street ? (
        <Text style={styles.jobMeta} numberOfLines={1}>
          {address.street}
          {address.city ? `, ${address.city}` : ''}
        </Text>
      ) : null}
      {clientName ? (
        <Text style={styles.jobClient} numberOfLines={1}>
          {clientName}
        </Text>
      ) : null}

      <View style={styles.jobDivider} />
      <Text style={styles.jobStage} numberOfLines={1}>
        Stage: {info.stage}
      </Text>
      <Text style={styles.jobNextAction} numberOfLines={2}>
        Next: {info.nextAction}
      </Text>

      <View style={styles.jobDivider} />
      <View style={styles.jobFooterRow}>
        <Text style={styles.jobFooterText} numberOfLines={1}>
          {crewNames.length ? crewNames.join(', ') : 'Unassigned'}
        </Text>
        {dueLabel ? <Text style={styles.jobFooterText}>{dueLabel}</Text> : null}
      </View>
      {amount ? <Text style={styles.jobAmount}>${Number(amount).toFixed(2)}</Text> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  scrollContent: { paddingBottom: spacing.xl },
  summaryRow: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.sm },
  summaryCard: { width: 108, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, alignItems: 'flex-start' },
  summaryValue: { ...typography.h2, color: colors.brandPrimary },
  summaryLabel: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },

  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    paddingHorizontal: spacing.md,
    height: 42,
  },
  searchInput: { flex: 1, ...typography.sub, color: colors.textPrimary, padding: 0 },
  archiveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.brandPrimary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 42,
  },
  archiveButtonActive: { backgroundColor: colors.brandPrimary },
  archiveButtonText: { ...typography.caption, color: colors.brandPrimary, fontWeight: '700' },
  archiveButtonTextActive: { color: colors.surface },

  chipsRow: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.xs },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
    marginRight: spacing.xs,
  },
  filterChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  filterChipText: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  filterChipTextActive: { color: '#E6C98B' },

  loadingWrap: { padding: spacing.xl, alignItems: 'center' },
  loadingText: { ...typography.sub, color: colors.textSecondary },

  archiveList: { paddingHorizontal: spacing.md, gap: spacing.sm },

  onHoldSection: {
    marginTop: spacing.sm,
    marginHorizontal: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(249,115,22,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(249,115,22,0.3)',
  },
  onHoldHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.xs },
  onHoldTitle: { ...typography.sub, color: '#C2410C', fontWeight: '700' },
  onHoldCount: {
    marginLeft: 'auto',
    backgroundColor: '#C2410C',
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  onHoldCountText: { ...typography.caption, color: '#fff', fontWeight: '700' },
  onHoldRow: { gap: spacing.sm },

  boardRow: { paddingHorizontal: spacing.md, paddingTop: spacing.md, gap: spacing.sm },
  column: {
    backgroundColor: '#EEF1F2',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.divider,
    overflow: 'hidden',
  },
  columnHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  columnTitle: { ...typography.sub, color: colors.textPrimary, fontWeight: '700' },
  columnCount: { backgroundColor: colors.divider, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 1 },
  columnCountText: { ...typography.caption, color: colors.textSecondary, fontWeight: '700' },
  noJobs: { ...typography.caption, color: colors.muted, textAlign: 'center', padding: spacing.md },

  jobCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.sm,
    margin: spacing.xs,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  jobCardPressed: { opacity: 0.9 },
  jobCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  jobNumber: { ...typography.sub, color: colors.brandPrimary, fontWeight: '700' },
  priorityBadge: { backgroundColor: 'rgba(220,38,38,0.12)', borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 1 },
  priorityBadgeText: { ...typography.caption, color: colors.danger, fontWeight: '700' },
  jobTitle: { ...typography.caption, color: colors.textPrimary, fontWeight: '600', marginTop: 2 },
  jobMeta: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  jobClient: { ...typography.caption, color: colors.muted, marginTop: 1 },
  jobDivider: { height: 1, backgroundColor: colors.divider, marginVertical: spacing.xs },
  jobStage: { ...typography.caption, color: colors.textSecondary },
  jobNextAction: { ...typography.caption, color: colors.textPrimary, fontWeight: '600', marginTop: 2 },
  jobFooterRow: { flexDirection: 'row', justifyContent: 'space-between' },
  jobFooterText: { ...typography.caption, color: colors.muted, fontSize: 11 },
  jobAmount: { ...typography.caption, color: colors.textSecondary, fontWeight: '600', marginTop: 4 },
})

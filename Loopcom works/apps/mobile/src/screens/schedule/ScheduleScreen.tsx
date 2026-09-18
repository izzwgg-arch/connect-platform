import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Ionicons } from '@expo/vector-icons'
import { Calendar, ICalendarEventBase } from 'react-native-big-calendar'
import {
  addDays,
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isWithinInterval,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { AppScreen } from '../../components/AppScreen'
import { apiRequest } from '../../api/client'
import { ScheduleItem } from '../../types/models'
import { useAuth } from '../../auth/AuthContext'
import { colors, typography } from '../../theme/tokens'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { useMobilePermissions } from '../../hooks/useMobilePermissions'
import { ScheduleStackParamList } from '../../types/navigation'
import { FilterEmployeeOption, FilterSheet } from '../../components/schedule/FilterSheet'

interface ScheduleResponse {
  schedules: ScheduleItem[]
  scope?: 'self' | 'all'
}

interface TeamMember {
  id: string
  firstName: string
  lastName: string
}

interface TeamMembersResponse {
  teamMembers: TeamMember[]
}

interface UnscheduledJobsResponse {
  jobs: Array<{
    id: string
    jobNumber: string
    title: string
    status: string
    client?: { name: string } | null
  }>
}

type Props = NativeStackScreenProps<ScheduleStackParamList, 'ScheduleHome'>
type CalendarViewMode = 'day' | 'week' | 'month'

interface CalendarScheduleEvent extends ICalendarEventBase {
  id: string
  scheduleId: string
  entityType: 'schedule' | 'task' | 'issue'
  entityId: string
  jobId?: string
  status?: string
  employeeLabel?: string
  accentColor: string
}

interface ScheduledTasksResponse {
  tasks: Array<{
    id: string
    title: string
    status: string
    dueDate?: string | null
  }>
}

interface ScheduledIssuesResponse {
  issues: Array<{
    id: string
    title: string
    status: string
    type?: string
    dueDate?: string | null
  }>
}

interface DayCellMeta {
  key: string
  date: Date
  inMonth: boolean
  selected: boolean
  isToday: boolean
  markers: string[]
  overflowCount: number
}

const KNOWN_JOB_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'PENDING', 'COMPLETED', 'CANCELLED']

function getDateRangeForView(anchor: Date, viewMode: CalendarViewMode): { start: Date; end: Date } {
  if (viewMode === 'day') {
    return { start: startOfDay(anchor), end: endOfDay(anchor) }
  }
  if (viewMode === 'month') {
    return { start: startOfMonth(anchor), end: endOfMonth(anchor) }
  }
  return { start: startOfWeek(anchor, { weekStartsOn: 1 }), end: endOfWeek(anchor, { weekStartsOn: 1 }) }
}

function getEventAccentColor(status?: string): string {
  switch ((status || '').toUpperCase()) {
    case 'COMPLETED':
      return '#16A34A'
    case 'IN_PROGRESS':
      return '#2563EB'
    case 'CANCELLED':
      return '#DC2626'
    case 'PENDING':
      return '#D97706'
    default:
      return '#2E4A59'
  }
}

function toValidDate(value: string): Date | null {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function formatEventTimeRange(start: Date, end: Date): string {
  return `${format(start, 'p')} - ${format(end, 'p')}`
}

function createMonthGridDays(anchorDate: Date, selectedDate: Date, events: CalendarScheduleEvent[]): DayCellMeta[] {
  const monthStart = startOfMonth(anchorDate)
  const monthEnd = endOfMonth(anchorDate)
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 })
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 })
  const days: DayCellMeta[] = []

  for (let cursor = gridStart; cursor <= gridEnd; cursor = addDays(cursor, 1)) {
    const dayEvents = events.filter((event) =>
      isWithinInterval(cursor, { start: startOfDay(event.start), end: endOfDay(event.end) })
    )
    const markers = dayEvents.slice(0, 3).map((event) => event.accentColor)
    days.push({
      key: cursor.toISOString(),
      date: cursor,
      inMonth: cursor.getMonth() === monthStart.getMonth(),
      selected: isSameDay(cursor, selectedDate),
      isToday: isSameDay(cursor, new Date()),
      markers,
      overflowCount: Math.max(0, dayEvents.length - 3),
    })
  }

  return days
}

const MonthGrid = memo(function MonthGrid({
  anchorDate,
  selectedDate,
  events,
  onSelectDate,
}: {
  anchorDate: Date
  selectedDate: Date
  events: CalendarScheduleEvent[]
  onSelectDate: (value: Date) => void
}) {
  const days = useMemo(() => createMonthGridDays(anchorDate, selectedDate, events), [anchorDate, selectedDate, events])
  const weekLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  return (
    <View style={styles.monthWrap}>
      <View style={styles.weekLabelRow}>
        {weekLabels.map((label) => (
          <Text key={label} style={styles.weekLabel}>
            {label}
          </Text>
        ))}
      </View>
      <View style={styles.monthGrid}>
        {days.map((cell) => (
          <Pressable
            key={cell.key}
            onPress={() => onSelectDate(cell.date)}
            style={[
              styles.monthCell,
              !cell.inMonth && styles.monthCellMuted,
              cell.selected && styles.monthCellSelected,
            ]}
          >
            <Text
              style={[
                styles.monthCellDay,
                !cell.inMonth && styles.monthCellDayMuted,
                cell.isToday && styles.monthCellToday,
                cell.selected && styles.monthCellDaySelected,
              ]}
            >
              {cell.date.getDate()}
            </Text>
            <View style={styles.monthMarkersRow}>
              {cell.markers.map((color, index) => (
                <View key={`${cell.key}-${index}`} style={[styles.monthMarker, { backgroundColor: color }]} />
              ))}
              {cell.overflowCount > 0 ? <Text style={styles.monthOverflow}>+{cell.overflowCount}</Text> : null}
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  )
})

export function ScheduleScreen({ navigation }: Props) {
  const { user } = useAuth()
  const { canViewEntireSchedule, canViewAllJobs } = useMobilePermissions()
  const queryClient = useQueryClient()

  const [viewMode, setViewMode] = useState<CalendarViewMode>('week')
  const [anchorDate, setAnchorDate] = useState(() => new Date())
  const [debouncedAnchorDate, setDebouncedAnchorDate] = useState(() => new Date())
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([])
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([])

  const canUseAllScope = canViewEntireSchedule()

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedAnchorDate(anchorDate), 160)
    return () => clearTimeout(timer)
  }, [anchorDate])

  const teamQuery = useQuery({
    queryKey: ['mobile-schedule-team'],
    queryFn: () => apiRequest<TeamMembersResponse>('/api/schedules/team'),
    enabled: Boolean(user?.id),
  })

  const employeeOptions = useMemo<FilterEmployeeOption[]>(() => {
    const me = user
      ? [{ id: user.id, label: `${user.firstName} ${user.lastName}`.trim() || user.email }]
      : []
    const rest = (teamQuery.data?.teamMembers || []).map((item) => ({
      id: item.id,
      label: `${item.firstName} ${item.lastName}`.trim(),
    }))

    const map = new Map<string, FilterEmployeeOption>()
    for (const option of [...me, ...rest]) {
      if (!map.has(option.id)) map.set(option.id, option)
    }
    return Array.from(map.values())
  }, [teamQuery.data?.teamMembers, user])

  useEffect(() => {
    if (!user?.id) return
    if (canUseAllScope) return
    setSelectedEmployeeIds([user.id])
  }, [canUseAllScope, user?.id])

  const visibleRange = useMemo(
    () => getDateRangeForView(debouncedAnchorDate, viewMode),
    [debouncedAnchorDate, viewMode]
  )

  const effectiveEmployeeIds = useMemo(() => {
    if (!user?.id) return []
    if (!canUseAllScope) return [user.id]
    return selectedEmployeeIds
  }, [canUseAllScope, selectedEmployeeIds, user?.id])

  const effectiveScope = useMemo(
    () => (canUseAllScope && effectiveEmployeeIds.length === 0 ? 'all' : 'self'),
    [canUseAllScope, effectiveEmployeeIds.length]
  )

  const userIdsParam = useMemo(
    () => (effectiveEmployeeIds.length > 0 ? effectiveEmployeeIds.join(',') : ''),
    [effectiveEmployeeIds]
  )
  const statusesParam = useMemo(
    () => (selectedStatuses.length > 0 ? selectedStatuses.join(',') : ''),
    [selectedStatuses]
  )

  const query = useQuery({
    queryKey: [
      'mobile-schedule',
      user?.id,
      viewMode,
      effectiveScope,
      userIdsParam,
      statusesParam,
      visibleRange.start.toISOString(),
      visibleRange.end.toISOString(),
    ],
    queryFn: () =>
      apiRequest<ScheduleResponse>(
        `/api/schedules?view=${viewMode}&scope=${effectiveScope}&startDate=${encodeURIComponent(
          visibleRange.start.toISOString()
        )}&endDate=${encodeURIComponent(visibleRange.end.toISOString())}${
          userIdsParam ? `&userIds=${encodeURIComponent(userIdsParam)}` : ''
        }${statusesParam ? `&status=${encodeURIComponent(statusesParam)}` : ''}`
      ),
    enabled: Boolean(user?.id),
    refetchInterval: 60_000,
    placeholderData: (previousData) => previousData,
  })

  const schedules = query.data?.schedules || []

  const unscheduledQuery = useQuery({
    queryKey: ['mobile-unscheduled-jobs', user?.id],
    queryFn: () => apiRequest<UnscheduledJobsResponse>('/api/jobs?status=PENDING&unscheduled=true&limit=20'),
    enabled: Boolean(user?.id),
    refetchInterval: 120_000,
    staleTime: 60_000,
  })

  const unscheduledJobs = unscheduledQuery.data?.jobs ?? []
  const scheduledTasksQuery = useQuery({
    queryKey: ['mobile-schedule-tasks', visibleRange.start.toISOString(), visibleRange.end.toISOString()],
    queryFn: () =>
      apiRequest<ScheduledTasksResponse>(
        `/api/tasks?filter=assigned&limit=100&scheduledFrom=${encodeURIComponent(
          visibleRange.start.toISOString()
        )}&scheduledTo=${encodeURIComponent(visibleRange.end.toISOString())}`
      ),
    enabled: Boolean(user?.id),
    refetchInterval: 60_000,
    placeholderData: (previousData) => previousData,
  })
  const scheduledIssuesQuery = useQuery({
    queryKey: ['mobile-schedule-issues', visibleRange.start.toISOString(), visibleRange.end.toISOString()],
    queryFn: () =>
      apiRequest<ScheduledIssuesResponse>(
        `/api/issues?filter=assigned_or_created&limit=100&scheduledFrom=${encodeURIComponent(
          visibleRange.start.toISOString()
        )}&scheduledTo=${encodeURIComponent(visibleRange.end.toISOString())}`
      ),
    enabled: Boolean(user?.id),
    refetchInterval: 60_000,
    placeholderData: (previousData) => previousData,
  })

  const scheduledTaskEvents = useMemo<CalendarScheduleEvent[]>(
    () =>
      (scheduledTasksQuery.data?.tasks || []).flatMap((task) => {
        const start = toValidDate(task.dueDate || '')
        if (!start) return []
        const end = new Date(start.getTime() + 45 * 60 * 1000)
        return [
          {
            id: `task-${task.id}`,
            scheduleId: `task-${task.id}`,
            entityType: 'task',
            entityId: task.id,
            start,
            end,
            title: task.title,
            status: task.status,
            accentColor: '#C17F00',
          },
        ]
      }),
    [scheduledTasksQuery.data?.tasks]
  )

  const scheduledIssueEvents = useMemo<CalendarScheduleEvent[]>(
    () =>
      (scheduledIssuesQuery.data?.issues || []).flatMap((issue) => {
        const start = toValidDate(issue.dueDate || '')
        if (!start) return []
        const end = new Date(start.getTime() + 45 * 60 * 1000)
        return [
          {
            id: `issue-${issue.id}`,
            scheduleId: `issue-${issue.id}`,
            entityType: 'issue',
            entityId: issue.id,
            start,
            end,
            title: issue.type ? `${issue.type} - ${issue.title}` : issue.title,
            status: issue.status,
            accentColor: '#8B5CF6',
          },
        ]
      }),
    [scheduledIssuesQuery.data?.issues]
  )

  const events = useMemo<CalendarScheduleEvent[]>(
    () => [
      ...schedules.flatMap((item) => {
        const start = toValidDate(item.startTime)
        const end = toValidDate(item.endTime)
        if (!start || !end) return []
        const accentColor = getEventAccentColor(item.job?.status)
        return [
          {
            id: item.id,
            scheduleId: item.id,
            entityType: 'schedule' as const,
            entityId: item.id,
            start,
            end,
            title: item.title || item.job?.title || 'Schedule',
            jobId: item.job?.id,
            status: item.job?.status || undefined,
            employeeLabel: item.user ? `${item.user.firstName} ${item.user.lastName}`.trim() : undefined,
            accentColor,
          },
        ]
      }),
      ...scheduledTaskEvents,
      ...scheduledIssueEvents,
    ],
    [schedules, scheduledIssueEvents, scheduledTaskEvents]
  )

  const statusOptions = useMemo(() => {
    const set = new Set<string>(KNOWN_JOB_STATUSES)
    for (const item of schedules) {
      if (item.job?.status) set.add(item.job.status)
    }
    return Array.from(set.values())
  }, [schedules])

  const selectedDayEvents = useMemo(
    () => events.filter((event) => isSameDay(event.start, anchorDate)),
    [events, anchorDate]
  )

  const dateRangeLabel = useMemo(() => {
    if (viewMode === 'day') return format(anchorDate, 'EEE, MMM d')
    if (viewMode === 'month') return format(anchorDate, 'MMMM yyyy')
    const start = startOfWeek(anchorDate, { weekStartsOn: 1 })
    const end = endOfWeek(anchorDate, { weekStartsOn: 1 })
    const sameMonth = start.getMonth() === end.getMonth()
    if (sameMonth) {
      return `${format(start, 'MMM d')}-${format(end, 'd')}`
    }
    return `${format(start, 'MMM d')}-${format(end, 'MMM d')}`
  }, [anchorDate, viewMode])

  const employeePillLabel = useMemo(() => {
    if (!canUseAllScope) return 'Employee: Me'
    if (selectedEmployeeIds.length === 0) return 'Employee: All'
    if (selectedEmployeeIds.length === 1) {
      const one = employeeOptions.find((item) => item.id === selectedEmployeeIds[0])
      return `Employee: ${one?.label || '1 selected'}`
    }
    return `Employee: ${selectedEmployeeIds.length} selected`
  }, [canUseAllScope, employeeOptions, selectedEmployeeIds])

  const statusPillLabel = selectedStatuses.length === 0 ? 'Status: All' : `Status: ${selectedStatuses.length} selected`

  const openDatePicker = useCallback(() => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        mode: 'date',
        value: anchorDate,
        onChange: (_event, selectedDate) => {
          if (selectedDate) setAnchorDate(selectedDate)
        },
      })
      return
    }
    setShowDatePicker(true)
  }, [anchorDate])

  const openDrawer = () => {
    const tabsParent = navigation.getParent()
    const drawerParent = tabsParent?.getParent?.()
    if (drawerParent && 'toggleDrawer' in drawerParent) {
      ;(drawerParent as any).toggleDrawer()
      return
    }
    if (tabsParent && 'toggleDrawer' in tabsParent) {
      ;(tabsParent as any).toggleDrawer()
    }
  }

  const onPressCalendarEvent = useCallback(
    (event: CalendarScheduleEvent) => {
      if (event.entityType === 'task') {
        const tabsNav = navigation.getParent() as any
        tabsNav?.navigate('TasksTab', {
          screen: 'TaskDetail',
          params: { taskId: event.entityId },
        })
        return
      }
      if (event.entityType === 'issue') {
        const tabsNav = navigation.getParent() as any
        tabsNav?.navigate('IssuesTab', {
          screen: 'IssueDetail',
          params: { issueId: event.entityId },
        })
        return
      }
      if (event.jobId) {
        const jobsScreen = canViewAllJobs() ? 'AdminJobDetail' : 'JobDetail'
        const tabsNav = navigation.getParent() as any
        tabsNav?.navigate('JobsTab', {
          screen: jobsScreen,
          params: { jobId: event.jobId },
        })
        return
      }
      navigation.navigate('ScheduleDetail', { scheduleId: event.scheduleId })
    },
    [canViewAllJobs, navigation]
  )

  const renderCalendarEvent = useCallback(
    (event: CalendarScheduleEvent) => (
      <View style={styles.eventCell}>
        <View style={[styles.eventAccent, { backgroundColor: event.accentColor }]} />
        <View style={styles.eventContent}>
          <Text style={styles.eventTitle} numberOfLines={1}>
            {event.title}
          </Text>
          <Text style={styles.eventTime} numberOfLines={1}>
            {formatEventTimeRange(event.start, event.end)}
          </Text>
        </View>
      </View>
    ),
    []
  )

  const renderJobCard = useCallback(
    ({ item }: { item: CalendarScheduleEvent }) => (
      <View style={styles.jobRowWrap}>
        <Pressable onPress={() => onPressCalendarEvent(item)}>
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>{item.title}</Text>
            <Text style={styles.meta}>
              {formatEventTimeRange(item.start, item.end)}
            </Text>
            {item.employeeLabel ? <Text style={styles.forUser}>For {item.employeeLabel}</Text> : null}
          </Card>
        </Pressable>
      </View>
    ),
    [onPressCalendarEvent]
  )

  const listHeader = useMemo(
    () => (
      <View style={styles.content}>
        <View style={styles.topBar}>
          <Pressable style={styles.menuButton} onPress={openDrawer}>
            <Ionicons name="menu" size={20} color={colors.textPrimary} />
          </Pressable>
          <Text style={styles.topBarTitle}>Schedule</Text>
          <Pressable style={styles.newButton} onPress={() => navigation.navigate('ScheduleCreate')}>
            <Ionicons name="add" size={14} color={colors.textPrimary} />
            <Text style={styles.newButtonText}>New</Text>
          </Pressable>
        </View>

        <View style={styles.viewTabs}>
          {(['day', 'week', 'month'] as CalendarViewMode[]).map((mode) => {
            const active = viewMode === mode
            return (
              <Pressable key={mode} onPress={() => setViewMode(mode)} style={[styles.viewTab, active && styles.viewTabActive]}>
                <Text style={[styles.viewTabText, active && styles.viewTabTextActive]}>{mode.toUpperCase()}</Text>
              </Pressable>
            )
          })}
        </View>

        <View style={styles.dateNavRow}>
          <Pressable
            style={styles.arrowButton}
            onPress={() =>
              setAnchorDate((prev) =>
                viewMode === 'month' ? addDays(prev, -30) : viewMode === 'week' ? addDays(prev, -7) : addDays(prev, -1)
              )
            }
          >
            <Ionicons name="chevron-back" size={16} color={colors.textPrimary} />
          </Pressable>
          <Pressable style={styles.rangePill} onPress={openDatePicker}>
            <Text style={styles.rangeLabel}>{dateRangeLabel}</Text>
          </Pressable>
          <Pressable style={styles.todayButton} onPress={() => setAnchorDate(new Date())}>
            <Text style={styles.todayButtonText}>Today</Text>
          </Pressable>
          <Pressable
            style={styles.arrowButton}
            onPress={() =>
              setAnchorDate((prev) =>
                viewMode === 'month' ? addDays(prev, 30) : viewMode === 'week' ? addDays(prev, 7) : addDays(prev, 1)
              )
            }
          >
            <Ionicons name="chevron-forward" size={16} color={colors.textPrimary} />
          </Pressable>
        </View>

        <View style={styles.filterRow}>
          <View style={styles.infoPill}>
            <Text style={styles.infoPillText}>{employeePillLabel}</Text>
          </View>
          <View style={styles.infoPill}>
            <Text style={styles.infoPillText}>{statusPillLabel}</Text>
          </View>
          <Pressable style={styles.filtersButton} onPress={() => setShowFilters(true)}>
            <Ionicons name="options-outline" size={14} color={colors.textPrimary} />
            <Text style={styles.filtersButtonText}>Filters</Text>
          </Pressable>
        </View>

        <View style={styles.calendarSurface}>
          {viewMode === 'month' ? (
            <MonthGrid
              anchorDate={anchorDate}
              selectedDate={anchorDate}
              events={events}
              onSelectDate={setAnchorDate}
            />
          ) : (
            // Single-scroll architecture: parent FlatList owns vertical scroll to avoid nested-scroll clipping/overlay.
            <Calendar<CalendarScheduleEvent>
              events={events}
              mode={viewMode}
              date={anchorDate}
              weekStartsOn={1}
              height={viewMode === 'week' ? 430 : 500}
              swipeEnabled
              onPressEvent={onPressCalendarEvent}
              onPressCell={(value) => setAnchorDate(value)}
              onChangeDate={([start]) => {
                if (start) setDebouncedAnchorDate(start)
              }}
              renderEvent={renderCalendarEvent}
              eventCellStyle={styles.calendarEventWrapper}
              calendarCellStyle={styles.calendarCell}
              hourStyle={styles.hourLabel}
            />
          )}
        </View>
        <Text style={styles.agendaTitle}>Agenda for {format(anchorDate, 'EEE, MMM d')}</Text>
      </View>
    ),
    [
      anchorDate,
      dateRangeLabel,
      employeePillLabel,
      events,
      navigation,
      onPressCalendarEvent,
      openDatePicker,
      renderCalendarEvent,
      statusPillLabel,
      viewMode,
    ]
  )

  if (query.isLoading && !query.data) {
    return (
      <AppScreen padded={false}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.brandPrimary} />
          <Text style={styles.loadingText}>Loading schedule...</Text>
        </View>
      </AppScreen>
    )
  }

  if (query.isError && !query.data) {
    return (
      <AppScreen padded={false}>
        <View style={styles.content}>
          <EmptyState
            icon="alert-circle-outline"
            title="Schedule failed to load"
            description="Pull to refresh and try again."
          />
        </View>
      </AppScreen>
    )
  }

  return (
    <AppScreen padded={false}>
      <FlatList
        data={selectedDayEvents}
        keyExtractor={(item) => item.id}
        nestedScrollEnabled={false}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={listHeader}
        refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} />}
        ListEmptyComponent={
          <EmptyState
            icon="calendar-outline"
            title="No events for this day"
            description="Pick another day or create a new schedule event."
          />
        }
        renderItem={renderJobCard}
        ListFooterComponent={
          unscheduledJobs.length > 0 ? (
            <View style={styles.unscheduledSection}>
              <Text style={styles.unscheduledTitle}>Unscheduled Jobs</Text>
              {unscheduledJobs.map((job: UnscheduledJobsResponse['jobs'][number]) => (
                <Pressable
                  key={job.id}
                  style={styles.unscheduledCard}
                  onPress={() => (navigation as any).navigate('JobDetail', { jobId: job.id })}
                >
                  <View style={styles.unscheduledAccent} />
                  <View style={styles.unscheduledBody}>
                    <Text style={styles.unscheduledJobNum}>{job.jobNumber}</Text>
                    <Text style={styles.unscheduledJobTitle} numberOfLines={1}>{job.title}</Text>
                    {job.client ? (
                      <Text style={styles.unscheduledMeta} numberOfLines={1}>{job.client.name}</Text>
                    ) : null}
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
                </Pressable>
              ))}
            </View>
          ) : null
        }
      />

      <FilterSheet
        visible={showFilters}
        employees={employeeOptions}
        statuses={statusOptions}
        selectedEmployeeIds={selectedEmployeeIds}
        selectedStatuses={selectedStatuses}
        onClose={() => setShowFilters(false)}
        onApply={({ employeeIds, statuses }) => {
          if (!canUseAllScope && user?.id) {
            setSelectedEmployeeIds([user.id])
          } else {
            setSelectedEmployeeIds(employeeIds)
          }
          setSelectedStatuses(statuses)
          void queryClient.invalidateQueries({ queryKey: ['mobile-schedule'] })
        }}
        onClear={() => {
          if (!canUseAllScope && user?.id) {
            setSelectedEmployeeIds([user.id])
          } else {
            setSelectedEmployeeIds([])
          }
          setSelectedStatuses([])
          void queryClient.invalidateQueries({ queryKey: ['mobile-schedule'] })
        }}
      />

      {Platform.OS === 'ios' && showDatePicker && (
        <DateTimePicker
          value={anchorDate}
          mode="date"
          display="spinner"
          onChange={(_event, selectedDate) => {
            if (selectedDate) setAnchorDate(selectedDate)
            setShowDatePicker(false)
          }}
        />
      )}
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  listContent: {
    paddingBottom: 16,
  },
  jobRowWrap: {
    paddingHorizontal: 16,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  topBar: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  menuButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EEF2F7',
  },
  topBarTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  newButton: {
    minHeight: 32,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.divider,
    paddingHorizontal: 10,
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  newButtonText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  viewTabs: {
    flexDirection: 'row',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.divider,
    overflow: 'hidden',
    marginBottom: 12,
    minHeight: 38,
  },
  viewTab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  viewTabActive: {
    backgroundColor: '#E9F0F4',
  },
  viewTabText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  viewTabTextActive: {
    color: colors.brandPrimary,
    fontWeight: '700',
  },
  dateNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  arrowButton: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.divider,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  rangePill: {
    flex: 1,
    minHeight: 30,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.divider,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  rangeLabel: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  todayButton: {
    minHeight: 30,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#BDD0DB',
    backgroundColor: '#F2F8FB',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  todayButtonText: {
    ...typography.caption,
    color: colors.brandPrimary,
    fontWeight: '700',
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  infoPill: {
    flex: 1,
    minHeight: 30,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.divider,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  infoPillText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  filtersButton: {
    minHeight: 30,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.divider,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  filtersButtonText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  calendarSurface: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
    marginBottom: 12,
  },
  calendarCell: {
    borderColor: '#EDF2F7',
  },
  hourLabel: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  calendarEventWrapper: {
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  eventCell: {
    flex: 1,
    flexDirection: 'row',
    borderRadius: 10,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E4ECF2',
    overflow: 'hidden',
  },
  eventAccent: {
    width: 4,
  },
  eventContent: {
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  eventTitle: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  eventTime: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 11,
  },
  monthWrap: {
    paddingVertical: 10,
    paddingHorizontal: 10,
  },
  weekLabelRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  weekLabel: {
    flex: 1,
    textAlign: 'center',
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  monthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: 1,
    borderTopColor: '#EDF2F7',
    borderLeftWidth: 1,
    borderLeftColor: '#EDF2F7',
  },
  monthCell: {
    width: '14.2857%',
    minHeight: 56,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderRightColor: '#EDF2F7',
    borderBottomColor: '#EDF2F7',
    paddingHorizontal: 4,
    paddingTop: 4,
    paddingBottom: 2,
    backgroundColor: '#FFFFFF',
  },
  monthCellMuted: {
    backgroundColor: '#FAFCFE',
  },
  monthCellSelected: {
    backgroundColor: '#EFF6FA',
  },
  monthCellDay: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  monthCellDayMuted: {
    color: '#A4B2C3',
  },
  monthCellToday: {
    color: colors.brandPrimary,
  },
  monthCellDaySelected: {
    fontWeight: '700',
  },
  monthMarkersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 2,
    marginTop: 4,
  },
  monthMarker: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  monthOverflow: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 10,
    marginLeft: 2,
  },
  unscheduledSection: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  unscheduledTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: 10,
  },
  unscheduledCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.divider,
    marginBottom: 8,
    padding: 12,
    gap: 10,
  },
  unscheduledAccent: {
    width: 4,
    minHeight: 36,
    borderRadius: 2,
    backgroundColor: '#D97706',
    alignSelf: 'stretch',
  },
  unscheduledBody: {
    flex: 1,
    gap: 2,
  },
  unscheduledJobNum: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
    fontSize: 11,
  },
  unscheduledJobTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  unscheduledMeta: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 12,
  },
  agendaTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: 8,
  },
  card: {
    marginBottom: 8,
  },
  cardTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: 4,
  },
  meta: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  forUser: {
    ...typography.caption,
    color: colors.brandPrimary,
    marginTop: 6,
    fontWeight: '600',
  },
})

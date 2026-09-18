import React, { useMemo } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useQuery } from '@tanstack/react-query'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { AppScreen } from '../../components/AppScreen'
import { EmptyState } from '../../components/EmptyState'
import { apiRequest } from '../../api/client'
import { JobsStackParamList } from '../../types/navigation'
import { colors, spacing, typography } from '../../theme/tokens'
import { StatusBadge } from '../../components/StatusBadge'

type Props = NativeStackScreenProps<JobsStackParamList, 'MeasuringRequestsHome'>

type MeasuringRequestListItem = {
  id: string
  status: 'pending' | 'opened' | 'completed'
  notes?: string | null
  createdAt: string
  createdByUser: {
    firstName: string
    lastName: string
  } | null
  request: {
    id: string
    customerName: string
    address?: string | null
  }
}

type MeasuringRequestsResponse = {
  measuringRequests: MeasuringRequestListItem[]
  counts: {
    pending: number
    opened: number
    completed: number
  }
}

export function MeasuringRequestsScreen({ navigation }: Props) {
  const query = useQuery({
    queryKey: ['mobile-measuring-requests'],
    queryFn: () => apiRequest<MeasuringRequestsResponse>('/api/measuring-requests/my?status=ALL'),
    refetchInterval: 30_000,
  })

  const rows = useMemo(() => query.data?.measuringRequests || [], [query.data?.measuringRequests])
  const counts = query.data?.counts || { pending: 0, opened: 0, completed: 0 }

  return (
    <AppScreen>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>Measuring Requests</Text>
            <Text style={styles.subtitle}>Assigned requests that need field measurement updates.</Text>
            <View style={styles.countRow}>
              <View style={styles.countPill}>
                <Text style={styles.countLabel}>Pending</Text>
                <Text style={styles.countValue}>{counts.pending}</Text>
              </View>
              <View style={styles.countPill}>
                <Text style={styles.countLabel}>Opened</Text>
                <Text style={styles.countValue}>{counts.opened}</Text>
              </View>
              <View style={styles.countPill}>
                <Text style={styles.countLabel}>Completed</Text>
                <Text style={styles.countValue}>{counts.completed}</Text>
              </View>
            </View>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon="resize-outline"
            title="No measuring requests"
            description="New measuring assignments will appear here."
          />
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            onPress={() => navigation.navigate('MeasuringRequestDetail', { measuringRequestId: item.id })}
          >
            <View style={styles.cardTop}>
              <Text style={styles.cardTitle}>Request #{item.request.id}</Text>
              <StatusBadge status={item.status.toUpperCase()} />
            </View>
            <Text style={styles.cardMeta}>{item.request.customerName}</Text>
            {item.request.address ? (
              <Text style={styles.cardMeta} numberOfLines={1}>
                {item.request.address}
              </Text>
            ) : null}
            <Text style={styles.cardMeta}>
              {new Date(item.createdAt).toLocaleDateString()}
              {item.createdByUser ? ` · Created by ${item.createdByUser.firstName} ${item.createdByUser.lastName}` : ''}
            </Text>
            {item.notes ? (
              <Text style={styles.notes} numberOfLines={2}>
                {item.notes}
              </Text>
            ) : null}
          </Pressable>
        )}
      />
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  header: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: 4,
  },
  title: {
    ...typography.h2,
    color: colors.textPrimary,
  },
  subtitle: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  countRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  countPill: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 10,
    paddingVertical: spacing.xs,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  countLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  countValue: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 12,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  cardTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  cardMeta: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  notes: {
    ...typography.caption,
    color: colors.textPrimary,
    marginTop: 6,
  },
})

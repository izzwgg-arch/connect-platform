import React, { useMemo, useState } from 'react'
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { DetailRow, DetailSection } from '../../components/DetailSection'
import { Job, TimeEntry } from '../../types/models'
import { colors, spacing, typography } from '../../theme/tokens'
import { API_BASE_URL } from '../../config/env'
import {
  JobDocumentPdfModal,
  type JobDocumentPreview,
} from '../../components/attachments/JobDocumentPdfModal'
import {
  formatCents,
  formatDate,
  formatDateTime,
  formatBillingStatus,
  formatJobType,
  formatMinutes,
  formatMoney,
} from '../../utils/format'

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

type DocKind = 'estimate' | 'invoice' | 'purchase_order' | 'payment'
type SortOption = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc'

type JobDocRow = {
  key: string
  kind: DocKind
  number: string
  title: string
  status: string
  amount: number
  date: string
  subtitle?: string
  preview: JobDocumentPreview
}

const KIND_LABEL: Record<DocKind, string> = {
  estimate: 'Estimate',
  invoice: 'Invoice',
  purchase_order: 'PO',
  payment: 'Payment',
}

const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: 'date-desc', label: 'Newest' },
  { value: 'date-asc', label: 'Oldest' },
  { value: 'amount-desc', label: 'Amount ↓' },
  { value: 'amount-asc', label: 'Amount ↑' },
]

const TYPE_OPTIONS: Array<{ value: 'all' | DocKind; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'estimate', label: 'Estimates' },
  { value: 'invoice', label: 'Invoices' },
  { value: 'purchase_order', label: 'POs' },
  { value: 'payment', label: 'Payments' },
]

function parseAmount(value?: string | number | null): number {
  if (value == null || value === '') return 0
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function buildJobDocumentRows(job: Job): JobDocRow[] {
  const rows: JobDocRow[] = []

  for (const row of asArray<NonNullable<Job['estimates']>[number]>(job.estimates)) {
    const number = row.estimateNumber || 'Estimate'
    const fileName = `Estimate-${number}.pdf`
    rows.push({
      key: `estimate-${row.id}`,
      kind: 'estimate',
      number,
      title: row.title || number,
      status: row.status,
      amount: parseAmount(row.total),
      date: row.createdAt,
      subtitle: row.title || undefined,
      preview: {
        id: row.id,
        title: `Estimate ${number}`,
        fileName,
        url: `${API_BASE_URL}/api/estimates/${row.id}/pdf`,
      },
    })
  }

  for (const row of asArray<NonNullable<Job['invoices']>[number]>(job.invoices)) {
    const number = row.invoiceNumber || 'Invoice'
    const fileName = `Invoice-${number}.pdf`
    rows.push({
      key: `invoice-${row.id}`,
      kind: 'invoice',
      number,
      title: number,
      status: row.status,
      amount: parseAmount(row.total),
      date: row.createdAt || '',
      subtitle: row.balance != null ? `Balance ${formatMoney(row.balance)}` : undefined,
      preview: {
        id: row.id,
        title: `Invoice ${number}`,
        fileName,
        url: `${API_BASE_URL}/api/invoices/${row.id}/pdf`,
      },
    })
  }

  for (const row of asArray<NonNullable<Job['purchaseOrders']>[number]>(job.purchaseOrders)) {
    const number = row.poNumber || 'PO'
    const fileName = `PO-${number}.pdf`
    rows.push({
      key: `po-${row.id}`,
      kind: 'purchase_order',
      number,
      title: number,
      status: row.status,
      amount: parseAmount(row.total),
      date: row.createdAt,
      preview: {
        id: row.id,
        title: `PO ${number}`,
        fileName,
        url: `${API_BASE_URL}/api/purchase-orders/${row.id}/pdf`,
      },
    })
  }

  for (const row of asArray<NonNullable<Job['payments']>[number]>(job.payments)) {
    const number = row.invoiceNumber || row.reference || 'Payment'
    const fileName = `Receipt-${number}.pdf`
    rows.push({
      key: `payment-${row.id}`,
      kind: 'payment',
      number,
      title: number,
      status: row.status,
      amount: parseAmount(row.amount),
      date: row.paymentDate || '',
      subtitle: [row.method, formatDate(row.paymentDate)].filter(Boolean).join(' · ') || undefined,
      preview: {
        id: row.id,
        title: `Payment ${number}`,
        fileName,
        url: `${API_BASE_URL}/api/payments/${row.id}/receipt`,
      },
    })
  }

  return rows
}

function compareDocs(a: JobDocRow, b: JobDocRow, sort: SortOption) {
  switch (sort) {
    case 'date-asc':
      return new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
    case 'amount-desc':
      return b.amount - a.amount
    case 'amount-asc':
      return a.amount - b.amount
    case 'date-desc':
    default:
      return new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
  }
}

export function JobDocumentsSection({ job }: { job: Job }) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortOption>('date-desc')
  const [typeFilter, setTypeFilter] = useState<'all' | DocKind>('all')
  const [preview, setPreview] = useState<JobDocumentPreview | null>(null)
  const [expanded, setExpanded] = useState(true)

  const allRows = useMemo(() => buildJobDocumentRows(job), [job])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allRows
      .filter((row) => (typeFilter === 'all' ? true : row.kind === typeFilter))
      .filter((row) => {
        if (!q) return true
        const haystack = [
          row.number,
          row.title,
          row.status,
          row.subtitle,
          KIND_LABEL[row.kind],
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return haystack.includes(q)
      })
      .sort((a, b) => compareDocs(a, b, sort))
  }, [allRows, search, sort, typeFilter])

  return (
    <>
      <DetailSection
        title="Documents"
        right={
          <View style={styles.docHeaderRight}>
            <Text style={styles.countBadge}>{allRows.length}</Text>
            <TouchableOpacity
              onPress={() => setExpanded((v) => !v)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={expanded ? 'Collapse documents' : 'Expand documents'}
            >
              <Ionicons
                name={expanded ? 'chevron-up' : 'chevron-down'}
                size={20}
                color={colors.textPrimary}
              />
            </TouchableOpacity>
          </View>
        }
      >
        {!expanded ? (
          <Text style={styles.empty}>Tap the arrow to show estimates, invoices, POs, and payments.</Text>
        ) : allRows.length === 0 ? (
          <Text style={styles.empty}>No estimates, invoices, POs, or payments.</Text>
        ) : (
          <>
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search documents…"
              placeholderTextColor={colors.muted}
              style={styles.searchInput}
              autoCorrect={false}
              autoCapitalize="none"
              clearButtonMode="while-editing"
            />

            <View style={styles.filterRow}>
              {TYPE_OPTIONS.map((opt) => {
                const active = typeFilter === opt.value
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.chip, active && styles.chipActive]}
                    activeOpacity={0.7}
                    onPress={() => setTypeFilter(opt.value)}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>

            <View style={styles.filterRow}>
              {SORT_OPTIONS.map((opt) => {
                const active = sort === opt.value
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.chip, active && styles.chipActive]}
                    activeOpacity={0.7}
                    onPress={() => setSort(opt.value)}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>

            {filtered.length === 0 ? (
              <Text style={styles.empty}>No documents match your search.</Text>
            ) : (
              filtered.map((row) => (
                <TouchableOpacity
                  key={row.key}
                  style={styles.docRow}
                  activeOpacity={0.55}
                  onPress={() => setPreview(row.preview)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${KIND_LABEL[row.kind]} ${row.number}`}
                >
                  <View style={styles.docMain}>
                    <Text style={styles.docKind}>{KIND_LABEL[row.kind]}</Text>
                    <Text style={styles.docTitle} numberOfLines={1}>
                      {row.number}
                    </Text>
                    {row.subtitle ? (
                      <Text style={styles.docMeta} numberOfLines={1}>
                        {row.subtitle}
                      </Text>
                    ) : null}
                    <Text style={styles.docMeta} numberOfLines={1}>
                      {formatDate(row.date)} · Tap to open
                    </Text>
                  </View>
                  <View style={styles.docRight}>
                    <Text style={styles.docAmount}>{formatMoney(row.amount)}</Text>
                    <Text style={styles.docStatus}>{String(row.status).replace(/_/g, ' ')}</Text>
                  </View>
                </TouchableOpacity>
              ))
            )}
          </>
        )}
      </DetailSection>

      <JobDocumentPdfModal document={preview} onClose={() => setPreview(null)} />
    </>
  )
}


export function JobInformationSection({
  job,
  showFinancials,
}: {
  job: Job
  showFinancials: boolean
}) {
  const profit =
    job.actualAmount && job.laborCost && job.materialCost
      ? Number.parseFloat(String(job.actualAmount)) -
        Number.parseFloat(String(job.laborCost)) -
        Number.parseFloat(String(job.materialCost))
      : null

  return (
    <DetailSection title="Job Information">
      <DetailRow label="Description" value={job.description} multiline />
      <DetailRow label="Job Type" value={formatJobType(job.jobType) || null} />
      <DetailRow label="Scheduled Start" value={job.scheduledStart ? formatDateTime(job.scheduledStart) : null} />
      <DetailRow label="Scheduled End" value={job.scheduledEnd ? formatDateTime(job.scheduledEnd) : null} />
      <DetailRow label="Actual Start" value={job.actualStart ? formatDateTime(job.actualStart) : null} />
      <DetailRow label="Actual End" value={job.actualEnd ? formatDateTime(job.actualEnd) : null} />

      {showFinancials && (job.estimateAmount || job.actualAmount || job.totalCost || job.totalInvoicedAmount) ? (
        <View style={styles.subBlock}>
          <Text style={styles.subTitle}>Financials</Text>
          <DetailRow label="Total Cost" value={job.totalCost ? formatMoney(job.totalCost) : null} />
          <DetailRow label="Estimate" value={job.estimateAmount ? formatMoney(job.estimateAmount) : null} />
          <DetailRow label="Actual" value={job.actualAmount ? formatMoney(job.actualAmount) : null} />
          <DetailRow label="Labor Cost" value={job.laborCost ? formatMoney(job.laborCost) : null} />
          <DetailRow label="Material Cost" value={job.materialCost ? formatMoney(job.materialCost) : null} />
          {profit !== null && Number.isFinite(profit) ? (
            <DetailRow label="Profit" value={formatMoney(profit)} />
          ) : null}
          <DetailRow label="Total Invoiced" value={formatMoney(job.totalInvoicedAmount || '0')} />
          <DetailRow label="Open Invoices" value={formatMoney(job.openInvoiceBalance || '0')} />
        </View>
      ) : null}
    </DetailSection>
  )
}

export function JobBillingSummarySection({
  job,
  children,
}: {
  job: Job
  children?: React.ReactNode
}) {
  return (
    <DetailSection title="Billing">
      <DetailRow label="Charge by hour" value={job.chargeByHour ? 'Yes' : 'No'} />
      {job.chargeByHour ? (
        <>
          <DetailRow
            label="Hourly rate"
            value={job.hourlyRateCents != null ? `${formatCents(job.hourlyRateCents)}/hr` : 'Not set'}
          />
          <DetailRow
            label="Billable time"
            value={
              job.billableHours != null
                ? `${Number(job.billableHours).toFixed(2)}h`
                : formatMinutes(job.billableMinutesTotal)
            }
          />
          <DetailRow
            label="Billable amount"
            value={
              job.billableAmountCents != null
                ? formatCents(job.billableAmountCents)
                : null
            }
          />
        </>
      ) : null}
      {children}
    </DetailSection>
  )
}

export function JobTimeEntriesSection({
  entries,
  activeTimers,
  loading,
  children,
}: {
  entries: TimeEntry[]
  activeTimers?: Job['activeTimers']
  loading?: boolean
  children?: React.ReactNode
}) {
  const timers = asArray<NonNullable<Job['activeTimers']>[number]>(activeTimers)

  return (
    <DetailSection
      title="Time Entries"
      right={<Text style={styles.countBadge}>{entries.length}</Text>}
    >
      {children}
      {loading ? <Text style={styles.empty}>Loading time entries...</Text> : null}
      {!loading && entries.length === 0 ? <Text style={styles.empty}>No time entries yet.</Text> : null}
      {entries.map((entry) => {
        const workerName = entry.worker
          ? `${entry.worker.firstName} ${entry.worker.lastName}`.trim()
          : 'Worker'
        return (
          <View key={entry.id} style={styles.listRow}>
            <Text style={styles.listTitle} numberOfLines={1}>
              {workerName} · {formatMinutes(entry.durationMinutes)}
            </Text>
            <Text style={styles.docMeta} numberOfLines={2}>
              {formatDate(entry.createdAt)} · {entry.source}
              {entry.status === 'ACTIVE' ? ' · Active' : ''}
              {entry.note ? ` · ${entry.note}` : ''}
            </Text>
            <Text style={styles.docMeta}>
              {entry.startedAt ? formatDateTime(entry.startedAt) : '—'}
              {' → '}
              {entry.endedAt ? formatDateTime(entry.endedAt) : entry.status === 'ACTIVE' ? 'Active' : '—'}
            </Text>
          </View>
        )
      })}
      {timers.length > 0 ? (
        <Text style={styles.activeTimerNote}>
          Active timer:{' '}
          {timers
            .map((t) =>
              t.worker ? `${t.worker.firstName} ${t.worker.lastName}`.trim() : 'Worker'
            )
            .join(', ')}
        </Text>
      ) : null}
    </DetailSection>
  )
}

export function JobSiteSection({
  job,
  onOpenMaps,
}: {
  job: Job
  onOpenMaps?: () => void
}) {
  const site = job.jobSite || job.address
  if (!site?.street) {
    return (
      <DetailSection title="Job Site">
        <Text style={styles.empty}>No job site address</Text>
      </DetailSection>
    )
  }
  const line2 = [site.city, site.state, site.zipCode].filter(Boolean).join(', ')
  return (
    <DetailSection title="Job Site">
      <Pressable onPress={onOpenMaps} disabled={!onOpenMaps}>
        <Text style={[styles.addressText, onOpenMaps ? styles.link : null]}>
          {site.street}
          {line2 ? `\n${line2}` : ''}
        </Text>
      </Pressable>
    </DetailSection>
  )
}

export function JobCrewSection({
  job,
  right,
}: {
  job: Job
  right?: React.ReactNode
}) {
  const assignments = asArray<NonNullable<Job['assignments']>[number]>(job.assignments)
  return (
    <DetailSection title="Crew Assignments" right={right}>
      {assignments.length === 0 ? <Text style={styles.empty}>No crew assigned</Text> : null}
      {assignments.map((a) => (
        <View key={a.id} style={styles.listRow}>
          <Text style={styles.listTitle}>
            {a.user.firstName} {a.user.lastName}
          </Text>
          {a.role ? <Text style={styles.docMeta}>{a.role}</Text> : null}
          {a.notes ? <Text style={styles.docMeta}>{a.notes}</Text> : null}
          {a.user.phone ? (
            <Pressable onPress={() => Linking.openURL(`tel:${a.user.phone}`)}>
              <Text style={styles.link}>{a.user.phone}</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </DetailSection>
  )
}

export function JobNotesHistorySection({
  job,
  children,
}: {
  job: Job
  children?: React.ReactNode
}) {
  const notes = asArray<NonNullable<Job['notes']>[number]>(job.notes)
  return (
    <DetailSection title="Notes" right={<Text style={styles.countBadge}>{notes.length}</Text>}>
      {children}
      {notes.length === 0 ? <Text style={styles.empty}>No notes yet.</Text> : null}
      {notes.map((note) => (
        <View key={note.id} style={styles.noteRow}>
          <Text style={styles.noteContent}>{note.content}</Text>
          <Text style={styles.docMeta}>
            {note.createdBy?.name ? `${note.createdBy.name} · ` : ''}
            {formatDateTime(note.createdAt)}
          </Text>
        </View>
      ))}
    </DetailSection>
  )
}

export function JobClientSection({ job }: { job: Job }) {
  const client = job.client
  if (!client) {
    return (
      <DetailSection title="Client">
        <Text style={styles.empty}>No client on file</Text>
      </DetailSection>
    )
  }
  const contacts = asArray<NonNullable<NonNullable<Job['client']>['contacts']>[number]>(client.contacts)

  return (
    <DetailSection title="Client">
      <DetailRow label="Name" value={client.name} />
      <DetailRow label="Company" value={client.companyName} />
      <DetailRow label="Phone" value={client.phone} />
      <DetailRow label="Email" value={client.email} />
      {contacts.length > 0 ? (
        <View style={styles.subBlock}>
          <Text style={styles.subTitle}>Contacts</Text>
          {contacts.map((c) => (
            <View key={c.id} style={styles.listRow}>
              <Text style={styles.listTitle}>
                {c.firstName} {c.lastName}
                {c.title ? ` · ${c.title}` : ''}
              </Text>
              {c.phone ? (
                <Pressable onPress={() => Linking.openURL(`tel:${c.phone}`)}>
                  <Text style={styles.link}>{c.phone}</Text>
                </Pressable>
              ) : null}
              {c.email ? (
                <Pressable onPress={() => Linking.openURL(`mailto:${c.email}`)}>
                  <Text style={styles.link}>{c.email}</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </DetailSection>
  )
}

export function JobTasksIssuesSection({
  job,
  showLists,
  createActions,
}: {
  job: Job
  showLists: boolean
  createActions?: React.ReactNode
}) {
  const tasks = asArray<NonNullable<Job['tasks']>[number]>(job.tasks)
  const issues = asArray<NonNullable<Job['issues']>[number]>(job.issues)

  return (
    <DetailSection title="Tasks & Issues">
      {createActions}
      {showLists ? (
        <>
          <View style={styles.subBlock}>
            <Text style={styles.subTitle}>Tasks ({job._count?.tasks ?? tasks.length})</Text>
            {tasks.length === 0 ? <Text style={styles.empty}>No tasks</Text> : null}
            {tasks.map((task) => (
              <Pressable
                key={task.id}
                style={styles.listRow}
                onPress={() => {
                  void Linking.openURL(`trimpro://tasks/${task.id}`)
                }}
              >
                <Text style={styles.listTitle} numberOfLines={1}>
                  {task.title}
                </Text>
                <Text style={styles.docMeta} numberOfLines={1}>
                  {String(task.status || '').replaceAll('_', ' ')} · {task.priority}
                  {' · '}
                  {task.assignedTo?.name || 'Unassigned'}
                  {' · Due '}
                  {formatDate(task.dueDate)}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.subBlock}>
            <Text style={styles.subTitle}>Issues ({job._count?.issues ?? issues.length})</Text>
            {issues.length === 0 ? <Text style={styles.empty}>No issues</Text> : null}
            {issues.map((issue) => (
              <Pressable
                key={issue.id}
                style={styles.listRow}
                onPress={() => {
                  void Linking.openURL(`trimpro://issues/${issue.id}`)
                }}
              >
                <Text style={styles.listTitle} numberOfLines={1}>
                  {issue.title}
                </Text>
                <Text style={styles.docMeta} numberOfLines={1}>
                  {String(issue.status || '').replaceAll('_', ' ')} · {issue.priority}
                  {' · '}
                  {issue.assignedTo?.name || 'Unassigned'}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </DetailSection>
  )
}

export function JobSchedulesSection({ job }: { job: Job }) {
  const schedules = asArray<NonNullable<Job['schedules']>[number]>(job.schedules)
  return (
    <DetailSection
      title="Schedules"
      right={<Text style={styles.countBadge}>{schedules.length}</Text>}
    >
      {schedules.length === 0 ? <Text style={styles.empty}>No schedules</Text> : null}
      {schedules.map((s) => (
        <View key={s.id} style={styles.listRow}>
          <Text style={styles.listTitle}>{formatDateTime(s.startTime)}</Text>
          <Text style={styles.docMeta}>
            Until {formatDateTime(s.endTime)}
            {s.user ? ` · ${s.user.firstName} ${s.user.lastName}` : ''}
          </Text>
        </View>
      ))}
    </DetailSection>
  )
}

export function JobOpenBalancesBanner({ job }: { job: Job }) {
  return (
    <View style={styles.balanceBannerWrap}>
      <Text style={styles.balanceBannerLabel}>Billing: {formatBillingStatus(job.billingStatus)}</Text>
      <Text style={styles.balanceBanner}>
        Job Open Invoices: {formatMoney(job.openInvoiceBalance || '0')} ({job.openInvoiceCount || 0})
        {' | '}
        Client Open Balance: {formatMoney(job.clientOpenInvoiceBalance || '0')}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  empty: {
    ...typography.caption,
    color: colors.textSecondary,
    fontStyle: 'italic',
  },
  countBadge: {
    minWidth: 22,
    textAlign: 'center',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.divider,
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 12,
    overflow: 'hidden',
  },
  docHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  subBlock: {
    gap: spacing.xs,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
    marginTop: spacing.xs,
  },
  subTitle: {
    ...typography.caption,
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontWeight: '700',
    marginBottom: 2,
  },
  docRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
    backgroundColor: colors.surface,
  },
  docMain: { flex: 1, gap: 2 },
  docRight: { alignItems: 'flex-end', gap: 2 },
  docKind: {
    ...typography.caption,
    color: colors.brandPrimary,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  docTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  docMeta: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  docAmount: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  docStatus: {
    ...typography.caption,
    color: colors.muted,
    textTransform: 'uppercase',
  },
  searchInput: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.background,
    marginBottom: 8,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.divider,
    backgroundColor: colors.background,
  },
  chipActive: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  chipTextActive: {
    color: '#fff',
  },
  listRow: {
    gap: 2,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
  },
  listTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  noteRow: {
    gap: 4,
    paddingVertical: 8,
    paddingLeft: 10,
    borderLeftWidth: 3,
    borderLeftColor: colors.brandPrimary,
    backgroundColor: colors.background,
    borderRadius: 6,
    paddingRight: 8,
  },
  noteContent: {
    ...typography.body,
    color: colors.textPrimary,
    fontSize: 14,
  },
  addressText: {
    ...typography.sub,
    color: colors.textPrimary,
    lineHeight: 20,
  },
  link: {
    color: colors.brandPrimary,
    textDecorationLine: 'underline',
  },
  activeTimerNote: {
    ...typography.caption,
    color: '#92400E',
    backgroundColor: '#FEF3C7',
    padding: spacing.sm,
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: spacing.xs,
  },
  balanceBannerWrap: {
    marginTop: 4,
    gap: 2,
  },
  balanceBannerLabel: {
    ...typography.caption,
    color: '#92400E',
    fontWeight: '700',
  },
  balanceBanner: {
    ...typography.caption,
    color: '#92400E',
    fontWeight: '700',
  },
})

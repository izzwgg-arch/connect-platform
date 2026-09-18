import React, { useEffect, useMemo, useState } from 'react'
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../../theme/tokens'

export interface FilterEmployeeOption {
  id: string
  label: string
}

interface FilterSheetProps {
  visible: boolean
  employees: FilterEmployeeOption[]
  statuses: string[]
  selectedEmployeeIds: string[]
  selectedStatuses: string[]
  onApply: (payload: { employeeIds: string[]; statuses: string[] }) => void
  onClear: () => void
  onClose: () => void
}

function toggleInList(list: string[], value: string): string[] {
  if (list.includes(value)) return list.filter((item) => item !== value)
  return [...list, value]
}

export function FilterSheet({
  visible,
  employees,
  statuses,
  selectedEmployeeIds,
  selectedStatuses,
  onApply,
  onClear,
  onClose,
}: FilterSheetProps) {
  const [employeeSearch, setEmployeeSearch] = useState('')
  const [draftEmployeeIds, setDraftEmployeeIds] = useState<string[]>(selectedEmployeeIds)
  const [draftStatuses, setDraftStatuses] = useState<string[]>(selectedStatuses)

  useEffect(() => {
    if (!visible) return
    setDraftEmployeeIds(selectedEmployeeIds)
    setDraftStatuses(selectedStatuses)
    setEmployeeSearch('')
  }, [selectedEmployeeIds, selectedStatuses, visible])

  const filteredEmployees = useMemo(() => {
    const query = employeeSearch.trim().toLowerCase()
    if (!query) return employees
    return employees.filter((employee) => employee.label.toLowerCase().includes(query))
  }, [employeeSearch, employees])

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Filters</Text>
            <Pressable onPress={onClose} style={styles.iconButton}>
              <Ionicons name="close" size={20} color={colors.textPrimary} />
            </Pressable>
          </View>

          <Text style={styles.sectionTitle}>Employee</Text>
          <View style={styles.searchRow}>
            <Ionicons name="search" size={16} color={colors.muted} />
            <TextInput
              value={employeeSearch}
              onChangeText={setEmployeeSearch}
              style={styles.searchInput}
              placeholder="Search employee"
              placeholderTextColor={colors.muted}
            />
          </View>
          <FlatList
            data={filteredEmployees}
            keyExtractor={(item) => item.id}
            style={styles.optionList}
            contentContainerStyle={styles.optionListContent}
            renderItem={({ item }) => {
              const selected = draftEmployeeIds.includes(item.id)
              return (
                <Pressable
                  style={[styles.optionRow, selected && styles.optionRowActive]}
                  onPress={() => setDraftEmployeeIds((prev) => toggleInList(prev, item.id))}
                >
                  <Text style={[styles.optionLabel, selected && styles.optionLabelActive]}>{item.label}</Text>
                  {selected ? <Ionicons name="checkmark" size={16} color={colors.brandPrimary} /> : null}
                </Pressable>
              )
            }}
          />

          <Text style={styles.sectionTitle}>Status</Text>
          <View style={styles.statusWrap}>
            {statuses.map((status) => {
              const selected = draftStatuses.includes(status)
              return (
                <Pressable
                  key={status}
                  style={[styles.statusChip, selected && styles.statusChipActive]}
                  onPress={() => setDraftStatuses((prev) => toggleInList(prev, status))}
                >
                  <Text style={[styles.statusChipText, selected && styles.statusChipTextActive]}>
                    {status}
                  </Text>
                </Pressable>
              )
            })}
          </View>

          <View style={styles.footer}>
            <Pressable
              style={[styles.actionButton, styles.clearButton]}
              onPress={() => {
                setDraftEmployeeIds([])
                setDraftStatuses([])
                onClear()
              }}
            >
              <Text style={[styles.actionButtonText, styles.clearButtonText]}>Clear</Text>
            </Pressable>
            <Pressable
              style={[styles.actionButton, styles.applyButton]}
              onPress={() => {
                onApply({ employeeIds: draftEmployeeIds, statuses: draftStatuses })
                onClose()
              }}
            >
              <Text style={[styles.actionButtonText, styles.applyButtonText]}>Apply</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(2, 6, 23, 0.38)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 20,
    maxHeight: '82%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    ...typography.h3,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F1F5F9',
  },
  sectionTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
    marginBottom: 8,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 10,
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  searchInput: {
    flex: 1,
    minHeight: 36,
    ...typography.sub,
    color: colors.textPrimary,
    marginLeft: 8,
  },
  optionList: {
    maxHeight: 190,
    marginBottom: 12,
  },
  optionListContent: {
    gap: 4,
  },
  optionRow: {
    minHeight: 36,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  optionRowActive: {
    borderColor: '#BFD2DD',
    backgroundColor: '#F2F8FB',
  },
  optionLabel: {
    ...typography.caption,
    color: colors.textPrimary,
  },
  optionLabelActive: {
    fontWeight: '600',
  },
  statusWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  statusChip: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#FFFFFF',
  },
  statusChipActive: {
    borderColor: '#BFD2DD',
    backgroundColor: '#F2F8FB',
  },
  statusChipText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  statusChipTextActive: {
    color: colors.brandPrimary,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    gap: 8,
  },
  actionButton: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearButton: {
    backgroundColor: '#EEF2F7',
  },
  applyButton: {
    backgroundColor: colors.brandPrimary,
  },
  actionButtonText: {
    ...typography.sub,
    fontWeight: '700',
  },
  clearButtonText: {
    color: colors.textPrimary,
  },
  applyButtonText: {
    color: '#FFFFFF',
  },
})

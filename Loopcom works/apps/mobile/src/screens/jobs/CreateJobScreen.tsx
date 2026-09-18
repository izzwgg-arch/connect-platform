import React, { useEffect, useRef, useState } from 'react'
import { Alert, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Platform } from 'react-native'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Ionicons } from '@expo/vector-icons'
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker'
import { AppScreen } from '../../components/AppScreen'
import { apiRequest } from '../../api/client'
import { colors, radius, spacing, typography } from '../../theme/tokens'
import { Card } from '../../components/Card'
import { JobsStackParamList } from '../../types/navigation'
import { useMobilePermissions } from '../../hooks/useMobilePermissions'

type Props = NativeStackScreenProps<JobsStackParamList, 'CreateJob'>

interface Client {
  id: string
  name: string
  companyName: string | null
}

interface ClientsResponse {
  clients: Client[]
  pagination?: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

interface ResolvedAddress {
  street: string
  city: string
  state: string
  zipCode: string
  country?: string
}

export function CreateJobScreen({ navigation }: Props) {
  const scrollRef = useRef<ScrollView | null>(null)
  const scrollYRef = useRef(0)
  const [addressCardY, setAddressCardY] = useState<number | null>(null)
  const [addressFocused, setAddressFocused] = useState(false)
  const { canScheduleJobs, canAssignJobs } = useMobilePermissions()
  const [showClientDropdown, setShowClientDropdown] = useState(false)
  const [clientSearch, setClientSearch] = useState('')
  const [addressSearch, setAddressSearch] = useState('')
  const [addressPredictions, setAddressPredictions] = useState<string[]>([])
  const [addressSelectedFromSuggestions, setAddressSelectedFromSuggestions] = useState(false)
  const [isLoadingAddressPredictions, setIsLoadingAddressPredictions] = useState(false)
  const [addressSuggestionsWarning, setAddressSuggestionsWarning] = useState('')
  const [formData, setFormData] = useState({
    clientId: '',
    title: '',
    description: '',
    status: 'QUOTE',
    priority: '3',
    scheduledStart: null as Date | null,
    scheduledEnd: null as Date | null,
    jobSite: {
      street: '',
      city: '',
      state: '',
      zipCode: '',
      country: 'US',
    },
  })
  const [showStartPicker, setShowStartPicker] = useState(false)
  const [showEndPicker, setShowEndPicker] = useState(false)

  const openStartPicker = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: formData.scheduledStart || new Date(),
        mode: 'date',
        onChange: (event, date) => {
          if (event.type === 'set' && date) {
            setFormData((prev) => ({ ...prev, scheduledStart: date }))
          }
        },
      })
      return
    }
    setShowStartPicker(true)
  }

  const openEndPicker = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: formData.scheduledEnd || new Date(),
        mode: 'date',
        onChange: (event, date) => {
          if (event.type === 'set' && date) {
            setFormData((prev) => ({ ...prev, scheduledEnd: date }))
          }
        },
      })
      return
    }
    setShowEndPicker(true)
  }

  const clientsQuery = useQuery({
    queryKey: ['clients-all'],
    queryFn: async () => {
      const allClients: Client[] = []
      const seenIds = new Set<string>()
      const pageSize = 200
      let page = 1
      let totalPages = 1

      while (page <= totalPages) {
        const response = await apiRequest<ClientsResponse>(`/api/clients?limit=${pageSize}&page=${page}`)
        totalPages = response.pagination?.totalPages || 1
        for (const client of response.clients || []) {
          if (!seenIds.has(client.id)) {
            seenIds.add(client.id)
            allClients.push(client)
          }
        }
        page += 1
      }

      return { clients: allClients } as ClientsResponse
    },
  })

  useEffect(() => {
    const value = addressSearch.trim()
    if (value.length < 3 || addressSelectedFromSuggestions) {
      setAddressPredictions([])
      return
    }

    const timer = setTimeout(async () => {
      try {
        setIsLoadingAddressPredictions(true)
        const response = await apiRequest<{ predictions: string[]; warning?: string }>(
          `/api/mobile/places?q=${encodeURIComponent(value)}&limit=8`
        )
        setAddressPredictions(response.predictions || [])
        setAddressSuggestionsWarning(response.warning || '')
      } catch {
        setAddressPredictions([])
        setAddressSuggestionsWarning('Google suggestions are unavailable right now. Please try again shortly.')
      } finally {
        setIsLoadingAddressPredictions(false)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [addressSearch, addressSelectedFromSuggestions])

  useEffect(() => {
    const scrollAddressIntoView = () => {
      if (!addressFocused || !scrollRef.current || addressCardY == null) return
      // Keep extra headroom so the address input + suggestions stay above keyboard.
      const targetY = Math.max(0, addressCardY - spacing.lg)
      // Never auto-scroll up on focus; only scroll down when input is near/under keyboard.
      if (targetY <= scrollYRef.current + 8) return
      scrollRef.current.scrollTo({ y: targetY, animated: true })
    }

    const showSub = Keyboard.addListener('keyboardDidShow', () => {
      // Android keyboard animation can race with focus; retry a few times.
      setTimeout(scrollAddressIntoView, 40)
      setTimeout(scrollAddressIntoView, 140)
      setTimeout(scrollAddressIntoView, 280)
    })
    return () => {
      showSub.remove()
    }
  }, [addressCardY, addressFocused])

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload: any = {
        clientId: formData.clientId,
        title: formData.title,
        description: formData.description || null,
        status: formData.status,
        priority: parseInt(formData.priority),
      }

      if (canScheduleJobs() && formData.scheduledStart) {
        payload.scheduledStart = formData.scheduledStart.toISOString()
      }
      if (canScheduleJobs() && formData.scheduledEnd) {
        payload.scheduledEnd = formData.scheduledEnd.toISOString()
      }

      if (addressSelectedFromSuggestions && addressSearch.trim()) {
        payload.jobSite = formData.jobSite
      }

      return apiRequest('/api/jobs', 'POST', payload)
    },
    onSuccess: (data: any) => {
      Alert.alert('Success', 'Job created successfully', [
        {
          text: 'OK',
          onPress: () => navigation.navigate('AdminJobDetail', { jobId: data.job.id }),
        },
      ])
    },
    onError: (error: any) => {
      Alert.alert('Error', error?.message || 'Failed to create job')
    },
  })

  const clients = clientsQuery.data?.clients ?? []
  const normalizedSearch = clientSearch.trim().toLowerCase()
  const filteredClients = normalizedSearch
    ? clients.filter((client) => {
        const primary = client.name.toLowerCase()
        const company = (client.companyName || '').toLowerCase()
        return primary.includes(normalizedSearch) || company.includes(normalizedSearch)
      })
    : clients

  const formatResolvedAddress = (address: ResolvedAddress): string => {
    const locality = [address.city, address.state, address.zipCode].filter(Boolean).join(' ')
    return [address.street, locality].filter(Boolean).join(', ')
  }

  const resolveAndSelectAddress = async (rawAddress: string): Promise<boolean> => {
    try {
      const resolved = await apiRequest<{ address: ResolvedAddress }>(
        `/api/mobile/places?mode=resolve&address=${encodeURIComponent(rawAddress)}`
      )
      const normalized = resolved.address
      setFormData((prev) => ({
        ...prev,
        jobSite: {
          street: normalized.street || '',
          city: normalized.city || '',
          state: normalized.state || '',
          zipCode: normalized.zipCode || '',
          country: normalized.country || 'US',
        },
      }))
      setAddressSearch(formatResolvedAddress(normalized) || rawAddress.trim())
      setAddressPredictions([])
      setAddressSelectedFromSuggestions(true)
      return true
    } catch {
      Alert.alert('Address Error', 'Could not verify this address. Please include city/state or choose a suggestion.')
      return false
    }
  }

  const handleSave = async () => {
    if (!formData.clientId) {
      Alert.alert('Validation Error', 'Please select a client')
      return
    }
    if (!formData.title.trim()) {
      Alert.alert('Validation Error', 'Please enter a job title')
      return
    }
    const hasAddressInput = !!addressSearch.trim()
    if (hasAddressInput && !addressSelectedFromSuggestions) {
      const resolved = await resolveAndSelectAddress(addressSearch.trim())
      if (!resolved) return
    }
    createMutation.mutate()
  }

  return (
    <AppScreen>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>Create Job</Text>
        <Pressable onPress={handleSave} style={styles.saveButton} disabled={createMutation.isPending}>
          <Text style={styles.saveButtonText}>{createMutation.isPending ? 'Saving...' : 'Save'}</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: spacing.xxl + spacing.lg }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScroll={(event) => {
          scrollYRef.current = event.nativeEvent.contentOffset.y
        }}
        scrollEventThrottle={16}
      >
        <Card style={styles.card}>
          <Text style={styles.label}>Client *</Text>
          <View style={styles.selectContainer}>
            <Text style={styles.selectText}>
              {formData.clientId ? clients.find((c) => c.id === formData.clientId)?.name || 'Select client' : 'Select client'}
            </Text>
            <Pressable
              style={styles.selectButton}
              onPress={() => setShowClientDropdown((prev) => !prev)}
            >
              <Ionicons name={showClientDropdown ? 'chevron-up' : 'chevron-down'} size={20} color={colors.textSecondary} />
            </Pressable>
          </View>
          {showClientDropdown && (
            <View style={styles.dropdownPanel}>
              <TextInput
                style={styles.searchInput}
                value={clientSearch}
                onChangeText={setClientSearch}
                placeholder="Search clients..."
                placeholderTextColor={colors.textPrimary}
                selectionColor={colors.textPrimary}
                cursorColor={colors.textPrimary}
              />
              <ScrollView style={styles.clientList} nestedScrollEnabled>
                {clientsQuery.isLoading ? (
                  <Text style={styles.dropdownMeta}>Loading clients...</Text>
                ) : filteredClients.length === 0 ? (
                  <Text style={styles.dropdownMeta}>No clients found</Text>
                ) : (
                  filteredClients.map((client) => (
                    <Pressable
                      key={client.id}
                      style={styles.clientOption}
                      onPress={() => {
                        setFormData((prev) => ({ ...prev, clientId: client.id }))
                        setShowClientDropdown(false)
                      }}
                    >
                      <Text style={styles.clientOptionText}>{client.name}</Text>
                      {!!client.companyName && <Text style={styles.clientOptionSubText}>{client.companyName}</Text>}
                    </Pressable>
                  ))
                )}
              </ScrollView>
            </View>
          )}
        </Card>

        <Card style={styles.card}>
          <Text style={styles.label}>Job Title *</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter job title"
            placeholderTextColor={colors.textPrimary}
            selectionColor={colors.textPrimary}
            cursorColor={colors.textPrimary}
            value={formData.title}
            onChangeText={(text) => setFormData((prev) => ({ ...prev, title: text }))}
          />
        </Card>

        <Card style={styles.card}>
          <Text style={styles.label}>Description</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            placeholder="Enter job description"
            placeholderTextColor={colors.textPrimary}
            selectionColor={colors.textPrimary}
            cursorColor={colors.textPrimary}
            multiline
            numberOfLines={4}
            value={formData.description}
            onChangeText={(text) => setFormData((prev) => ({ ...prev, description: text }))}
          />
        </Card>

        <Card style={styles.card}>
          <Text style={styles.label}>Status</Text>
          <View style={styles.statusRow}>
            {['QUOTE', 'SCHEDULED', 'IN_PROGRESS'].map((status) => (
              <Pressable
                key={status}
                style={[styles.statusChip, formData.status === status && styles.statusChipActive]}
                onPress={() => setFormData((prev) => ({ ...prev, status }))}
              >
                <Text style={[styles.statusChipText, formData.status === status && styles.statusChipTextActive]}>
                  {status.replace('_', ' ')}
                </Text>
              </Pressable>
            ))}
          </View>
        </Card>

        {canScheduleJobs() && (
          <>
            <Card style={styles.card}>
              <Text style={styles.label}>Scheduled Start</Text>
              <Pressable style={styles.dateButton} onPress={openStartPicker}>
                <Text style={styles.dateText}>
                  {formData.scheduledStart ? formData.scheduledStart.toLocaleString() : 'Select date/time'}
                </Text>
                <Ionicons name="calendar-outline" size={20} color={colors.textSecondary} />
              </Pressable>
              {Platform.OS === 'ios' && showStartPicker && (
                <DateTimePicker
                  value={formData.scheduledStart || new Date()}
                  mode="datetime"
                  onChange={(event, date) => {
                    setShowStartPicker(false)
                    if (date) setFormData((prev) => ({ ...prev, scheduledStart: date }))
                  }}
                />
              )}
            </Card>

            <Card style={styles.card}>
              <Text style={styles.label}>Scheduled End</Text>
              <Pressable style={styles.dateButton} onPress={openEndPicker}>
                <Text style={styles.dateText}>
                  {formData.scheduledEnd ? formData.scheduledEnd.toLocaleString() : 'Select date/time'}
                </Text>
                <Ionicons name="calendar-outline" size={20} color={colors.textSecondary} />
              </Pressable>
              {Platform.OS === 'ios' && showEndPicker && (
                <DateTimePicker
                  value={formData.scheduledEnd || new Date()}
                  mode="datetime"
                  onChange={(event, date) => {
                    setShowEndPicker(false)
                    if (date) setFormData((prev) => ({ ...prev, scheduledEnd: date }))
                  }}
                />
              )}
            </Card>
          </>
        )}

        <View
          onLayout={(event) => {
            setAddressCardY(event.nativeEvent.layout.y)
          }}
        >
          <Card style={styles.card}>
            <Text style={styles.label}>Job Address</Text>
            <TextInput
              style={styles.input}
              placeholder="Search address"
              placeholderTextColor={colors.textPrimary}
              selectionColor={colors.textPrimary}
              cursorColor={colors.textPrimary}
              value={addressSearch}
              onFocus={() => {
                setAddressFocused(true)
                const scrollNow = () => {
                  if (addressCardY == null) return
                  const targetY = Math.max(0, addressCardY - spacing.lg)
                  if (targetY <= scrollYRef.current + 8) return
                  scrollRef.current?.scrollTo({ y: targetY, animated: true })
                }
                // Initial + delayed retries cover flaky focus/keyboard timing.
                setTimeout(scrollNow, 0)
                setTimeout(scrollNow, 100)
                setTimeout(scrollNow, 220)
              }}
              onBlur={() => setAddressFocused(false)}
              onChangeText={(text) => {
                setAddressSearch(text)
                setAddressSelectedFromSuggestions(false)
                setAddressSuggestionsWarning('')
                setFormData((prev) => ({
                  ...prev,
                  jobSite: {
                    ...prev.jobSite,
                    street: '',
                    city: '',
                    state: '',
                    zipCode: '',
                  },
                }))
              }}
            />
            {isLoadingAddressPredictions && <Text style={styles.dropdownMeta}>Loading address suggestions...</Text>}
            {addressPredictions.length > 0 && (
              <View style={styles.dropdownPanel}>
                <ScrollView style={styles.clientList} nestedScrollEnabled>
                  {addressPredictions.map((prediction) => (
                    <Pressable
                      key={prediction}
                      style={styles.clientOption}
                      onPress={async () => {
                      await resolveAndSelectAddress(prediction)
                      }}
                    >
                      <Text style={styles.clientOptionText}>{prediction}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            )}
          {!isLoadingAddressPredictions && addressSearch.trim().length >= 3 && addressPredictions.length === 0 && (
            <Text style={styles.dropdownMeta}>
              {addressSuggestionsWarning || 'No Google suggestions yet. Try adding city/state.'}
            </Text>
          )}
          </Card>
        </View>
      </ScrollView>
    </AppScreen>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  backButton: {
    padding: spacing.xs,
  },
  headerTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  saveButton: {
    padding: spacing.xs,
  },
  saveButtonText: {
    ...typography.sub,
    color: colors.brandPrimary,
    fontWeight: '600',
  },
  scrollView: { flex: 1 },
  scrollContent: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl },
  card: {
    marginBottom: spacing.sm,
  },
  label: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  input: {
    ...typography.sub,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    padding: spacing.sm,
    backgroundColor: colors.surface,
  },
  textArea: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  selectContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    padding: spacing.sm,
    backgroundColor: colors.surface,
  },
  selectText: {
    ...typography.sub,
    color: colors.textPrimary,
    flex: 1,
  },
  selectButton: {
    padding: spacing.xs,
  },
  dropdownPanel: {
    marginTop: spacing.xs,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.xs,
    gap: spacing.xs,
  },
  searchInput: {
    ...typography.sub,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
  },
  clientList: {
    maxHeight: 220,
  },
  dropdownMeta: {
    ...typography.caption,
    color: colors.textSecondary,
    padding: spacing.sm,
  },
  clientOption: {
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  clientOptionText: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  clientOptionSubText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  statusChip: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    backgroundColor: colors.surface,
  },
  statusChipActive: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  statusChipText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  statusChipTextActive: {
    color: '#E6C98B',
  },
  dateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    padding: spacing.sm,
    backgroundColor: colors.surface,
  },
  dateText: {
    ...typography.sub,
    color: colors.textPrimary,
  },
  addressRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  addressInput: {
    flex: 1,
  },
})

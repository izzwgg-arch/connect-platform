import React, { useEffect, useMemo, useState } from 'react'
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useQuery } from '@tanstack/react-query'
import { Screen } from '../../components/Screen'
import { apiRequest } from '../../api/client'
import { BRAND } from '../../config/env'
import { JobsStackParamList } from '../../types/navigation'
import { AttachmentPickerSheet } from '../../components/attachments/AttachmentPickerSheet'
import { pickAttachmentsByAction } from '../../services/attachment-upload'
import {
  createEmptyRequestDraft,
  getRequestDraft,
  LocalRequestDraftAttachment,
  upsertRequestDraft,
} from '../../drafts/storage'
import { formatScheduledAt } from '../../utils/schedule'
import { publishRequestDraft } from '../../services/publish-request-draft'

interface ResolvedAddress {
  street: string
  city: string
  state: string
  zipCode: string
  country?: string
}

type Props = NativeStackScreenProps<JobsStackParamList, 'RequestCreate'>

interface ClientListResponse {
  clients: Array<{
    id: string
    name: string
    companyName?: string | null
    email?: string | null
    phone?: string | null
  }>
}

type ClientMode = 'existing' | 'new'

export function CreateRequestScreen({ navigation, route }: Props) {
  const draftId = route.params?.draftId
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [jobSiteAddress, setJobSiteAddress] = useState('')
  const [addressPredictions, setAddressPredictions] = useState<string[]>([])
  const [addressSelectedFromSuggestions, setAddressSelectedFromSuggestions] = useState(false)
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [isLoadingPredictions, setIsLoadingPredictions] = useState(false)
  const [showAttachmentPicker, setShowAttachmentPicker] = useState(false)
  const [clientMode, setClientMode] = useState<ClientMode>('existing')
  const [showClientPicker, setShowClientPicker] = useState(false)
  const [clientSearch, setClientSearch] = useState('')
  const [selectedClient, setSelectedClient] = useState<ClientListResponse['clients'][number] | null>(null)
  const [draftAttachments, setDraftAttachments] = useState<LocalRequestDraftAttachment[]>([])
  const [scheduledAt, setScheduledAt] = useState<string | null>(null)

  useEffect(() => {
    const value = jobSiteAddress.trim()
    if (value.length < 3 || addressSelectedFromSuggestions) {
      setAddressPredictions([])
      return
    }

    const timer = setTimeout(async () => {
      try {
        setIsLoadingPredictions(true)
        const response = await apiRequest<{ predictions: string[] }>(
          `/api/mobile/places?q=${encodeURIComponent(value)}&limit=8`
        )
        setAddressPredictions(response.predictions || [])
      } catch {
        setAddressPredictions([])
      } finally {
        setIsLoadingPredictions(false)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [jobSiteAddress, addressSelectedFromSuggestions])

  const formatResolvedAddress = (address: ResolvedAddress): string => {
    const locality = [address.city, address.state, address.zipCode].filter(Boolean).join(' ')
    return [address.street, locality].filter(Boolean).join(', ')
  }

  const resolveAndSelectAddress = async (rawAddress: string): Promise<boolean> => {
    try {
      const resolved = await apiRequest<{ address: ResolvedAddress }>(
        `/api/mobile/places?mode=resolve&address=${encodeURIComponent(rawAddress)}`
      )
      setJobSiteAddress(formatResolvedAddress(resolved.address) || rawAddress.trim())
      setAddressPredictions([])
      setAddressSelectedFromSuggestions(true)
      return true
    } catch {
      Alert.alert('Address Error', 'Could not verify this address. Please include city/state or choose a suggestion.')
      return false
    }
  }

  useEffect(() => {
    let cancelled = false
    const loadDraft = async () => {
      if (!draftId) return
      const draft = await getRequestDraft(draftId)
      if (!draft || cancelled) return
      setFirstName(draft.firstName)
      setLastName(draft.lastName)
      setPhone(draft.phone)
      setEmail(draft.email)
      setCompany(draft.company)
      setJobSiteAddress(draft.jobSiteAddress)
      setAddressSelectedFromSuggestions(draft.addressSelectedFromSuggestions)
      setNotes(draft.notes)
      setClientMode(draft.clientMode)
      setDraftAttachments(draft.attachments || [])
      setScheduledAt(draft.scheduledAt || null)
      setSelectedClient(
        draft.selectedClientId
          ? {
              id: draft.selectedClientId,
              name: draft.selectedClientName || 'Selected client',
              companyName: draft.selectedClientName || null,
            }
          : null
      )
    }
    void loadDraft()
    return () => {
      cancelled = true
    }
  }, [draftId])

  const onSelectAttachmentAction = async (
    action: 'take-photo' | 'record-video' | 'choose-photos' | 'choose-videos' | 'choose-audio' | 'choose-document'
  ) => {
    try {
      const picked = await pickAttachmentsByAction(action)
      if (!picked.length) return
      setDraftAttachments((prev) => [
        ...prev,
        ...picked.map((file) => ({
          id: `${Date.now()}-${file.name}-${Math.random().toString(36).slice(2, 7)}`,
          uri: file.uri,
          fileName: file.name,
          mimeType: file.mimeType,
          fileSize: Number(file.sizeBytes || 0),
        })),
      ])
    } catch (error: any) {
      Alert.alert('Attachment selection failed', error?.message || 'Please try again.')
    }
  }

  const clientsQuery = useQuery({
    queryKey: ['mobile-clients-for-request', clientSearch],
    queryFn: () =>
      apiRequest<ClientListResponse>(
        `/api/clients?status=active&limit=100&search=${encodeURIComponent(clientSearch.trim())}`
      ),
  })

  const clientRows = useMemo(() => clientsQuery.data?.clients || [], [clientsQuery.data?.clients])

  const selectExistingClient = (client: ClientListResponse['clients'][number]) => {
    const nameParts = String(client.name || '').trim().split(/\s+/).filter(Boolean)
    const inferredFirst = nameParts[0] || ''
    const inferredLast = nameParts.slice(1).join(' ') || 'Client'
    setSelectedClient(client)
    setClientMode('existing')
    setFirstName(inferredFirst)
    setLastName(inferredLast)
    setEmail(client.email || '')
    setPhone(client.phone || '')
    setCompany(client.companyName || '')
    setShowClientPicker(false)
  }

  const submit = async () => {
    if (!firstName.trim() || !lastName.trim()) {
      Alert.alert('Missing info', 'First name and last name are required.')
      return
    }
    if (clientMode === 'existing' && !selectedClient?.id) {
      Alert.alert('Missing client', 'Select an existing client or switch to Add New Client.')
      return
    }

    setLoading(true)
    try {
      const existingDraft = draftId ? await getRequestDraft(draftId) : null
      const savedDraft = await upsertRequestDraft({
        id: existingDraft?.id || draftId || createEmptyRequestDraft().id,
        kind: existingDraft?.kind || 'STANDARD',
        firstName,
        lastName,
        phone,
        email,
        company,
        clientMode,
        selectedClientId: clientMode === 'existing' ? selectedClient?.id || null : null,
        selectedClientName: clientMode === 'existing' ? selectedClient?.name || null : null,
        jobSiteAddress,
        addressSelectedFromSuggestions,
        notes,
        attachments: draftAttachments,
        scheduledAt,
        publishState: 'pendingPublish',
        publishError: null,
      })

      const { requestId, attachmentErrors } = await publishRequestDraft(savedDraft)
      void navigation.replace('RequestDetail', { requestId })
      if (attachmentErrors.length > 0) {
        Alert.alert(
          'Saved with warnings',
          `Request was saved for everyone, but ${attachmentErrors.length} attachment(s) failed.`
        )
      } else {
        Alert.alert('Saved', 'Request saved and is visible to your team.')
      }
    } catch (error: any) {
      Alert.alert('Failed', error?.message || 'Could not save request.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Screen style={styles.screen}>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>{draftId ? 'Edit Request' : 'Create Request'}</Text>
        <View style={styles.statusCard}>
          <Text style={styles.statusTitle}>Team request</Text>
          <Text style={styles.statusText}>Saving publishes this request for everyone on your team.</Text>
          <Text style={styles.statusText}>Schedule: {formatScheduledAt(scheduledAt)}</Text>
        </View>
        <View style={styles.clientModeWrap}>
          <Pressable
            style={[styles.clientModeButton, clientMode === 'existing' && styles.clientModeButtonActive]}
            onPress={() => setClientMode('existing')}
          >
            <Text style={[styles.clientModeText, clientMode === 'existing' && styles.clientModeTextActive]}>Existing Client</Text>
          </Pressable>
          <Pressable
            style={[styles.clientModeButton, clientMode === 'new' && styles.clientModeButtonActive]}
            onPress={() => {
              setClientMode('new')
              setSelectedClient(null)
            }}
          >
            <Text style={[styles.clientModeText, clientMode === 'new' && styles.clientModeTextActive]}>Add New Client</Text>
          </Pressable>
        </View>
        {clientMode === 'existing' ? (
          <View>
            <Pressable style={styles.clientSelectButton} onPress={() => setShowClientPicker(true)}>
              <Text style={selectedClient ? styles.clientSelectValue : styles.clientSelectPlaceholder}>
                {selectedClient ? selectedClient.name : 'Select existing client'}
              </Text>
              <Ionicons name="chevron-down" size={18} color={BRAND.text} />
            </Pressable>
          </View>
        ) : null}
        <TextInput
          style={styles.input}
          placeholder="First name"
          placeholderTextColor={BRAND.text}
          selectionColor={BRAND.text}
          cursorColor={BRAND.text}
          value={firstName}
          onChangeText={setFirstName}
        />
        <TextInput
          style={styles.input}
          placeholder="Last name"
          placeholderTextColor={BRAND.text}
          selectionColor={BRAND.text}
          cursorColor={BRAND.text}
          value={lastName}
          onChangeText={setLastName}
        />
        <TextInput
          style={styles.input}
          placeholder="Phone"
          placeholderTextColor={BRAND.text}
          selectionColor={BRAND.text}
          cursorColor={BRAND.text}
          value={phone}
          onChangeText={setPhone}
        />
        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={BRAND.text}
          autoCapitalize="none"
          keyboardType="email-address"
          selectionColor={BRAND.text}
          cursorColor={BRAND.text}
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Company (optional)"
          placeholderTextColor={BRAND.text}
          selectionColor={BRAND.text}
          cursorColor={BRAND.text}
          value={company}
          onChangeText={setCompany}
        />
        <View>
          <TextInput
            style={styles.input}
            placeholder="Job address (Google suggested)"
            placeholderTextColor={BRAND.text}
            selectionColor={BRAND.text}
            cursorColor={BRAND.text}
            value={jobSiteAddress}
            onChangeText={(text) => {
              setJobSiteAddress(text)
              setAddressSelectedFromSuggestions(false)
            }}
          />
          {isLoadingPredictions && <Text style={styles.hint}>Loading address suggestions...</Text>}
          {addressPredictions.length > 0 && (
            <View style={styles.suggestionsBox}>
              {addressPredictions.map((prediction) => (
                <Pressable key={prediction} style={styles.suggestionRow} onPress={async () => void resolveAndSelectAddress(prediction)}>
                  <Text style={styles.suggestionText}>{prediction}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {!isLoadingPredictions && jobSiteAddress.trim().length >= 3 && addressPredictions.length === 0 && (
            <Text style={styles.hint}>Searching Google suggestions... try adding city/state.</Text>
          )}
        </View>
        <TextInput
          style={[styles.input, styles.notes]}
          placeholder="Notes"
          placeholderTextColor={BRAND.text}
          selectionColor={BRAND.text}
          cursorColor={BRAND.text}
          value={notes}
          onChangeText={setNotes}
          multiline
        />

        <View style={styles.uploadSection}>
          <View style={styles.uploadHeader}>
            <Ionicons name="attach-outline" size={18} color={BRAND.text} />
            <Text style={styles.uploadTitle}>Attachments</Text>
          </View>
          <Pressable style={styles.uploadButton} onPress={() => setShowAttachmentPicker(true)}>
            <Ionicons name="add-circle-outline" size={18} color={BRAND.primary} />
            <Text style={styles.uploadButtonText}>Add Attachment</Text>
          </Pressable>
          <Text style={styles.uploadHint}>
            Files upload when you save. Supports photos, videos, PDF, Word, Excel, CSV, PowerPoint, and TXT.
          </Text>
          {draftAttachments.map((attachment) => (
            <View key={attachment.id} style={styles.localAttachmentRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.localAttachmentName}>{attachment.fileName}</Text>
                <Text style={styles.localAttachmentMeta}>
                  {attachment.mimeType || 'file'} • {Math.max(1, Math.round(attachment.fileSize / 1024))} KB
                </Text>
              </View>
              <Pressable
                onPress={() => setDraftAttachments((prev) => prev.filter((item) => item.id !== attachment.id))}
                hitSlop={8}
              >
                <Ionicons name="trash-outline" size={18} color="#B42318" />
              </Pressable>
            </View>
          ))}
        </View>

        <Pressable
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={submit}
          disabled={loading}
        >
          <Text style={styles.buttonText}>{loading ? 'Saving...' : 'Save request'}</Text>
        </Pressable>
      </ScrollView>
      <AttachmentPickerSheet
        visible={showAttachmentPicker}
        onClose={() => setShowAttachmentPicker(false)}
        onSelect={onSelectAttachmentAction}
      />
      <Modal
        visible={showClientPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowClientPicker(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowClientPicker(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Select Existing Client</Text>
            <TextInput
              style={styles.input}
              placeholder="Search client"
              placeholderTextColor={BRAND.text}
              selectionColor={BRAND.text}
              cursorColor={BRAND.text}
              value={clientSearch}
              onChangeText={setClientSearch}
            />
            <ScrollView style={styles.clientList}>
              {clientRows.map((client) => (
                <Pressable
                  key={client.id}
                  style={styles.clientRow}
                  onPress={() => selectExistingClient(client)}
                >
                  <Text style={styles.clientRowName}>{client.name}</Text>
                  {!!client.companyName ? <Text style={styles.clientRowMeta}>{client.companyName}</Text> : null}
                </Pressable>
              ))}
              {clientsQuery.isLoading ? <Text style={styles.hint}>Loading clients...</Text> : null}
              {!clientsQuery.isLoading && clientRows.length === 0 ? (
                <Text style={styles.hint}>No clients found. Switch to Add New Client to create one.</Text>
              ) : null}
            </ScrollView>
            <Pressable style={styles.modalCloseButton} onPress={() => setShowClientPicker(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </Screen>
  )
}

const styles = StyleSheet.create({
  screen: { padding: 14 },
  scrollContent: { gap: 10, paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: '800', color: BRAND.text, marginBottom: 8 },
  clientModeWrap: {
    flexDirection: 'row',
    gap: 8,
  },
  clientModeButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: BRAND.white,
  },
  clientModeButtonActive: {
    borderColor: BRAND.primary,
    backgroundColor: '#EEF4F7',
  },
  clientModeText: {
    color: BRAND.text,
    fontWeight: '600',
    fontSize: 13,
  },
  clientModeTextActive: {
    color: BRAND.primary,
  },
  clientSelectButton: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 12,
    paddingHorizontal: 12,
    backgroundColor: BRAND.white,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  clientSelectPlaceholder: {
    color: '#6B7280',
    fontSize: 14,
  },
  clientSelectValue: {
    color: BRAND.text,
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    backgroundColor: BRAND.white,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: BRAND.text,
  },
  hint: {
    marginTop: 6,
    color: BRAND.text,
    fontSize: 12,
  },
  suggestionsBox: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 12,
    backgroundColor: BRAND.white,
  },
  suggestionRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#EAECF0',
  },
  suggestionText: {
    color: BRAND.text,
    fontSize: 14,
  },
  notes: { minHeight: 100, textAlignVertical: 'top' },
  uploadSection: {
    borderWidth: 2,
    borderColor: '#E5E7EB',
    borderStyle: 'dashed',
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  uploadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  uploadTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: BRAND.text,
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: BRAND.primary,
  },
  uploadButtonText: {
    color: BRAND.primary,
    fontWeight: '600',
    fontSize: 14,
  },
  uploadHint: {
    fontSize: 11,
    color: '#6B7280',
  },
  localAttachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: '#EAECF0',
    paddingTop: 10,
  },
  localAttachmentName: {
    color: BRAND.text,
    fontWeight: '600',
    fontSize: 13,
  },
  localAttachmentMeta: {
    color: '#6B7280',
    fontSize: 11,
    marginTop: 2,
  },
  button: { backgroundColor: BRAND.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.7 },
  buttonText: { color: BRAND.white, fontWeight: '700' },
  statusCard: {
    backgroundColor: '#EEF4F7',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D4E3EA',
    padding: 12,
    gap: 4,
  },
  statusTitle: {
    color: BRAND.primary,
    fontWeight: '700',
    fontSize: 14,
  },
  statusText: {
    color: BRAND.text,
    fontSize: 12,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2,6,23,0.45)',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    backgroundColor: BRAND.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    padding: 12,
    gap: 8,
    maxHeight: '75%',
  },
  modalTitle: {
    color: BRAND.text,
    fontWeight: '700',
    fontSize: 16,
  },
  clientList: {
    maxHeight: 280,
  },
  clientRow: {
    borderTopWidth: 1,
    borderTopColor: '#EAECF0',
    paddingVertical: 10,
  },
  clientRowName: {
    color: BRAND.text,
    fontWeight: '600',
    fontSize: 14,
  },
  clientRowMeta: {
    color: '#6B7280',
    fontSize: 12,
    marginTop: 2,
  },
  modalCloseButton: {
    alignSelf: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D0D5DD',
  },
  modalCloseText: {
    color: BRAND.text,
    fontWeight: '600',
  },
})


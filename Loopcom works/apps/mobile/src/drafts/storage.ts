import AsyncStorage from '@react-native-async-storage/async-storage'

const DRAFTS_KEY = 'trimpro.mobile.local-drafts.v1'

export type DraftPublishState = 'localDraft' | 'readyToPublish' | 'pendingPublish' | 'publishFailed'
export type RequestDraftKind = 'STANDARD' | 'MEASURING'

export interface LocalTaskDraft {
  id: string
  title: string
  description: string
  notes: string
  selectedClientId: string | null
  selectedClientName: string | null
  scheduledAt: string | null
  assigneeId: string | null
  status: string
  priority: string
  publishState: DraftPublishState
  publishError?: string | null
  createdAt: string
  updatedAt: string
}

export interface LocalRequestDraftAttachment {
  id: string
  uri: string
  fileName: string
  mimeType: string
  fileSize: number
}

export interface LocalRequestDraft {
  id: string
  kind: RequestDraftKind
  firstName: string
  lastName: string
  phone: string
  email: string
  company: string
  notes: string
  jobSiteAddress: string
  addressSelectedFromSuggestions: boolean
  clientMode: 'existing' | 'new'
  selectedClientId: string | null
  selectedClientName: string | null
  attachments: LocalRequestDraftAttachment[]
  scheduledAt: string | null
  sourceTaskDraftId?: string | null
  publishState: DraftPublishState
  publishError?: string | null
  createdAt: string
  updatedAt: string
}

type DraftStore = {
  taskDrafts: LocalTaskDraft[]
  requestDrafts: LocalRequestDraft[]
}

const EMPTY_STORE: DraftStore = {
  taskDrafts: [],
  requestDrafts: [],
}

function nowIso() {
  return new Date().toISOString()
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

async function loadStore(): Promise<DraftStore> {
  const raw = await AsyncStorage.getItem(DRAFTS_KEY)
  if (!raw) return EMPTY_STORE
  try {
    const parsed = JSON.parse(raw) as Partial<DraftStore>
    return {
      taskDrafts: Array.isArray(parsed.taskDrafts) ? parsed.taskDrafts : [],
      requestDrafts: Array.isArray(parsed.requestDrafts) ? parsed.requestDrafts : [],
    }
  } catch {
    return EMPTY_STORE
  }
}

async function saveStore(store: DraftStore) {
  await AsyncStorage.setItem(DRAFTS_KEY, JSON.stringify(store))
}

function getDraftPublishState(isReady: boolean, previous?: DraftPublishState): DraftPublishState {
  if (previous === 'pendingPublish') return previous
  if (previous === 'publishFailed') return previous
  return isReady ? 'readyToPublish' : 'localDraft'
}

export function createEmptyTaskDraft(): LocalTaskDraft {
  const createdAt = nowIso()
  return {
    id: makeId('task-draft'),
    title: '',
    description: '',
    notes: '',
    selectedClientId: null,
    selectedClientName: null,
    scheduledAt: null,
    assigneeId: null,
    status: 'TODO',
    priority: 'MEDIUM',
    publishState: 'localDraft',
    publishError: null,
    createdAt,
    updatedAt: createdAt,
  }
}

export function createEmptyRequestDraft(kind: RequestDraftKind = 'STANDARD'): LocalRequestDraft {
  const createdAt = nowIso()
  return {
    id: makeId(kind === 'MEASURING' ? 'measuring-draft' : 'request-draft'),
    kind,
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    company: '',
    notes: '',
    jobSiteAddress: '',
    addressSelectedFromSuggestions: false,
    clientMode: 'existing',
    selectedClientId: null,
    selectedClientName: null,
    attachments: [],
    scheduledAt: null,
    sourceTaskDraftId: null,
    publishState: 'localDraft',
    publishError: null,
    createdAt,
    updatedAt: createdAt,
  }
}

export function isTaskDraftReady(draft: Pick<LocalTaskDraft, 'title'>) {
  return Boolean(String(draft.title || '').trim())
}

export function isRequestDraftReady(
  draft: Pick<LocalRequestDraft, 'firstName' | 'lastName' | 'clientMode' | 'selectedClientId'>
) {
  if (!String(draft.firstName || '').trim() || !String(draft.lastName || '').trim()) return false
  if (draft.clientMode === 'existing' && !draft.selectedClientId) return false
  return true
}

export async function listTaskDrafts() {
  const store = await loadStore()
  return [...store.taskDrafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function listRequestDrafts() {
  const store = await loadStore()
  return [...store.requestDrafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getTaskDraft(id: string) {
  const store = await loadStore()
  return store.taskDrafts.find((draft) => draft.id === id) || null
}

export async function getRequestDraft(id: string) {
  const store = await loadStore()
  return store.requestDrafts.find((draft) => draft.id === id) || null
}

export async function upsertTaskDraft(input: Partial<LocalTaskDraft> & { id?: string }) {
  const store = await loadStore()
  const existing = input.id ? store.taskDrafts.find((draft) => draft.id === input.id) : null
  const base = existing || createEmptyTaskDraft()
  const next: LocalTaskDraft = {
    ...base,
    ...input,
    title: String(input.title ?? base.title ?? ''),
    description: String(input.description ?? base.description ?? ''),
    notes: String(input.notes ?? base.notes ?? ''),
    selectedClientId:
      input.selectedClientId !== undefined ? input.selectedClientId : base.selectedClientId,
    selectedClientName:
      input.selectedClientName !== undefined ? input.selectedClientName : base.selectedClientName,
    scheduledAt: input.scheduledAt !== undefined ? input.scheduledAt : base.scheduledAt,
    assigneeId: input.assigneeId !== undefined ? input.assigneeId : base.assigneeId,
    status: String(input.status ?? base.status ?? 'TODO'),
    priority: String(input.priority ?? base.priority ?? 'MEDIUM'),
    publishError: input.publishError !== undefined ? input.publishError : base.publishError ?? null,
    updatedAt: nowIso(),
  }
  next.publishState =
    input.publishState !== undefined
      ? input.publishState
      : getDraftPublishState(isTaskDraftReady(next), base.publishState)

  const taskDrafts = existing
    ? store.taskDrafts.map((draft) => (draft.id === next.id ? next : draft))
    : [next, ...store.taskDrafts]
  await saveStore({ ...store, taskDrafts })
  return next
}

export async function upsertRequestDraft(input: Partial<LocalRequestDraft> & { id?: string }) {
  const store = await loadStore()
  const existing = input.id ? store.requestDrafts.find((draft) => draft.id === input.id) : null
  const base = existing || createEmptyRequestDraft(input.kind || 'STANDARD')
  const next: LocalRequestDraft = {
    ...base,
    ...input,
    kind: (input.kind ?? base.kind ?? 'STANDARD') as RequestDraftKind,
    firstName: String(input.firstName ?? base.firstName ?? ''),
    lastName: String(input.lastName ?? base.lastName ?? ''),
    phone: String(input.phone ?? base.phone ?? ''),
    email: String(input.email ?? base.email ?? ''),
    company: String(input.company ?? base.company ?? ''),
    notes: String(input.notes ?? base.notes ?? ''),
    jobSiteAddress: String(input.jobSiteAddress ?? base.jobSiteAddress ?? ''),
    addressSelectedFromSuggestions:
      input.addressSelectedFromSuggestions !== undefined
        ? Boolean(input.addressSelectedFromSuggestions)
        : Boolean(base.addressSelectedFromSuggestions),
    clientMode: (input.clientMode ?? base.clientMode ?? 'existing') as 'existing' | 'new',
    selectedClientId:
      input.selectedClientId !== undefined ? input.selectedClientId : base.selectedClientId,
    selectedClientName:
      input.selectedClientName !== undefined ? input.selectedClientName : base.selectedClientName,
    attachments: Array.isArray(input.attachments) ? input.attachments : base.attachments || [],
    scheduledAt: input.scheduledAt !== undefined ? input.scheduledAt : base.scheduledAt,
    sourceTaskDraftId:
      input.sourceTaskDraftId !== undefined ? input.sourceTaskDraftId : base.sourceTaskDraftId ?? null,
    publishError: input.publishError !== undefined ? input.publishError : base.publishError ?? null,
    updatedAt: nowIso(),
  }
  next.publishState =
    input.publishState !== undefined
      ? input.publishState
      : getDraftPublishState(isRequestDraftReady(next), base.publishState)

  const requestDrafts = existing
    ? store.requestDrafts.map((draft) => (draft.id === next.id ? next : draft))
    : [next, ...store.requestDrafts]
  await saveStore({ ...store, requestDrafts })
  return next
}

export async function deleteTaskDraft(id: string) {
  const store = await loadStore()
  await saveStore({
    ...store,
    taskDrafts: store.taskDrafts.filter((draft) => draft.id !== id),
  })
}

export async function deleteRequestDraft(id: string) {
  const store = await loadStore()
  await saveStore({
    ...store,
    requestDrafts: store.requestDrafts.filter((draft) => draft.id !== id),
  })
}

export async function setTaskDraftPublishState(id: string, publishState: DraftPublishState, publishError?: string | null) {
  return upsertTaskDraft({ id, publishState, publishError: publishError ?? null })
}

export async function setRequestDraftPublishState(id: string, publishState: DraftPublishState, publishError?: string | null) {
  return upsertRequestDraft({ id, publishState, publishError: publishError ?? null })
}

export async function convertTaskDraftToRequestDraft(taskDraftId: string) {
  const taskDraft = await getTaskDraft(taskDraftId)
  if (!taskDraft) {
    throw new Error('Task draft not found')
  }
  const requestDraft = await upsertRequestDraft({
    kind: 'STANDARD',
    firstName: taskDraft.title.trim() || 'Task',
    lastName: 'Request',
    notes: [taskDraft.description.trim(), taskDraft.notes.trim()].filter(Boolean).join('\n\n'),
    scheduledAt: taskDraft.scheduledAt,
    sourceTaskDraftId: taskDraft.id,
    clientMode: taskDraft.selectedClientId ? 'existing' : 'new',
    selectedClientId: taskDraft.selectedClientId || null,
    selectedClientName: taskDraft.selectedClientName || null,
    publishState: 'localDraft',
    publishError: null,
  })
  await deleteTaskDraft(taskDraft.id)
  return requestDraft
}

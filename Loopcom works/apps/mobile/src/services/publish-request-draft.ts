import * as FileSystem from 'expo-file-system/legacy'
import { apiRequest, getValidAccessToken } from '../api/client'
import { API_BASE_URL } from '../config/env'
import {
  deleteRequestDraft,
  LocalRequestDraft,
  setRequestDraftPublishState,
  upsertRequestDraft,
} from '../drafts/storage'
import { extractCreatedRequestId } from '../screens/requests/request-utils'

export type PublishRequestResult = {
  requestId: string
  attachmentErrors: string[]
}

/**
 * Creates the request on the server (POST /api/leads) and uploads local attachments.
 * Used by Create Request (save for everyone) and the Requests list Publish action.
 */
export async function publishRequestDraft(draft: LocalRequestDraft): Promise<PublishRequestResult> {
  const token = await getValidAccessToken()
  if (!token) {
    throw new Error('You must be logged in to save requests.')
  }
  if (draft.clientMode === 'existing' && !draft.selectedClientId) {
    throw new Error('Select an existing client before saving.')
  }
  if (!draft.firstName.trim() || !draft.lastName.trim()) {
    throw new Error('First name and last name are required.')
  }

  await setRequestDraftPublishState(draft.id, 'pendingPublish')

  let resolvedAddress = draft.jobSiteAddress
  let addressSelected = draft.addressSelectedFromSuggestions
  if (resolvedAddress.trim() && !addressSelected) {
    const resolved = await apiRequest<{
      address: { street: string; city: string; state: string; zipCode: string }
    }>(`/api/mobile/places?mode=resolve&address=${encodeURIComponent(resolvedAddress.trim())}`)
    const locality = [resolved.address.city, resolved.address.state, resolved.address.zipCode]
      .filter(Boolean)
      .join(' ')
    resolvedAddress = [resolved.address.street, locality].filter(Boolean).join(', ')
    addressSelected = true
    await upsertRequestDraft({
      id: draft.id,
      jobSiteAddress: resolvedAddress,
      addressSelectedFromSuggestions: true,
      publishState: 'pendingPublish',
    })
  }

  const response = await apiRequest<{ lead?: { id?: string }; id?: string }>('/api/leads', 'POST', {
    firstName: draft.firstName.trim(),
    lastName: draft.lastName.trim(),
    phone: draft.phone.trim() || null,
    email: draft.email.trim() || null,
    company: draft.company.trim() || null,
    clientId: draft.clientMode === 'existing' ? draft.selectedClientId : null,
    jobSiteAddress: resolvedAddress.trim() || null,
    notes: draft.notes.trim() || null,
    source: 'OTHER',
    status: 'NEW',
  })

  const requestId = extractCreatedRequestId(response)
  const attachmentErrors: string[] = []

  for (const attachment of draft.attachments || []) {
    try {
      const upload = await FileSystem.uploadAsync(`${API_BASE_URL}/api/uploads`, attachment.uri, {
        fieldName: 'file',
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'TrimProMobile',
        },
        mimeType: attachment.mimeType,
      })

      if (upload.status < 200 || upload.status >= 300) {
        throw new Error('Upload failed')
      }

      const payload = JSON.parse(upload.body)
      await apiRequest('/api/attachments', 'POST', {
        entityType: 'request',
        entityId: requestId,
        fileName: attachment.fileName,
        fileSize: attachment.fileSize,
        mimeType: attachment.mimeType,
        url: payload.url,
        key: payload.relativeUrl || payload.filename || payload.url,
      })
    } catch (error: any) {
      attachmentErrors.push(error?.message || `Failed to upload ${attachment.fileName}`)
    }
  }

  await deleteRequestDraft(draft.id)
  return { requestId, attachmentErrors }
}

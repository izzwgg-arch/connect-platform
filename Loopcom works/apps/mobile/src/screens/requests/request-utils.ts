export interface CreateRequestLikeResponse {
  id?: string | null
  lead?: { id?: string | null } | null
}

export function extractCreatedRequestId(response: CreateRequestLikeResponse): string {
  const candidate = (response.lead?.id || response.id || '').trim()
  if (!candidate) {
    throw new Error('Request was created but no request id was returned.')
  }
  return candidate
}

export function getRequestDetailsErrorCopy(errorMessage?: string): {
  title: string
  description: string
  canRetry: boolean
} {
  const normalized = String(errorMessage || '').toLowerCase()
  if (normalized.includes('forbidden') || normalized.includes('not found')) {
    return {
      title: 'Access restricted',
      description: "You don't have access to this request.",
      canRetry: true,
    }
  }
  return {
    title: 'Request failed to load',
    description: 'Please try again.',
    canRetry: true,
  }
}

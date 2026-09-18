export type CreateSourceType = 'request' | 'job' | 'estimate' | 'client'

export type CreateContextParams = {
  clientId?: string | null
  sourceType?: CreateSourceType | null
  sourceId?: string | null
  addressId?: string | null

  // Optional legacy/relationship params we already use in some flows.
  requestId?: string | null
  jobId?: string | null

  // Anything else a page already uses (e.g., jobNumber/clientName for banners).
  extra?: Record<string, string | null | undefined>
}

export function buildCreateContextQuery(params: CreateContextParams): string {
  const qs = new URLSearchParams()

  if (params.clientId) qs.set('clientId', params.clientId)
  if (params.sourceType) qs.set('sourceType', params.sourceType)
  if (params.sourceId) qs.set('sourceId', params.sourceId)
  if (params.addressId) qs.set('addressId', params.addressId)

  if (params.requestId) qs.set('requestId', params.requestId)
  if (params.jobId) qs.set('jobId', params.jobId)

  if (params.extra) {
    for (const [k, v] of Object.entries(params.extra)) {
      if (v === null || v === undefined || String(v).trim() === '') continue
      qs.set(k, String(v))
    }
  }

  const str = qs.toString()
  return str ? `?${str}` : ''
}


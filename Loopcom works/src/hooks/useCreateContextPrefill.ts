'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { z } from 'zod'
import { fetchClientPickerDetail, pickDefaultClientAddress } from '@/lib/clients/client-picker-api'

type EntityType = 'estimate' | 'job' | 'task' | 'issue'
type SourceType = 'request' | 'job' | 'estimate' | 'client'

type ClientAddress = {
  id: string
  type: string
  street: string
  city: string
  state: string
  zipCode: string
  country: string
  isDefault?: boolean
}

type ClientPrefill = {
  id: string
  name: string
  companyName?: string | null
  addresses?: ClientAddress[]
}

const querySchema = z.object({
  clientId: z.string().trim().min(1).optional(),
  sourceType: z.enum(['request', 'job', 'estimate', 'client']).optional(),
  sourceId: z.string().trim().min(1).optional(),
  addressId: z.string().trim().min(1).optional(),
  requestId: z.string().trim().min(1).optional(),
  jobId: z.string().trim().min(1).optional(),
})

async function fetchClientPrefill(clientId: string): Promise<ClientPrefill | null> {
  const client = await fetchClientPickerDetail(clientId)
  return client
}

export function useCreateContextPrefill(entityType: EntityType) {
  const searchParams = useSearchParams()

  const parsed = useMemo(() => {
    const raw = Object.fromEntries(searchParams.entries())
    const result = querySchema.safeParse(raw)
    return result.success ? result.data : {}
  }, [searchParams])

  const prefillClientId = parsed.clientId || null
  const sourceType = (parsed.sourceType || null) as SourceType | null
  const sourceId = parsed.sourceId || null

  const [client, setClient] = useState<ClientPrefill | null>(null)
  const [address, setAddress] = useState<ClientAddress | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Prevent overwriting user edits: caller controls whether to apply, and we only allow it once.
  const appliedRef = useRef(false)
  const applyDefaultsOnce = useCallback(
    (shouldApply: () => boolean, apply: () => void) => {
      if (appliedRef.current) return false
      if (!shouldApply()) return false
      appliedRef.current = true
      apply()
      return true
    },
    []
  )

  useEffect(() => {
    // Only prefetch client/address for entity types that actually have address fields.
    if (!prefillClientId) return
    if (entityType !== 'estimate' && entityType !== 'job') return

    let cancelled = false
    setLoading(true)
    setError(null)

    fetchClientPrefill(prefillClientId)
      .then((c) => {
        if (cancelled) return
        setClient(c)
        const addr = c?.addresses ? pickDefaultClientAddress(c.addresses, parsed.addressId) : null
        setAddress(addr)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e?.message || 'Failed to load client context')
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [prefillClientId, parsed.addressId, entityType])

  const noAddressWarning =
    Boolean(prefillClientId) && (entityType === 'estimate' || entityType === 'job') && Boolean(client) && !address

  return {
    entityType,
    prefillClientId,
    sourceType,
    sourceId,
    requestId: parsed.requestId || null,
    jobId: parsed.jobId || null,
    addressId: parsed.addressId || null,
    client,
    address,
    noAddressWarning,
    applyDefaultsOnce,
    loading,
    error,
  }
}


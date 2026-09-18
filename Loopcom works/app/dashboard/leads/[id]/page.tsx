'use client'

import { useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'

export default function LeadDetailPageRedirect() {
  const router = useRouter()
  const params = useParams()
  const id = params.id as string
  
  useEffect(() => {
    if (id) {
      router.replace(`/dashboard/requests/${id}`)
    }
  }, [router, id])
  return null
}

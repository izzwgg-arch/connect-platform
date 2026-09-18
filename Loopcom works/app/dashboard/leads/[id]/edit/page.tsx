'use client'

import { useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'

export default function EditLeadPageRedirect() {
  const router = useRouter()
  const params = useParams()
  const id = params.id as string
  
  useEffect(() => {
    if (id) {
      router.replace(`/dashboard/requests/${id}/edit`)
    }
  }, [router, id])
  return null
}

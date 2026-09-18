'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function NewLeadPageRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/dashboard/requests/new')
  }, [router])
  return null
}

import { useEffect, useState } from 'react'
import { getOutboxCount } from '../offline/outbox'

export function useOutboxCount(pollMs = 2000) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let active = true
    const tick = async () => {
      const next = await getOutboxCount()
      if (active) setCount(next)
    }

    void tick()
    const interval = setInterval(() => {
      void tick()
    }, pollMs)

    return () => {
      active = false
      clearInterval(interval)
    }
  }, [pollMs])

  return count
}


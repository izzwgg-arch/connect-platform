import { useEffect, useState } from 'react'
import NetInfo from '@react-native-community/netinfo'

export function useOnlineState() {
  const [isOnline, setIsOnline] = useState(true)

  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      setIsOnline(Boolean(state.isConnected && state.isInternetReachable !== false))
    })
    return () => unsub()
  }, [])

  return isOnline
}


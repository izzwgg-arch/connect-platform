import 'react-native-gesture-handler'
import React, { useEffect, useRef, useState } from 'react'
import { AppState, TextInput, View } from 'react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as Notifications from 'expo-notifications'
import * as SplashScreen from 'expo-splash-screen'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { BrandingProvider } from './branding/BrandingContext'
import { RootNavigator } from './navigation/RootNavigator'
import { registerPushToken, setLastPushReceivedAtNow } from './notifications/registerPush'
import { flushOutbox, loadOutbox } from './offline/outbox'
import { useOnlineState } from './hooks/useOnlineState'
import { apiRequest } from './api/client'
import { NotificationPopup } from './components/NotificationPopup'
import { openFromNotificationPayload } from './notifications/openFromNotification'

// Never call preventAutoHideAsync — if JS stalls before hide, the native splash
// stays forever. Hide as soon as this module loads, then again after mount.
void SplashScreen.hideAsync().catch(() => null)

try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  })
} catch {
  // Non-fatal on devices where notifications module is unavailable.
}

const queryClient = new QueryClient()

// Enforce readable default input text/placeholder colors across the app.
TextInput.defaultProps = TextInput.defaultProps || {}
TextInput.defaultProps.placeholderTextColor = '#0F172A'
TextInput.defaultProps.selectionColor = '#0F172A'

function SyncAndPushBootstrap() {
  const { token } = useAuth()
  const isOnline = useOnlineState()
  const [pushRegistered, setPushRegistered] = useState(false)
  const assignmentSignatureRef = useRef('')
  const [currentNotification, setCurrentNotification] = useState<Notifications.Notification | null>(null)
  const lastNotificationIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!token || pushRegistered) return
    let stopped = false

    const attemptRegister = async () => {
      try {
        await registerPushToken()
        if (!stopped) setPushRegistered(true)
      } catch (error) {
        console.warn('Push registration retry scheduled:', error)
      }
    }

    void attemptRegister()
    const interval = setInterval(() => {
      if (!stopped) void attemptRegister()
    }, 30000)

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [pushRegistered, token])

  // Re-attempt registration whenever app comes back to foreground.
  useEffect(() => {
    if (!token) return
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || pushRegistered) return
      void registerPushToken()
        .then(() => setPushRegistered(true))
        .catch((error) => {
          console.warn('Push registration on foreground failed:', error)
        })
    })
    return () => sub.remove()
  }, [pushRegistered, token])

  // Handle foreground notifications (show popup)
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener((notification) => {
      // Show popup for foreground notifications
      setCurrentNotification(notification)
      void setLastPushReceivedAtNow()
      queryClient.invalidateQueries({ queryKey: ['mobile-notifications'] })
      queryClient.invalidateQueries({ queryKey: ['mobile-notifications-unread'] })
    })
    return () => sub.remove()
  }, [])

  // Handle notification taps
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = (response.notification.request.content.data || {}) as Record<string, any>
      void setLastPushReceivedAtNow()
      queryClient.invalidateQueries({ queryKey: ['mobile-notifications'] })
      queryClient.invalidateQueries({ queryKey: ['mobile-notifications-unread'] })
      const notificationId = typeof data.notificationId === 'string' ? data.notificationId : ''
      if (notificationId) {
        void apiRequest('/api/mobile/notifications/read', 'POST', { notificationId }).catch(() => null)
      }
      void openFromNotificationPayload(data).catch(() => null)
    })
    return () => sub.remove()
  }, [])

  // Poll for new notifications
  useEffect(() => {
    if (!token || !isOnline) return
    let stopped = false

    const pollNotifications = async () => {
      try {
        const data = await apiRequest<{
          notifications: Array<{
            id: string
            title: string
            message: string | null
            linkType: string | null
            linkId: string | null
            createdAt: string
          }>
        }>('/api/notifications?status=UNREAD&limit=1')

        // Show the most recent unread notification if it's new
        if (data.notifications.length > 0) {
          const latest = data.notifications[0]
          if (latest.id !== lastNotificationIdRef.current) {
            lastNotificationIdRef.current = latest.id

            // Create a notification object for the popup
            const notification: Notifications.Notification = {
              request: {
                identifier: latest.id,
                content: {
                  title: latest.title,
                  body: latest.message || undefined,
                  data: {
                    linkType: latest.linkType || undefined,
                    linkId: latest.linkId || undefined,
                  },
                },
                trigger: null,
              },
              date: new Date(latest.createdAt),
            }

            setCurrentNotification(notification)
          }
        }
      } catch (error) {
        console.warn('Notification polling error:', error)
        // Non-blocking
      }
    }

    // Poll immediately, then every 3 seconds for faster updates
    void pollNotifications()
    const interval = setInterval(() => {
      if (!stopped) void pollNotifications()
    }, 3000) // Poll every 3 seconds for faster updates

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [token, isOnline])

  useEffect(() => {
    if (!token || !isOnline) return
    let cancelled = false
    ;(async () => {
      const queue = await loadOutbox()
      if (queue.length === 0 || cancelled) return
      await flushOutbox(token)
      queryClient.invalidateQueries()
    })()
    return () => {
      cancelled = true
    }
  }, [isOnline, token])

  useEffect(() => {
    if (!token || !isOnline) return
    let stopped = false

    const pollAssignments = async () => {
      try {
        const payload = await apiRequest<{
          jobs: Array<{ id: string; updatedAt: string }>
          tasks: Array<{ id: string; updatedAt: string }>
          issues: Array<{ id: string; updatedAt: string }>
        }>('/api/mobile/assignments')

        const nextSignature = JSON.stringify({
          jobs: payload.jobs.map((x) => `${x.id}:${x.updatedAt}`),
          tasks: payload.tasks.map((x) => `${x.id}:${x.updatedAt}`),
          issues: payload.issues.map((x) => `${x.id}:${x.updatedAt}`),
        })

        if (!stopped && assignmentSignatureRef.current && assignmentSignatureRef.current !== nextSignature) {
          queryClient.invalidateQueries({ queryKey: ['mobile-jobs'] })
          queryClient.invalidateQueries({ queryKey: ['mobile-tasks'] })
          queryClient.invalidateQueries({ queryKey: ['mobile-issues'] })
          queryClient.invalidateQueries({ queryKey: ['mobile-schedule'] })
          queryClient.invalidateQueries({ queryKey: ['mobile-chat-conversations'] })
          queryClient.invalidateQueries({ queryKey: ['mobile-chat-thread'] })
        }

        if (!stopped) assignmentSignatureRef.current = nextSignature
      } catch {
        // Non-blocking; polling retries next interval.
      }
    }

    void pollAssignments()
    const interval = setInterval(() => {
      void pollAssignments()
    }, 60000)

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [isOnline, token])

  return (
    <>
      <RootNavigator />
      <NotificationPopup
        notification={currentNotification}
        onDismiss={() => setCurrentNotification(null)}
      />
    </>
  )
}

export default function AppRoot() {
  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => null)
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <KeyboardProvider statusBarTranslucent navigationBarTranslucent preserveEdgeToEdge>
          <BrandingProvider>
            <AuthProvider>
              <SyncAndPushBootstrap />
            </AuthProvider>
          </BrandingProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
  )
}


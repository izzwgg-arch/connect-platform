import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import * as Application from 'expo-application'
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { apiRequest } from '../api/client'

const PUSH_TOKEN_KEY = 'trimpro.push.token'
const PUSH_DEVICE_ID_KEY = 'trimpro.push.deviceId'
const PUSH_LAST_RECEIVED_AT_KEY = 'trimpro.push.lastReceivedAt'
const PUSH_REGISTER_MAX_RETRIES = 3

async function getStableDeviceId() {
  const existing = await SecureStore.getItemAsync(PUSH_DEVICE_ID_KEY)
  if (existing) return existing
  const generated = `${Platform.OS}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await SecureStore.setItemAsync(PUSH_DEVICE_ID_KEY, generated)
  return generated
}

function getProjectId(): string | null {
  const fromExpoConfig = Constants.expoConfig?.extra?.eas?.projectId
  const fromEasConfig = (Constants as any)?.easConfig?.projectId
  const fromManifest2 = (Constants as any)?.manifest2?.extra?.eas?.projectId
  const fromManifest = (Constants as any)?.manifest?.extra?.eas?.projectId
  // Last-resort fallback to this app's current EAS project id.
  const fromFallback = '5d6344e3-86ce-4e96-93e8-13893313d47f'
  const projectId = String(
    fromEasConfig || fromExpoConfig || fromManifest2 || fromManifest || fromFallback || ''
  ).trim()
  return projectId || null
}

function getLocaleAndTimezone() {
  const intl = Intl.DateTimeFormat().resolvedOptions()
  return {
    locale: intl?.locale || null,
    timezone: intl?.timeZone || null,
  }
}

export async function getStoredPushToken() {
  return SecureStore.getItemAsync(PUSH_TOKEN_KEY)
}

export async function setLastPushReceivedAtNow() {
  await SecureStore.setItemAsync(PUSH_LAST_RECEIVED_AT_KEY, new Date().toISOString())
}

export async function getLastPushReceivedAt() {
  return SecureStore.getItemAsync(PUSH_LAST_RECEIVED_AT_KEY)
}

export async function registerPushToken() {
  if (!Device.isDevice) return null

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('trimpro-default', {
      name: 'TrimPro',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#0F4C5C',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      sound: 'default',
      showBadge: true,
    })
  }

  const existing = await Notifications.getPermissionsAsync()
  let status = existing.status
  if (status !== 'granted') {
    const requested = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    })
    status = requested.status
  }
  if (status !== 'granted') return null

  const projectId = getProjectId()
  if (!projectId) throw new Error('EAS projectId is missing for push token registration')

  let tokenData: Notifications.ExpoPushToken
  try {
    tokenData = await Notifications.getExpoPushTokenAsync({ projectId })
  } catch (error) {
    console.warn('Expo push token with projectId failed, retrying without projectId:', error)
    tokenData = await Notifications.getExpoPushTokenAsync()
  }
  const token = tokenData.data
  const oldToken = await getStoredPushToken()
  const deviceId = await getStableDeviceId()

  if (oldToken && oldToken !== token) {
    await apiRequest('/api/mobile/push/unregister', 'POST', {
      expoPushToken: oldToken,
      deviceId,
    }).catch(() => null)
  }

  let registerError: Error | null = null
  for (let attempt = 1; attempt <= PUSH_REGISTER_MAX_RETRIES; attempt += 1) {
    try {
      const localeAndTimezone = getLocaleAndTimezone()
      await apiRequest('/api/mobile/push/register', 'POST', {
        expoPushToken: token,
        token,
        deviceId,
        platform: Platform.OS,
        appVersion: Application.nativeApplicationVersion || Constants.expoConfig?.version || 'unknown',
        buildNumber: Application.nativeBuildVersion || 'unknown',
        locale: localeAndTimezone.locale,
        timezone: localeAndTimezone.timezone,
      })
      registerError = null
      break
    } catch (error) {
      registerError = error instanceof Error ? error : new Error('Push registration failed')
      if (attempt < PUSH_REGISTER_MAX_RETRIES) {
        const delayMs = attempt * 700
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  if (registerError) throw registerError

  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token)
  return token
}

export async function unregisterPushToken() {
  const token = await getStoredPushToken()
  const deviceId = await SecureStore.getItemAsync(PUSH_DEVICE_ID_KEY)
  await apiRequest('/api/mobile/push/unregister', 'POST', {
    expoPushToken: token,
    token,
    deviceId,
  }).catch(() => null)
}
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'

const ACCESS_TOKEN_KEY = 'trimpro.mobile.accessToken'
const REFRESH_TOKEN_KEY = 'trimpro.mobile.refreshToken'
const USER_KEY = 'trimpro.mobile.user'
const DEVICE_ID_KEY = 'trimpro.mobile.deviceId'

export async function saveAuth(accessToken: string, refreshToken: string, userJson: string) {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken),
    SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken),
    SecureStore.setItemAsync(USER_KEY, userJson),
  ])
}

export async function saveTokens(accessToken: string, refreshToken: string) {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken),
    SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken),
  ])
}

export async function getAccessToken() {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY)
}

export async function getRefreshToken() {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY)
}

export async function getStoredUser() {
  return SecureStore.getItemAsync(USER_KEY)
}

export async function getOrCreateDeviceId() {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY)
  if (existing) return existing
  const generated = `${Platform.OS}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await SecureStore.setItemAsync(DEVICE_ID_KEY, generated)
  return generated
}

export async function clearAuth() {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    SecureStore.deleteItemAsync(USER_KEY),
  ])
}


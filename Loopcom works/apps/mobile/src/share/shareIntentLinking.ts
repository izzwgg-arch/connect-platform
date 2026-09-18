import * as Linking from 'expo-linking'
import Constants from 'expo-constants'
import {
  ShareIntentModule,
  getScheme,
  getShareExtensionKey,
} from 'expo-share-intent'
import type { LinkingOptions } from '@react-navigation/native'
import type { RootDrawerParamList } from '../types/navigation'

const SHARE_INGRESS_URL = 'trimprofield://share-ingress'

function isShareExtensionUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return url.includes(`dataUrl=${getShareExtensionKey()}`) || url.includes('shareintent')
}

/**
 * React Navigation linking helpers so Android share intents open ShareIngress
 * on cold start and when the app is already running in the background.
 */
export function buildShareAwareLinking(
  base: LinkingOptions<RootDrawerParamList>
): LinkingOptions<RootDrawerParamList> {
  const scheme = getScheme() || 'trimprofield'
  const packageName =
    Constants.expoConfig?.android?.package ||
    Constants.expoConfig?.ios?.bundleIdentifier ||
    'com.trimpro.field'

  return {
    ...base,
    prefixes: [...(base.prefixes || []), `${scheme}://`, `${packageName}://`],
    async getInitialURL() {
      try {
        const needRedirect = ShareIntentModule?.hasShareIntent(getShareExtensionKey())
        if (needRedirect) return SHARE_INGRESS_URL
      } catch {
        // Native module unavailable (Expo Go) — fall through.
      }
      return (await Linking.getInitialURL()) || undefined
    },
    subscribe(listener) {
      const onReceiveURL = ({ url }: { url: string }) => {
        if (isShareExtensionUrl(url)) {
          listener(SHARE_INGRESS_URL)
          return
        }
        listener(url)
      }

      const shareIntentStateSubscription = ShareIntentModule?.addListener(
        'onStateChange',
        (event) => {
          if (event.value === 'pending') {
            listener(SHARE_INGRESS_URL)
          }
        }
      )

      const shareIntentValueSubscription = ShareIntentModule?.addListener(
        'onChange',
        async () => {
          const url = await Linking.getInitialURL()
          if (url) onReceiveURL({ url })
        }
      )

      const urlEventSubscription = Linking.addEventListener('url', onReceiveURL)

      return () => {
        shareIntentStateSubscription?.remove()
        shareIntentValueSubscription?.remove()
        urlEventSubscription.remove()
      }
    },
  }
}

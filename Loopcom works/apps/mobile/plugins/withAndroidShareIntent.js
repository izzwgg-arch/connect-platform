/**
 * Registers TrimPro Field as a target in the Android "Share" sheet so users can
 * share photos, videos, PDFs, and other files from other apps (Gallery, Files,
 * Gmail, etc.) directly into TrimPro.
 *
 * This merges ACTION_SEND / ACTION_SEND_MULTIPLE intent-filters onto the existing
 * MainActivity declaration (idempotent - safe to run on every `expo prebuild`).
 *
 * NOTE: this only makes the app appear as a share target and lets Android launch
 * it. Turning the incoming Intent extras (EXTRA_STREAM / EXTRA_TEXT) into a
 * payload the JS side can read requires either `expo-share-intent` (currently
 * incompatible with this project's Expo SDK - see BUILDING.md) or a custom
 * native module. Until one of those lands, `ShareIngressScreen` is reachable
 * for manual testing via the `trimprofield://share-ingress` deep link.
 */
const { withAndroidManifest } = require('expo/config-plugins')

const SHARE_MIME_TYPES = ['*/*', 'image/*', 'video/*', 'application/pdf']

function ensureArray(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function buildShareIntentFilter(action) {
  return {
    action: [{ $: { 'android:name': `android.intent.action.${action}` } }],
    category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
    data: SHARE_MIME_TYPES.map((mimeType) => ({ $: { 'android:mimeType': mimeType } })),
  }
}

function hasShareIntentFilter(intentFilters, action) {
  return intentFilters.some((filter) => {
    const actions = ensureArray(filter.action).map((entry) => entry?.$?.['android:name'])
    return actions.includes(`android.intent.action.${action}`)
  })
}

const withAndroidShareIntent = (config) =>
  withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest
    const application = ensureArray(manifest.application)[0]
    if (!application) return config

    const activities = ensureArray(application.activity)
    const mainActivity = activities.find((activity) => activity?.$?.['android:name'] === '.MainActivity')
    if (!mainActivity) return config

    const existingFilters = ensureArray(mainActivity['intent-filter'])
    const filtersToAdd = ['SEND', 'SEND_MULTIPLE']
      .filter((action) => !hasShareIntentFilter(existingFilters, action))
      .map(buildShareIntentFilter)

    if (filtersToAdd.length > 0) {
      mainActivity['intent-filter'] = [...existingFilters, ...filtersToAdd]
    }

    return config
  })

module.exports = withAndroidShareIntent

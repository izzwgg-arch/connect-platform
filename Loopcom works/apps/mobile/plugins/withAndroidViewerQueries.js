/**
 * Android 11+ package visibility: allow resolving apps that can VIEW / SEND files.
 * Without this, IntentLauncher VIEW often fails with "No Activity found".
 */
const { withAndroidManifest } = require('expo/config-plugins')

function ensureArray(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

const VIEW_INTENTS = [
  {
    action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
    data: [{ $: { 'android:mimeType': '*/*' } }],
  },
  {
    action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
    data: [{ $: { 'android:mimeType': 'application/pdf' } }],
  },
  {
    action: [{ $: { 'android:name': 'android.intent.action.SEND' } }],
    data: [{ $: { 'android:mimeType': '*/*' } }],
  },
]

const withAndroidViewerQueries = (config) =>
  withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest
    const existingQueries = ensureArray(manifest.queries)
    const existingIntents = existingQueries.flatMap((q) => ensureArray(q.intent))

    const alreadyHasView = existingIntents.some((intent) => {
      const actions = ensureArray(intent.action).map((a) => a?.$?.['android:name'])
      return actions.includes('android.intent.action.VIEW')
    })

    if (!alreadyHasView) {
      manifest.queries = [
        ...existingQueries,
        {
          intent: VIEW_INTENTS,
        },
      ]
    }

    return config
  })

module.exports = withAndroidViewerQueries

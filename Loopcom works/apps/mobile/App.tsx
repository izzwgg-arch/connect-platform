import { StatusBar } from 'expo-status-bar'
import { ShareIntentProvider } from 'expo-share-intent'
import AppRoot from './src/AppRoot'

export default function App() {
  return (
    <ShareIntentProvider>
      <AppRoot />
      <StatusBar style="dark" />
    </ShareIntentProvider>
  )
}

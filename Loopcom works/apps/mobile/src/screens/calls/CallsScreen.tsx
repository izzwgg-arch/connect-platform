import React, { useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useQuery } from '@tanstack/react-query'
import { Screen } from '../../components/Screen'
import { apiRequest } from '../../api/client'
import { BRAND } from '../../config/env'

interface CallRecord {
  id: string
  fromNumber: string
  toNumber: string
  direction: string
  status: string
  startedAt: string
}

interface CallsResponse {
  calls: CallRecord[]
}

export function CallsScreen() {
  const [dialNumber, setDialNumber] = useState('')
  const [sipServer, setSipServer] = useState('')
  const [sipUser, setSipUser] = useState('')
  const [sipPassword, setSipPassword] = useState('')

  const query = useQuery({
    queryKey: ['mobile-calls'],
    queryFn: () => apiRequest<CallsResponse>('/api/calls?limit=50'),
  })

  return (
    <Screen style={styles.screen}>
      <Text style={styles.title}>Calls</Text>
      <Text style={styles.subtitle}>SIP setup, dialer, and recent call activity.</Text>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>SIP Settings</Text>
        <TextInput style={styles.input} value={sipServer} onChangeText={setSipServer} placeholder="SIP server" />
        <TextInput style={styles.input} value={sipUser} onChangeText={setSipUser} placeholder="SIP username" />
        <TextInput
          style={styles.input}
          value={sipPassword}
          onChangeText={setSipPassword}
          placeholder="SIP password"
          secureTextEntry
        />
        <Text style={styles.note}>
          Full SIP calling may require Expo development build with native VoIP modules.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Dial pad</Text>
        <TextInput
          style={styles.input}
          keyboardType="phone-pad"
          value={dialNumber}
          onChangeText={setDialNumber}
          placeholder="Enter number"
        />
        <Pressable style={styles.button}>
          <Text style={styles.buttonText}>Call (UI scaffold)</Text>
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Recents</Text>
      <FlatList
        data={query.data?.calls ?? []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.rowTitle}>
              {item.fromNumber} → {item.toNumber}
            </Text>
            <Text style={styles.rowMeta}>
              {item.direction} · {item.status}
            </Text>
          </View>
        )}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  screen: { padding: 14, gap: 8 },
  title: { fontSize: 24, fontWeight: '800', color: BRAND.text },
  subtitle: { color: BRAND.muted, marginBottom: 4 },
  sectionTitle: { fontWeight: '700', color: BRAND.text, marginBottom: 6 },
  card: {
    backgroundColor: BRAND.white,
    borderRadius: 12,
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: '#EAECF0',
    shadowColor: '#101828',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    paddingHorizontal: 10,
    paddingVertical: 10,
    color: BRAND.text,
  },
  button: { backgroundColor: BRAND.primary, borderRadius: 10, alignItems: 'center', paddingVertical: 10 },
  buttonText: { color: BRAND.white, fontWeight: '700' },
  note: { color: BRAND.muted, fontSize: 12 },
  row: {
    backgroundColor: BRAND.white,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#EAECF0',
  },
  rowTitle: { color: BRAND.text, fontWeight: '600' },
  rowMeta: { color: BRAND.muted, fontSize: 12 },
})


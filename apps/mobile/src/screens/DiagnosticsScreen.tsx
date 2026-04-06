import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useSip } from '../context/SipContext';
import { getVoiceExtension } from '../api/client';
import { HeaderBar } from '../components/HeaderBar';
import type { VoiceExtension } from '../types';
import { typography } from '../theme/typography';
import { spacing, radius } from '../theme/spacing';

const PROVISION_KEY = 'cc_mobile_provision';

type RowProps = {
  label: string;
  value: string;
  ok?: boolean;
  warn?: boolean;
  danger?: boolean;
};

function DiagRow({ label, value, ok, warn, danger }: RowProps) {
  const { colors } = useTheme();
  const color = danger
    ? colors.danger
    : ok
    ? colors.successText
    : warn
    ? colors.warningText
    : colors.textSecondary;

  return (
    <View style={[styles.row, { borderBottomColor: colors.borderSubtle }]}>
      <Text style={[typography.labelLg, { color: colors.text, flex: 1 }]}>{label}</Text>
      <Text
        style={[typography.mono, { color, maxWidth: '60%', textAlign: 'right' }]}
        numberOfLines={2}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <>
      <Text style={[typography.h4, { color: colors.text, marginTop: spacing['4'], marginBottom: spacing['2'] }]}>
        {title}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {children}
      </View>
    </>
  );
}

export function DiagnosticsScreen() {
  const { colors } = useTheme();
  const { token } = useAuth();
  const sip = useSip();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  const [voice, setVoice] = useState<VoiceExtension | null>(null);
  const [loading, setLoading] = useState(false);
  const [provBundle, setProvBundle] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!token) return;
      setLoading(true);
      Promise.all([
        getVoiceExtension(token).then(setVoice).catch(() => {}),
        SecureStore.getItemAsync(PROVISION_KEY).then(setProvBundle).catch(() => {}),
      ]).finally(() => setLoading(false));
    }, [token]),
  );

  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://app.connectcomunications.com/api';

  const callStateColor = (s: string) => {
    if (s === 'connected') return colors.successText;
    if (s === 'dialing' || s === 'ringing') return colors.warningText;
    if (s === 'ended') return colors.danger;
    return colors.textSecondary;
  };

  const parsedBundle = (() => {
    try {
      return provBundle ? JSON.parse(provBundle) : null;
    } catch {
      return null;
    }
  })();

  const handleClearProvisioning = () => {
    Alert.alert(
      'Clear Provisioning',
      'This will remove your SIP credentials and require re-provisioning via QR code.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await SecureStore.deleteItemAsync(PROVISION_KEY);
            setProvBundle(null);
            await sip.unregister();
          },
        },
      ],
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <HeaderBar title="Diagnostics" showBack onBack={() => nav.goBack()} />

      {loading ? (
        <View style={styles.loader}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing['4'], paddingBottom: insets.bottom + spacing['8'] }}
          showsVerticalScrollIndicator={false}
        >
          {/* ── SIP Registration ── */}
          <Section title="SIP Registration">
            <DiagRow
              label="State"
              value={sip.registrationState}
              ok={sip.registrationState === 'registered'}
              warn={sip.registrationState === 'registering'}
              danger={sip.registrationState === 'failed'}
            />
            <DiagRow
              label="Provisioned"
              value={sip.hasProvisioning ? 'Yes' : 'No'}
              ok={sip.hasProvisioning}
              warn={!sip.hasProvisioning}
            />
            {sip.lastError ? (
              <DiagRow label="Last Error" value={sip.lastError} danger />
            ) : null}
          </Section>

          {/* ── Active Call ── */}
          <Section title="Active Call">
            <DiagRow
              label="Call State"
              value={sip.callState}
              ok={sip.callState === 'connected'}
              warn={sip.callState === 'dialing' || sip.callState === 'ringing'}
            />
            <DiagRow
              label="Remote Party"
              value={sip.remoteParty || '—'}
            />
            <DiagRow label="Muted" value={sip.muted ? 'Yes' : 'No'} warn={sip.muted} />
            <DiagRow label="Speaker" value={sip.speakerOn ? 'On' : 'Off'} />
            <DiagRow label="On Hold" value={sip.onHold ? 'Yes' : 'No'} warn={sip.onHold} />
          </Section>

          {/* ── Extension (from API) ── */}
          <Section title="Extension (Server)">
            <DiagRow label="Extension #" value={voice?.extensionNumber || '—'} />
            <DiagRow label="Display Name" value={voice?.displayName || '—'} />
            <DiagRow label="SIP Username" value={voice?.sipUsername || '—'} />
            <DiagRow
              label="SIP Password Set"
              value={voice?.hasSipPassword ? 'Yes' : 'No'}
              ok={voice?.hasSipPassword}
              warn={!voice?.hasSipPassword}
            />
            <DiagRow
              label="WebRTC"
              value={voice?.webrtcEnabled ? 'Enabled' : 'Disabled'}
              ok={voice?.webrtcEnabled}
              warn={!voice?.webrtcEnabled}
            />
          </Section>

          {/* ── Provisioning Bundle (stored on device) ── */}
          <Section title="Provisioning Bundle (Device)">
            <DiagRow label="WSS URL" value={parsedBundle?.sipWsUrl || '—'} ok={!!parsedBundle?.sipWsUrl} />
            <DiagRow label="SIP Domain" value={parsedBundle?.sipDomain || '—'} ok={!!parsedBundle?.sipDomain} />
            <DiagRow label="SIP Username" value={parsedBundle?.sipUsername || '—'} />
            <DiagRow label="Outbound Proxy" value={parsedBundle?.outboundProxy || 'None'} />
            <DiagRow
              label="ICE Servers"
              value={parsedBundle?.iceServers?.length ? `${parsedBundle.iceServers.length} configured` : 'None'}
              ok={(parsedBundle?.iceServers?.length ?? 0) > 0}
            />
            <DiagRow label="DTMF Mode" value={parsedBundle?.dtmfMode || '—'} />
          </Section>

          {/* ── App Info ── */}
          <Section title="App Info">
            <DiagRow label="App Version" value={String(Constants.expoConfig?.version || '1.0.0')} />
            <DiagRow label="API Base" value={apiBase} />
            <DiagRow
              label="Voice Simulate"
              value={process.env.EXPO_PUBLIC_VOICE_SIMULATE === 'true' ? 'ON ⚠' : 'OFF'}
              warn={process.env.EXPO_PUBLIC_VOICE_SIMULATE === 'true'}
            />
          </Section>

          {/* ── Actions ── */}
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: colors.primary, marginTop: spacing['5'] }]}
            onPress={() => sip.register()}
            activeOpacity={0.85}
          >
            <Ionicons name="refresh" size={18} color="#fff" style={{ marginRight: 8 }} />
            <Text style={[typography.labelLg, { color: '#fff' }]}>Re-register</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.btn, { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: 1, marginTop: spacing['3'] }]}
            onPress={() => {
              if (token) {
                setLoading(true);
                getVoiceExtension(token)
                  .then(setVoice)
                  .catch(() => {})
                  .finally(() => setLoading(false));
              }
            }}
            activeOpacity={0.85}
          >
            <Ionicons name="cloud-download-outline" size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[typography.labelLg, { color: colors.primary }]}>Reload Extension Data</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.btn, { backgroundColor: 'rgba(239,68,68,0.1)', borderColor: 'rgba(239,68,68,0.3)', borderWidth: 1, marginTop: spacing['3'] }]}
            onPress={handleClearProvisioning}
            activeOpacity={0.85}
          >
            <Ionicons name="trash-outline" size={18} color={colors.danger} style={{ marginRight: 8 }} />
            <Text style={[typography.labelLg, { color: colors.danger }]}>Clear Provisioning</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: spacing['2'],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['4'],
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  btn: {
    height: 50,
    borderRadius: radius['2xl'],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

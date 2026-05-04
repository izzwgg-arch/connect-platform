import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useSip } from '../context/SipContext';
import { useIncomingNotifications } from '../context/NotificationsContext';
import { getMyMobileDevices, getVoiceExtension, getWakeTimeline, type MobileDeviceDiagnostics, type WakeTimelineEvent } from '../api/client';
import { HeaderBar } from '../components/HeaderBar';
import type { VoiceExtension } from '../types';
import { typography } from '../theme/typography';
import { spacing, radius } from '../theme/spacing';
import {
  describeChannelImportance,
  formatTimestamp,
  getCallWakeDeviceInfo,
  getCallWakeNativeState,
  getCallWakePermissionState,
  isSamsungDevice,
  requestFullScreenIntentPermission,
  type CallWakeDeviceInfo,
  type CallWakeNativeState,
  type CallWakePermissionState,
} from '../diagnostics/callWakeDiagnostics';

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
  const notifications = useIncomingNotifications();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  const [voice, setVoice] = useState<VoiceExtension | null>(null);
  const [loading, setLoading] = useState(false);
  const [provBundle, setProvBundle] = useState<string | null>(null);

  // ── Call Wake (Android) state ─────────────────────────────────────────────
  const [wakeDeviceInfo] = useState<CallWakeDeviceInfo>(() => getCallWakeDeviceInfo());
  const [wakeState, setWakeState] = useState<CallWakeNativeState>(() => getCallWakeNativeState());
  const [wakePerms, setWakePerms] = useState<CallWakePermissionState>({
    notificationsEnabled: null,
    canUseFullScreenIntent: null,
    callChannelImportance: null,
    batteryOptimizationIgnored: null,
  });
  const [wakeBackend, setWakeBackend] = useState<MobileDeviceDiagnostics[]>([]);
  const [wakeTimeline, setWakeTimeline] = useState<WakeTimelineEvent[]>([]);
  const [wakeRefreshing, setWakeRefreshing] = useState(false);

  const refreshCallWake = useCallback(async () => {
    setWakeRefreshing(true);
    try {
      setWakeState(getCallWakeNativeState());
      const [perms, devices, timeline] = await Promise.all([
        getCallWakePermissionState(),
        token
          ? getMyMobileDevices(token).catch(() => ({ devices: [] }))
          : Promise.resolve({ devices: [] }),
        token
          ? getWakeTimeline(token, { limit: 50 }).catch(() => ({ events: [] as WakeTimelineEvent[] }))
          : Promise.resolve({ events: [] as WakeTimelineEvent[] }),
      ]);
      setWakePerms(perms);
      setWakeBackend(devices.devices ?? []);
      setWakeTimeline(timeline.events ?? []);
    } finally {
      setWakeRefreshing(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      if (!token) return;
        setLoading(true);
      Promise.all([
        getVoiceExtension(token).then(setVoice).catch(() => {}),
        SecureStore.getItemAsync(PROVISION_KEY).then(setProvBundle).catch(() => {}),
        refreshCallWake(),
      ]).finally(() => setLoading(false));
    }, [token, refreshCallWake]),
  );

  // Refresh native state every 5 seconds while screen is open so a missed-call
  // test can be observed live without leaving the screen.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const id = setInterval(() => {
      setWakeState(getCallWakeNativeState());
    }, 5000);
    return () => clearInterval(id);
  }, []);

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
          bounces={false}
          alwaysBounceVertical={false}
          overScrollMode="never"
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

          {/* ── ICE / TURN ── */}
          <Section title="ICE / TURN">
            {(() => {
              const iceServers: any[] = parsedBundle?.iceServers ?? [];
              const hasTurn = iceServers.some((s: any) => {
                const urls: string[] = Array.isArray(s.urls) ? s.urls : [s.urls];
                return urls.some((u: string) => u?.startsWith('turn:') || u?.startsWith('turns:'));
              });
              const hasStun = iceServers.some((s: any) => {
                const urls: string[] = Array.isArray(s.urls) ? s.urls : [s.urls];
                return urls.some((u: string) => u?.startsWith('stun:'));
              });
              const turnServers = iceServers.filter((s: any) => {
                const urls: string[] = Array.isArray(s.urls) ? s.urls : [s.urls];
                return urls.some((u: string) => u?.startsWith('turn:') || u?.startsWith('turns:'));
              });
              return (
                <>
                  <DiagRow
                    label="TURN Configured"
                    value={hasTurn ? 'Yes' : 'No — audio may fail behind strict NAT'}
                    ok={hasTurn}
                    warn={!hasTurn}
                  />
                  <DiagRow
                    label="STUN Configured"
                    value={hasStun ? 'Yes' : 'No'}
                    ok={hasStun}
                    warn={!hasStun}
                  />
                  {hasTurn && (
                    <DiagRow
                      label="TURN Credential"
                      value={turnServers[0]?.username ? 'Present' : 'Missing — anonymous TURN'}
                      ok={!!turnServers[0]?.username}
                      warn={!turnServers[0]?.username}
                    />
                  )}
                  <DiagRow
                    label="Total ICE Servers"
                    value={iceServers.length ? String(iceServers.length) : '0 — fallback only'}
                    ok={iceServers.length > 0}
                    warn={iceServers.length === 0}
                  />
                </>
              );
            })()}
          </Section>

          {/* ── Phone Readiness ── */}
          <Section title="Phone Readiness">
            {(() => {
              const iceServers: any[] = parsedBundle?.iceServers ?? [];
              const hasTurn = iceServers.some((s: any) => {
                const urls: string[] = Array.isArray(s.urls) ? s.urls : [s.urls];
                return urls.some((u: string) => u?.startsWith('turn:') || u?.startsWith('turns:'));
              });
              const checks = [
                { label: 'SIP Registered', pass: sip.registrationState === 'registered' },
                { label: 'Provisioning Loaded', pass: sip.hasProvisioning },
                { label: 'WSS URL set', pass: !!parsedBundle?.sipWsUrl },
                { label: 'SIP Domain set', pass: !!parsedBundle?.sipDomain },
                { label: 'TURN configured', pass: hasTurn, warn: true },
                { label: 'SIP Password set (server)', pass: !!voice?.hasSipPassword },
                { label: 'WebRTC enabled (server)', pass: !!voice?.webrtcEnabled },
              ];
              const passed = checks.filter((c) => c.pass).length;
              const required = checks.filter((c) => !c.warn).length;
              const requiredPassed = checks.filter((c) => !c.warn && c.pass).length;
              const ready = requiredPassed === required;
              return (
                <>
                  <DiagRow
                    label="Overall Status"
                    value={ready ? `READY (${passed}/${checks.length})` : `NOT READY (${passed}/${checks.length})`}
                    ok={ready}
                    warn={!ready}
                  />
                  {checks.map((c) => (
                    <DiagRow
                      key={c.label}
                      label={c.label}
                      value={c.pass ? '✓' : c.warn ? '⚠ recommended' : '✕'}
                      ok={c.pass}
                      warn={!c.pass && c.warn}
                      danger={!c.pass && !c.warn}
                    />
                  ))}
                </>
              );
            })()}
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

          {/* ── Call Wake (Android) ── */}
          {Platform.OS === 'android' && (
            <>
              <Section title="Call Wake — Device">
                <DiagRow
                  label="Manufacturer"
                  value={wakeDeviceInfo.manufacturer || '—'}
                />
                <DiagRow label="Model" value={wakeDeviceInfo.model || '—'} />
                <DiagRow
                  label="Android Version"
                  value={wakeDeviceInfo.osVersion ? `${wakeDeviceInfo.osVersion} (SDK ${wakeDeviceInfo.sdkInt})` : '—'}
                />
                <DiagRow
                  label="App Version"
                  value={
                    wakeDeviceInfo.appVersion
                      ? `${wakeDeviceInfo.appVersion}${wakeDeviceInfo.appBuild ? ` (${wakeDeviceInfo.appBuild})` : ''}`
                      : String(Constants.expoConfig?.version || '—')
                  }
                />
                {isSamsungDevice(wakeDeviceInfo) && (
                  <DiagRow
                    label="Samsung Notes"
                    value="Battery + Sleeping Apps must be off (see button below)"
                    warn
                  />
                )}
              </Section>

              <Section title="Call Wake — Permissions">
                <DiagRow
                  label="Notifications"
                  value={
                    wakePerms.notificationsEnabled === null
                      ? 'unknown'
                      : wakePerms.notificationsEnabled
                        ? 'Allowed'
                        : 'Blocked — calls will not ring'
                  }
                  ok={wakePerms.notificationsEnabled === true}
                  danger={wakePerms.notificationsEnabled === false}
                />
                <DiagRow
                  label="Full-Screen Intent"
                  value={
                    wakePerms.canUseFullScreenIntent === null
                      ? 'unknown'
                      : wakePerms.canUseFullScreenIntent
                        ? 'Allowed'
                        : 'Revoked — call screen will not appear over lock'
                  }
                  ok={wakePerms.canUseFullScreenIntent === true}
                  danger={wakePerms.canUseFullScreenIntent === false}
                />
                <DiagRow
                  label="Battery Optimization"
                  value={
                    wakePerms.batteryOptimizationIgnored === null
                      ? 'unknown'
                      : wakePerms.batteryOptimizationIgnored
                        ? 'Ignored (good)'
                        : 'Active — Doze can delay or block call wake'
                  }
                  ok={wakePerms.batteryOptimizationIgnored === true}
                  warn={wakePerms.batteryOptimizationIgnored === false}
                />
                <DiagRow
                  label="Call Channel Importance"
                  value={describeChannelImportance(wakePerms.callChannelImportance)}
                  ok={wakePerms.callChannelImportance != null && wakePerms.callChannelImportance >= 4}
                  warn={
                    wakePerms.callChannelImportance != null &&
                    wakePerms.callChannelImportance >= 0 &&
                    wakePerms.callChannelImportance < 4
                  }
                />
              </Section>

              <Section title="Call Wake — Last Push (this device)">
                <DiagRow
                  label="FCM Push Received"
                  value={formatTimestamp(wakeState.lastPushReceivedAtMs)}
                  ok={wakeState.lastPushReceivedAtMs > 0}
                />
                <DiagRow
                  label="Push Type"
                  value={wakeState.lastPushType || '—'}
                />
                <DiagRow
                  label="Process State at Push"
                  value={wakeState.lastPushReceivedAppState || '—'}
                />
                <DiagRow
                  label="Incoming UI Posted"
                  value={formatTimestamp(wakeState.lastIncomingUiDisplayedAtMs)}
                  ok={wakeState.lastIncomingUiDisplayedAtMs > 0}
                  warn={
                    wakeState.lastPushReceivedAtMs > 0 &&
                    wakeState.lastIncomingUiDisplayedAtMs === 0
                  }
                />
                <DiagRow
                  label="Presentation"
                  value={wakeState.lastIncomingUiPresentation || '—'}
                />
                <DiagRow
                  label="Ringtone Started"
                  value={formatTimestamp(wakeState.ringtoneStartedAtMs)}
                />
                <DiagRow
                  label="Ringtone Stopped"
                  value={
                    wakeState.ringtoneStoppedAtMs > 0
                      ? `${formatTimestamp(wakeState.ringtoneStoppedAtMs)} (${wakeState.ringtoneStopReason || 'n/a'})`
                      : '—'
                  }
                />
                {wakeState.lastPushError ? (
                  <DiagRow label="Last Error" value={wakeState.lastPushError} danger />
                ) : null}
              </Section>

              <Section title="Call Wake — Backend View">
                {wakeBackend.length === 0 ? (
                  <DiagRow label="Devices" value="None registered yet" warn />
                ) : (
                  wakeBackend.map((d, idx) => (
                    <View key={d.id}>
                      <DiagRow
                        label={`Device #${idx + 1}`}
                        value={`${d.platform} ${d.model || d.deviceName || ''}`.trim()}
                      />
                      <DiagRow
                        label="Active"
                        value={d.active ? 'Yes' : 'No'}
                        ok={d.active}
                        warn={!d.active}
                      />
                      <DiagRow
                        label="Last Push Sent"
                        value={
                          d.lastPushSentAt
                            ? `${formatTimestamp(new Date(d.lastPushSentAt).getTime())}${d.lastPushType ? ` (${d.lastPushType})` : ''}`
                            : 'Never'
                        }
                        ok={!!d.lastPushSentAt}
                      />
                      <DiagRow
                        label="Push Status"
                        value={d.lastPushStatus || '—'}
                        ok={d.lastPushStatus === 'ok' || d.lastPushStatus === 'queued'}
                        danger={
                          !!d.lastPushStatus &&
                          d.lastPushStatus !== 'ok' &&
                          d.lastPushStatus !== 'queued'
                        }
                      />
                      {d.lastPushError ? (
                        <DiagRow label="Push Error" value={d.lastPushError} danger />
                      ) : null}
                      <DiagRow
                        label="Token Tail"
                        value={d.expoPushTokenTail}
                      />
                    </View>
                  ))
                )}
              </Section>

              {/* Push-wake (Option 2) native receipt — fires only when an
                  INCOMING_CALL_WAKE FCM data message reached the device. */}
              <Section title="Call Wake — Push-Wake (Option 2)">
                <DiagRow
                  label="Last Wake Push"
                  value={
                    wakeState.lastWakePushReceivedAtMs > 0
                      ? formatTimestamp(wakeState.lastWakePushReceivedAtMs)
                      : 'Never'
                  }
                  ok={wakeState.lastWakePushReceivedAtMs > 0}
                  warn={wakeState.lastWakePushReceivedAtMs === 0}
                />
                <DiagRow
                  label="pbxCallId"
                  value={wakeState.lastWakePushPbxCallId || '—'}
                />
                <DiagRow
                  label="Target Extension"
                  value={wakeState.lastWakePushExtension || '—'}
                />
                <DiagRow
                  label="JS Bridge Emitted"
                  value={
                    wakeState.lastWakeBridgeEmittedAtMs > 0
                      ? `${formatTimestamp(wakeState.lastWakeBridgeEmittedAtMs)} (${wakeState.lastWakeBridgeStatus || 'unknown'})`
                      : '—'
                  }
                  ok={wakeState.lastWakeBridgeStatus === 'emitted_to_js'}
                  warn={
                    !!wakeState.lastWakeBridgeStatus &&
                    wakeState.lastWakeBridgeStatus !== 'emitted_to_js'
                  }
                />
              </Section>

              {/* Stage 2 — SipKeepAliveService FGS state. The single most
                  diagnostic surface for "calls don't ring on backgrounded
                  S25". keepAliveIsRunning=false + keepAliveLastForegroundResult
                  ="threw" + keepAliveLastForegroundErrorClass tells us
                  exactly which Android 15 / OEM rule killed the FGS. */}
              <Section title="Call Wake — SIP Keep-Alive Service">
                <DiagRow
                  label="Service Running"
                  value={wakeState.keepAliveIsRunning ? 'Yes' : 'No'}
                  ok={wakeState.keepAliveIsRunning}
                  warn={!wakeState.keepAliveIsRunning}
                />
                <DiagRow
                  label="Service Created"
                  value={
                    wakeState.keepAliveServiceCreatedAtMs > 0
                      ? formatTimestamp(wakeState.keepAliveServiceCreatedAtMs)
                      : 'Never'
                  }
                />
                <DiagRow
                  label="Last Start Attempt"
                  value={
                    wakeState.keepAliveLastStartAttemptAtMs > 0
                      ? `${formatTimestamp(wakeState.keepAliveLastStartAttemptAtMs)} (${wakeState.keepAliveLastStartResult || 'n/a'})`
                      : '—'
                  }
                  ok={wakeState.keepAliveLastStartResult === 'dispatched'}
                  warn={wakeState.keepAliveLastStartResult === 'threw'}
                />
                {wakeState.keepAliveLastStartErrorClass ? (
                  <DiagRow
                    label="Start Error"
                    value={`${wakeState.keepAliveLastStartErrorClass}: ${wakeState.keepAliveLastStartErrorMessage || ''}`}
                    warn
                  />
                ) : null}
                <DiagRow
                  label="Last Foreground Attempt"
                  value={
                    wakeState.keepAliveLastForegroundAttemptAtMs > 0
                      ? `${formatTimestamp(wakeState.keepAliveLastForegroundAttemptAtMs)} (${wakeState.keepAliveLastForegroundResult || 'n/a'} via ${wakeState.keepAliveLastForegroundTypeUsed || 'n/a'})`
                      : '—'
                  }
                  ok={wakeState.keepAliveLastForegroundResult === 'ok'}
                  warn={wakeState.keepAliveLastForegroundResult === 'threw'}
                />
                {wakeState.keepAliveLastForegroundErrorClass ? (
                  <DiagRow
                    label="Foreground Error"
                    value={`${wakeState.keepAliveLastForegroundErrorClass}: ${wakeState.keepAliveLastForegroundErrorMessage || ''}`}
                    warn
                  />
                ) : null}
              </Section>

              {/* Wake Timeline — full event sequence from backend. Useful when
                  user calls and we want to see every step end-to-end. */}
              <Section title="Call Wake — Timeline (latest 50)">
                {wakeTimeline.length === 0 ? (
                  <DiagRow label="Events" value="No wake events recorded yet" warn />
                ) : (
                  wakeTimeline.slice(0, 50).map((ev) => (
                    <View key={ev.id}>
                      <DiagRow
                        label={ev.stage}
                        value={
                          `${formatTimestamp(new Date(ev.occurredAt).getTime())}` +
                          (ev.latencyMs != null ? ` (+${ev.latencyMs}ms)` : '') +
                          ` [${ev.source}]` +
                          (ev.pbxCallId ? ` ${ev.pbxCallId.slice(-10)}` : '')
                        }
                        ok={ev.stage.endsWith('COMPLETE') || ev.stage === 'WAKE_PUSH_DELIVERED'}
                        warn={ev.stage.endsWith('TRIGGERED') || ev.stage === 'WAKE_REQUESTED'}
                        danger={ev.stage.endsWith('FAILED') || ev.stage.endsWith('NOT_FOUND') || ev.stage === 'WAKE_PUSH_FAILED'}
                      />
                    </View>
                  ))
                )}
              </Section>

              {/* Quick fix actions for the most common Samsung S25 wake regressions. */}
              <TouchableOpacity
                style={[
                  styles.btn,
                  {
                    backgroundColor: colors.surfaceElevated,
                    borderColor: colors.border,
                    borderWidth: 1,
                    marginTop: spacing['3'],
                  },
                ]}
                onPress={refreshCallWake}
                activeOpacity={0.85}
                disabled={wakeRefreshing}
              >
                <Ionicons
                  name="refresh"
                  size={18}
                  color={colors.primary}
                  style={{ marginRight: 8 }}
                />
                <Text style={[typography.labelLg, { color: colors.primary }]}>
                  {wakeRefreshing ? 'Refreshing…' : 'Refresh Call Wake Diagnostics'}
                </Text>
              </TouchableOpacity>

              {wakePerms.canUseFullScreenIntent === false && (
                <TouchableOpacity
                  style={[
                    styles.btn,
                    {
                      backgroundColor: 'rgba(245,158,11,0.12)',
                      borderColor: 'rgba(245,158,11,0.4)',
                      borderWidth: 1,
                      marginTop: spacing['3'],
                    },
                  ]}
                  onPress={async () => {
                    await requestFullScreenIntentPermission();
                    setTimeout(refreshCallWake, 500);
                  }}
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name="warning-outline"
                    size={18}
                    color={colors.warningText}
                    style={{ marginRight: 8 }}
                  />
                  <Text style={[typography.labelLg, { color: colors.warningText }]}>
                    Allow Full-Screen Notifications
                  </Text>
                </TouchableOpacity>
              )}

              {wakePerms.batteryOptimizationIgnored === false && (
                <TouchableOpacity
                  style={[
                    styles.btn,
                    {
                      backgroundColor: 'rgba(245,158,11,0.12)',
                      borderColor: 'rgba(245,158,11,0.4)',
                      borderWidth: 1,
                      marginTop: spacing['3'],
                    },
                  ]}
                  onPress={async () => {
                    await notifications.openBatteryOptimizationSettings();
                    setTimeout(refreshCallWake, 500);
                  }}
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name="battery-charging-outline"
                    size={18}
                    color={colors.warningText}
                    style={{ marginRight: 8 }}
                  />
                  <Text style={[typography.labelLg, { color: colors.warningText }]}>
                    Fix Battery / Sleeping Apps
                  </Text>
                </TouchableOpacity>
                )}
              </>
          )}

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

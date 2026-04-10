import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Switch,
  Alert,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useSip } from '../context/SipContext';
import { useIncomingNotifications, type CallReadiness } from '../context/NotificationsContext';
import { Avatar } from '../components/ui/Avatar';
import { HeaderBar } from '../components/HeaderBar';
import { getVoiceExtension } from '../api/client';
import type { VoiceExtension } from '../types';
import { typography } from '../theme/typography';
import { spacing, radius } from '../theme/spacing';

function SettingRow({
  icon,
  iconColor,
  label,
  value,
  onPress,
  rightElement,
  destructive,
  disabled,
  subtitle,
}: {
  icon: string;
  iconColor?: string;
  label: string;
  value?: string;
  onPress?: () => void;
  rightElement?: React.ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  subtitle?: string;
}) {
  const { colors } = useTheme();
  const color = destructive ? colors.danger : iconColor ?? colors.primary;

  return (
    <TouchableOpacity
      style={[styles.settingRow, { borderBottomColor: colors.borderSubtle, opacity: disabled ? 0.5 : 1 }]}
      onPress={onPress}
      disabled={disabled || !onPress}
      activeOpacity={onPress ? 0.7 : 1}
    >
      <View style={[styles.settingIcon, { backgroundColor: color + '18' }]}>
        <Ionicons name={icon as any} size={18} color={color} />
      </View>
      <View style={styles.settingLabel}>
        <Text style={[typography.labelLg, { color: destructive ? colors.danger : colors.text }]}>
          {label}
        </Text>
        {subtitle && (
          <Text style={[typography.caption, { color: colors.textTertiary }]}>{subtitle}</Text>
        )}
      </View>
      <View style={styles.settingRight}>
        {value && (
          <Text style={[typography.body, { color: colors.textSecondary, marginRight: 6 }]} numberOfLines={1}>
            {value}
          </Text>
        )}
        {rightElement}
        {onPress && !rightElement && (
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        )}
      </View>
    </TouchableOpacity>
  );
}

function SectionHeader({ title }: { title: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.sectionHeader, { borderBottomColor: colors.border }]}>
      <Text style={[typography.labelSm, { color: colors.textTertiary, letterSpacing: 1 }]}>
        {title.toUpperCase()}
      </Text>
    </View>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {children}
    </View>
  );
}

export function SettingsScreen() {
  const { colors, mode, setMode, isDark } = useTheme();
  const { token, logout } = useAuth();
  const sip = useSip();
  const {
    callReadiness,
    openBatteryOptimizationSettings,
    requestNotificationPermission,
  } = useIncomingNotifications();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  const [voice, setVoice] = useState<VoiceExtension | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!token) return;
      getVoiceExtension(token).then(setVoice).catch(() => {});
    }, [token])
  );

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await sip.unregister().catch(() => {});
          await logout();
        },
      },
    ]);
  };

  const handleReprovision = () => {
    nav.navigate('QrProvision');
  };

  const themeLabel = mode === 'dark' ? 'Dark' : mode === 'light' ? 'Light' : 'System';

  const cycleTheme = () => {
    const next: Record<string, 'dark' | 'light' | 'system'> = {
      dark: 'light',
      light: 'system',
      system: 'dark',
    };
    setMode(next[mode] ?? 'dark');
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <HeaderBar
        title="Settings"
        showBack
        onBack={() => nav.goBack()}
      />

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing['8'], padding: spacing['4'] }}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile */}
        <View style={[styles.profileCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Avatar name={voice?.displayName || 'Connect User'} size="xl" />
          <View style={styles.profileInfo}>
            <Text style={[typography.h2, { color: colors.text }]}>
              {voice?.displayName || 'Connect User'}
            </Text>
            {voice?.extensionNumber && (
              <Text style={[typography.body, { color: colors.textSecondary }]}>
                Extension {voice.extensionNumber}
              </Text>
            )}
            <View style={[styles.regBadge, { backgroundColor: sip.registrationState === 'registered' ? colors.successMuted : colors.dangerMuted, borderColor: (sip.registrationState === 'registered' ? colors.success : colors.danger) + '50' }]}>
              <View style={[styles.regDot, { backgroundColor: sip.registrationState === 'registered' ? colors.success : colors.danger }]} />
              <Text style={[typography.labelSm, { color: sip.registrationState === 'registered' ? colors.successText : colors.dangerText }]}>
                {sip.registrationState === 'registered' ? 'Registered' : 'Not Registered'}
              </Text>
            </View>
          </View>
        </View>

        {/* Account */}
        <SectionHeader title="Account" />
        <SectionCard>
          <SettingRow
            icon="person-outline"
            label="Display Name"
            value={voice?.displayName || '—'}
            iconColor={colors.primary}
          />
          <SettingRow
            icon="call-outline"
            label="Extension"
            value={voice?.extensionNumber ? `Ext ${voice.extensionNumber}` : '—'}
            iconColor={colors.teal}
          />
          <SettingRow
            icon="server-outline"
            label="SIP Domain"
            value={voice?.sipDomain || '—'}
            iconColor={colors.indigo}
          />
        </SectionCard>

        {/* Phone setup */}
        <SectionHeader title="Phone Setup" />
        <SectionCard>
          <SettingRow
            icon="phone-portrait-outline"
            label="Re-provision Device"
            subtitle="Scan a new QR code to update extension"
            iconColor={colors.primary}
            onPress={handleReprovision}
          />
          <SettingRow
            icon="refresh-outline"
            label="Re-register"
            subtitle="Reconnect to the PBX"
            iconColor={colors.teal}
            onPress={() => sip.register()}
          />
          <SettingRow
            icon="construct-outline"
            label="Connection Diagnostics"
            iconColor={colors.purple}
            onPress={() => nav.navigate('Diagnostics')}
          />
        </SectionCard>

        {/* Preferences */}
        <SectionHeader title="Preferences" />
        <SectionCard>
          <SettingRow
            icon="moon-outline"
            label="Theme"
            value={themeLabel}
            iconColor={colors.indigo}
            onPress={cycleTheme}
          />
          <SettingRow
            icon="notifications-outline"
            label="Notifications"
            iconColor={colors.warning}
            onPress={() => {}}
          />
          <SettingRow
            icon="volume-medium-outline"
            label="Ringtone"
            value="Default"
            iconColor={colors.teal}
            onPress={() => {}}
          />
          <SettingRow
            icon="phone-landscape-outline"
            label="Audio Route"
            value="Auto"
            iconColor={colors.success}
            onPress={() => {}}
          />
        </SectionCard>

        {/* About */}
        <SectionHeader title="About" />
        <SectionCard>
          <SettingRow
            icon="information-circle-outline"
            label="Version"
            value="1.0.0"
            iconColor={colors.textTertiary}
          />
          <SettingRow
            icon="shield-checkmark-outline"
            label="Security"
            subtitle="Tokens stored in secure device storage"
            iconColor={colors.success}
          />
        </SectionCard>

        {/* ── Call Readiness — Android only ─────────────────────────────── */}
        {Platform.OS === 'android' && (
          <>
            <SectionHeader title="Incoming Call Readiness" />

            {/* Overall status banner */}
            <View style={[
              styles.readinessBanner,
              {
                backgroundColor: callReadiness.isFullyReady
                  ? (isDark ? 'rgba(34,197,94,0.12)' : 'rgba(34,197,94,0.08)')
                  : (isDark ? 'rgba(234,179,8,0.12)' : 'rgba(234,179,8,0.08)'),
                borderColor: callReadiness.isFullyReady
                  ? 'rgba(34,197,94,0.3)'
                  : 'rgba(234,179,8,0.3)',
              },
            ]}>
              <Ionicons
                name={callReadiness.isFullyReady ? 'checkmark-circle' : 'warning'}
                size={20}
                color={callReadiness.isFullyReady ? colors.success : colors.warning}
              />
              <Text style={[typography.body, {
                color: callReadiness.isFullyReady ? colors.success : colors.warning,
                marginLeft: 10,
                flex: 1,
              }]}>
                {callReadiness.isFullyReady
                  ? 'Ready — calls will ring even when app is closed'
                  : 'Action needed — incoming calls may not ring reliably'}
              </Text>
            </View>

            <SectionCard>
              {/* 1. Notification permission */}
              <SettingRow
                icon="notifications-outline"
                label="Notification Permission"
                subtitle={
                  callReadiness.notificationPermission === 'granted'
                    ? 'Granted — call alerts will appear'
                    : 'Not granted — calls will not ring'
                }
                iconColor={callReadiness.notificationPermission === 'granted' ? colors.success : colors.danger}
                onPress={callReadiness.notificationPermission !== 'granted' ? requestNotificationPermission : undefined}
                rightElement={
                  <View style={[styles.statusChip, {
                    backgroundColor: callReadiness.notificationPermission === 'granted'
                      ? colors.successMuted : colors.dangerMuted,
                  }]}>
                    <Text style={[typography.labelSm, {
                      color: callReadiness.notificationPermission === 'granted'
                        ? colors.success : colors.danger,
                    }]}>
                      {callReadiness.notificationPermission === 'granted' ? '✓ Granted' : '✗ Denied'}
                    </Text>
                  </View>
                }
              />

              {/* 2. Push token registered */}
              <SettingRow
                icon="cloud-outline"
                label="Push Token"
                subtitle={
                  callReadiness.pushTokenRegistered
                    ? 'Registered — server can reach this device'
                    : 'Not registered — sign out and back in'
                }
                iconColor={callReadiness.pushTokenRegistered ? colors.success : colors.danger}
                rightElement={
                  <View style={[styles.statusChip, {
                    backgroundColor: callReadiness.pushTokenRegistered
                      ? colors.successMuted : colors.dangerMuted,
                  }]}>
                    <Text style={[typography.labelSm, {
                      color: callReadiness.pushTokenRegistered ? colors.success : colors.danger,
                    }]}>
                      {callReadiness.pushTokenRegistered ? '✓ OK' : '✗ Missing'}
                    </Text>
                  </View>
                }
              />

              {/* 3. Battery optimization */}
              <SettingRow
                icon="battery-half-outline"
                label="Battery Optimization"
                subtitle="Disable for Connect to ensure calls ring when app is closed"
                iconColor={colors.warning}
                onPress={() => {
                  Alert.alert(
                    'Disable Battery Optimization',
                    'Android may kill background tasks for Connect when battery optimization is on, preventing incoming calls from ringing.\n\nTap "Open Settings" and set Connect to "Don\'t optimize".',
                    [
                      { text: 'Later', style: 'cancel' },
                      { text: 'Open Settings', onPress: openBatteryOptimizationSettings },
                    ],
                  );
                }}
                rightElement={
                  <View style={[styles.statusChip, { backgroundColor: colors.warningMuted }]}>
                    <Text style={[typography.labelSm, { color: colors.warning }]}>
                      ⚠ Check
                    </Text>
                  </View>
                }
              />

              {/* 4. SIP registration */}
              <SettingRow
                icon="wifi-outline"
                label="SIP Registration"
                subtitle={
                  sip.registrationState === 'registered'
                    ? 'Connected to PBX'
                    : 'Not connected — check network or re-register'
                }
                iconColor={sip.registrationState === 'registered' ? colors.success : colors.danger}
                onPress={sip.registrationState !== 'registered' ? () => sip.register() : undefined}
                rightElement={
                  <View style={[styles.statusChip, {
                    backgroundColor: sip.registrationState === 'registered'
                      ? colors.successMuted : colors.dangerMuted,
                  }]}>
                    <Text style={[typography.labelSm, {
                      color: sip.registrationState === 'registered' ? colors.success : colors.danger,
                    }]}>
                      {sip.registrationState === 'registered' ? '✓ OK' : '✗ Offline'}
                    </Text>
                  </View>
                }
              />
            </SectionCard>
          </>
        )}

        {/* Danger zone */}
        <SectionHeader title="Account" />
        <SectionCard>
          <SettingRow
            icon="log-out-outline"
            label="Sign Out"
            onPress={handleLogout}
            destructive
          />
        </SectionCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.xl,
    borderWidth: 1,
    padding: spacing['5'],
    marginBottom: spacing['2'],
    gap: 16,
  },
  profileInfo: { flex: 1, gap: 4 },
  regBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
    marginTop: 4,
    gap: 5,
  },
  regDot: { width: 6, height: 6, borderRadius: 3 },
  sectionHeader: {
    paddingVertical: spacing['2'],
    marginTop: spacing['4'],
    marginBottom: spacing['1'],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionCard: {
    borderRadius: radius.xl,
    borderWidth: 1,
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['4'],
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  settingIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  settingLabel: { flex: 1, gap: 2 },
  settingRight: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '40%',
  },
  statusChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  readinessBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
});

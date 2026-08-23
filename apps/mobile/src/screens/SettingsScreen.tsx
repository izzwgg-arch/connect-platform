import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Linking,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../context/ThemeContext';
// iOS alternate app icons (2026-08-23 icon refinement): 'Navy' vs the default
// light blue. ⛔ iOS-ONLY — android/ is bare so the plugin's activity-aliases
// never land there; the row is Platform-gated below.
import { setAlternateAppIcon, resetAppIcon, getAppIconName, supportsAlternateIcons } from 'expo-alternate-app-icons';
import { useAuth } from '../context/AuthContext';
import { useSip } from '../context/SipContext';
import { useIncomingNotifications, type CallReadiness } from '../context/NotificationsContext';
import { Avatar } from '../components/ui/Avatar';
import { showAppAlert } from '../components/ui/appAlert';
import { HeaderBar } from '../components/HeaderBar';
import { useQueryClient } from '@tanstack/react-query';
import { getVoiceExtension, mobileQueryKeys } from '../api/client';
import {
  DEFAULT_MOBILE_RINGTONE_ID,
  getMobileIncomingRingtone,
  getMobileIncomingRingtoneLabel,
  setMobileIncomingRingtone,
  type MobileRingtoneId,
} from '../audio/ringtonePreferences';
import { applyIosRingtonePreference } from '../sip/callkeep';
import { DEFAULT_QUICK_REPLIES, getQuickReplies, setQuickReplies } from '../calls/quickReplies';
import {
  DEFAULT_LAUNCH_TAB,
  LAUNCH_TAB_OPTIONS,
  getLaunchTab,
  launchTabLabel,
  setLaunchTab,
  type LaunchTabId,
} from '../config/launchTab';
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
  const { colors, mode, setMode } = useTheme();
  const { token, logout } = useAuth();
  const sip = useSip();
  const {
    callReadiness,
    requestBatteryOptimizationExclusion,
    requestNotificationPermission,
    requestMicrophonePermission,
    refreshDeviceReadiness,
    retryPushTokenRegistration,
  } = useIncomingNotifications();

  const [retryingPushToken, setRetryingPushToken] = useState(false);
  // Current iOS app icon: null = default (light blue), 'Navy' = the dark one.
  const [appIconName, setAppIconName] = useState<string | null>(() => {
    try { return Platform.OS === 'ios' ? getAppIconName() : null; } catch { return null; }
  });
  const toggleAppIcon = async () => {
    try {
      if (appIconName === 'Navy') {
        await resetAppIcon();
        setAppIconName(null);
      } else {
        await setAlternateAppIcon('Navy');
        setAppIconName('Navy');
      }
    } catch {
      // iOS shows its own confirmation alert; a user cancelling it lands here. Nothing to do.
    }
  };
  const [incomingRingtone, setIncomingRingtoneId] =
    useState<MobileRingtoneId>(DEFAULT_MOBILE_RINGTONE_ID);
  const [launchTab, setLaunchTabState] = useState<LaunchTabId>(DEFAULT_LAUNCH_TAB);

  // Quick replies (decline-with-message). Drafts edit in place; persisted on
  // end-editing. Empty rows are dropped by setQuickReplies, so re-hydrate the
  // draft list from storage after each save.
  const [quickReplyDrafts, setQuickReplyDrafts] = useState<string[]>(DEFAULT_QUICK_REPLIES);
  const quickReplyDraftsRef = useRef(quickReplyDrafts);
  useEffect(() => { quickReplyDraftsRef.current = quickReplyDrafts; }, [quickReplyDrafts]);
  const persistQuickReplies = useCallback(async () => {
    try {
      await setQuickReplies(quickReplyDraftsRef.current);
      setQuickReplyDrafts(await getQuickReplies());
    } catch { /* keep drafts */ }
  }, []);

  const handleRetryPushToken = async () => {
    setRetryingPushToken(true);
    try {
      await retryPushTokenRegistration();
    } finally {
      setRetryingPushToken(false);
    }
  };

  const handleFixBatteryOptimization = async () => {
    // Fires the system Doze-exemption "Allow" dialog directly, then re-reads
    // the real status. No fake "opened" flag — the row reflects the OS truth.
    await requestBatteryOptimizationExclusion();
  };

  const handleRequestMicrophone = async () => {
    await requestMicrophonePermission();
  };

  // Deep-links into this app's own page in the OS Settings app (iOS: the
  // Connect page under Settings, with its "Notifications" row for sound /
  // banner / badge controls scoped to just this app; Android: the app-info
  // notification settings screen). This is the only App Store–safe way to
  // expose per-app notification sound controls — third-party apps cannot
  // present the system sound picker themselves.
  const handleOpenNotificationSettings = () => {
    Linking.openSettings().catch(() => {});
  };
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const queryClient = useQueryClient();

  // Seeded synchronously from the shared cache — see KeypadTab: starting from
  // null made this header show the placeholder name for a frame every time
  // Settings was opened, then swap to the real one.
  const [voice, setVoice] = useState<VoiceExtension | null>(
    () => queryClient.getQueryData<VoiceExtension>(mobileQueryKeys.voiceExtension) ?? null,
  );

  useFocusEffect(
    useCallback(() => {
      // Always re-read the live OS permission/battery state on focus so the
      // rows are never stale (independent of auth).
      refreshDeviceReadiness().catch(() => {});
      if (!token) return;
      queryClient
        .fetchQuery({
          queryKey: mobileQueryKeys.voiceExtension,
          queryFn: () => getVoiceExtension(token),
          staleTime: 5 * 60 * 1000,
        })
        .then(setVoice)
        .catch(() => {});
      getMobileIncomingRingtone().then(setIncomingRingtoneId).catch(() => {});
      getQuickReplies().then(setQuickReplyDrafts).catch(() => {});
      getLaunchTab().then(setLaunchTabState).catch(() => {});
    }, [queryClient, token, refreshDeviceReadiness])
  );

  const handleLogout = () => {
    showAppAlert('Sign Out', 'Are you sure you want to sign out?', [
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

  const themeLabel = mode === 'dark' ? 'Dark' : 'Light';

  const cycleTheme = () => {
    setMode(mode === 'dark' ? 'light' : 'dark');
  };

  const handleCycleIncomingRingtone = async () => {
    const options: MobileRingtoneId[] = ['connect-default', 'classic'];
    const currentIndex = options.indexOf(incomingRingtone);
    const nextId = options[(currentIndex + 1 + options.length) % options.length];
    await setMobileIncomingRingtone(nextId);
    setIncomingRingtoneId(nextId);
    // iOS ONLY: re-apply CallKit's ringtoneSound immediately so the new
    // preference takes effect on the very next call, not just after an app
    // restart. No-op on Android.
    void applyIosRingtonePreference(nextId);
  };

  const handleCycleLaunchTab = async () => {
    const idx = LAUNCH_TAB_OPTIONS.findIndex((o) => o.id === launchTab);
    const next = LAUNCH_TAB_OPTIONS[(idx + 1 + LAUNCH_TAB_OPTIONS.length) % LAUNCH_TAB_OPTIONS.length].id;
    await setLaunchTab(next);
    setLaunchTabState(next);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <HeaderBar
        title="Settings"
        showBack={nav.canGoBack?.() === true}
        onBack={() => nav.goBack()}
      />

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing['8'], padding: spacing['4'] }}
        showsVerticalScrollIndicator={false}
        bounces={false}
        alwaysBounceVertical={false}
        overScrollMode="never"
      >
        {/* Profile */}
        <View style={[styles.profileCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {/* Blank, not "Loopcom User", until the real name is known — the
              placeholder flashing for a frame on every visit read as a bug.
              Avatar renders a neutral person icon for an empty name. */}
          <Avatar name={voice?.displayName || ''} size="xl" />
          <View style={styles.profileInfo}>
            <Text style={[typography.h2, { color: colors.text }]}>
              {voice?.displayName || ''}
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
          {Platform.OS === 'ios' && supportsAlternateIcons && (
            <SettingRow
              icon="color-palette-outline"
              label="App icon"
              subtitle="The icon on your home screen"
              value={appIconName === 'Navy' ? 'Navy' : 'Light blue'}
              iconColor={colors.primary}
              onPress={toggleAppIcon}
            />
          )}
          <SettingRow
            icon="notifications-outline"
            label="Notifications"
            subtitle="Change notification sounds for this app"
            iconColor={colors.warning}
            onPress={handleOpenNotificationSettings}
          />
          <SettingRow
            icon="home-outline"
            label="Launch Screen"
            subtitle="Which screen the app opens on"
            value={launchTabLabel(launchTab)}
            iconColor={colors.primary}
            onPress={handleCycleLaunchTab}
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
        </SectionCard>

        <SectionHeader title="Call Audio" />
        <SectionCard>
          <SettingRow
            icon="musical-notes-outline"
            label="Incoming Ringtone"
            subtitle="Default is your Loopcom ringtone. Tap to switch."
            value={getMobileIncomingRingtoneLabel(incomingRingtone)}
            onPress={handleCycleIncomingRingtone}
          />
        </SectionCard>

        <SectionHeader title="Quick Replies" />
        <SectionCard>
          <Text style={[typography.caption, { color: colors.textTertiary, paddingHorizontal: 16, paddingTop: 12 }]}>
            Shown when declining a call with a message. Sent as a text from your number.
          </Text>
          {quickReplyDrafts.map((draft, i) => (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginHorizontal: 16,
                marginTop: 10,
                marginBottom: i === quickReplyDrafts.length - 1 ? 14 : 0,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.border,
                borderRadius: 8,
                paddingHorizontal: 10,
              }}
            >
              <TextInput
                style={{ flex: 1, color: colors.text, fontSize: 14, paddingVertical: 9 }}
                value={draft}
                maxLength={160}
                placeholder={`Quick reply ${i + 1}`}
                placeholderTextColor={colors.textTertiary}
                onChangeText={(t) => {
                  setQuickReplyDrafts((prev) => prev.map((p, j) => (j === i ? t : p)));
                }}
                onEndEditing={() => void persistQuickReplies()}
              />
            </View>
          ))}
        </SectionCard>

        {/* ── Call Readiness — Android only ─────────────────────────────── */}
        {Platform.OS === 'android' && (
          <>
            <SectionHeader title="Incoming Call Readiness" />

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
              {/*
                The auto-retry effect in NotificationsContext flips
                `pushTokenRetrying` to true while a backoff timer is pending
                for the next FCM registration attempt (Google Play Services
                SERVICE_NOT_AVAILABLE on Moto G / Lenovo / older Android 14
                builds typically self-heals within 30s–10min). Render that as
                an amber "Retrying…" row so the user knows the app is actively
                recovering and they don't need to keep tapping.
              */}
              {(() => {
                const autoRetrying = !!callReadiness.pushTokenRetrying;
                const showRetrying = retryingPushToken || autoRetrying;
                const subtitle = callReadiness.pushTokenRegistered
                  ? 'Registered — server can reach this device'
                  : retryingPushToken
                    ? 'Registering…'
                    : autoRetrying
                      ? `Retrying automatically… (${callReadiness.pushTokenError ?? 'transient error'})`
                      : callReadiness.pushTokenError
                        ? `Error: ${callReadiness.pushTokenError}`
                        : 'Not registered — tap to retry';
                const iconColor = callReadiness.pushTokenRegistered
                  ? colors.success
                  : showRetrying
                    ? colors.warning
                    : colors.danger;
                const chipBg = callReadiness.pushTokenRegistered
                  ? colors.successMuted
                  : showRetrying
                    ? colors.warningMuted
                    : colors.dangerMuted;
                const chipColor = callReadiness.pushTokenRegistered
                  ? colors.success
                  : showRetrying
                    ? colors.warning
                    : colors.danger;
                const chipLabel = callReadiness.pushTokenRegistered
                  ? '✓ OK'
                  : retryingPushToken
                    ? '…'
                    : autoRetrying
                      ? 'Retrying'
                      : '✗ Missing';
                return (
                  <SettingRow
                    icon="cloud-outline"
                    label="Push Token"
                    subtitle={subtitle}
                    iconColor={iconColor}
                    onPress={!callReadiness.pushTokenRegistered && !retryingPushToken ? handleRetryPushToken : undefined}
                    disabled={retryingPushToken}
                    rightElement={
                      <View style={[styles.statusChip, { backgroundColor: chipBg }]}>
                        <Text style={[typography.labelSm, { color: chipColor }]}>
                          {chipLabel}
                        </Text>
                      </View>
                    }
                  />
                );
              })()}

              {/* 3. Battery optimization — REAL OS exemption state */}
              {(() => {
                const ignored = callReadiness.batteryOptimizationIgnored;
                const isExempt = ignored === true;
                const isOptimized = ignored === false;
                const subtitle = isExempt
                  ? 'Allowed — calls ring even in the background'
                  : isOptimized
                    ? 'Optimized — tap to allow background running'
                    : 'Tap to allow Loopcom to run in the background';
                const statusColor = isExempt
                  ? colors.success
                  : isOptimized
                    ? colors.danger
                    : colors.warning;
                const chipBg = isExempt
                  ? colors.successMuted
                  : isOptimized
                    ? colors.dangerMuted
                    : colors.warningMuted;
                const chipLabel = isExempt ? '✓ Allowed' : isOptimized ? '✗ Optimized' : '⚠ Check';
                return (
                  <SettingRow
                    icon="battery-half-outline"
                    label="Battery Optimization"
                    subtitle={subtitle}
                    iconColor={statusColor}
                    // Only actionable when not already exempt.
                    onPress={isExempt ? undefined : handleFixBatteryOptimization}
                    rightElement={
                      <View style={[styles.statusChip, { backgroundColor: chipBg }]}>
                        <Text style={[typography.labelSm, { color: statusColor }]}>
                          {chipLabel}
                        </Text>
                      </View>
                    }
                  />
                );
              })()}

              {/* 4. Microphone permission — REAL RECORD_AUDIO grant state */}
              {(() => {
                const mic = callReadiness.microphonePermission;
                const granted = mic === 'granted';
                const denied = mic === 'denied';
                const statusColor = granted
                  ? colors.success
                  : denied
                    ? colors.danger
                    : colors.warning;
                const chipBg = granted
                  ? colors.successMuted
                  : denied
                    ? colors.dangerMuted
                    : colors.warningMuted;
                return (
                  <SettingRow
                    icon="mic-outline"
                    label="Microphone"
                    subtitle={
                      granted
                        ? 'Granted — you can be heard on calls'
                        : denied
                          ? 'Not granted — tap to allow microphone'
                          : 'Tap to check microphone access'
                    }
                    iconColor={statusColor}
                    onPress={granted ? undefined : handleRequestMicrophone}
                    rightElement={
                      <View style={[styles.statusChip, { backgroundColor: chipBg }]}>
                        <Text style={[typography.labelSm, { color: statusColor }]}>
                          {granted ? '✓ Granted' : denied ? '✗ Denied' : '⚠ Check'}
                        </Text>
                      </View>
                    }
                  />
                );
              })()}

              {/* 5. SIP registration */}
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
});

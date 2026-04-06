import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useSip } from '../../context/SipContext';
import { usePresence } from '../../context/PresenceContext';
import { Avatar } from '../../components/ui/Avatar';
import { Card } from '../../components/ui/Card';
import { Chip } from '../../components/ui/Chip';
import { PresenceDot } from '../../components/ui/PresenceDot';
import { getVoiceExtension } from '../../api/client';
import type { VoiceExtension } from '../../types';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/spacing';

const { width } = Dimensions.get('window');

const QUICK_ACTIONS = [
  { icon: 'keypad-outline', label: 'Dialpad', screen: 'Keypad', color: '#3b82f6' },
  { icon: 'time-outline', label: 'Recents', screen: 'Recent', color: '#06b6d4' },
  { icon: 'recording-outline', label: 'Voicemail', screen: 'Voicemail', color: '#a78bfa' },
  { icon: 'people-outline', label: 'Team', screen: 'Team', color: '#10b981' },
  { icon: 'chatbubbles-outline', label: 'Chat', screen: 'Chat', color: '#f59e0b' },
  { icon: 'qr-code-outline', label: 'Pair QR', screen: 'QrProvision', color: '#f43f5e' },
];

const STATUS_OPTIONS: Array<{ status: any; label: string; color: string }> = [
  { status: 'available', label: 'Available', color: '#22c55e' },
  { status: 'busy', label: 'Busy', color: '#ef4444' },
  { status: 'dnd', label: 'Do Not Disturb', color: '#f97316' },
  { status: 'away', label: 'Away', color: '#f59e0b' },
  { status: 'offline', label: 'Invisible', color: '#64748b' },
];

export function QuickActionTab() {
  const { colors, isDark } = useTheme();
  const { token } = useAuth();
  const sip = useSip();
  const { myStatus, setMyStatus } = usePresence();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  const [voice, setVoice] = useState<VoiceExtension | null>(null);
  const [showStatusPicker, setShowStatusPicker] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (!token) return;
      getVoiceExtension(token)
        .then(setVoice)
        .catch(() => {});
    }, [token])
  );

  const regState = sip.registrationState;
  const regChipVariant = regState === 'registered' ? 'success' : regState === 'failed' ? 'danger' : 'neutral';
  const regChipLabel = regState.toUpperCase();

  const statusConfig = STATUS_OPTIONS.find((s) => s.status === myStatus)!;

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Header gradient banner */}
      <LinearGradient
        colors={isDark ? ['#0d1426', '#111827'] : ['#1e3a5f', '#2563eb']}
        style={[styles.headerBanner, { paddingTop: insets.top + 12 }]}
      >
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            {voice && (
              <Avatar name={voice.displayName || voice.extensionNumber} size="md" status={myStatus as any} />
            )}
            <View style={{ marginLeft: 12 }}>
              <Text style={[typography.h4, { color: '#f0f4ff' }]}>
                {voice?.displayName || 'Connect User'}
              </Text>
              {voice?.extensionNumber && (
                <Text style={[typography.caption, { color: 'rgba(240,244,255,0.65)' }]}>
                  Ext {voice.extensionNumber}
                </Text>
              )}
            </View>
          </View>

          <TouchableOpacity
            onPress={() => nav.navigate('Settings')}
            style={styles.settingsBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="settings-outline" size={22} color="rgba(240,244,255,0.8)" />
          </TouchableOpacity>
        </View>

        {/* Status / registration row */}
        <View style={styles.statusRow}>
          <TouchableOpacity
            style={[styles.statusPill, { backgroundColor: 'rgba(0,0,0,0.2)', borderColor: 'rgba(255,255,255,0.15)' }]}
            onPress={() => setShowStatusPicker((prev) => !prev)}
            activeOpacity={0.8}
          >
            <PresenceDot status={myStatus} size={8} />
            <Text style={[typography.labelSm, { color: 'rgba(240,244,255,0.9)', marginLeft: 6, marginRight: 4 }]}>
              {statusConfig.label}
            </Text>
            <Ionicons name="chevron-down" size={12} color="rgba(240,244,255,0.6)" />
          </TouchableOpacity>

          <View style={[styles.regPill, { backgroundColor: regState === 'registered' ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.1)', borderColor: regState === 'registered' ? 'rgba(16,185,129,0.4)' : 'rgba(255,255,255,0.15)' }]}>
            <View style={[styles.regDot, { backgroundColor: regState === 'registered' ? '#10b981' : '#ef4444' }]} />
            <Text style={[typography.labelSm, { color: 'rgba(240,244,255,0.85)', marginLeft: 5 }]}>
              {regState === 'registered' ? 'Registered' : regState === 'registering' ? 'Registering…' : regState === 'failed' ? 'Reg. Failed' : 'Not Registered'}
            </Text>
          </View>
        </View>

        {/* Status picker dropdown */}
        {showStatusPicker && (
          <View style={[styles.statusDropdown, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {STATUS_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.status}
                style={[styles.statusOption, myStatus === opt.status && { backgroundColor: colors.primaryDim }]}
                onPress={() => { setMyStatus(opt.status); setShowStatusPicker(false); }}
                activeOpacity={0.7}
              >
                <View style={[styles.statusDot, { backgroundColor: opt.color }]} />
                <Text style={[typography.labelLg, { color: colors.text }]}>{opt.label}</Text>
                {myStatus === opt.status && (
                  <Ionicons name="checkmark" size={16} color={colors.primary} style={{ marginLeft: 'auto' }} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </LinearGradient>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 90 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Registration prompt if not registered */}
        {regState !== 'registered' && sip.hasProvisioning && (
          <Card style={{ marginTop: spacing['4'] }}>
            <View style={styles.regPromptRow}>
              <View style={[styles.regPromptIcon, { backgroundColor: colors.warningMuted }]}>
                <Ionicons name="warning-outline" size={20} color={colors.warning} />
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={[typography.labelLg, { color: colors.text }]}>Not Registered</Text>
                <Text style={[typography.bodySm, { color: colors.textSecondary }]}>
                  Tap to reconnect to the PBX
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.regBtn, { backgroundColor: colors.primary }]}
                onPress={() => sip.register()}
                activeOpacity={0.85}
              >
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Connect</Text>
              </TouchableOpacity>
            </View>
          </Card>
        )}

        {!sip.hasProvisioning && (
          <Card style={{ marginTop: spacing['4'] }}>
            <View style={styles.regPromptRow}>
              <View style={[styles.regPromptIcon, { backgroundColor: colors.primaryMuted }]}>
                <Ionicons name="phone-portrait-outline" size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={[typography.labelLg, { color: colors.text }]}>Device Not Provisioned</Text>
                <Text style={[typography.bodySm, { color: colors.textSecondary }]}>
                  Scan a QR code to set up your extension
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.regBtn, { backgroundColor: colors.primary }]}
                onPress={() => nav.navigate('QrProvision')}
                activeOpacity={0.85}
              >
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Setup</Text>
              </TouchableOpacity>
            </View>
          </Card>
        )}

        {/* Quick actions grid */}
        <Text style={[typography.h4, { color: colors.text, marginTop: spacing['5'], marginBottom: spacing['3'] }]}>
          Quick Actions
        </Text>

        <View style={styles.quickGrid}>
          {QUICK_ACTIONS.map((action) => (
            <TouchableOpacity
              key={action.screen}
              style={[styles.quickItem, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={() => {
                if (action.screen === 'QrProvision' || action.screen === 'Settings') {
                  nav.navigate(action.screen);
                } else {
                  nav.navigate(action.screen);
                }
              }}
              activeOpacity={0.75}
            >
              <View style={[styles.quickIconBg, { backgroundColor: action.color + '18' }]}>
                <Ionicons name={action.icon as any} size={24} color={action.color} />
              </View>
              <Text style={[typography.label, { color: colors.text, marginTop: 8 }]}>
                {action.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Extension details card */}
        {voice && (
          <>
            <Text style={[typography.h4, { color: colors.text, marginTop: spacing['5'], marginBottom: spacing['3'] }]}>
              My Extension
            </Text>
            <Card>
              <View style={styles.extRow}>
                <View style={[styles.extIcon, { backgroundColor: colors.primaryMuted }]}>
                  <Ionicons name="call" size={20} color={colors.primary} />
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={[typography.h3, { color: colors.text }]}>
                    Ext {voice.extensionNumber}
                  </Text>
                  <Text style={[typography.body, { color: colors.textSecondary }]}>
                    {voice.displayName}
                  </Text>
                </View>
                <View style={styles.extChips}>
                  {voice.webrtcEnabled && (
                    <View style={[styles.smallChip, { backgroundColor: colors.tealMuted, borderColor: colors.teal + '40' }]}>
                      <Text style={{ color: colors.teal, fontSize: 10, fontWeight: '700' }}>WebRTC</Text>
                    </View>
                  )}
                </View>
              </View>

              <View style={[styles.divider, { backgroundColor: colors.border }]} />

              <View style={styles.extDetailRow}>
                <Ionicons name="wifi-outline" size={14} color={colors.textTertiary} />
                <Text style={[typography.caption, { color: colors.textSecondary, marginLeft: 6, flex: 1 }]} numberOfLines={1}>
                  {voice.sipDomain || 'SIP Domain not configured'}
                </Text>
              </View>
              {voice.sipWsUrl && (
                <View style={[styles.extDetailRow, { marginTop: 4 }]}>
                  <Ionicons name="server-outline" size={14} color={colors.textTertiary} />
                  <Text style={[typography.caption, { color: colors.textSecondary, marginLeft: 6, flex: 1 }]} numberOfLines={1}>
                    {voice.sipWsUrl}
                  </Text>
                </View>
              )}
            </Card>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerBanner: {
    paddingHorizontal: spacing['5'],
    paddingBottom: spacing['5'],
    zIndex: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing['3'],
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  settingsBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  regPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  regDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusDropdown: {
    position: 'absolute',
    top: '100%',
    left: spacing['5'],
    right: spacing['5'],
    borderRadius: 12,
    borderWidth: 1,
    zIndex: 100,
    overflow: 'hidden',
    marginTop: 4,
  },
  statusOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  scroll: {
    paddingHorizontal: spacing['4'],
  },
  regPromptRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  regPromptIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  regBtn: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -spacing['1.5'],
  },
  quickItem: {
    width: (width - spacing['4'] * 2 - spacing['3'] * 2) / 3,
    marginHorizontal: spacing['1.5'],
    marginBottom: spacing['3'],
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    alignItems: 'center',
  },
  quickIconBg: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  extRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  extIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  extChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 4,
  },
  smallChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 12,
  },
  extDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});

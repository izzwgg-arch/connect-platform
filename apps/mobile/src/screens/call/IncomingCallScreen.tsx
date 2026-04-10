import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Dimensions,
  TouchableOpacity,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useIncomingNotifications } from '../../context/NotificationsContext';
import { useAuth } from '../../context/AuthContext';
import { useSip } from '../../context/SipContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { respondInvite, postVoiceDiagEvent } from '../../api/client';
import { typography } from '../../theme/typography';
import { spacing } from '../../theme/spacing';

const INVITE_TTL_S = 45; // seconds before invite expires

const { width } = Dimensions.get('window');

export function IncomingCallScreen() {
  const { token } = useAuth();
  const sip = useSip();
  const { incomingInvite, clearIncomingInvite } = useIncomingNotifications();
  const insets = useSafeAreaInsets();
  // Remaining-time countdown (seconds until invite expires)
  const [secondsLeft, setSecondsLeft] = useState(INVITE_TTL_S);

  // Animations
  const ring1 = useRef(new Animated.Value(1)).current;
  const ring2 = useRef(new Animated.Value(1)).current;
  const ring3 = useRef(new Animated.Value(1)).current;
  const ring1Opacity = useRef(new Animated.Value(0.6)).current;
  const ring2Opacity = useRef(new Animated.Value(0.4)).current;
  const ring3Opacity = useRef(new Animated.Value(0.2)).current;
  const contentFade = useRef(new Animated.Value(0)).current;
  const contentSlide = useRef(new Animated.Value(30)).current;
  const answerScale = useRef(new Animated.Value(1)).current;
  const declineScale = useRef(new Animated.Value(1)).current;

  // ── UI_SHOWN telemetry + countdown timer ─────────────────────────────────

  useEffect(() => {
    if (!incomingInvite) return;

    const uiShownAt = Date.now();
    const pushReceivedAt = (incomingInvite as any)._pushReceivedAt as number | undefined;

    // Post UI_SHOWN event with latency data
    if (token) {
      AsyncStorage.getItem('connect_diag_session_id').catch(() => null).then((sid) => {
        if (!sid) return;
        postVoiceDiagEvent(token, {
          sessionId: sid,
          type: 'UI_SHOWN',
          payload: {
            inviteId: incomingInvite.id,
            screen: 'IncomingCallScreen',
            uiShownAt,
            pushReceivedAt,
            pushToUiMs: pushReceivedAt ? uiShownAt - pushReceivedAt : null,
          },
        }).catch(() => undefined);
      });
    }

    // ── Countdown timer ─────────────────────────────────────────────────────
    // Compute seconds remaining from the invite's expiresAt timestamp.
    // Updates every second so the user knows how long they have to answer.
    const computeLeft = () => {
      if (!incomingInvite.expiresAt) return INVITE_TTL_S;
      const ms = new Date(incomingInvite.expiresAt).getTime() - Date.now();
      return Math.max(0, Math.ceil(ms / 1000));
    };

    setSecondsLeft(computeLeft());
    const interval = setInterval(() => {
      const left = computeLeft();
      setSecondsLeft(left);
      if (left <= 0) clearInterval(interval);
    }, 1000);

    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingInvite?.id]);

  useEffect(() => {
    // Content entrance
    Animated.parallel([
      Animated.timing(contentFade, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.timing(contentSlide, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start();

    // Pulse rings
    const createRingAnim = (scale: Animated.Value, opacity: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.parallel([
            Animated.timing(scale, { toValue: 1.6, duration: 1200, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 0, duration: 1200, useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(scale, { toValue: 1, duration: 0, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: delay === 0 ? 0.5 : delay === 300 ? 0.35 : 0.2, duration: 0, useNativeDriver: true }),
          ]),
        ])
      );

    const a1 = createRingAnim(ring1, ring1Opacity, 0);
    const a2 = createRingAnim(ring2, ring2Opacity, 300);
    const a3 = createRingAnim(ring3, ring3Opacity, 600);

    a1.start();
    a2.start();
    a3.start();

    // Pulse answer button
    const answerPulse = Animated.loop(
      Animated.sequence([
        Animated.timing(answerScale, { toValue: 1.06, duration: 700, useNativeDriver: true }),
        Animated.timing(answerScale, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    answerPulse.start();

    // Haptic pattern
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});

    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
      answerPulse.stop();
    };
  }, []);

  const handleAnswer = async () => {
    if (!token || !incomingInvite) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});

    Animated.timing(answerScale, { toValue: 0.9, duration: 100, useNativeDriver: true }).start();

    try {
      const resp = await respondInvite(token, incomingInvite.id, 'ACCEPT').catch(() => null);
      if (resp?.code !== 'INVITE_CLAIMED_OK') {
        clearIncomingInvite();
        return;
      }
      await sip.register().catch(() => undefined);
      await sip.answerIncomingInvite({
        fromNumber: incomingInvite.fromNumber,
        toExtension: incomingInvite.toExtension,
        pbxCallId: incomingInvite.pbxCallId,
        sipCallTarget: incomingInvite.sipCallTarget,
      }, 5000).catch(() => false);
      clearIncomingInvite();
    } catch {
      clearIncomingInvite();
    }
  };

  const handleDecline = async () => {
    if (!token || !incomingInvite) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

    Animated.timing(declineScale, { toValue: 0.9, duration: 100, useNativeDriver: true }).start();

    await respondInvite(token, incomingInvite.id, 'DECLINE').catch(() => undefined);
    await sip.rejectIncomingInvite({
      fromNumber: incomingInvite.fromNumber,
      toExtension: incomingInvite.toExtension,
      pbxCallId: incomingInvite.pbxCallId,
      sipCallTarget: incomingInvite.sipCallTarget,
    }).catch(() => false);
    clearIncomingInvite();
  };

  const callerName = incomingInvite?.fromDisplay || incomingInvite?.fromNumber || 'Unknown';
  const callerNumber = incomingInvite?.fromNumber || '';
  const toExt = incomingInvite?.toExtension || '';

  const initials = callerName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';

  return (
    <LinearGradient
      colors={['#0a0f1e', '#0d1430', '#0f1a42']}
      style={styles.container}
    >
      {/* Pulse rings */}
      <View style={styles.ringsCenter}>
        {[{ scale: ring3, opacity: ring3Opacity }, { scale: ring2, opacity: ring2Opacity }, { scale: ring1, opacity: ring1Opacity }].map((r, i) => (
          <Animated.View
            key={i}
            style={[
              styles.ring,
              {
                width: 180 + i * 30,
                height: 180 + i * 30,
                borderRadius: 90 + i * 15,
                transform: [{ scale: r.scale }],
                opacity: r.opacity,
                borderColor: 'rgba(34, 197, 94, 0.5)',
              },
            ]}
          />
        ))}
      </View>

      <Animated.View
        style={[
          styles.content,
          {
            paddingTop: insets.top + 60,
            paddingBottom: insets.bottom + 32,
            opacity: contentFade,
            transform: [{ translateY: contentSlide }],
          },
        ]}
      >
        {/* Label */}
        <Text style={[typography.label, { color: 'rgba(34,197,94,0.9)', letterSpacing: 3 }]}>
          INCOMING CALL
        </Text>

        {/* Avatar */}
        <View style={styles.avatarWrap}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        </View>

        {/* Caller info */}
        <Text style={[typography.callName, { color: '#f0f4ff', textAlign: 'center' }]} numberOfLines={2}>
          {callerName}
        </Text>
        {callerNumber !== callerName && (
          <Text style={[typography.bodyLg, { color: 'rgba(136,153,187,0.8)', marginTop: 4 }]}>
            {callerNumber}
          </Text>
        )}
        {toExt ? (
          <View style={styles.extPill}>
            <Ionicons name="call-outline" size={12} color="rgba(136,153,187,0.7)" style={{ marginRight: 4 }} />
            <Text style={[typography.caption, { color: 'rgba(136,153,187,0.7)' }]}>
              Ext {toExt}
            </Text>
          </View>
        ) : null}

        {/* Expiry countdown — shows when 10s or less remain */}
        {secondsLeft <= 10 && secondsLeft > 0 && (
          <View style={styles.countdownPill}>
            <Ionicons name="time-outline" size={11} color="rgba(251,191,36,0.9)" style={{ marginRight: 3 }} />
            <Text style={[typography.caption, { color: 'rgba(251,191,36,0.9)', fontWeight: '700' }]}>
              {secondsLeft}s
            </Text>
          </View>
        )}

        {/* Spacer */}
        <View style={{ flex: 1 }} />

        {/* Action buttons */}
        <View style={styles.actions}>
          {/* Decline */}
          <View style={styles.actionItem}>
            <Animated.View style={{ transform: [{ scale: declineScale }] }}>
              <TouchableOpacity style={styles.declineBtn} onPress={handleDecline} activeOpacity={0.8}>
                <Ionicons name="call" size={30} color="#fff" style={{ transform: [{ rotate: '135deg' }] }} />
              </TouchableOpacity>
            </Animated.View>
            <Text style={styles.actionLabel}>Decline</Text>
          </View>

          {/* Answer */}
          <View style={styles.actionItem}>
            <Animated.View style={{ transform: [{ scale: answerScale }] }}>
              <TouchableOpacity style={styles.answerBtn} onPress={handleAnswer} activeOpacity={0.8}>
                <Ionicons name="call" size={30} color="#fff" />
              </TouchableOpacity>
            </Animated.View>
            <Text style={styles.actionLabel}>Answer</Text>
          </View>
        </View>
      </Animated.View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  ringsCenter: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    top: '25%',
  },
  ring: {
    position: 'absolute',
    borderWidth: 1,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: spacing['8'],
  },
  avatarWrap: {
    marginTop: 32,
    marginBottom: 20,
  },
  avatarCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
    borderWidth: 2,
    borderColor: 'rgba(34, 197, 94, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 40,
    fontWeight: '700',
    color: '#22c55e',
    letterSpacing: 1,
  },
  extPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30,45,71,0.6)',
    borderColor: 'rgba(59,130,246,0.2)',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginTop: 10,
  },
  countdownPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(120,53,15,0.45)',
    borderColor: 'rgba(251,191,36,0.3)',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 8,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    marginBottom: 16,
  },
  actionItem: {
    alignItems: 'center',
    gap: 12,
  },
  declineBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 10,
  },
  answerBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#22c55e',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#22c55e',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 10,
  },
  actionLabel: {
    color: 'rgba(240,244,255,0.7)',
    fontSize: 13,
    fontWeight: '500',
    marginTop: 8,
  },
});

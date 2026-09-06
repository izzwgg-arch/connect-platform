import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  NativeModules,
  TextInput,
  KeyboardAvoidingView,
  Pressable,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIncomingNotifications } from '../../context/NotificationsContext';
import { clearAndroidLockScreenCallPresentation } from '../../sip/callkeep';
import { useAuth } from '../../context/AuthContext';
import { startRingtone, stopAllTelephonyAudio } from '../../audio/telephonyAudio';
import { postVoiceDiagEvent, getVoiceExtension } from '../../api/client';
import { typography } from '../../theme/typography';
import { logCallFlow } from '../../debug/callFlowDebug';
import { markCallLatency } from '../../debug/callLatency';
import { spacing } from '../../theme/spacing';
import { findCallModalNavigator } from '../../navigation/callStackNav';
import { normalizeCallerIdentity, callerDisplayLines } from '../../calls/callerIdentity';
import { useContactNameResolver } from '../../contacts/useContactNameResolver';
import { useTheme } from '../../context/ThemeContext';
import { getQuickReplies, canSmsReply, sendQuickReplySms, DEFAULT_QUICK_REPLIES } from '../../calls/quickReplies';

const INVITE_TTL_S = 45; // seconds before invite expires

// (A module-scope Dimensions.get('window') read used to sit here, unused. Do
// not bring it back: it is evaluated at bundle load, usually a headless push
// start with no portrait lock. See ui/phoneLayoutWidth.ts.)

export function IncomingCallScreen() {
  const { token } = useAuth();
  const nav = useNavigation<any>();
  const {
    incomingInvite,
    incomingCallUiState,
    answerIncomingCall,
    declineIncomingCall,
    answerHandoffInviteIdRef,
    answerHandoffTick,
    quickReplyInviteId,
    clearQuickReplyRequest,
  } = useIncomingNotifications() as ReturnType<typeof useIncomingNotifications> & {
    quickReplyInviteId?: string | null;
    clearQuickReplyRequest?: () => void;
  };
  const { isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const [displayInvite, setDisplayInvite] = useState(incomingInvite);
  // Remaining-time countdown (seconds until invite expires)
  const [secondsLeft, setSecondsLeft] = useState(INVITE_TTL_S);

  // ── Quick reply ("decline with message") ─────────────────────────────────
  const [replySheetOpen, setReplySheetOpen] = useState(false);
  const [quickReplies, setQuickRepliesState] = useState<string[]>(DEFAULT_QUICK_REPLIES);
  const [customReply, setCustomReply] = useState('');
  const replySentRef = useRef(false);
  useEffect(() => {
    getQuickReplies().then(setQuickRepliesState).catch(() => undefined);
  }, []);
  // Notification "Reply" action deep-links here with the sheet pre-opened.
  useEffect(() => {
    if (!quickReplyInviteId) return;
    if (displayInvite && quickReplyInviteId === displayInvite.id) {
      setReplySheetOpen(true);
      clearQuickReplyRequest?.();
    }
  }, [quickReplyInviteId, displayInvite, clearQuickReplyRequest]);

  // Theme palette — the screen supports light mode; dark keeps the original
  // navy look exactly.
  const pal = isDark
    ? {
        gradient: ['#0a0f1e', '#0d1430', '#0f1a42'] as const,
        flatBg: '#040810',
        name: '#f0f4ff',
        secondary: 'rgba(136,153,187,0.8)',
        actionLabel: 'rgba(240,244,255,0.7)',
        replyBtnBg: 'rgba(30,45,71,0.85)',
        replyBtnBorder: 'rgba(147,197,253,0.35)',
        replyBtnIcon: '#bcd0f7',
        sheetBg: '#141d3f',
        sheetHandle: '#31427a',
        bubbleBg: '#1b2650',
        bubbleText: '#dbe6ff',
        customBg: '#10193a',
        customBorder: '#31427a',
        customText: '#e7eeff',
        customPlaceholder: 'rgba(143,163,208,0.8)',
        sheetCaption: '#8fa3d0',
        backdrop: 'rgba(0,0,0,0.45)',
        pillBg: 'rgba(30,45,71,0.6)',
        pillBorder: 'rgba(59,130,246,0.2)',
        pillText: 'rgba(136,153,187,0.7)',
      }
    : {
        gradient: ['#eef3fc', '#e7effb', '#dfe9fa'] as const,
        flatBg: '#eef3fc',
        name: '#122344',
        secondary: 'rgba(59,79,120,0.85)',
        actionLabel: 'rgba(28,44,80,0.75)',
        replyBtnBg: '#ffffff',
        replyBtnBorder: 'rgba(59,79,120,0.35)',
        replyBtnIcon: '#28437c',
        sheetBg: '#ffffff',
        sheetHandle: '#c3d0e8',
        bubbleBg: '#eef2fa',
        bubbleText: '#1c2c50',
        customBg: '#f6f8fd',
        customBorder: '#c3d0e8',
        customText: '#1c2c50',
        customPlaceholder: 'rgba(91,111,150,0.8)',
        sheetCaption: '#5b6f96',
        backdrop: 'rgba(10,20,40,0.35)',
        pillBg: '#ffffff',
        pillBorder: 'rgba(59,79,120,0.25)',
        pillText: '#41597f',
      };

  // The logged-in user's own extension identity, so its name (e.g. "Home") is
  // never shown as the incoming caller. Loaded non-blocking with an
  // AsyncStorage cache so it is instant on subsequent calls and never delays
  // the ring UI.
  const [selfExtNames, setSelfExtNames] = useState<string[]>([]);
  const [selfExtNumbers, setSelfExtNumbers] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const SELF_KEY = 'cc_self_ext_identity';
    (async () => {
      try {
        const cached = await AsyncStorage.getItem(SELF_KEY);
        if (cached && !cancelled) {
          const o = JSON.parse(cached);
          if (Array.isArray(o?.names)) setSelfExtNames(o.names);
          if (Array.isArray(o?.numbers)) setSelfExtNumbers(o.numbers);
        }
      } catch {}
      if (!token) return;
      try {
        const v = await getVoiceExtension(token);
        const names = [v?.displayName].filter((x): x is string => Boolean(x && x.trim()));
        const numbers = [v?.extensionNumber, v?.sipUsername?.replace(/_\d+$/, '')].filter(
          (x): x is string => Boolean(x && x.trim()),
        );
        if (!cancelled) {
          setSelfExtNames(names);
          setSelfExtNumbers(numbers);
        }
        await AsyncStorage.setItem(SELF_KEY, JSON.stringify({ names, numbers }));
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (incomingInvite) {
      setDisplayInvite(incomingInvite);
      // New ring — reset the quick-reply machinery from any previous call.
      replySentRef.current = false;
      setReplySheetOpen(false);
      setCustomReply('');
      return;
    }
    if (incomingCallUiState.phase !== 'idle') {
      return;
    }
    const timer = setTimeout(() => setDisplayInvite(null), 450);
    return () => clearTimeout(timer);
  }, [incomingInvite, incomingCallUiState.phase]);

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
    if (!displayInvite) return;

    const uiShownAt = Date.now();
    const pushReceivedAt = (displayInvite as any)._pushReceivedAt as number | undefined;

    // Post UI_SHOWN event with latency data
    if (token) {
      AsyncStorage.getItem('connect_diag_session_id').catch(() => null).then((sid) => {
        if (!sid) return;
        postVoiceDiagEvent(token, {
          sessionId: sid,
          type: 'UI_SHOWN',
          payload: {
            inviteId: displayInvite.id,
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
      if (!displayInvite?.expiresAt) return INVITE_TTL_S;
      const ms = new Date(displayInvite.expiresAt).getTime() - Date.now();
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
  }, [displayInvite?.id]);

  useEffect(() => {
    if (!incomingInvite || incomingCallUiState.phase !== 'incoming') return;
    // Android path: do NOT play a JS ringtone. Native IncomingCallFirebaseService
    // owns ringtone playback end-to-end (MediaPlayer with USAGE_NOTIFICATION_RINGTONE
    // and a wake lock). Layering expo-av on top caused the lock-screen "double
    // ringtone" (both native MediaPlayer and JS expo-av audible simultaneously)
    // and left leaked Audio.Sound instances if stopAllTelephonyAudio raced with
    // the async Audio.Sound.createAsync call. Native keeps ringing until one of:
    //   - the user taps answer/decline on the native notification (onNewIntent)
    //   - IncomingCallUi.dismiss is called from JS on answer/decline
    //   - an INVITE_CLAIMED / INVITE_CANCELED FCM arrives.
    if (Platform.OS === 'android') return;
    if (answerHandoffInviteIdRef.current === incomingInvite.id) return;
    startRingtone().catch(() => undefined);
    return () => {
      stopAllTelephonyAudio().catch(() => undefined);
    };
  }, [incomingInvite?.id, incomingCallUiState.phase, answerHandoffInviteIdRef]);

  useEffect(() => {
    if (!displayInvite?.id) return;
    if (incomingCallUiState.phase !== 'incoming' && incomingCallUiState.phase !== 'connecting') return;
    logCallFlow('INCOMING_CALL_SCREEN_MOUNT', {
      inviteId: displayInvite.id,
      pbxCallId: displayInvite.pbxCallId ?? null,
      extension: displayInvite.toExtension ?? null,
      extra: { phase: incomingCallUiState.phase },
    });
    // Latency: first paint of the incoming-call UI. The delta from
    // INCOMING_RECEIVED to here captures full-screen intent / navigator
    // handoff cost.
    markCallLatency(displayInvite.id, 'INCOMING_UI_SHOWN', {
      phase: incomingCallUiState.phase,
    });
  }, [displayInvite?.id, incomingCallUiState.phase]);

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
    // IMPORTANT: do NOT early-return on `!token` or phase==='connecting'.
    // On lock-screen cold resume, `token` from useAuth() can still be null
    // for ~50–300 ms even though SecureStore has the value. The previous
    // early-return caused the first tap to be silently dropped and the user
    // to tap 2–3 times. The shared answer path (handleAcceptInvite) has its
    // own tokenRef wait (up to 4 s) and an in-flight guard keyed by
    // inviteId, so duplicate-tap protection still works — subsequent taps
    // become no-ops because inviteActionInFlightRef already contains the key.
    const invite = incomingInvite ?? displayInvite;
    if (!invite) return;
    // Latency: record the tap the instant the touch handler fires,
    // BEFORE any async work. This is the user-visible start of the
    // "answer → audio" window, so it must come before haptics / audio
    // teardown to avoid attributing that cost to business logic.
    markCallLatency(invite.id, 'ANSWER_TAPPED', { source: 'incoming_screen' });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    // Fire-and-forget audio stop so we don't block the UI tap handler.
    stopAllTelephonyAudio().catch(() => undefined);
    Animated.timing(answerScale, { toValue: 0.9, duration: 100, useNativeDriver: true }).start();
    console.log('[IncomingCall] handleAnswer → delegating to answerIncomingCall (tokenReady=' + !!token + ' phase=' + incomingCallUiState.phase + ')');
    // Do not await — the navigation handoff happens synchronously via
    // answerHandoffInviteIdRef inside handleAcceptInvite, and awaiting here
    // would hold the IncomingCallScreen mounted until SIP claim / register
    // complete, delaying the visible transition to ActiveCall.
    void answerIncomingCall(invite).catch(() => undefined);
  };

  const handleDecline = async () => {
    if (!incomingInvite) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    stopAllTelephonyAudio().catch(() => undefined);
    Animated.timing(declineScale, { toValue: 0.9, duration: 100, useNativeDriver: true }).start();
    await declineIncomingCall(incomingInvite).catch(() => undefined);
    if (Platform.OS === 'android') {
      clearAndroidLockScreenCallPresentation();
    }
  };

  // Quick reply: decline IMMEDIATELY (caller stops ringing, same as the stock
  // dialer), then send the SMS in the background from the user's own number.
  // A send failure is logged, never surfaced mid-decline.
  const handleQuickReply = (message: string) => {
    const invite = incomingInvite ?? displayInvite;
    const text = message.trim();
    if (!invite || !text || replySentRef.current) return;
    replySentRef.current = true;
    setReplySheetOpen(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    const replyTo = invite.fromNumber || '';
    if (token && canSmsReply(replyTo)) {
      sendQuickReplySms(token, replyTo, text).catch((e) => {
        console.warn('[QUICK_REPLY] sms send failed:', e instanceof Error ? e.message : String(e));
      });
    }
    void handleDecline();
  };

  // Normalize the PBX-delivered caller identity so the ring-group prefix,
  // external number, and caller name are kept separate and rendered
  // deterministically (never the prefix alone, never our own extension name).
  // ⛔ Client-side contact fallback (2026-08-23, the Relax Tires complaint):
  // the ring screen used to trust the push's fromDisplay ALONE, so any
  // server-side resolution miss (PBX-event path, wake path, a swallowed
  // lookup error) rendered the raw number even though the caller sat in the
  // user's own contacts — while ActiveCall and Recents resolved locally.
  // A saved contact's name beats carrier CNAM, same rule as the server.
  const resolveContactName = useContactNameResolver();
  const localContactName = resolveContactName(displayInvite?.fromNumber);
  const callerIdentity = normalizeCallerIdentity({
    number: displayInvite?.fromNumber,
    displayName: localContactName || displayInvite?.fromDisplay,
    direction: 'inbound',
    selfNames: selfExtNames,
    selfExtensionNumbers: selfExtNumbers,
    ringGroupPrefix: (displayInvite as any)?.fromPrefix ?? null,
    tenantId: displayInvite?.tenantId,
  });
  const callerLines = callerDisplayLines(callerIdentity);
  const callerName = callerLines.primary;
  const callerNumber = callerLines.secondary || '';
  const prefixBadge = callerLines.prefixBadge;
  const toExt = displayInvite?.toExtension || '';
  const inAnswerHandoff =
    !!displayInvite?.id && answerHandoffInviteIdRef.current === displayInvite.id;

  // After answer, invite is cleared asynchronously but this modal may still be
  // visible for a frame. Jump to ActiveCall immediately — no extra "Connecting"
  // screen (ActiveCall already shows CONNECTING… while SIP attaches).
  useLayoutEffect(() => {
    if (!inAnswerHandoff) return;
    let cancelled = false;
    let retries = 0;
    const tryNavigate = () => {
      if (cancelled) return;
      let onActive = false;
      try {
        const stackNav = findCallModalNavigator(nav) ?? nav;
        const routeName = stackNav.getCurrentRoute?.()?.name;
        if (routeName !== 'ActiveCall') {
          stackNav.navigate('ActiveCall');
        }
        onActive = stackNav.getCurrentRoute?.()?.name === 'ActiveCall';
      } catch {
        /* ignore */
      }
      if (!cancelled && !onActive && retries < 15) {
        retries += 1;
        setTimeout(tryNavigate, 45);
      }
    };
    tryNavigate();
    return () => {
      cancelled = true;
    };
  }, [inAnswerHandoff, nav, answerHandoffTick]);

  const isConnecting =
    (incomingCallUiState.phase === 'connecting' && incomingCallUiState.inviteId === displayInvite?.id) ||
    inAnswerHandoff;
  const isEnded =
    !inAnswerHandoff &&
    incomingCallUiState.phase === 'ended' &&
    incomingCallUiState.inviteId === displayInvite?.id;
  const hasFailure =
    !inAnswerHandoff &&
    incomingCallUiState.phase === 'failed' &&
    incomingCallUiState.inviteId === displayInvite?.id;
  const rawError = incomingCallUiState.error;
  const terminalMessage = rawError || 'Call ended';
  const failureSubtitle =
    hasFailure &&
    rawError &&
    (rawError.length > 90 ||
      rawError.includes('respond_invite') ||
      rawError.includes('sip_') ||
      rawError.includes('INVITE_'))
      ? "We couldn't connect this call. Check signal or Wi‑Fi, then try again."
      : terminalMessage;
  const showActions = !!incomingInvite && !isConnecting && !isEnded && !hasFailure;

  if (!displayInvite && incomingCallUiState.phase === 'idle') {
    return <View style={[styles.container, { backgroundColor: pal.flatBg }]} />;
  }

  // Answer-from-notification: invite is cleared immediately while SIP connects.
  // Keep a flat background only — ActiveCall is pushed on the same tick (above).
  if (inAnswerHandoff) {
    return <View style={[styles.container, { backgroundColor: pal.flatBg }]} />;
  }

  const initials = callerName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';

  return (
    <LinearGradient
      colors={pal.gradient as unknown as [string, string, ...string[]]}
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
          {isConnecting
            ? 'Joining call…'
            : isEnded
              ? 'Call ended'
              : hasFailure
                ? "Couldn't connect"
                : 'Incoming call'}
        </Text>

        {/* Avatar */}
        <View style={styles.avatarWrap}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        </View>

        {/* Ring-group / context prefix (matches how desk phones show it) */}
        {prefixBadge ? (
          <View style={styles.prefixBadge}>
            <Ionicons name="people-outline" size={12} color="rgba(34,197,94,0.95)" style={{ marginRight: 5 }} />
            <Text style={[typography.caption, { color: 'rgba(34,197,94,0.95)', fontWeight: '700' }]}>
              {prefixBadge}
            </Text>
          </View>
        ) : null}

        {/* Caller info */}
        <Text style={[typography.callName, { color: pal.name, textAlign: 'center' }]} numberOfLines={2}>
          {callerName}
        </Text>
        {callerNumber && callerNumber !== callerName ? (
          <Text style={[typography.bodyLg, { color: pal.secondary, marginTop: 4 }]}>
            {callerNumber}
          </Text>
        ) : null}
        {toExt ? (
          <View style={[styles.extPill, { backgroundColor: pal.pillBg, borderColor: pal.pillBorder }]}>
            <Ionicons name="call-outline" size={12} color={pal.pillText} style={{ marginRight: 4 }} />
            <Text style={[typography.caption, { color: pal.pillText }]}>
              Ext {toExt}
            </Text>
          </View>
        ) : null}

        {isConnecting ? (
          <View style={styles.statusPill}>
            <ActivityIndicator size="small" color="#93c5fd" />
            <Text style={[typography.caption, styles.statusPillText]}>One moment…</Text>
          </View>
        ) : null}

        {(isEnded || hasFailure) ? (
          <View style={[styles.statusPill, styles.statusPillError]}>
            <Ionicons name="checkmark-circle-outline" size={14} color="#bfdbfe" style={{ flexShrink: 0 }} />
            <Text style={[typography.caption, styles.statusPillErrorText, { flexShrink: 1, textAlign: 'center' }]}>
              {hasFailure ? failureSubtitle : terminalMessage}
            </Text>
          </View>
        ) : null}

        {(isEnded || hasFailure) ? (
          <Text style={[typography.caption, styles.returningText]}>Back to Quick Actions…</Text>
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
        {showActions ? (
          <View style={styles.actions}>
          {/* Decline */}
          <View style={styles.actionItem}>
            <Animated.View style={{ transform: [{ scale: declineScale }] }}>
              <TouchableOpacity style={styles.declineBtn} onPress={handleDecline} activeOpacity={0.8}>
                <Ionicons name="call" size={30} color="#fff" style={{ transform: [{ rotate: '135deg' }] }} />
              </TouchableOpacity>
            </Animated.View>
            <Text style={[styles.actionLabel, { color: pal.actionLabel }]}>Decline</Text>
          </View>

          {/* Reply (decline with message) — PSTN callers only */}
          {canSmsReply(displayInvite?.fromNumber) ? (
            <View style={styles.actionItem}>
              <TouchableOpacity
                style={[styles.replyBtn, { backgroundColor: pal.replyBtnBg, borderColor: pal.replyBtnBorder }]}
                onPress={() => setReplySheetOpen(true)}
                activeOpacity={0.8}
              >
                <Ionicons name="chatbubble-ellipses-outline" size={26} color={pal.replyBtnIcon} />
              </TouchableOpacity>
              <Text style={[styles.actionLabel, { color: pal.actionLabel }]}>Reply</Text>
            </View>
          ) : null}

          {/* Answer */}
          <View style={styles.actionItem}>
            <Animated.View style={{ transform: [{ scale: answerScale }] }}>
              <TouchableOpacity style={[styles.answerBtn, isConnecting && styles.answerBtnDisabled]} onPress={handleAnswer} activeOpacity={0.8} disabled={isConnecting}>
                <Ionicons name="call" size={30} color="#fff" />
              </TouchableOpacity>
            </Animated.View>
            <Text style={[styles.actionLabel, { color: pal.actionLabel }]}>{isConnecting ? 'Connecting…' : 'Answer'}</Text>
          </View>
          </View>
        ) : null}
      </Animated.View>

      {/* Quick-reply sheet — call keeps ringing until a reply is picked */}
      {replySheetOpen && showActions ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={StyleSheet.absoluteFill}
          pointerEvents="box-none"
        >
          <Pressable
            style={[StyleSheet.absoluteFill, { backgroundColor: pal.backdrop }]}
            onPress={() => setReplySheetOpen(false)}
          />
          <View style={[styles.replySheet, { backgroundColor: pal.sheetBg, paddingBottom: insets.bottom + 12 }]}>
            <View style={[styles.sheetHandle, { backgroundColor: pal.sheetHandle }]} />
            <Text style={[typography.caption, { color: pal.sheetCaption, marginBottom: 8 }]}>
              Reply with a text and decline
            </Text>
            {quickReplies.map((msg) => (
              <TouchableOpacity
                key={msg}
                style={[styles.replyBubble, { backgroundColor: pal.bubbleBg }]}
                onPress={() => handleQuickReply(msg)}
                activeOpacity={0.7}
              >
                <Text style={{ color: pal.bubbleText, fontSize: 13 }} numberOfLines={1}>{msg}</Text>
              </TouchableOpacity>
            ))}
            <View style={[styles.customReplyRow, { backgroundColor: pal.customBg, borderColor: pal.customBorder }]}>
              <TextInput
                style={[styles.customReplyInput, { color: pal.customText }]}
                placeholder="Write your own…"
                placeholderTextColor={pal.customPlaceholder}
                value={customReply}
                onChangeText={setCustomReply}
                maxLength={160}
                returnKeyType="send"
                onSubmitEditing={() => handleQuickReply(customReply)}
              />
              <TouchableOpacity
                onPress={() => handleQuickReply(customReply)}
                disabled={!customReply.trim()}
                style={{ opacity: customReply.trim() ? 1 : 0.4, padding: 4 }}
              >
                <Ionicons name="send" size={18} color={pal.replyBtnIcon} />
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      ) : null}
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
  prefixBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderColor: 'rgba(34,197,94,0.35)',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginBottom: 10,
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
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(30,45,71,0.75)',
    borderColor: 'rgba(147,197,253,0.25)',
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginTop: 12,
    maxWidth: '100%',
  },
  statusPillError: {
    backgroundColor: 'rgba(127,29,29,0.5)',
    borderColor: 'rgba(252,165,165,0.22)',
  },
  statusPillText: {
    color: 'rgba(191,219,254,0.95)',
  },
  statusPillErrorText: {
    color: 'rgba(219,234,254,0.95)',
  },
  returningText: {
    color: 'rgba(191,219,254,0.72)',
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
  answerBtnDisabled: {
    opacity: 0.7,
  },
  actionLabel: {
    color: 'rgba(240,244,255,0.7)',
    fontSize: 13,
    fontWeight: '500',
    marginTop: 8,
  },
  replyBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  replySheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 14,
    paddingTop: 8,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    marginBottom: 8,
  },
  replyBubble: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 6,
  },
  customReplyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 2,
  },
  customReplyInput: {
    flex: 1,
    fontSize: 13,
    paddingVertical: 8,
  },
});

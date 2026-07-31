import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Dimensions,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { useSip } from '../../context/SipContext';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { usePresence } from '../../context/PresenceContext';
import { Avatar } from '../../components/ui/Avatar';
import { AppConfirmDialog } from '../../components/ui/AppPopup';
import { showAppAlert } from '../../components/ui/appAlert';
import { getContacts, getOutboundRoutes, getSipAccounts, getVoiceExtension, resolveOutboundDial, resolveSipAccountDial, type UserSipAccount } from '../../api/client';
import { loadLocalCallHistory } from '../../storage/callHistory';
import type { Contact, CallRecord, OutboundDialRoute, VoiceExtension } from '../../types';
import { spacing } from '../../theme/spacing';
import { playDtmfTone } from '../../audio/telephonyAudio';
import { ensureMicPermissionOrAlert } from '../../sip/permissions';

const { width, height: screenHeight } = Dimensions.get('window');

const KEYS = [
  { digit: '1', sub: '' },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '' },
  { digit: '0', sub: '+' },
  { digit: '#', sub: '' },
];

// Compact layout: tighter gutters so the keypad sits closer to the number
// display above and the call button below. Key size stays comfortable by
// clamping to a sensible min/max.
const PAD_H_PADDING = 14;
const KEY_GAP = 8;
const KEY_CELL_WIDTH = Math.floor((width - PAD_H_PADDING * 2 - KEY_GAP * 2) / 3);
// Key height flexes between these bounds so the live-suggestion area above the
// keypad always has room for two rows. When even the smallest keypad can't fit
// two rows, we fall back to showing a single suggestion instead.
const KEY_MAX = 70;
const KEY_MIN = 46;
const SHORT_SCREEN = screenHeight < 740;
// One suggestion row's footprint (avatar/text height + vertical padding + border).
const SUGGESTION_ROW_H = 50;
const SUGGESTION_GAP = 6;
const SUGGESTION_PAD_V = 14; // paddingTop(12) + paddingBottom(2) of the list

type Suggestion = {
  id: string;
  kind: 'contact' | 'recent';
  label: string;
  sub: string;
  value: string;
};

function DialKey({
  digit,
  sub,
  onPress,
  onLongPress,
  disabled,
  size,
  digitFontSize,
}: {
  digit: string;
  sub: string;
  onPress: (d: string) => void;
  onLongPress?: (d: string) => void;
  disabled?: boolean;
  size: number;
  digitFontSize: number;
}) {
  const { colors } = useTheme();
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const opacityAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback(() => {
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 0.92,
        useNativeDriver: true,
        speed: 40,
        bounciness: 0,
      }),
      Animated.timing(opacityAnim, {
        toValue: 0.75,
        duration: 60,
        useNativeDriver: true,
      }),
    ]).start();
  }, [scaleAnim, opacityAnim]);

  const handlePressOut = useCallback(() => {
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 1,
        useNativeDriver: true,
        speed: 22,
        bounciness: 8,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 110,
        useNativeDriver: true,
      }),
    ]).start();
  }, [scaleAnim, opacityAnim]);

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onPress(digit);
  };

  const handleLongPress = () => {
    if (onLongPress) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      onLongPress(digit);
    }
  };

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={handleLongPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      hitSlop={4}
    >
      <Animated.View
        style={[
          styles.key,
          {
            width: KEY_CELL_WIDTH,
            height: size,
            transform: [{ scale: scaleAnim }],
            opacity: opacityAnim,
          },
        ]}
      >
        <Text style={[styles.keyDigit, { color: colors.text, fontSize: digitFontSize, lineHeight: digitFontSize + 3 }]}>{digit}</Text>
        {sub ? (
          <Text style={[styles.keySub, { color: colors.textTertiary }]}>{sub}</Text>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

function SuggestionRow({
  suggestion,
  onPress,
}: {
  suggestion: Suggestion;
  onPress: (s: Suggestion) => void;
}) {
  const { colors } = useTheme();
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const pressIn = () =>
    Animated.spring(scaleAnim, { toValue: 0.98, useNativeDriver: true, speed: 30, bounciness: 0 }).start();
  const pressOut = () =>
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 6 }).start();

  const kindColor = suggestion.kind === 'contact' ? colors.primary : colors.teal;
  const kindIcon = suggestion.kind === 'contact' ? 'person-outline' : 'time-outline';

  return (
    <Pressable onPress={() => onPress(suggestion)} onPressIn={pressIn} onPressOut={pressOut}>
      <Animated.View
        style={[
          styles.suggestion,
          {
            backgroundColor: colors.surface,
            borderColor: colors.borderSubtle,
            transform: [{ scale: scaleAnim }],
          },
        ]}
      >
        {suggestion.kind === 'contact' ? (
          <Avatar name={suggestion.label} size="sm" />
        ) : (
          <View style={[styles.suggestionIcon, { backgroundColor: kindColor + '1f' }]}>
            <Ionicons name={kindIcon} size={16} color={kindColor} />
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.suggestionLabel, { color: colors.text }]} numberOfLines={1}>
            {suggestion.label}
          </Text>
          <Text style={[styles.suggestionSub, { color: colors.textSecondary }]} numberOfLines={1}>
            {suggestion.sub}
          </Text>
        </View>
        <Ionicons name="arrow-up-outline" size={14} color={colors.textTertiary} style={styles.suggestionArrow} />
      </Animated.View>
    </Pressable>
  );
}

export function KeypadTab() {
  const { colors, isDark } = useTheme();
  const sip = useSip();
  const { token } = useAuth();
  const { setMyStatus, isDnd } = usePresence();
  const insets = useSafeAreaInsets();
  const [number, setNumber] = useState('');
  // Clipboard paste offer (long-press on the number display). Holds the
  // CLEANED dialable string, or null when no offer is showing.
  const [pasteOffer, setPasteOffer] = useState<string | null>(null);

  const offerPasteFromClipboard = useCallback(async () => {
    try {
      const raw = (await Clipboard.getStringAsync()) || '';
      // Keep digits, *, # and a LEADING + only — strip spaces, dashes,
      // parentheses, dots and everything else people copy along with numbers.
      const cleaned = raw
        .trim()
        .replace(/[^\d+*#]/g, '')
        .replace(/(?!^)\+/g, '');
      const digitCount = cleaned.replace(/\D/g, '').length;
      if (digitCount >= 2 && cleaned.length <= 24) {
        setPasteOffer(cleaned);
        try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch { /* ignore */ }
      }
    } catch { /* clipboard unavailable — no offer */ }
  }, []);

  // The offer auto-dismisses after a few seconds or when the user keeps typing.
  useEffect(() => {
    if (pasteOffer === null) return undefined;
    const t = setTimeout(() => setPasteOffer(null), 6000);
    return () => clearTimeout(t);
  }, [pasteOffer]);
  const [dialing, setDialing] = useState(false);
  // Two-tap redial: first tap fills the last-dialed number, second tap calls it
  const [redialFilled, setRedialFilled] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [recent, setRecent] = useState<CallRecord[]>([]);
  const [voice, setVoice] = useState<VoiceExtension | null>(null);
  const [outboundRoutes, setOutboundRoutes] = useState<OutboundDialRoute[]>([]);
  // Selection encoding shared with the portal dialer:
  //   ''                        → primary line, no prefix
  //   '<routeId>'               → primary line + prefix
  //   'acct:<accountId>'        → extra SIP account (second line)
  //   'acct:<accountId>|<rid>'  → extra SIP account + its tenant's prefix
  const [selectedOutboundRouteId, setSelectedOutboundRouteId] = useState('');
  const [sipAccounts, setSipAccounts] = useState<UserSipAccount[]>([]);
  const [dndConfirmOpen, setDndConfirmOpen] = useState(false);
  const [dndOffConfirmOpen, setDndOffConfirmOpen] = useState(false);
  // Measured height of the whole tab — drives adaptive keypad sizing so the
  // suggestion list always has room for (ideally) two rows.
  const [tabHeight, setTabHeight] = useState(screenHeight);
  const prevCallStateRef = useRef(sip.callState);

  // Load suggestion sources on focus. Network call is best-effort — failure
  // leaves the suggestion list empty but never disables the dialer.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      loadLocalCallHistory()
        .then((h) => { if (alive) setRecent(h); })
        .catch(() => {});
      if (token) {
        getContacts(token, '')
          .then((res) => { if (alive) setContacts(res.rows ?? []); })
          .catch(() => {});
        getVoiceExtension(token)
          .then((next) => { if (alive) setVoice(next); })
          .catch(() => {});
        getOutboundRoutes(token)
          .then((routes) => {
            if (!alive) return;
            const allowed = routes.filter((route) => route && route.id);
            setOutboundRoutes(allowed);
            setSelectedOutboundRouteId('');
          })
          .catch(() => {
            if (alive) {
              setOutboundRoutes([]);
              setSelectedOutboundRouteId('');
            }
          });
        getSipAccounts(token)
          .then((accounts) => {
            if (!alive) return;
            setSipAccounts(accounts.filter((a) => a && a.id && a.ready));
          })
          .catch(() => {
            if (alive) setSipAccounts([]);
          });
      }
      return () => { alive = false; };
    }, [token]),
  );

  useEffect(() => {
    if (sip.callState === 'idle' || sip.callState === 'ended') setSelectedOutboundRouteId('');
  }, [sip.callState]);

  // Clear number when call ends and return to idle
  useEffect(() => {
    const prev = prevCallStateRef.current;
    prevCallStateRef.current = sip.callState;
    const wasInCall =
      prev === 'connected' || prev === 'dialing' || prev === 'ringing' || prev === 'ended';
    if (sip.callState === 'idle' && wasInCall) {
      setNumber('');
      setRedialFilled(false);
    }
  }, [sip.callState]);

  const callActive =
    sip.callState === 'connected' ||
    sip.callState === 'dialing' ||
    sip.callState === 'ringing' ||
    sip.callState === 'ended';
  const registered = sip.registrationState === 'registered';
  const selectedOutboundRoute = useMemo(
    () => outboundRoutes.find((route) => route.id === selectedOutboundRouteId) || null,
    [outboundRoutes, selectedOutboundRouteId],
  );
  /** Decoded second-line selection, or null when dialing the primary line. */
  const selectedSipAccount = useMemo(() => {
    if (!selectedOutboundRouteId.startsWith('acct:')) return null;
    const [accountId, routeId] = selectedOutboundRouteId.slice(5).split('|');
    const account = sipAccounts.find((a) => a.id === accountId) || null;
    if (!account) return null;
    return { account, routeId: routeId || null };
  }, [selectedOutboundRouteId, sipAccounts]);

  const handleKey = (digit: string) => {
    playDtmfTone(digit);
    if (callActive) {
      sip.sendDtmf(digit);
    } else {
      setNumber((prev) => prev + digit);
      setRedialFilled(false); // Manual typing cancels redial mode
    }
  };

  const handleLongPress = (digit: string) => {
    if (digit === '0') {
      setNumber((prev) => (prev.endsWith('+') ? prev : prev.slice(0, -1) + '+'));
    }
  };

  const handleBackspace = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setNumber((prev) => prev.slice(0, -1));
    setRedialFilled(false);
  };

  const handleLongBackspace = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setNumber('');
    setRedialFilled(false);
  };

  const confirmDnd = useCallback(() => {
    if (sip.registrationState !== 'registered') return;
    // Already in DND → tapping asks for confirmation before turning it OFF, so a
    // stray tap can't silently re-open the phone to calls. (Turning DND ON also
    // confirms, below.)
    if (isDnd) {
      setDndOffConfirmOpen(true);
      return;
    }
    setDndConfirmOpen(true);
  }, [sip.registrationState, isDnd]);

  const handleDial = async () => {
    const target = number.trim();

    // Two-tap redial: first tap fills last-dialed number, second tap calls
    if (!target) {
      const last = sip.lastDialed;
      if (!last) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        return;
      }
      setNumber(last);
      setRedialFilled(true);
      return; // Wait for second tap
    }

    await doCall(target);
  };

  const doCall = async (target: string) => {
    // Second-line calls register their own SIP account on demand inside
    // dial(), so the primary line's registration state doesn't gate them.
    if (!selectedSipAccount && sip.registrationState !== 'registered') {
      showAppAlert(
        'Not Registered',
        'The softphone is not registered. Please check your connection in Settings.',
      );
      return;
    }

    // Cross-platform mic preflight. On Android this still calls
    // PermissionsAndroid.request(RECORD_AUDIO) exactly like before. On iOS it
    // proactively triggers the native mic prompt via react-native-webrtc's
    // getUserMedia() (already a dependency for SIP) so the user grants access
    // BEFORE jssip's audio session fails silently. Returns false + shows an
    // Alert on denial; short-circuits the call attempt in that case.
    const micOk = await ensureMicPermissionOrAlert();
    if (!micOk) return;

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setDialing(true);
    try {
      if (selectedSipAccount && token) {
        // Second line: resolve the (optional) prefix within the ACCOUNT's
        // tenant, then dial from that account's own SIP registration.
        const resolved = await resolveSipAccountDial(token, {
          number: target,
          accountId: selectedSipAccount.account.id,
          outboundRouteId: selectedSipAccount.routeId,
        });
        await sip.dial(resolved.finalNumber || target, {
          displayTarget: target,
          accountId: selectedSipAccount.account.id,
        });
      } else {
        const pbxTarget = selectedOutboundRoute && token
          ? (await resolveOutboundDial(token, { number: target, outboundRouteId: selectedOutboundRoute.id })).finalNumber
          : target;
        await sip.dial(pbxTarget, { displayTarget: target });
      }
    } catch (e: any) {
      setSelectedOutboundRouteId('');
      const msg = String(e?.message || '');
      showAppAlert(
        'Call Failed',
        msg === 'SECOND_LINE_REGISTER_TIMEOUT'
          ? 'That phone line could not connect. Try again, or ask your administrator to sync its SIP account.'
          : msg || 'Could not start the call. Check your connection.',
      );
    } finally {
      setDialing(false);
    }
  };

  const handleHangup = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    await sip.hangup();
  };

  // Format display number nicely
  const formatDisplay = (n: string): string => {
    if (!n) return '';
    // Extension (1–5 digits) — show raw
    if (n.length <= 5 && /^\d+$/.test(n)) return n;
    const digits = n.replace(/\D/g, '');
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
    if (digits.length <= 10)
      return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    return n;
  };

  // Live suggestions — contacts and recents matched against the typed number.
  const suggestions = useMemo<Suggestion[]>(() => {
    const q = number.trim();
    if (q.length < 1 || callActive) return [];
    const qDigits = q.replace(/\D/g, '');
    const qLower = q.toLowerCase();
    if (!qDigits && qLower.length < 1) return [];
    const out: Suggestion[] = [];
    const seen = new Set<string>();

    for (const c of contacts) {
      if (out.length >= 4) break;
      // Extension match — wins on exact prefix
      if (c.extension && qDigits && c.extension.startsWith(qDigits)) {
        const key = `ext:${c.extension}`;
        if (!seen.has(key)) {
          out.push({ id: `c:${c.id}:ext`, kind: 'contact', label: c.displayName, sub: `Ext ${c.extension}`, value: c.extension });
          seen.add(key);
        }
        continue;
      }
      // Phone number match
      let phoneHit: string | null = null;
      for (const p of c.phones || []) {
        const digits = (p.numberRaw || '').replace(/\D/g, '');
        if (qDigits && digits.includes(qDigits)) { phoneHit = p.numberRaw; break; }
      }
      if (phoneHit) {
        const key = `c:${c.id}:${phoneHit}`;
        if (!seen.has(key)) {
          out.push({ id: key, kind: 'contact', label: c.displayName, sub: phoneHit, value: phoneHit });
          seen.add(key);
        }
        continue;
      }
      // Name match (when user typed letters via T9, rare — at least support plain text search)
      if (qLower.length >= 2 && c.displayName.toLowerCase().includes(qLower)) {
        const primaryPhone = c.primaryPhone?.numberRaw || c.phones?.[0]?.numberRaw || c.extension || '';
        if (primaryPhone) {
          const key = `cname:${c.id}`;
          if (!seen.has(key)) {
            out.push({ id: key, kind: 'contact', label: c.displayName, sub: primaryPhone, value: primaryPhone });
            seen.add(key);
          }
        }
      }
    }

    for (const r of recent) {
      if (out.length >= 6) break;
      const dir = r.direction?.toLowerCase();
      const isInbound = dir === 'inbound' || dir === 'incoming';
      const num = isInbound ? r.fromNumber : r.toNumber;
      if (!num) continue;
      const digits = num.replace(/\D/g, '');
      if (!qDigits || !digits.includes(qDigits)) continue;
      const key = `r:${num}`;
      if (seen.has(key)) continue;
      const name = r.fromName && r.fromName.trim() && r.fromName !== num ? r.fromName : num;
      out.push({ id: `${r.id}:${num}`, kind: 'recent', label: name, sub: num, value: num });
      seen.add(key);
    }

    return out.slice(0, SHORT_SCREEN ? 2 : 3);
  }, [number, contacts, recent, callActive]);

  const outboundVisible = (outboundRoutes.length > 0 || sipAccounts.length > 0) && !callActive;

  // Adaptive sizing. Reserve vertical room for up to two suggestion rows and
  // shrink the keypad keys (down to KEY_MIN) to make that room. If even the
  // smallest keypad can't fit two rows (e.g. tiny screen + outbound chips
  // present), drop to a single suggestion so it's never clipped.
  const { keySize, keyFontSize, singleSuggestionOnly } = useMemo(() => {
    const desiredRows = Math.min(suggestions.length, 2);
    const suggHeight = (rows: number) =>
      rows <= 0 ? 0 : SUGGESTION_PAD_V + SUGGESTION_ROW_H * rows + SUGGESTION_GAP * (rows - 1) + 8;

    // Fixed (non-keypad, non-suggestion) vertical consumers, generously rounded
    // so the real leftover never undershoots the reserved suggestion space.
    const topBarH = insets.top + 48;
    const outboundH = outboundVisible ? 58 : 0;
    const displayH = 64;
    const callRowH = 64 + insets.bottom + 16;
    const gridFixed = KEY_GAP * 3 + 10; // row gaps + grid marginBottom

    const budget = tabHeight - topBarH - outboundH - displayH - callRowH - gridFixed;
    const keyForRows = (rows: number) => (budget - suggHeight(rows)) / 4;

    let rows = desiredRows;
    let singleSuggestionOnly = false;
    let rawKey = keyForRows(rows);
    if (rows >= 2 && rawKey < KEY_MIN) {
      // Can't fit two rows even at the minimum key size → reserve one row only.
      rows = 1;
      singleSuggestionOnly = true;
      rawKey = keyForRows(rows);
    }
    const keySize = Math.max(KEY_MIN, Math.min(KEY_MAX, Math.floor(rawKey)));
    const keyFontSize = Math.max(23, Math.round(keySize * 0.49));
    return { keySize, keyFontSize, singleSuggestionOnly };
  }, [tabHeight, insets.top, insets.bottom, outboundVisible, suggestions.length]);

  const visibleSuggestions = useMemo(
    () => (singleSuggestionOnly ? suggestions.slice(0, 1) : suggestions),
    [suggestions, singleSuggestionOnly],
  );

  const handleSuggestion = (s: Suggestion) => {
    Haptics.selectionAsync().catch(() => {});
    setNumber(s.value);
    setRedialFilled(false);
  };

  const displayValue = formatDisplay(number);
  const subHint = redialFilled ? 'Tap call to dial' : null;

  const callButtonDisabled = callActive ? false : dialing;

  const callButtonColor = callActive
    ? colors.callRed
    : registered
    ? colors.callGreen
    : colors.textTertiary;

  const statusLabel = callActive
    ? sip.callState === 'connected'
      ? 'On Call'
      : sip.callState === 'dialing'
      ? 'Calling…'
      : sip.callState === 'ringing'
      ? 'Incoming…'
      : 'Ending…'
    : registered
    ? 'Ready'
    : 'Not registered';
  const userLabel = voice?.displayName?.trim() || 'Connect User';

  return (
    <View
      style={[styles.container, { backgroundColor: colors.bg }]}
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        if (h > 0 && Math.abs(h - tabHeight) > 1) setTabHeight(h);
      }}
    >
      {/* ── Top bar ── */}
      <View style={[styles.topBar, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity
          style={[
            styles.readyTag,
            {
              backgroundColor: registered ? (isDnd ? colors.warningMuted : colors.successMuted) : colors.dangerMuted,
              borderColor: registered ? (isDnd ? colors.warning + '50' : colors.callGreen + '40') : colors.danger + '40',
            },
          ]}
          activeOpacity={registered ? 0.72 : 1}
          onPress={registered ? confirmDnd : undefined}
        >
          <Text
            style={[
              styles.readyTagText,
              { color: registered ? (isDnd ? colors.warning : colors.callGreen) : colors.danger },
            ]}
            numberOfLines={1}
          >
            {registered && isDnd ? `${userLabel}  ·  Do Not Disturb` : userLabel}
          </Text>
        </TouchableOpacity>
      </View>

      {outboundVisible ? (
        <View style={styles.outboundWrap}>
          <Text style={[styles.outboundLabel, { color: colors.textTertiary }]}>Outbound</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.outboundScroller}>
            <TouchableOpacity
              style={[
                styles.outboundChip,
                {
                  borderColor: !selectedOutboundRouteId ? colors.primary : colors.borderSubtle,
                  backgroundColor: !selectedOutboundRouteId ? colors.primary + '1f' : colors.surface,
                },
              ]}
              activeOpacity={0.78}
              onPress={() => setSelectedOutboundRouteId('')}
            >
              <Text style={[styles.outboundChipText, { color: !selectedOutboundRouteId ? colors.primary : colors.textSecondary }]}>No prefix</Text>
            </TouchableOpacity>
            {outboundRoutes.map((route) => {
              const selected = route.id === selectedOutboundRouteId;
              return (
                <TouchableOpacity
                  key={route.id}
                  style={[
                    styles.outboundChip,
                    {
                      borderColor: selected ? colors.primary : colors.borderSubtle,
                      backgroundColor: selected ? colors.primary + '1f' : colors.surface,
                    },
                  ]}
                  activeOpacity={0.78}
                  onPress={() => setSelectedOutboundRouteId(route.id)}
                >
                  <Text style={[styles.outboundChipText, { color: selected ? colors.primary : colors.textSecondary }]}>
                    {route.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
            {sipAccounts.flatMap((account) => {
              const entries = [
                { value: `acct:${account.id}`, label: account.label || account.tenantName || 'Second line' },
                ...account.routes.map((route) => ({
                  value: `acct:${account.id}|${route.id}`,
                  label: `${account.label || account.tenantName} · ${route.name}`,
                })),
              ];
              return entries.map((entry) => {
                const selected = entry.value === selectedOutboundRouteId;
                return (
                  <TouchableOpacity
                    key={entry.value}
                    style={[
                      styles.outboundChip,
                      {
                        borderColor: selected ? colors.primary : colors.borderSubtle,
                        backgroundColor: selected ? colors.primary + '1f' : colors.surface,
                      },
                    ]}
                    activeOpacity={0.78}
                    onPress={() => setSelectedOutboundRouteId(entry.value)}
                  >
                    <Text style={[styles.outboundChipText, { color: selected ? colors.primary : colors.textSecondary }]}>
                      {entry.label}
                    </Text>
                  </TouchableOpacity>
                );
              });
            })}
          </ScrollView>
        </View>
      ) : null}

      {/* ── Live suggestions (contacts + recents) ──
         Lives in a flexible, scrollable middle region so a long suggestion
         list can never push the keypad / call / backspace row off the bottom
         of the screen. The keypad below stays pinned and always visible. */}
      <View style={styles.middleFlex}>
        {visibleSuggestions.length > 0 && (
          <ScrollView
            style={styles.suggestionsScroll}
            contentContainerStyle={styles.suggestionsWrap}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {visibleSuggestions.map((s) => (
              <SuggestionRow key={s.id} suggestion={s} onPress={handleSuggestion} />
            ))}
          </ScrollView>
        )}
      </View>

      {/* ── Display Area: sits directly above the keypad ── */}
      <View style={styles.displayArea}>
        {/* Long-press the number area → offer to paste a phone number from the
            clipboard (Izzy 2026-07-30). The pasted text is cleaned to just the
            dialable characters: spaces, dashes, parens etc. are stripped; a
            leading + survives. */}
        {pasteOffer !== null && (
          <TouchableOpacity
            style={[styles.pasteChip, { backgroundColor: colors.surface, borderColor: colors.border }]}
            activeOpacity={0.8}
            onPress={() => {
              setNumber(pasteOffer);
              setPasteOffer(null);
              try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch { /* ignore */ }
            }}
          >
            <Ionicons name="clipboard-outline" size={16} color={colors.primary} />
            <Text style={[styles.pasteChipText, { color: colors.text }]} numberOfLines={1}>
              Paste {formatDisplay(pasteOffer)}
            </Text>
          </TouchableOpacity>
        )}
        <Pressable style={styles.numberRow} onLongPress={offerPasteFromClipboard} delayLongPress={350}>
          {/* A REAL TextInput, not a <Text> (Izzy 2026-07-31: "it doesn't let
              you paste in"). The number used to be display-only text, so the
              OS had nothing to paste into and the only route was an
              undiscoverable long-press chip. As an editable field it gets the
              standard iOS/Android tap-and-hold → Paste menu for free, plus
              select/copy of a number you already typed.

              showSoftInputOnFocus={false} is what makes this safe: the field
              accepts focus, selection and paste, but the SYSTEM keyboard never
              opens — the app's own dialpad below stays the way you type. The
              long-press chip above is kept as a fallback for the area around
              the field. Pasted text runs through the same clean-up as the chip
              (digits, *, # and a single leading + survive), so a copied
              "(347) 978-0090" or "+1 347-978-0090" both dial correctly. */}
          <TextInput
            style={[
              styles.displayText,
              {
                color: colors.text,
                fontSize:
                  displayValue.length > 14
                    ? 26
                    : displayValue.length > 10
                    ? 31
                    : displayValue.length > 6
                    ? 36
                    : 42,
              },
            ]}
            value={displayValue}
            onChangeText={(text) => {
              const cleaned = text
                .replace(/[^\d+*#]/g, '')
                .replace(/(?!^)\+/g, '');
              setNumber(cleaned.slice(0, 24));
            }}
            showSoftInputOnFocus={false}
            keyboardType="phone-pad"
            returnKeyType="done"
            autoCorrect={false}
            autoCapitalize="none"
            numberOfLines={1}
            textAlign="center"
          />
        </Pressable>

        {subHint && (
          <Text style={[styles.hintText, { color: colors.textTertiary }]} numberOfLines={1}>
            {subHint}
          </Text>
        )}

        {callActive && (
          <Text style={[styles.callStateText, { color: callButtonColor }]} numberOfLines={1}>
            {statusLabel}
          </Text>
        )}
      </View>

      {/* ── Keypad Grid ── */}
      <View style={[styles.keypad, { paddingHorizontal: PAD_H_PADDING }]}>
        <View style={styles.keyGrid}>
          {KEYS.map(({ digit, sub }) => (
            <DialKey
              key={digit}
              digit={digit}
              sub={sub}
              onPress={handleKey}
              onLongPress={handleLongPress}
              disabled={dialing}
              size={keySize}
              digitFontSize={keyFontSize}
            />
          ))}
        </View>

        {/* ── Call Button ── */}
        <View style={[styles.callRow, { paddingBottom: insets.bottom + 14 }]}>
          {number.length > 0 && (
            <TouchableOpacity
              onPress={handleBackspace}
              onLongPress={handleLongBackspace}
              delayLongPress={500}
              activeOpacity={0.75}
              style={[
                styles.deleteBtn,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.surfaceElevated,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Delete digit"
            >
              <Ionicons name="backspace-outline" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[
              styles.callBtn,
              {
                backgroundColor: callButtonColor,
                shadowColor: callButtonColor,
              },
            ]}
            onPress={callActive ? handleHangup : handleDial}
            activeOpacity={0.9}
            disabled={callButtonDisabled}
            accessibilityRole="button"
            accessibilityLabel={callActive ? 'End call' : 'Call'}
          >
            <Ionicons
              name="call"
              size={30}
              color="#fff"
              style={callActive ? { transform: [{ rotate: '135deg' }] } : undefined}
            />
          </TouchableOpacity>
        </View>
      </View>
      <AppConfirmDialog
        visible={dndConfirmOpen}
        title="Enable Do Not Disturb?"
        message="Incoming calls won't ring this phone — they'll go straight to voicemail."
        cancelLabel="Cancel"
        confirmLabel="Turn On"
        onClose={() => setDndConfirmOpen(false)}
        onConfirm={() => {
          setMyStatus('dnd');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        }}
      />
      <AppConfirmDialog
        visible={dndOffConfirmOpen}
        title="Turn off Do Not Disturb?"
        message="Your phone will start ringing for incoming calls again."
        cancelLabel="Cancel"
        confirmLabel="Turn Off"
        onClose={() => setDndOffConfirmOpen(false)}
        onConfirm={() => {
          setMyStatus('available');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // ── Top bar ─────────────────────────────────────────
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: spacing['5'],
    paddingBottom: 4,
  },
  readyTag: {
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  readyTagText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.2,
    includeFontPadding: false,
  },
  outboundWrap: {
    paddingHorizontal: PAD_H_PADDING,
    paddingTop: 6,
    gap: 6,
  },
  outboundLabel: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  outboundScroller: {
    gap: 8,
    paddingRight: PAD_H_PADDING,
  },
  outboundChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  outboundChipText: {
    fontSize: 12,
    fontWeight: '800',
  },
  outboundPreview: {
    fontSize: 11,
    fontWeight: '700',
  },

  // ── Display ──────────────────────────────────────────
  displayArea: {
    alignItems: 'center',
    paddingHorizontal: PAD_H_PADDING,
    paddingTop: 4,
    paddingBottom: 8,
  },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
    width: '100%',
    gap: 8,
  },
  pasteChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 6,
    maxWidth: '90%',
    elevation: 3,
  },
  pasteChipText: {
    fontSize: 15,
    fontWeight: '600',
  },
  displayText: {
    fontWeight: '300',
    letterSpacing: 1.5,
    textAlign: 'center',
    flex: 1,
  },
  hintText: {
    fontSize: 12,
    marginTop: 2,
    letterSpacing: 0.2,
  },
  callStateText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.3,
    marginTop: 6,
  },

  // ── Suggestions ─────────────────────────────────────
  middleFlex: {
    flex: 1,
    minHeight: 10,
  },
  suggestionsScroll: {
    flex: 1,
    width: '100%',
  },
  suggestionsWrap: {
    paddingHorizontal: PAD_H_PADDING,
    paddingTop: 12,
    paddingBottom: 2,
    gap: 6,
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  suggestionIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestionLabel: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.15,
  },
  suggestionSub: {
    fontSize: 12,
    fontWeight: '500',
    opacity: 0.85,
    marginTop: 1,
  },
  suggestionArrow: {
    transform: [{ rotate: '45deg' }],
    opacity: 0.7,
  },

  // Flex spacer — absorbs all free vertical space and pushes the keypad block
  // down toward the bottom navigation bar for ergonomic thumb reach.
  // ── Keys ─────────────────────────────────────────────
  keypad: {
    // No flex — height determined by content; spacer above handles positioning
  },
  keyGrid: {
    width: KEY_CELL_WIDTH * 3 + KEY_GAP * 2,
    alignSelf: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    rowGap: KEY_GAP,
    columnGap: KEY_GAP,
    marginBottom: 10,
  },
  key: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyDigit: {
    fontSize: 34,
    fontWeight: '500',
    letterSpacing: 0.3,
    lineHeight: 37,
  },
  keySub: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2.0,
    marginTop: 1,
    opacity: 0.8,
  },

  // ── Call Button ─────────────────────────────────────
  callRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  deleteBtn: {
    position: 'absolute',
    right: (KEY_CELL_WIDTH - 52) / 2,
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 14,
    elevation: 10,
  },
});

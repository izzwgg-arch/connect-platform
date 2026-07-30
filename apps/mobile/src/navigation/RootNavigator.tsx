import React, { useEffect, useRef, useState } from 'react';
import { Linking, NativeModules, Platform, StyleSheet, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { CommonActions, NavigationContainer, StackActions, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { useSip } from '../context/SipContext';
import { useTheme } from '../context/ThemeContext';
import { SplashScreen } from '../screens/SplashScreen';
import { TabNavigator } from './TabNavigator';
import { WelcomeScreen } from '../screens/auth/WelcomeScreen';
import { LoginScreen } from '../screens/auth/LoginScreen';
import { QrProvisionScreen } from '../screens/auth/QrProvisionScreen';
import { ActiveCallScreen } from '../screens/call/ActiveCallScreen';
import { IncomingCallScreen } from '../screens/call/IncomingCallScreen';
import { DiagnosticsScreen } from '../screens/DiagnosticsScreen';
import { DeliveryNavigator } from './DeliveryNavigator';
import { useIncomingNotifications } from '../context/NotificationsContext';
import { useCallSessions } from '../context/CallSessionManager';
import { logCallFlow } from '../debug/callFlowDebug';
import { moveAppToBackground } from '../sip/callkeep';
import type { CallDirection, CallState } from '../types';
import { findCallModalNavigator } from './callStackNav';
import { getCallReturnTab, recordFocusedRoute } from './callOrigin';
import { shouldShowIncomingCallCover } from './incomingCallCover';
import { OngoingCallBanner } from '../components/call/OngoingCallBanner';
import { MobileNotificationRoute, notificationDataToRoute } from '../notifications/notificationRouting';
import { useFullScreenCallPermissionPrompt } from '../hooks/useFullScreenCallPermissionPrompt';
import { useBatteryOptimizationPrompt } from '../hooks/useBatteryOptimizationPrompt';
import { useDndMissedCallDrain } from '../notifications/dndMissedCalls';

function hasActiveOrPendingCall(
  callState: CallState,
  callDirection: CallDirection,
  answering: boolean,
): boolean {
  if (answering) return true;
  switch (callState) {
    case 'connected':
    case 'ringing':
      return true;
    case 'dialing':
      return callDirection === 'outbound';
    case 'idle':
    case 'ended':
    default:
      return false;
  }
}

const RootStack = createNativeStackNavigator();
const AuthStack = createNativeStackNavigator();
const AppStack = createNativeStackNavigator();

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false, animation: 'fade_from_bottom' }}>
      <AuthStack.Screen name="Welcome" component={WelcomeScreen} />
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="QrProvision" component={QrProvisionScreen} />
    </AuthStack.Navigator>
  );
}

/**
 * Wraps TabNavigator and watches SIP call state to imperatively navigate to
 * the ActiveCall / IncomingCall fullscreen modal when a call starts.
 */
function TabsWrapper() {
  const nav = useNavigation<any>();
  // COWORK iOS fix (2026-07-15): remoteParty + callConnectedAt are consumed
  // ONLY by the iOS-gated banner fallback below; on Android callConnectedAt
  // is always null and the fallback never activates.
  const { callState, callDirection, remoteParty, callConnectedAt } = useSip();
  const {
    incomingInvite,
    incomingCallUiState,
    answerHandoffInviteIdRef,
    answerHandoffTick,
    answeredFromBackgroundRef,
    answeredFromLockScreenRef,
  } = useIncomingNotifications();
  const callSessions = useCallSessions();
  // First-run nudges, armed here because TabsWrapper only mounts once the user
  // is authenticated (i.e. device setup is complete):
  //  - full-screen-intent (Android 14+) so incoming calls take over the screen
  //  - battery-optimization exemption so the keep-alive service survives in the
  //    background and calls keep ringing on aggressive OEMs.
  useFullScreenCallPermissionPrompt(true);
  useBatteryOptimizationPrompt(true);
  // Fold DND-suppressed missed calls (recorded natively while the app was
  // backgrounded/killed) into local call history so they appear in Recent.
  useDndMissedCallDrain();
  // Multi-call guard: if another call is already active, new inbound INVITEs
  // are routed to the CallWaitingBanner inside ActiveCallScreen instead of
  // the full-screen IncomingCallScreen.
  // Gate the full-screen IncomingCall navigation on ANY ongoing call —
  // active, held, still connecting, or dialing. This prevents a secondary
  // invite from yanking the user away from the ActiveCallScreen mid-
  // answer (the CallsDrawer takes over instead).
  const hasMultiCallActive = callSessions.hasAnyOngoingCall;

  const prevCallState = useRef<CallState>(callState);
  const prevIncoming = useRef(incomingInvite);

  const stackNav = () => nav.getParent?.() ?? nav;

  const appStackNav = () => findCallModalNavigator(nav) ?? stackNav();

  const navigateOnce = (screen: 'IncomingCall' | 'ActiveCall'): boolean => {
    try {
      const target = appStackNav();
      if (!target?.navigate) {
        console.warn('[CALL_NAV] navigateOnce: no app stack navigator for', screen);
        return false;
      }
      const routeName = target.getCurrentRoute?.()?.name;
      if (routeName === screen) return true;
      console.log('[CALL_NAV] navigating to', screen, 'from', routeName ?? 'unknown');
      target.navigate(screen);
      return true;
    } catch (e) {
      console.warn(
        '[CALL_NAV] navigateOnce failed screen=' + screen + ':',
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
  };

  const returnToDefaultTab = () => {
    try {
      // Captured before the background/lock refs are cleared below — used to
      // decide whether we can pop the modal (foreground) or must full-reset
      // (lock-screen / background answer).
      const cameFromBackground = !!answeredFromBackgroundRef.current;
      // IMPORTANT ORDERING: if the call was answered from the background /
      // lock screen, move the Android task back to background FIRST, then
      // reset the navigation stack. Reversing these (navigate-then-move)
      // caused the user to see the default tab on the lock screen for a
      // beat before the keyguard re-appeared, then have to press back to
      // return to the lock screen. moveTaskToBack() is synchronous — the
      // activity pauses immediately, the keyguard is revealed, and the
      // subsequent navigation reset happens off-screen so the next time
      // the user opens the app they land on the default tab as expected.
      if (answeredFromBackgroundRef.current) {
        answeredFromBackgroundRef.current = false;
        // We only push the Android task back to the keyguard / launcher
        // when the call came in via the lock screen (or was surfaced via
        // the incoming-call PendingIntent). Previously we also tried a
        // live `isDeviceLocked()` check, but Samsung One UI flips
        // KeyguardManager to "unlocked" the moment MainActivity surfaces
        // over the keyguard via showWhenLocked=true — leaving the user
        // on the app's main page after hanging up a call they picked up
        // from the lock screen. `answeredFromLockScreenRef` is set at
        // answer time from the authoritative `deviceLockedAtAnswer` /
        // `launchedFromIncomingCall` flags captured before that flip
        // happened, so it's always correct even on Samsung.
        //
        // Importantly, for background-but-UNLOCKED answers (e.g. heads-up
        // on home screen) we STILL keep MainActivity resumed. That was
        // the whole point of the original live-keyguard gate: Android 14+
        // BAL policy quietly drops background full-screen activity
        // starts when MainActivity is paused, which breaks the next
        // incoming call's IncomingCallScreen. Our lock-screen ref only
        // goes true when the user was on the lock screen at answer time,
        // so the heads-up case correctly falls through to "keep
        // resumed".
        const cameFromLock = !!answeredFromLockScreenRef.current;
        answeredFromLockScreenRef.current = false;
        if (cameFromLock) {
          moveAppToBackground();
          console.log('[LOCK_CALL_CLEANUP] moveAppToBackground called before nav reset (answered from lock screen)');
        } else {
          console.log('[LOCK_CALL_CLEANUP] skip moveAppToBackground (not from lock screen) — keep MainActivity resumed for next incoming call');
        }
      }
      // Return to whichever tab the call started from (dialer, call history,
      // contacts, messages, ...) instead of always the dialer.
      const returnTab = getCallReturnTab();
      const stack = appStackNav();

      // Fix 7: for a FOREGROUND-initiated call (e.g. an outbound callback from
      // the Voicemail list) where ActiveCall is sitting directly on top of
      // Tabs, pop ONLY the ActiveCall modal. A full CommonActions.reset (below)
      // rebuilds the Tabs navigator, which remounts the origin tab's FlatList
      // and snaps its scroll position back to the top. Popping keeps the
      // still-mounted tab — and its scroll position / expanded voicemail —
      // exactly where the user left it. The lock-screen / background-answer
      // cases fall through to the reset path (they rely on the task-back +
      // origin-tab rebuild handled above).
      if (!cameFromBackground) {
        try {
          const st = stack.getState?.();
          const routes = st?.routes ?? [];
          const top = routes[routes.length - 1];
          const beneath = routes[routes.length - 2];
          if (top?.name === 'ActiveCall' && beneath?.name === 'Tabs') {
            stack.dispatch(StackActions.pop(1));
            console.log('[ANSWER_FLOW] POPPED_ACTIVE_CALL_PRESERVE_TAB', returnTab);
            logCallFlow('NAVIGATE_BACK_TO_ORIGIN_TAB', {
              extra: { source: 'returnToDefaultTab:pop', tab: returnTab },
            });
            return;
          }
        } catch {}
      }

      stack.dispatch(
        CommonActions.reset({
          index: 0,
          routes: [
            {
              name: 'Tabs',
              state: {
                routes: [{ name: returnTab }],
                index: 0,
              },
            },
          ],
        }),
      );
      console.log('[ANSWER_FLOW] RETURNED_TO_ORIGIN_TAB', returnTab);
      logCallFlow('NAVIGATE_BACK_TO_ORIGIN_TAB', { extra: { source: 'returnToDefaultTab', tab: returnTab } });
    } catch {}
  };

  // Navigate to ActiveCall when an outbound call starts
  useEffect(() => {
    const prev = prevCallState.current;
    prevCallState.current = callState;

    const answering = !!answerHandoffInviteIdRef.current;
    const blockedByIncomingFlow =
      (!!incomingInvite && !answering) ||
      ((incomingCallUiState.phase === 'ended' || incomingCallUiState.phase === 'failed') && !answering);
    const isActive =
      !blockedByIncomingFlow &&
      (
        callState === 'connected' ||
        (callDirection === 'outbound' &&
          (callState === 'dialing' || callState === 'ringing')) ||
        // Answer tapped: jump to ActiveCall immediately even if SIP is still on idle/ringing edge.
        (answering && callDirection !== 'outbound')
      );
    const wasActive =
      prev === 'dialing' ||
      prev === 'ringing' ||
      prev === 'connected' ||
      // SipContext: connected → ended → idle; on the idle render `prev` is still ended.
      prev === 'ended';

    if (isActive) {
      navigateOnce('ActiveCall');
    }

    // When a call returns to idle and we're on ActiveCall, go back
    if (callState === 'idle' && wasActive) {
      returnToDefaultTab();
    }
  }, [
    answerHandoffInviteIdRef,
    answerHandoffTick,
    callDirection,
    callState,
    incomingCallUiState.phase,
    incomingInvite,
    nav,
  ]);

  // Navigate to IncomingCall whenever an invite exists, including cold-start
  // cases where the invite was already present before this wrapper mounted.
  useEffect(() => {
    const prev = prevIncoming.current;
    prevIncoming.current = incomingInvite;
    const answering = !!answerHandoffInviteIdRef.current;
    const hasOngoingCall = hasActiveOrPendingCall(callState, callDirection, answering);
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    if (
      (incomingInvite && !answering) ||
      ((incomingCallUiState.phase === 'ended' || incomingCallUiState.phase === 'failed') && !answering)
    ) {
      // Multi-call: if a call is already active, stay on ActiveCall and let
      // the CallWaitingBanner inside it handle the waiting invite. The banner
      // reads from CallSessionManager.ringingCalls[].
      if (hasMultiCallActive) {
        console.log('[MULTICALL] skip_incoming_nav — active call present, banner will handle');
      } else if (!navigateOnce('IncomingCall')) {
        retryTimer = setTimeout(() => {
          navigateOnce('IncomingCall');
        }, 50);
      }
    } else if (!incomingInvite && prev && !hasOngoingCall) {
      returnToDefaultTab();
    }

    return () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [
    answerHandoffInviteIdRef,
    answerHandoffTick,
    callDirection,
    callState,
    incomingCallUiState.phase,
    incomingInvite,
    hasMultiCallActive,
    nav,
  ]);

  // When an incoming invite exists (or answer handoff / transient ended UI),
  // paint a black cover over the tabs until IncomingCallScreen mounts. Do NOT
  // cover on raw SIP ringing alone — JsSIP fires before ForegroundInvite sets
  // incomingInvite, which produced a blank screen with no modal on top.
  // IncomingCallScreen / ActiveCallScreen are fullScreen modals pushed on top
  // of TabsWrapper, so they render above this cover — the cover only masks the
  // tabs. pointerEvents="none" keeps taps falling through when the cover is
  // showing alone (shouldn't happen, but it's a safety net).
  const answering = !!answerHandoffInviteIdRef.current;
  const coverTabs = shouldShowIncomingCallCover({
    hasIncomingInvite: !!incomingInvite,
    answering,
    incomingUiPhase: incomingCallUiState.phase,
  });

  // Ongoing-call banner (Fix 2): shown when the user has minimized a live call
  // (there's an ongoing call AND the ActiveCall screen is not focused — i.e.
  // the tabs are visible). `useIsFocused()` here reflects the AppStack "Tabs"
  // route, so it's false while ActiveCall / IncomingCall is presented on top.
  const tabsFocused = useIsFocused();
  const bannerSession = callSessions.activeCall ?? callSessions.heldCalls[0] ?? null;
  // COWORK fix (2026-07-13): a lingering/zombie session from a cold-answer
  // re-delivery can leave the multi-call map (`hasAnyOngoingCall`) reporting an
  // "ongoing" call after the real call has already ended, which stranded this
  // banner (the green pill) on screen. The SIP aggregate `callState` reliably
  // returns to "ended"/"idle" when the last live SIP leg dies, so treat
  // idle/ended as "no live call" and hide the pill — UNLESS there is a
  // genuinely held (parked) call. Display-only; never touches the
  // answer/register path.
  const callLayerEnded = callState === 'idle' || callState === 'ended';
  const hasHeldCall = callSessions.heldCalls.length > 0;
  const hasOngoingCall =
    (callSessions.hasAnyOngoingCall || callState === 'connected') &&
    (!callLayerEnded || hasHeldCall);
  // COWORK iOS fix (2026-07-15): the flip side of the zombie-session bug — on
  // a cold-answer re-delivery (and some session-map misses) the live call is
  // bridged on a session the map never marks "active", so `bannerSession` is
  // null and the pill never shows DURING the call. When the SIP layer says
  // "connected" but the map has nothing, drive the pill from SIP-level state
  // (remoteParty + callConnectedAt). iOS-ONLY by owner directive: on Android
  // this flag is hard-false and every expression below reduces to its
  // previous value. Display-only; never touches the answer/register path.
  const iosSipBannerFallback =
    Platform.OS === 'ios' && callState === 'connected' && !bannerSession;
  const showOngoingBanner =
    tabsFocused && hasOngoingCall && (!!bannerSession || iosSipBannerFallback) && !coverTabs;
  const bannerName =
    bannerSession?.remoteName?.trim() ||
    bannerSession?.remoteNumber ||
    (iosSipBannerFallback && remoteParty ? remoteParty : 'Ongoing call');
  // Timer fallback applies whenever the session map lacks answeredAt (both the
  // no-session case above and a tracked-but-never-activated session). On
  // Android callConnectedAt is always null, so this line is inert there.
  const bannerConnectedAt =
    bannerSession?.answeredAt ?? (Platform.OS === 'ios' ? callConnectedAt : null);

  return (
    <>
      <TabNavigator />
      {coverTabs ? (
        <View pointerEvents="none" style={styles.incomingCallCover} />
      ) : null}
      <OngoingCallBanner
        visible={showOngoingBanner}
        name={bannerName}
        number={bannerSession?.remoteNumber ?? null}
        connectedAt={bannerConnectedAt}
        onPress={() => navigateOnce('ActiveCall')}
      />
    </>
  );
}

const styles = StyleSheet.create({
  incomingCallCover: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    // Sit below React-Navigation's fullScreen modal (which has its own
    // layering) but above the tabs / base stack so nothing else shows
    // through while IncomingCallScreen mounts.
    zIndex: 0,
    elevation: 0,
  },
});

function AppNavigator() {
  return (
    <AppStack.Navigator screenOptions={{ headerShown: false }}>
      <AppStack.Screen name="Tabs" component={TabsWrapper} />
      <AppStack.Screen
        name="QrProvision"
        component={QrProvisionScreen}
        options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
      />
      <AppStack.Screen
        name="Diagnostics"
        component={DiagnosticsScreen}
        options={{ animation: 'slide_from_right' }}
      />
      <AppStack.Screen
        name="Delivery"
        component={DeliveryNavigator}
        options={{ animation: 'slide_from_right' }}
      />
      <AppStack.Screen
        name="ActiveCall"
        component={ActiveCallScreen}
        options={{
          // Avoid a second full slide when answering from IncomingCall — feels like a "jump" screen.
          animation: 'none',
          presentation: 'fullScreenModal',
        }}
      />
      <AppStack.Screen
        name="IncomingCall"
        component={IncomingCallScreen}
        options={{
          // No slide animation: the incoming-call screen must take over the
          // entire display the instant an invite exists so the user never
          // sees a flash of the underlying tab (especially on the lock
          // screen where MainActivity resumes with its prior route visible
          // for ~50–250 ms while JS catches up).
          animation: 'none',
          presentation: 'fullScreenModal',
        }}
      />
    </AppStack.Navigator>
  );
}

export function RootNavigator() {
  const navRef = useNavigationContainerRef<any>();
  const { token, isLoading } = useAuth();
  const { callState, callDirection } = useSip();
  const { colors } = useTheme();
  const { incomingInvite, incomingCallUiState, answerHandoffInviteIdRef, answerHandoffTick } =
    useIncomingNotifications();

  // Show the branded splash until both conditions are met:
  //   1. The minimum display time has elapsed (enforced inside SplashScreen)
  //   2. Auth state is resolved (isLoading === false)
  const [splashDone, setSplashDone] = useState(false);
  const [navReady, setNavReady] = useState(false);
  const pendingNotificationRouteRef = useRef<MobileNotificationRoute | null>(null);
  // Set when the in-call notification body is tapped (deep link
  // com.connectcommunications.mobile://active-call) before navigation is
  // ready; consumed by the nav-ready effect below.
  const pendingActiveCallOpenRef = useRef(false);

  void answerHandoffTick;
  const answerHandoffActive = !!answerHandoffInviteIdRef.current;
  const hasActiveCallUi =
    !!incomingInvite ||
    answerHandoffActive ||
    (!answerHandoffActive && incomingCallUiState.phase === 'ended') ||
    (!answerHandoffActive && incomingCallUiState.phase === 'failed') ||
    callState === 'connected' ||
    (callDirection === 'outbound' &&
      (callState === 'dialing' || callState === 'ringing')) ||
    (callDirection === 'inbound' &&
      callState === 'ringing' &&
      (!!incomingInvite || answerHandoffActive)) ||
    (!answerHandoffActive && callState === 'ended');
  const showSplash = !splashDone && !hasActiveCallUi;

  // If an incoming call ever hid the splash before SplashScreen finished its
  // minimum timer, `splashDone` could still be false — when the call ends the
  // overlay would incorrectly reappear (looks like an app restart).
  useEffect(() => {
    if (token && !isLoading && hasActiveCallUi) {
      setSplashDone(true);
    }
  }, [token, isLoading, hasActiveCallUi]);

  const routeFromNotification = (target: MobileNotificationRoute) => {
    const tabRoute =
      target.type === 'voicemail'
        ? { name: 'Voicemail', params: { voicemailId: target.voicemailId } }
        : target.type === 'missed_call'
          ? { name: 'Recent' }
          : { name: 'Chat', params: { threadId: target.conversationId } };

    navRef.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [
          {
            name: 'App',
            state: {
              index: 0,
              routes: [
                {
                  name: 'Tabs',
                  state: {
                    index: 0,
                    routes: [tabRoute],
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  };

  useEffect(() => {
    const queueRoute = (data: any) => {
      const target = notificationDataToRoute(data);
      if (target) {
        pendingNotificationRouteRef.current = target;
        // WARM TAP FIX (2026-07-29): when the app is already running, nothing
        // re-runs the nav-ready consumption effect (refs don't trigger
        // effects), so a tray tap queued a destination that was never read —
        // notification taps only ever navigated on cold start. Consume
        // immediately whenever navigation is already up.
        consumePendingRouteRef.current();
      }
    };

    Notifications.getLastNotificationResponseAsync()
      .then((response) => queueRoute(response?.notification.request.content.data))
      .catch(() => undefined);

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      queueRoute(response.notification.request.content.data);
    });

    return () => sub.remove();
  }, []);

  // ── Missed-call deep-link handler ─────────────────────────────────────────
  // Native postMissedCallNotification fires a tap intent with URI
  // com.connectcommunications.mobile://missed-call. MainActivity passes it
  // through to React Native's Linking module untouched (neutralizeStale only
  // acts on host "incoming-call"). We queue a missed_call route so the
  // existing pendingNotificationRouteRef machinery navigates to Recent.
  useEffect(() => {
    const handlePushRouteUrl = (url: string | null) => {
      if (!url) return;
      if (url.startsWith('com.connectcommunications.mobile://active-call')) {
        // In-call notification body tapped: surface the ActiveCall modal.
        // Navigate immediately when the container is ready (warm tap while
        // the app is alive in the background); otherwise queue for the
        // nav-ready effect (cold start with a live call).
        if (navRef.isReady()) {
          console.log('[CALL_NAV] active-call deep link — navigating to ActiveCall');
          navRef.navigate('App', { screen: 'ActiveCall' });
        } else {
          pendingActiveCallOpenRef.current = true;
        }
        return;
      }
      if (url === 'com.connectcommunications.mobile://missed-call') {
        pendingNotificationRouteRef.current = { type: 'missed_call' };
        consumePendingRouteRef.current(); // warm tap — navigate now (see queueRoute)
        return;
      }
      if (url.startsWith('com.connectcommunications.mobile://voicemail')) {
        const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const params = new URLSearchParams(q);
        const voicemailId = params.get('voicemailId') || undefined;
        pendingNotificationRouteRef.current = { type: 'voicemail', voicemailId };
        consumePendingRouteRef.current(); // warm tap — navigate now
        return;
      }
      if (url.startsWith('com.connectcommunications.mobile://chat')) {
        const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const params = new URLSearchParams(q);
        const conversationId = params.get('conversationId');
        const messageId = params.get('messageId') || undefined;
        if (conversationId) {
          pendingNotificationRouteRef.current = {
            type: 'dm_message',
            conversationId,
            messageId,
          };
          consumePendingRouteRef.current(); // warm tap — navigate now
        }
      }
    };
    Linking.getInitialURL()
      .then(handlePushRouteUrl)
      .catch(() => undefined);
    const sub = Linking.addEventListener('url', ({ url }) => handlePushRouteUrl(url));
    return () => sub.remove();
  }, []);

  // Single consumer for a queued notification destination. Kept in a ref so
  // the empty-dep listener effects above always call the CURRENT version
  // (with fresh token/navReady/isLoading) — a warm tray tap navigates
  // immediately; a cold-start tap stays queued until the nav-ready effect
  // below drains it.
  const consumePendingRoute = () => {
    if (!token || !navReady || isLoading) return;
    if (!navRef.isReady()) return;
    const target = pendingNotificationRouteRef.current;
    if (!target) return;
    pendingNotificationRouteRef.current = null;
    console.log('[CALL_NAV] notification route — navigating', JSON.stringify(target));
    routeFromNotification(target);
  };
  const consumePendingRouteRef = useRef(consumePendingRoute);
  consumePendingRouteRef.current = consumePendingRoute;

  useEffect(() => {
    if (!token || !navReady || isLoading) return;
    if (pendingActiveCallOpenRef.current) {
      pendingActiveCallOpenRef.current = false;
      console.log('[CALL_NAV] active-call deep link (queued) — navigating to ActiveCall');
      navRef.navigate('App', { screen: 'ActiveCall' });
      return;
    }
    consumePendingRouteRef.current();
  }, [token, navReady, isLoading]);

  return (
    <>
      {/* Keep navigation mounted even while splash is visible so incoming-call
          handoff never tears down and rebuilds the app shell. */}
      <NavigationContainer
        ref={navRef}
        onReady={() => {
          setNavReady(true);
          recordFocusedRoute(navRef.getCurrentRoute()?.name);
        }}
        onStateChange={() => recordFocusedRoute(navRef.getCurrentRoute()?.name)}
      >
        <RootStack.Navigator screenOptions={{ headerShown: false }}>
          {!token ? (
            <RootStack.Screen name="Auth" component={AuthNavigator} />
          ) : (
            <RootStack.Screen name="App" component={AppNavigator} />
          )}
        </RootStack.Navigator>
      </NavigationContainer>

      {/* Branded splash overlay — sits on top, fades out on its own schedule */}
      {showSplash && (
        <SplashScreen
          authReady={!isLoading}
          onReady={() => setSplashDone(true)}
        />
      )}
    </>
  );
}

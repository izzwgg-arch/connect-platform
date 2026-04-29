import React, { useEffect, useRef, useState } from 'react';
import { NativeModules, Platform, StyleSheet, View } from 'react-native';
import { CommonActions, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
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
import { useIncomingNotifications } from '../context/NotificationsContext';
import { useCallSessions } from '../context/CallSessionManager';
import { logCallFlow } from '../debug/callFlowDebug';
import { moveAppToBackground } from '../sip/callkeep';
import type { CallDirection, CallState } from '../types';
import { findCallModalNavigator } from './callStackNav';

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
  const { callState, callDirection } = useSip();
  const {
    incomingInvite,
    incomingCallUiState,
    answerHandoffInviteIdRef,
    answerHandoffTick,
    answeredFromBackgroundRef,
    answeredFromLockScreenRef,
  } = useIncomingNotifications();
  const callSessions = useCallSessions();
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

  const navigateOnce = (screen: 'IncomingCall' | 'ActiveCall') => {
    try {
      const target = appStackNav();
      const routeName = target.getCurrentRoute?.()?.name;
      if (routeName === screen) return;
      target.navigate(screen);
    } catch {}
  };

  const returnToDefaultTab = () => {
    try {
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
      const stack = appStackNav();
      stack.dispatch(
        CommonActions.reset({
          index: 0,
          routes: [
            {
              name: 'Tabs',
              state: {
                routes: [{ name: 'Keypad' }],
                index: 0,
              },
            },
          ],
        }),
      );
      console.log('[ANSWER_FLOW] RETURNED_TO_KEYPAD');
      logCallFlow('NAVIGATE_BACK_TO_KEYPAD', { extra: { source: 'returnToDefaultTab' } });
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

    if (
      (incomingInvite && !answering) ||
      ((incomingCallUiState.phase === 'ended' || incomingCallUiState.phase === 'failed') && !answering)
    ) {
      // Multi-call: if a call is already active, stay on ActiveCall and let
      // the CallWaitingBanner inside it handle the waiting invite. The banner
      // reads from CallSessionManager.ringingCalls[].
      if (hasMultiCallActive) {
        console.log('[MULTICALL] skip_incoming_nav — active call present, banner will handle');
        return;
      }
      navigateOnce('IncomingCall');
      return;
    }

    if (!incomingInvite && prev && !hasOngoingCall) {
      returnToDefaultTab();
    }
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

  // If an incoming invite exists or we're in any active-call UI phase, paint a
  // black cover over the tabs. Purpose: MainActivity resumes from the keyguard
  // with its prior route (e.g. Keypad / the last visited tab) visible for
  // ~50 ms before React-Navigation mounts IncomingCallScreen. The cover
  // prevents that flash.
  // IncomingCallScreen / ActiveCallScreen are fullScreen modals pushed on top
  // of TabsWrapper, so they render above this cover — the cover only masks the
  // tabs. pointerEvents="none" keeps taps falling through when the cover is
  // showing alone (shouldn't happen, but it's a safety net).
  const answering = !!answerHandoffInviteIdRef.current;
  const coverTabs =
    !!incomingInvite ||
    answering ||
    (callDirection === 'inbound' && callState === 'ringing');
  return (
    <>
      <TabNavigator />
      {coverTabs ? (
        <View pointerEvents="none" style={styles.incomingCallCover} />
      ) : null}
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
  const { token, isLoading } = useAuth();
  const { callState, callDirection } = useSip();
  const { colors } = useTheme();
  const { incomingInvite, incomingCallUiState, answerHandoffInviteIdRef, answerHandoffTick } =
    useIncomingNotifications();

  // Show the branded splash until both conditions are met:
  //   1. The minimum display time has elapsed (enforced inside SplashScreen)
  //   2. Auth state is resolved (isLoading === false)
  const [splashDone, setSplashDone] = useState(false);

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

  return (
    <>
      {/* Keep navigation mounted even while splash is visible so incoming-call
          handoff never tears down and rebuilds the app shell. */}
      <NavigationContainer>
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

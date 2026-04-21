import React, { useEffect, useRef, useState } from 'react';
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
import { SettingsScreen } from '../screens/SettingsScreen';
import { DiagnosticsScreen } from '../screens/DiagnosticsScreen';
import { useIncomingNotifications } from '../context/NotificationsContext';
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
  const { incomingInvite, incomingCallUiState, answerHandoffInviteIdRef, answerHandoffTick, answeredFromBackgroundRef } =
    useIncomingNotifications();

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

  const returnToQuickAction = () => {
    try {
      const stack = appStackNav();
      stack.dispatch(
        CommonActions.reset({
          index: 0,
          routes: [
            {
              name: 'Tabs',
              state: {
                routes: [{ name: 'QuickAction' }],
                index: 0,
              },
            },
          ],
        }),
      );
      console.log('[ANSWER_FLOW] RETURNED_TO_QUICK_ACTION');
      logCallFlow('NAVIGATE_BACK_TO_QUICK', { extra: { source: 'returnToQuickAction' } });

      // If this call was answered from the background (e.g. lock screen), move the
      // app to the background so the lock screen is shown instead of the Quick page.
      if (answeredFromBackgroundRef.current) {
        answeredFromBackgroundRef.current = false;
        moveAppToBackground();
      }
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
      returnToQuickAction();
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
      navigateOnce('IncomingCall');
      return;
    }

    if (!incomingInvite && prev && !hasOngoingCall) {
      returnToQuickAction();
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

  return <TabNavigator />;
}

function AppNavigator() {
  return (
    <AppStack.Navigator screenOptions={{ headerShown: false }}>
      <AppStack.Screen name="Tabs" component={TabsWrapper} />
      <AppStack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
      />
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
        options={{ animation: 'slide_from_bottom', presentation: 'fullScreenModal' }}
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

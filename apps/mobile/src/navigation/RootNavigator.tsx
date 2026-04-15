import React, { useEffect, useRef, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
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
import type { CallState } from '../types';

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
  const { incomingInvite, incomingCallUiState } = useIncomingNotifications();

  const prevCallState = useRef<CallState>(callState);
  const prevIncoming = useRef(incomingInvite);

  const navigateOnce = (screen: 'IncomingCall' | 'ActiveCall') => {
    try {
      const routeName = nav.getCurrentRoute?.()?.name;
      if (routeName === screen) return;
    } catch {}
    setTimeout(() => {
      nav.navigate(screen);
    }, 20);
  };

  // Navigate to ActiveCall when an outbound call starts
  useEffect(() => {
    const prev = prevCallState.current;
    prevCallState.current = callState;

    const blockedByIncomingFlow =
      incomingCallUiState.phase === 'connecting' ||
      incomingCallUiState.phase === 'failed' ||
      !!incomingInvite;
    const isActive =
      !blockedByIncomingFlow &&
      (
        callState === 'connected' ||
        (callDirection === 'outbound' &&
          (callState === 'dialing' || callState === 'ringing'))
      );
    const wasActive =
      prev === 'dialing' ||
      prev === 'ringing' ||
      prev === 'connected';

    if (isActive) {
      navigateOnce('ActiveCall');
    }

    // When a call returns to idle and we're on ActiveCall, go back
    if (callState === 'idle' && wasActive) {
      try {
        if (nav.canGoBack()) nav.goBack();
      } catch {}
    }
  }, [callDirection, callState, incomingCallUiState.phase, incomingInvite, nav]);

  // Navigate to IncomingCall whenever an invite exists, including cold-start
  // cases where the invite was already present before this wrapper mounted.
  useEffect(() => {
    const prev = prevIncoming.current;
    prevIncoming.current = incomingInvite;

    if (incomingInvite || incomingCallUiState.phase === 'connecting' || incomingCallUiState.phase === 'failed') {
      navigateOnce('IncomingCall');
      return;
    }

    if (!incomingInvite && prev) {
      try {
        const routeName = nav.getCurrentRoute?.()?.name;
        if (routeName === 'IncomingCall' && nav.canGoBack()) {
          nav.goBack();
        }
      } catch {}
    }
  }, [incomingCallUiState.phase, incomingInvite, nav]);

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
        options={{ animation: 'slide_from_bottom', presentation: 'fullScreenModal' }}
      />
      <AppStack.Screen
        name="IncomingCall"
        component={IncomingCallScreen}
        options={{ animation: 'fade', presentation: 'fullScreenModal' }}
      />
    </AppStack.Navigator>
  );
}

export function RootNavigator() {
  const { token, isLoading } = useAuth();
  const { callState, callDirection } = useSip();
  const { colors } = useTheme();
  const { incomingInvite, incomingCallUiState } = useIncomingNotifications();

  // Show the branded splash until both conditions are met:
  //   1. The minimum display time has elapsed (enforced inside SplashScreen)
  //   2. Auth state is resolved (isLoading === false)
  const [splashDone, setSplashDone] = useState(false);

  const hasActiveCallUi =
    !!incomingInvite ||
    incomingCallUiState.phase === 'connecting' ||
    incomingCallUiState.phase === 'failed' ||
    callState === 'connected' ||
    (callDirection === 'outbound' &&
      (callState === 'dialing' || callState === 'ringing')) ||
    callState === 'ended';
  const showSplash = !splashDone && !hasActiveCallUi;

  return (
    <>
      {/* Navigation stack — rendered in the background during splash so
          NavigationContainer mounts immediately (avoids a second "flash"
          when splash fades out). */}
      {!showSplash && (
        <NavigationContainer>
          <RootStack.Navigator screenOptions={{ headerShown: false }}>
            {!token ? (
              <RootStack.Screen name="Auth" component={AuthNavigator} />
            ) : (
              <RootStack.Screen name="App" component={AppNavigator} />
            )}
          </RootStack.Navigator>
        </NavigationContainer>
      )}

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

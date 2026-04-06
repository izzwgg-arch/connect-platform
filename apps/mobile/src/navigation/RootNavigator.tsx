import React, { useEffect, useRef } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { useSip } from '../context/SipContext';
import { useTheme } from '../context/ThemeContext';
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
  const { callState } = useSip();
  const { incomingInvite } = useIncomingNotifications();

  const prevCallState = useRef<CallState>(callState);
  const prevIncoming = useRef(incomingInvite);

  // Navigate to ActiveCall when an outbound call starts
  useEffect(() => {
    const prev = prevCallState.current;
    prevCallState.current = callState;

    const isActive =
      callState === 'dialing' ||
      callState === 'ringing' ||
      callState === 'connected';
    const wasActive =
      prev === 'dialing' ||
      prev === 'ringing' ||
      prev === 'connected';

    if (isActive && !wasActive) {
      // Small delay ensures the screen is registered in the navigator first
      setTimeout(() => {
        nav.navigate('ActiveCall');
      }, 20);
    }

    // When a call returns to idle and we're on ActiveCall, go back
    if (callState === 'idle' && wasActive) {
      try {
        if (nav.canGoBack()) nav.goBack();
      } catch {}
    }
  }, [callState, nav]);

  // Navigate to IncomingCall when a push invite arrives
  useEffect(() => {
    const prev = prevIncoming.current;
    prevIncoming.current = incomingInvite;

    if (incomingInvite && !prev) {
      setTimeout(() => {
        nav.navigate('IncomingCall');
      }, 20);
    }
  }, [incomingInvite, nav]);

  return <TabNavigator />;
}

function AppNavigator() {
  const { callState } = useSip();
  const { incomingInvite } = useIncomingNotifications();

  // Include 'ended' so the screen stays up showing call-ended state
  const isCallActive =
    callState === 'connected' ||
    callState === 'dialing' ||
    callState === 'ringing' ||
    callState === 'ended';

  const hasIncoming = !!incomingInvite && callState !== 'connected';

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
      {isCallActive && !hasIncoming && (
        <AppStack.Screen
          name="ActiveCall"
          component={ActiveCallScreen}
          options={{ animation: 'slide_from_bottom', presentation: 'fullScreenModal' }}
        />
      )}
      {hasIncoming && (
        <AppStack.Screen
          name="IncomingCall"
          component={IncomingCallScreen}
          options={{ animation: 'fade', presentation: 'fullScreenModal' }}
        />
      )}
    </AppStack.Navigator>
  );
}

export function RootNavigator() {
  const { token, isLoading } = useAuth();
  const { colors } = useTheme();

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {!token ? (
          <RootStack.Screen name="Auth" component={AuthNavigator} />
        ) : (
          <RootStack.Screen name="App" component={AppNavigator} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

import React, { useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from './src/context/ThemeContext';
import { AuthProvider } from './src/context/AuthContext';
import { SipProvider } from './src/context/SipContext';
import { CallSessionProvider } from './src/context/CallSessionManager';
import { NotificationsProvider } from './src/context/NotificationsContext';
import { PresenceProvider } from './src/context/PresenceContext';
import { RootNavigator } from './src/navigation/RootNavigator';
import { CallFlowDebugOverlay } from './src/debug/CallFlowDebugOverlay';
import { ensureCallFlowAppStateHook, logCallFlowBootDiagnostics } from './src/debug/callFlowDebug';
import { PENDING_CALL_STORAGE_KEY } from './src/notifications/backgroundCallTask';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      const err = this.state.error as Error;
      return (
        <View style={styles.errorContainer}>
          <ScrollView contentContainerStyle={styles.errorContent}>
            <Text style={styles.errorTitle}>App Error</Text>
            <Text style={styles.errorMsg}>{err.message}</Text>
            <Text style={styles.errorStack}>{err.stack}</Text>
          </ScrollView>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  errorContainer: { flex: 1, backgroundColor: '#090e18' },
  errorContent: { padding: 24, paddingTop: 60 },
  errorTitle: { color: '#ff4444', fontSize: 20, fontWeight: '700', marginBottom: 12 },
  errorMsg: { color: '#ffffff', fontSize: 14, marginBottom: 16 },
  errorStack: { color: '#aaaaaa', fontSize: 11, fontFamily: 'monospace' },
});

export default function App() {
  useEffect(() => {
    ensureCallFlowAppStateHook();
    void logCallFlowBootDiagnostics(() =>
      AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null),
    );
  }, []);

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <ThemeProvider>
            <AuthProvider>
              <PresenceProvider>
                <SipProvider>
                  <CallSessionProvider>
                    <NotificationsProvider>
                      <RootNavigator />
                      <CallFlowDebugOverlay />
                    </NotificationsProvider>
                  </CallSessionProvider>
                </SipProvider>
              </PresenceProvider>
            </AuthProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

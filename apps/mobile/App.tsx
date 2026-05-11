import React, { useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ThemeProvider } from './src/context/ThemeContext';
import { AuthProvider } from './src/context/AuthContext';
import { useAuth } from './src/context/AuthContext';
import { SipProvider } from './src/context/SipContext';
import { CallSessionProvider } from './src/context/CallSessionManager';
import { NotificationsProvider } from './src/context/NotificationsContext';
import { PresenceProvider } from './src/context/PresenceContext';
import { RootNavigator } from './src/navigation/RootNavigator';
import { CallFlowDebugOverlay } from './src/debug/CallFlowDebugOverlay';
import { ensureCallFlowAppStateHook, logCallFlowBootDiagnostics } from './src/debug/callFlowDebug';
import { PENDING_CALL_STORAGE_KEY } from './src/notifications/backgroundCallTask';
import { getCallHistory, getContacts, getTeamDirectory, getVoicemails, mobileQueryKeys } from './src/api/client';

const mobileQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 3 * 60 * 1000,
      gcTime: 20 * 60 * 1000,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: 1,
    },
  },
});

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

function MobileDataPrefetcher() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    queryClient.removeQueries({ queryKey: ['mobile', 'voicemails'] });
    if (!token) {
      return;
    }
    queryClient.prefetchQuery({
      queryKey: mobileQueryKeys.contacts(''),
      queryFn: () => getContacts(token, ''),
    }).catch(() => undefined);
    queryClient.prefetchQuery({
      queryKey: mobileQueryKeys.callHistory,
      queryFn: () => getCallHistory(token),
    }).catch(() => undefined);
    queryClient.prefetchQuery({
      queryKey: mobileQueryKeys.voicemails('all', token),
      queryFn: () => getVoicemails(token),
    }).catch(() => undefined);
    queryClient.prefetchQuery({
      queryKey: mobileQueryKeys.teamDirectory(token.slice(-16)),
      queryFn: () => getTeamDirectory(token),
    }).catch(() => undefined);
  }, [queryClient, token]);

  return null;
}

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
          <QueryClientProvider client={mobileQueryClient}>
            <ThemeProvider>
              <AuthProvider>
                <MobileDataPrefetcher />
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
          </QueryClientProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

// ══════════════════ LOOPCOM DRIVER — ROOT ══════════════════
// The driver APK's whole world: sign in → today's runs → scan → stop → proof,
// plus the in-app route map and the driver settings (which navigation app,
// map in-app or hand off). ⛔ No SipProvider, no CallSessionProvider, no
// NotificationsProvider — this tree must never import the phone stack; the
// entry file (index.driver.js) is the guarantee and this file must keep it.
import React from "react";
import { ActivityIndicator, StatusBar, View } from "react-native";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ThemeProvider, useTheme } from "../context/ThemeContext";
import { AuthProvider, useAuth } from "../context/AuthContext";
import { DeliveryNavigator } from "../navigation/DeliveryNavigator";
import { DriverLoginScreen } from "./DriverLoginScreen";
import { DriverMapScreen } from "../screens/delivery/DriverMapScreen";
import { DriverSettingsScreen } from "../screens/delivery/DriverSettingsScreen";

const queryClient = new QueryClient();
const Stack = createNativeStackNavigator();

function DriverRoot() {
  const { token, isLoading } = useAuth();
  const { colors, isDark } = useTheme();

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const navTheme = {
    ...DefaultTheme,
    colors: { ...DefaultTheme.colors, background: colors.bg, card: colors.bg, text: colors.text, primary: colors.primary, border: colors.border },
  };

  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} backgroundColor={colors.bg} />
      <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        {token ? (
          <>
            <Stack.Screen name="Delivery" component={DeliveryNavigator} />
            <Stack.Screen name="DriverMap" component={DriverMapScreen} options={{ animation: "slide_from_right" }} />
            <Stack.Screen name="DriverSettings" component={DriverSettingsScreen} options={{ animation: "slide_from_bottom" }} />
          </>
        ) : (
          <Stack.Screen name="DriverLogin" component={DriverLoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function DriverApp() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <DriverRoot />
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

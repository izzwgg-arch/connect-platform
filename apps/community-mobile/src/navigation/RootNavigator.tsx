import { NavigationContainer, type NavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useAuth } from "../auth/AuthProvider";
import { registerForPushNotificationsAsync } from "../notifications/push";
import { Button, Icon } from "../ui";
import { useTheme } from "../theme/ThemeProvider";
import { AuthStackNavigator } from "./AuthStack";
import { OnboardingScreen } from "../screens/auth/OnboardingScreen";
import { RootTabs } from "./Tabs";
import { buildLinking, resolveDeepLinkPath } from "./linking";
import type { RootStackParamList } from "./types";
import { ComposerScreen } from "../screens/home/ComposerScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();

function LockScreen() {
  const { theme } = useTheme();
  const { unlock } = useAuth();
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center", gap: 16 }}>
      <Icon name="lock" size={40} />
      <Text style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}>Loopcom Community is locked</Text>
      <Button title="Unlock" kind="primary" onPress={unlock} testID="lock-unlock" />
    </View>
  );
}

function AppNavigator() {
  const navRef = useRef<NavigationContainerRef<RootStackParamList>>(null);

  useEffect(() => {
    registerForPushNotificationsAsync().catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const href = response.notification.request.content.data?.href as string | undefined;
      if (!href) return;
      const target = resolveDeepLinkPath(href);
      if (!target) return;
      // Navigate within the Home tab's stack for content targets; the
      // navigator resolves nested screens by name across the tree.
      (navRef.current as any)?.navigate("App", { screen: "HomeTab", params: { screen: target.screen, params: target.params } });
    });
    return () => sub.remove();
  }, []);

  return (
    <NavigationContainer ref={navRef} linking={buildLinking()}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="App">{() => <RootTabs onOpenComposer={() => navRef.current?.navigate("Composer" as never)} />}</Stack.Screen>
        <Stack.Screen name="Composer" component={ComposerScreen} options={{ presentation: "modal", headerShown: false }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export function RootNavigator() {
  const { theme } = useTheme();
  const { me, loading, locked } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  if (!me) {
    return (
      <NavigationContainer>
        <AuthStackNavigator />
      </NavigationContainer>
    );
  }

  if (locked) return <LockScreen />;

  if (!me.person.onboardingDone) {
    return <OnboardingScreen />;
  }

  return <AppNavigator />;
}

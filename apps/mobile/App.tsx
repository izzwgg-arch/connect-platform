import "react-native-gesture-handler";
import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { ActivityIndicator, View } from "react-native";
import { AuthProvider, useAuth } from "./src/context/AuthContext";
import { SipProvider } from "./src/context/SipContext";
import { LoginScreen } from "./src/screens/LoginScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { QrProvisionScreen } from "./src/screens/QrProvisionScreen";
import { DialpadScreen } from "./src/screens/DialpadScreen";
import { CallHistoryScreen } from "./src/screens/CallHistoryScreen";

const Stack = createNativeStackNavigator();

function RootNavigator() {
  const { token, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!token ? (
          <Stack.Screen name="Login" component={LoginScreen} />
        ) : (
          <>
            <Stack.Screen name="Home" component={HomeScreen} />
            <Stack.Screen name="QrProvision" component={QrProvisionScreen} />
            <Stack.Screen name="Dialpad" component={DialpadScreen} />
            <Stack.Screen name="CallHistory" component={CallHistoryScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <SipProvider>
        <RootNavigator />
      </SipProvider>
    </AuthProvider>
  );
}

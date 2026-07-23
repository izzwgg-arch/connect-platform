import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { RunsScreen } from "../screens/delivery/RunsScreen";
import { ScanScreen } from "../screens/delivery/ScanScreen";
import { DeliveryStopScreen } from "../screens/delivery/DeliveryStopScreen";
import { DeliveryProofScreen } from "../screens/delivery/DeliveryProofScreen";
import { DeliveryExceptionScreen } from "../screens/delivery/DeliveryExceptionScreen";
import { DeliverySyncScreen } from "../screens/delivery/DeliverySyncScreen";
import { useTheme } from "../context/ThemeContext";

const Stack = createNativeStackNavigator();

// Self-contained driver delivery flow. Registered in AppNavigator as "Delivery".
export function DeliveryNavigator() {
  const { colors } = useTheme();
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="DeliveryRuns" component={RunsScreen} />
      <Stack.Screen name="DeliveryScan" component={ScanScreen} />
      <Stack.Screen name="DeliveryStop" component={DeliveryStopScreen} />
      <Stack.Screen name="DeliveryProof" component={DeliveryProofScreen} />
      <Stack.Screen name="DeliveryException" component={DeliveryExceptionScreen} />
      <Stack.Screen name="DeliverySync" component={DeliverySyncScreen} />
    </Stack.Navigator>
  );
}

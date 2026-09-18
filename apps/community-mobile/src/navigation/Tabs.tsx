import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { View } from "react-native";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "../ui/Icon";
import { useTheme } from "../theme/ThemeProvider";
import type { RootTabParamList } from "./types";
import { HomeStackNavigator, MeStackNavigator, MessagesStackNavigator, NetworkStackNavigator } from "./stacks";

const Tab = createBottomTabNavigator<RootTabParamList>();

/** A no-op screen: the Post tab is intercepted by tabPress to open the Composer modal instead of navigating here. */
function PostPlaceholder() {
  return <View style={{ flex: 1 }} />;
}

function Badge({ count }: { count: number }) {
  const { theme } = useTheme();
  if (!count) return null;
  return (
    <View
      accessibilityLabel={`${count} unread`}
      style={{ position: "absolute", top: -4, right: -8, backgroundColor: theme.danger, borderRadius: 8, minWidth: 16, height: 16, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 }}
    >
      <View />
    </View>
  );
}

export function RootTabs({ onOpenComposer }: { onOpenComposer: () => void }) {
  const { theme } = useTheme();
  const { me } = useAuth();

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.dim,
        tabBarStyle: { backgroundColor: theme.panel, borderTopColor: theme.border },
      }}
    >
      <Tab.Screen
        name="HomeTab"
        component={HomeStackNavigator}
        options={{ title: "Home", tabBarIcon: ({ color, size }) => <Icon name="home" color={color} size={size} />, tabBarAccessibilityLabel: "Home" }}
      />
      <Tab.Screen
        name="NetworkTab"
        component={NetworkStackNavigator}
        options={{ title: "Network", tabBarIcon: ({ color, size }) => <Icon name="people" color={color} size={size} />, tabBarAccessibilityLabel: "Network" }}
      />
      <Tab.Screen
        name="PostTab"
        component={PostPlaceholder}
        options={{
          title: "Post",
          tabBarIcon: ({ color, size }) => <Icon name="plus" color={color} size={size} />,
          tabBarAccessibilityLabel: "Create a post",
        }}
        listeners={{
          tabPress: (e) => {
            e.preventDefault();
            onOpenComposer();
          },
        }}
      />
      <Tab.Screen
        name="MessagesTab"
        component={MessagesStackNavigator}
        options={{
          title: "Messages",
          tabBarIcon: ({ color, size }) => <Icon name="chat" color={color} size={size} />,
          tabBarBadge: me?.counts.messages ? me.counts.messages : undefined,
          tabBarAccessibilityLabel: "Messages",
        }}
      />
      <Tab.Screen
        name="MeTab"
        component={MeStackNavigator}
        options={{
          title: "Me",
          tabBarIcon: ({ color, size }) => <Icon name="gear" color={color} size={size} />,
          tabBarBadge: me?.counts.notifications ? me.counts.notifications : undefined,
          tabBarAccessibilityLabel: "Me",
        }}
      />
    </Tab.Navigator>
  );
}

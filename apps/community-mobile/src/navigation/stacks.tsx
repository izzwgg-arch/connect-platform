import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useTheme } from "../theme/ThemeProvider";
import type { HomeStackParamList, MeStackParamList, MessagesStackParamList, NetworkStackParamList } from "./types";
import { FeedScreen } from "../screens/home/FeedScreen";
import { PostDetailScreen } from "../screens/home/PostDetailScreen";
import { ExternalLinkScreen } from "../screens/home/ExternalLinkScreen";
import { PersonProfileScreen } from "../screens/profile/PersonProfileScreen";
import { CompanyScreen } from "../screens/company/CompanyScreen";
import { NetworkScreen } from "../screens/network/NetworkScreen";
import { ConnectionsScreen } from "../screens/network/ConnectionsScreen";
import { ThreadListScreen } from "../screens/messages/ThreadListScreen";
import { ConversationScreen } from "../screens/messages/ConversationScreen";
import { NewMessageScreen } from "../screens/messages/NewMessageScreen";
import { MeScreen } from "../screens/me/MeScreen";
import { EditProfileScreen } from "../screens/me/EditProfileScreen";
import { QrScreen } from "../screens/me/QrScreen";
import { ScanScreen } from "../screens/me/ScanScreen";
import { SettingsScreen } from "../screens/me/SettingsScreen";
import { SessionsScreen } from "../screens/me/SessionsScreen";
import { SecurityScreen } from "../screens/me/SecurityScreen";
import { NotificationsScreen } from "../screens/notifications/NotificationsScreen";
import { SearchScreen } from "../screens/search/SearchScreen";

function useStackOptions() {
  const { theme } = useTheme();
  return {
    headerStyle: { backgroundColor: theme.panel },
    headerTintColor: theme.text,
    headerShadowVisible: false,
    contentStyle: { backgroundColor: theme.bg },
  } as const;
}

const HomeStack = createNativeStackNavigator<HomeStackParamList>();
export function HomeStackNavigator() {
  const options = useStackOptions();
  return (
    <HomeStack.Navigator screenOptions={options}>
      <HomeStack.Screen name="Feed" component={FeedScreen} options={{ title: "Loopcom Community" }} />
      <HomeStack.Screen name="PostDetail" component={PostDetailScreen} options={{ title: "Post" }} />
      <HomeStack.Screen name="PersonProfile" component={PersonProfileScreen} options={{ title: "Profile" }} />
      <HomeStack.Screen name="Company" component={CompanyScreen} options={{ title: "Company" }} />
      <HomeStack.Screen name="ExternalLink" component={ExternalLinkScreen} options={{ title: "" }} />
    </HomeStack.Navigator>
  );
}

const NetworkStack = createNativeStackNavigator<NetworkStackParamList>();
export function NetworkStackNavigator() {
  const options = useStackOptions();
  return (
    <NetworkStack.Navigator screenOptions={options}>
      <NetworkStack.Screen name="Network" component={NetworkScreen} options={{ title: "My Network" }} />
      <NetworkStack.Screen name="Connections" component={ConnectionsScreen} options={{ title: "Connections" }} />
      <NetworkStack.Screen name="PersonProfile" component={PersonProfileScreen as any} options={{ title: "Profile" }} />
      <NetworkStack.Screen name="Company" component={CompanyScreen as any} options={{ title: "Company" }} />
    </NetworkStack.Navigator>
  );
}

const MessagesStack = createNativeStackNavigator<MessagesStackParamList>();
export function MessagesStackNavigator() {
  const options = useStackOptions();
  return (
    <MessagesStack.Navigator screenOptions={options}>
      <MessagesStack.Screen name="Threads" component={ThreadListScreen} options={{ headerShown: false }} />
      <MessagesStack.Screen name="Conversation" component={ConversationScreen} />
      <MessagesStack.Screen name="NewMessage" component={NewMessageScreen} options={{ title: "New message" }} />
      <MessagesStack.Screen name="PersonProfile" component={PersonProfileScreen as any} options={{ title: "Profile" }} />
    </MessagesStack.Navigator>
  );
}

const MeStack = createNativeStackNavigator<MeStackParamList>();
export function MeStackNavigator() {
  const options = useStackOptions();
  return (
    <MeStack.Navigator screenOptions={options}>
      <MeStack.Screen name="Me" component={MeScreen} options={{ title: "Me" }} />
      <MeStack.Screen name="EditProfile" component={EditProfileScreen} options={{ title: "Edit profile" }} />
      <MeStack.Screen name="Qr" component={QrScreen} options={{ title: "My QR code" }} />
      <MeStack.Screen name="Scan" component={ScanScreen} options={{ title: "Scan" }} />
      <MeStack.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
      <MeStack.Screen name="Sessions" component={SessionsScreen} options={{ title: "Sessions" }} />
      <MeStack.Screen name="Security" component={SecurityScreen} options={{ title: "Security" }} />
      <MeStack.Screen name="Notifications" component={NotificationsScreen} options={{ headerShown: false }} />
      <MeStack.Screen name="Search" component={SearchScreen} options={{ headerShown: false }} />
      <MeStack.Screen name="PersonProfile" component={PersonProfileScreen as any} options={{ title: "Profile" }} />
      <MeStack.Screen name="Company" component={CompanyScreen as any} options={{ title: "Company" }} />
    </MeStack.Navigator>
  );
}

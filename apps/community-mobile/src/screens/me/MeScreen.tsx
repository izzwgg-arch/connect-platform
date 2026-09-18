import * as ImagePicker from "expo-image-picker";
import { Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError, uploadMedia } from "../../api/client";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Avatar, Button, Icon, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { MeStackParamList } from "../../navigation/types";

type Props = NativeStackScreenProps<MeStackParamList, "Me">;

export function MeScreen({ navigation }: Props) {
  const { theme, toggle, themeName } = useTheme();
  const { me, reload, signOut } = useAuth();
  const toast = useToast();

  if (!me) return null;
  const p = me.profile;
  const name = p ? `${p.firstName} ${p.lastName}` : me.person.username;

  async function changeAvatar() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      toast("Photo library access is off.", { kind: "err" });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.85 });
    if (result.canceled) return;
    const asset = result.assets[0];
    try {
      const uploaded = await uploadMedia(asset.uri, asset.fileName ?? "avatar.jpg", asset.mimeType ?? "image/jpeg");
      await api("/me/avatar", { method: "POST", body: { assetId: uploaded.asset.id } });
      await reload();
      toast("Profile photo updated.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  const rows: Array<{ icon: any; label: string; onPress: () => void; testID: string }> = [
    { icon: "edit", label: "Edit profile", onPress: () => navigation.navigate("EditProfile"), testID: "me-edit" },
    { icon: "qr", label: "My QR code", onPress: () => navigation.navigate("Qr"), testID: "me-qr" },
    { icon: "cam", label: "Scan a QR code", onPress: () => navigation.navigate("Scan"), testID: "me-scan" },
    { icon: "bell", label: "Notifications", onPress: () => navigation.navigate("Notifications"), testID: "me-notifications" },
    { icon: "search", label: "Search", onPress: () => navigation.navigate("Search"), testID: "me-search" },
    { icon: "gear", label: "Settings", onPress: () => navigation.navigate("Settings"), testID: "me-settings" },
  ];

  // Cross-stack navigation into the Home stack's "Find & sell" screens — the
  // same getParent() pattern ConnectionsScreen already uses to jump into
  // MessagesTab. Kept in its own section (rather than a new tab) per the
  // brief; a push notification or deep link for any of these paths (see
  // src/navigation/deepLink.ts) reaches the same screens directly.
  function openInHome(screen: string, params?: object) {
    (navigation.getParent() as any)?.navigate("HomeTab", { screen, params });
  }
  const findAndSellRows: Array<{ icon: any; label: string; onPress: () => void; testID: string }> = [
    { icon: "brief", label: "Jobs", onPress: () => openInHome("JobsList"), testID: "me-jobs" },
    { icon: "quote", label: "Request for quotes", onPress: () => openInHome("RfqHome"), testID: "me-rfq" },
    { icon: "cal", label: "Events", onPress: () => openInHome("EventsList"), testID: "me-events" },
    { icon: "group", label: "Groups", onPress: () => openInHome("GroupsList"), testID: "me-groups" },
    { icon: "tag", label: "Opportunities", onPress: () => openInHome("OpportunitiesList"), testID: "me-opportunities" },
    { icon: "wallet", label: "Marketplace", onPress: () => openInHome("MarketplaceList"), testID: "me-marketplace" },
    { icon: "people", label: "CRM", onPress: () => openInHome("Crm"), testID: "me-crm" },
    { icon: "chat", label: "Concierge", onPress: () => openInHome("Concierge"), testID: "me-concierge" },
    { icon: "star", label: "For you", onPress: () => openInHome("ForYou"), testID: "me-for-you" },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <View style={{ alignItems: "center", gap: 8 }}>
          <Pressable onPress={changeAvatar} accessibilityRole="button" accessibilityLabel="Change profile photo">
            <Avatar assetId={p?.avatarAssetId} name={name} size={88} />
          </Pressable>
          <Text style={{ color: theme.text, fontWeight: "800", fontSize: 20 }}>{name}</Text>
          <Text style={{ color: theme.dim }}>@{me.person.username}</Text>
          {p?.headline ? <Text style={{ color: theme.dim }}>{p.headline}</Text> : null}
        </View>

        <View style={{ backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border }}>
          {rows.map((r, i) => (
            <Pressable
              key={r.label}
              onPress={r.onPress}
              accessibilityRole="button"
              testID={r.testID}
              style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderTopWidth: i ? 1 : 0, borderColor: theme.border }}
            >
              <Icon name={r.icon} size={20} />
              <Text style={{ color: theme.text, flex: 1, fontSize: 15 }}>{r.label}</Text>
              <Icon name="arrow" size={16} color={theme.dim} />
            </Pressable>
          ))}
        </View>

        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.dim, fontWeight: "800", fontSize: 13, textTransform: "uppercase" }}>Find & sell</Text>
          <View style={{ backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border }}>
            {findAndSellRows.map((r, i) => (
              <Pressable
                key={r.label}
                onPress={r.onPress}
                accessibilityRole="button"
                testID={r.testID}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderTopWidth: i ? 1 : 0, borderColor: theme.border }}
              >
                <Icon name={r.icon} size={20} />
                <Text style={{ color: theme.text, flex: 1, fontSize: 15 }}>{r.label}</Text>
                <Icon name="arrow" size={16} color={theme.dim} />
              </Pressable>
            ))}
          </View>
        </View>

        <Button title={themeName === "dark" ? "Switch to light mode" : "Switch to dark mode"} icon={themeName === "dark" ? "sun" : "moon"} onPress={toggle} testID="me-theme" />
        <Button title="Sign out" kind="danger" onPress={signOut} testID="me-signout" />
      </ScrollView>
    </SafeAreaView>
  );
}

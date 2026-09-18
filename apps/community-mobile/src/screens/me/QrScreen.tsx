import QRCode from "react-native-qrcode-svg";
import { SafeAreaView, Text, View } from "react-native";
import { useAuth } from "../../auth/AuthProvider";
import { useTheme } from "../../theme/ThemeProvider";

export function QrScreen() {
  const { theme } = useTheme();
  const { me } = useAuth();
  const url = `https://community.loopcom.net/people/${me?.person.username ?? ""}?via=qr`;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center", gap: 20, padding: 24 }}>
      <View style={{ backgroundColor: "#fff", padding: 20, borderRadius: 20 }}>
        <QRCode value={url} size={220} />
      </View>
      <Text style={{ color: theme.text, fontWeight: "800", fontSize: 18 }}>@{me?.person.username}</Text>
      <Text style={{ color: theme.dim, textAlign: "center" }}>Let someone scan this to connect with you instantly.</Text>
    </SafeAreaView>
  );
}

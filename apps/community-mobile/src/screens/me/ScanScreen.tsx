import * as Contacts from "expo-contacts";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { SafeAreaView, Share, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import type { PersonCard } from "../../api/types";
import { Avatar, Button, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { MeStackParamList } from "../../navigation/types";

type Resolved = { person: PersonCard; relationship: { degree: number; connectionStatus: string } };

export function ScanScreen({ navigation }: NativeStackScreenProps<MeStackParamList, "Scan">) {
  const { theme } = useTheme();
  const toast = useToast();
  const [permission, requestPermission] = useCameraPermissions();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const scanned = useRef(false);

  async function onScanned(code: string) {
    if (scanned.current) return;
    scanned.current = true;
    try {
      const res = await api<Resolved>(`/qr/resolve?code=${encodeURIComponent(code)}`);
      setResolved(res);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
      setTimeout(() => (scanned.current = false), 1500);
    }
  }

  async function connect() {
    if (!resolved) return;
    try {
      await api("/connections/request", { method: "POST", body: { personId: resolved.person.id } });
      toast("Request sent.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function follow() {
    if (!resolved) return;
    try {
      await api(`/people/${resolved.person.id}/follow`, { method: "POST" });
      toast("Following.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function saveContact() {
    if (!resolved) return;
    const perm = await Contacts.requestPermissionsAsync();
    if (!perm.granted) {
      toast("Contacts access is off — sharing their card instead.", { kind: "err" });
      await Share.share({ message: `${resolved.person.name} — https://community.loopcom.net/people/${resolved.person.username}` });
      return;
    }
    await Contacts.addContactAsync({
      [Contacts.Fields.FirstName]: resolved.person.firstName,
      [Contacts.Fields.LastName]: resolved.person.lastName,
      contactType: Contacts.ContactTypes.Person,
    } as any);
    toast("Saved to your contacts.");
  }

  async function met() {
    if (!resolved) return;
    try {
      await api("/qr/met", { method: "POST", body: { personId: resolved.person.id } });
      toast("Noted that you met in person.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  if (!permission) return null;
  if (!permission.granted) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
        <Text style={{ color: theme.text, textAlign: "center" }}>Camera access is needed to scan a profile QR code.</Text>
        <Button title="Allow camera" kind="primary" onPress={requestPermission} testID="scan-allow" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#000" }}>
      {!resolved ? (
        <CameraView
          style={{ flex: 1 }}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={(e) => onScanned(e.data)}
        />
      ) : (
        <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center", gap: 14, padding: 24 }}>
          <Avatar assetId={resolved.person.avatarAssetId} name={resolved.person.name} size={80} />
          <Text style={{ color: theme.text, fontWeight: "800", fontSize: 18 }}>{resolved.person.name}</Text>
          {resolved.person.headline ? <Text style={{ color: theme.dim }}>{resolved.person.headline}</Text> : null}
          <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
            {resolved.relationship.connectionStatus === "none" ? <Button title="Connect" kind="primary" onPress={connect} testID="scan-connect" /> : null}
            <Button title="Follow" onPress={follow} testID="scan-follow" />
            <Button title="Save contact" onPress={saveContact} testID="scan-save" />
            <Button title="We just met" onPress={met} testID="scan-met" />
          </View>
          <Button title="Scan another" kind="ghost" onPress={() => { setResolved(null); scanned.current = false; }} />
        </View>
      )}
    </SafeAreaView>
  );
}

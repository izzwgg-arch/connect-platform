import React, { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ScrollView } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { submitProof } from "../../delivery/deliveryClient";

const HANDOVERS = [
  { key: "handed_to_customer", label: "Handed to customer" },
  { key: "left_at_door", label: "Left at door" },
  { key: "household_member", label: "Household member" },
  { key: "reception", label: "Reception" },
];

export function DeliveryProofScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const { colors } = useTheme();
  const { orderId, orderRef } = (useRoute<any>().params) || {};
  const { token } = useAuth();
  const [handover, setHandover] = useState("handed_to_customer");
  const [recipient, setRecipient] = useState("");
  const [photo, setPhoto] = useState<{ base64: string; mime: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert("Camera needed", "Allow the camera to capture proof.");
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.5, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (!res.canceled && res.assets?.[0]?.base64) setPhoto({ base64: res.assets[0].base64, mime: res.assets[0].mimeType || "image/jpeg" });
  }

  async function submit() {
    setBusy(true);
    try {
      let gps: any = {};
      try {
        const loc = await Location.getCurrentPositionAsync({});
        gps = { gpsLat: loc.coords.latitude, gpsLng: loc.coords.longitude, gpsAccuracy: loc.coords.accuracy };
      } catch { /* proximity override handled server-side if far */ }
      const r = await submitProof(token!, orderId, {
        handover, recipientName: recipient || undefined,
        photoBase64: photo?.base64, photoMime: photo?.mime, ...gps,
      });
      if (r.ok) { Alert.alert("Delivered", "Proof captured."); nav.popToTop(); }
      else Alert.alert("Can't complete", (r.blocks || r.missingProof || ["Check the requirements"]).join(", "));
    } catch (e: any) {
      Alert.alert("Couldn't submit", e?.message || "Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={[styles.fill, { backgroundColor: colors.bg, paddingTop: insets.top + 8 }]} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Text style={[styles.h1, { color: colors.text }]}>Proof of delivery {orderRef || ""}</Text>

      <Text style={[styles.lab, { color: colors.textTertiary }]}>Handover</Text>
      <View style={styles.wrap}>
        {HANDOVERS.map((h) => (
          <TouchableOpacity key={h.key} style={[styles.chip, { backgroundColor: colors.surface, borderColor: colors.border }, handover === h.key && { backgroundColor: colors.primaryMuted, borderColor: colors.primary }]} onPress={() => setHandover(h.key)}>
            <Text style={[styles.chipText, { color: colors.textSecondary }, handover === h.key && { color: colors.text }]}>{h.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={[styles.lab, { color: colors.textTertiary }]}>Recipient name (optional)</Text>
      <TextInput style={[styles.input, { backgroundColor: colors.surfaceElevated, borderColor: colors.border, color: colors.text }]} value={recipient} onChangeText={setRecipient} placeholder="Name" placeholderTextColor={colors.textTertiary} />

      <TouchableOpacity style={[styles.btnSec, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} onPress={takePhoto}>
        <Text style={[styles.btnSecText, { color: colors.text }]}>{photo ? "✓ Photo captured — retake" : "📷  Take proof photo"}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary }, busy && { opacity: 0.6 }]} disabled={busy} onPress={submit}>
        <Text style={[styles.btnText, { color: colors.white }]}>Complete delivery</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  h1: { fontSize: 18, fontWeight: "700" },
  lab: { fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: "700" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12 },
  chipText: { fontSize: 12.5 },
  input: { borderWidth: 1, borderRadius: 11, padding: 12, fontSize: 14 },
  btn: { borderRadius: 12, padding: 14, alignItems: "center", marginTop: 4 },
  btnText: { fontWeight: "700", fontSize: 15 },
  btnSec: { borderWidth: 1, borderRadius: 12, padding: 13, alignItems: "center" },
  btnSecText: { fontWeight: "600" },
});

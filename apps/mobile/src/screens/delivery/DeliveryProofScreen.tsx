import React, { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ScrollView } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
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
    <ScrollView style={[styles.fill, { paddingTop: insets.top + 8 }]} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Text style={styles.h1}>Proof of delivery {orderRef || ""}</Text>

      <Text style={styles.lab}>Handover</Text>
      <View style={styles.wrap}>
        {HANDOVERS.map((h) => (
          <TouchableOpacity key={h.key} style={[styles.chip, handover === h.key && styles.chipSel]} onPress={() => setHandover(h.key)}>
            <Text style={[styles.chipText, handover === h.key && styles.chipTextSel]}>{h.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.lab}>Recipient name (optional)</Text>
      <TextInput style={styles.input} value={recipient} onChangeText={setRecipient} placeholder="Name" placeholderTextColor="#5f7186" />

      <TouchableOpacity style={styles.btnSec} onPress={takePhoto}>
        <Text style={styles.btnSecText}>{photo ? "✓ Photo captured — retake" : "📷  Take proof photo"}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.btn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submit}>
        <Text style={styles.btnText}>Complete delivery</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#0c1218" },
  h1: { color: "#e1e9f1", fontSize: 18, fontWeight: "700" },
  lab: { color: "#5f7186", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: "700" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderColor: "#26374a", borderWidth: 1, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: "#141f2b" },
  chipSel: { borderColor: "#22a8ff", backgroundColor: "rgba(34,168,255,0.1)" },
  chipText: { color: "#8ea0b2", fontSize: 12.5 },
  chipTextSel: { color: "#e1e9f1" },
  input: { backgroundColor: "#1a2635", borderColor: "#26374a", borderWidth: 1, borderRadius: 11, padding: 12, color: "#e1e9f1", fontSize: 14 },
  btn: { backgroundColor: "#22a8ff", borderRadius: 12, padding: 14, alignItems: "center", marginTop: 4 },
  btnText: { color: "#00121f", fontWeight: "700", fontSize: 15 },
  btnSec: { backgroundColor: "#1a2635", borderColor: "#26374a", borderWidth: 1, borderRadius: 12, padding: 13, alignItems: "center" },
  btnSecText: { color: "#e1e9f1", fontWeight: "600" },
});

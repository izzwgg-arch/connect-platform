import React, { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ScrollView } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { submitException } from "../../delivery/deliveryClient";

const REASONS = [
  { key: "customer_unavailable", label: "Customer unavailable" },
  { key: "cannot_access", label: "Can't access building" },
  { key: "incorrect_address", label: "Incorrect address" },
  { key: "refused", label: "Customer refused" },
  { key: "damaged", label: "Order damaged" },
  { key: "age_verification_failed", label: "Age check failed" },
  { key: "other", label: "Other" },
];

export function DeliveryExceptionScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const { colors } = useTheme();
  const { orderId, orderRef } = (useRoute<any>().params) || {};
  const { token } = useAuth();
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<{ base64: string; mime: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert("Camera needed", "Allow the camera to attach a photo.");
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.5, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (!res.canceled && res.assets?.[0]?.base64) setPhoto({ base64: res.assets[0].base64, mime: res.assets[0].mimeType || "image/jpeg" });
  }

  async function submit() {
    if (!reason) return;
    setBusy(true);
    try {
      const r = await submitException(token!, orderId, { reason, note: note || undefined, photoBase64: photo?.base64, photoMime: photo?.mime });
      if (r.ok) { Alert.alert("Reported", "Dispatch has been notified."); nav.popToTop(); }
      else Alert.alert("Incomplete", `Missing: ${(r.missing || ["details"]).join(", ")}`);
    } catch (e: any) {
      Alert.alert("Couldn't submit", e?.message || "Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={[styles.fill, { backgroundColor: colors.bg, paddingTop: insets.top + 8 }]} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={[styles.h1, { color: colors.text }]}>Report a problem {orderRef || ""}</Text>
      <Text style={[styles.lab, { color: colors.textTertiary }]}>What happened?</Text>
      {REASONS.map((r) => (
        <TouchableOpacity key={r.key} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }, reason === r.key && { borderColor: colors.primary, backgroundColor: colors.primaryMuted }]} onPress={() => setReason(r.key)}>
          <Text style={[styles.rowText, { color: colors.textSecondary }, reason === r.key && { color: colors.text }]}>{r.label}</Text>
        </TouchableOpacity>
      ))}

      <Text style={[styles.lab, { color: colors.textTertiary }]}>Note {reason === "other" ? "(required)" : "(optional)"}</Text>
      <TextInput style={[styles.input, { backgroundColor: colors.surfaceElevated, borderColor: colors.border, color: colors.text }]} value={note} onChangeText={setNote} placeholder="Add details…" placeholderTextColor={colors.textTertiary} multiline />

      <TouchableOpacity style={[styles.btnSec, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} onPress={takePhoto}>
        <Text style={[styles.btnSecText, { color: colors.text }]}>{photo ? "✓ Photo attached — retake" : "📷  Add photo"}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary }, (!reason || busy) && { opacity: 0.5 }]} disabled={!reason || busy} onPress={submit}>
        <Text style={[styles.btnText, { color: colors.white }]}>Submit</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  h1: { fontSize: 18, fontWeight: "700" },
  lab: { fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: "700", marginTop: 6 },
  row: { borderWidth: 1, borderRadius: 11, padding: 13 },
  rowText: { fontSize: 13.5 },
  input: { borderWidth: 1, borderRadius: 11, padding: 12, fontSize: 14, minHeight: 64, textAlignVertical: "top" },
  btn: { borderRadius: 12, padding: 14, alignItems: "center", marginTop: 4 },
  btnText: { fontWeight: "700", fontSize: 15 },
  btnSec: { borderWidth: 1, borderRadius: 12, padding: 13, alignItems: "center" },
  btnSecText: { fontWeight: "600" },
});

import React, { useMemo, useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ScrollView, PanResponder } from "react-native";
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

  // Delivery PIN — shown for signature/age-restricted orders. The screen doesn't yet
  // know the requirement (no per-order flag in route params), so a toggle reveals it.
  // TODO: when the runs/stop API exposes `requiresPin`/`requiresSignature`, default these
  // from route.params instead of the manual toggles.
  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState("");

  // Lightweight signature pad backed by PanResponder — records stroke points and marks the
  // signature as provided. No native signature dependency (pnpm store is locked).
  const [sigPoints, setSigPoints] = useState<{ x: number; y: number }[]>([]);
  const sigPointsRef = useRef<{ x: number; y: number }[]>([]);
  const signatureCaptured = sigPoints.length > 0;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const { locationX, locationY } = e.nativeEvent;
          sigPointsRef.current = [...sigPointsRef.current, { x: locationX, y: locationY }];
          setSigPoints(sigPointsRef.current);
        },
        onPanResponderMove: (e) => {
          const { locationX, locationY } = e.nativeEvent;
          sigPointsRef.current = [...sigPointsRef.current, { x: locationX, y: locationY }];
          setSigPoints(sigPointsRef.current);
        },
      }),
    [],
  );

  function clearSignature() {
    sigPointsRef.current = [];
    setSigPoints([]);
  }

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
        photoBase64: photo?.base64, photoMime: photo?.mime,
        pin: pinRequired && pin ? pin : undefined,
        signatureCaptured,
        ...gps,
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

      <TouchableOpacity
        style={[styles.toggleRow, { backgroundColor: colors.surface, borderColor: pinRequired ? colors.primary : colors.border }]}
        onPress={() => setPinRequired((v) => !v)}
      >
        <Text style={[styles.btnSecText, { color: colors.text }]}>Enter delivery PIN</Text>
        <View style={[styles.toggleDot, { backgroundColor: pinRequired ? colors.primary : colors.textTertiary }]} />
      </TouchableOpacity>
      {pinRequired ? (
        <TextInput
          style={[styles.input, styles.pinInput, { backgroundColor: colors.surfaceElevated, borderColor: colors.border, color: colors.text }]}
          value={pin}
          onChangeText={(t) => setPin(t.replace(/[^0-9]/g, "").slice(0, 6))}
          keyboardType="number-pad"
          maxLength={6}
          placeholder="4-digit code from the customer"
          placeholderTextColor={colors.textTertiary}
        />
      ) : null}

      <View style={styles.between}>
        <Text style={[styles.lab, { color: colors.textTertiary }]}>Signature</Text>
        {signatureCaptured ? (
          <TouchableOpacity onPress={clearSignature}>
            <Text style={[styles.clear, { color: colors.primary }]}>Clear</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <View
        {...panResponder.panHandlers}
        style={[styles.sigPad, { backgroundColor: colors.surfaceElevated, borderColor: signatureCaptured ? colors.primary : colors.border }]}
      >
        {!signatureCaptured ? (
          <Text style={[styles.sigHint, { color: colors.textTertiary }]}>Ask the recipient to sign here</Text>
        ) : null}
        {sigPoints.map((p, i) => (
          <View key={i} style={[styles.sigDot, { backgroundColor: colors.text, left: p.x - 1.5, top: p.y - 1.5 }]} />
        ))}
      </View>
      {signatureCaptured ? <Text style={[styles.sigCaptured, { color: colors.successText }]}>✓ Signature captured</Text> : null}

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
  pinInput: { fontSize: 20, letterSpacing: 6, textAlign: "center", fontVariant: ["tabular-nums"] },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderRadius: 12, padding: 13 },
  toggleDot: { width: 14, height: 14, borderRadius: 7 },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  clear: { fontSize: 13, fontWeight: "700" },
  sigPad: { height: 160, borderWidth: 1, borderRadius: 12, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  sigHint: { fontSize: 13 },
  sigDot: { position: "absolute", width: 3, height: 3, borderRadius: 1.5 },
  sigCaptured: { fontSize: 12.5, fontWeight: "600" },
  btn: { borderRadius: 12, padding: 14, alignItems: "center", marginTop: 4 },
  btnText: { fontWeight: "700", fontSize: 15 },
  btnSec: { borderWidth: 1, borderRadius: 12, padding: 13, alignItems: "center" },
  btnSecText: { fontWeight: "600" },
});

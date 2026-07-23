import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Linking, Alert } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { getStopNav, markArrived } from "../../delivery/deliveryClient";

// Current-stop screen: navigate (Waze) → arrive → deliver (proof) / report issue (exception).
export function DeliveryStopScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const { colors } = useTheme();
  const { orderId, orderRef, addr } = route.params || {};
  const { token } = useAuth();
  const [arrived, setArrived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showNavChooser, setShowNavChooser] = useState(false);

  async function navigateToStop(app: "waze" | "google") {
    setShowNavChooser(false);
    try {
      const { url } = await getStopNav(token!, orderId, app);
      await Linking.openURL(url);
    } catch (e: any) {
      Alert.alert("Navigation unavailable", e?.body?.code === "no_coords" ? "This stop has no map coordinates yet." : "Couldn't open navigation.");
    }
  }

  async function arrive() {
    setBusy(true);
    try {
      await markArrived(token!, orderId);
      setArrived(true);
    } catch {
      Alert.alert("Couldn't mark arrival", "Make sure you're out for delivery and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.fill, { backgroundColor: colors.bg, paddingTop: insets.top + 8 }]}>
      <View style={styles.appbar}>
        <TouchableOpacity onPress={() => nav.goBack()}><Text style={[styles.back, { color: colors.textSecondary }]}>‹</Text></TouchableOpacity>
        <Text style={[styles.h1, { color: colors.text }]}>Stop {orderRef || ""}</Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.addr, { color: colors.text }]}>{addr || "Delivery address"}</Text>
      </View>

      <View style={{ flex: 1 }} />

      <View style={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 16, gap: 10 }}>
        {!showNavChooser ? (
          <TouchableOpacity style={[styles.btnSec, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} onPress={() => setShowNavChooser(true)}>
            <Text style={[styles.btnSecText, { color: colors.text }]}>🧭  Navigate</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.navChooser}>
            <TouchableOpacity style={[styles.btnSec, styles.navOption, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} onPress={() => navigateToStop("google")}>
              <Text style={[styles.btnSecText, { color: colors.text }]}>🗺  Google Maps</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btnSec, styles.navOption, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} onPress={() => navigateToStop("waze")}>
              <Text style={[styles.btnSecText, { color: colors.text }]}>🧭  Waze</Text>
            </TouchableOpacity>
          </View>
        )}

        {!arrived ? (
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary }, busy && { opacity: 0.6 }]} disabled={busy} onPress={arrive}>
            <Text style={[styles.btnText, { color: colors.white }]}>I've arrived</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary }]} onPress={() => nav.navigate("DeliveryProof", { orderId, orderRef })}>
              <Text style={[styles.btnText, { color: colors.white }]}>Deliver — capture proof</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btnGhost, { borderColor: colors.border }]} onPress={() => nav.navigate("DeliveryException", { orderId, orderRef })}>
              <Text style={[styles.btnGhostText, { color: colors.textSecondary }]}>Report a problem</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  appbar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingBottom: 8 },
  back: { fontSize: 26 },
  h1: { fontSize: 18, fontWeight: "700" },
  card: { borderWidth: 1, borderRadius: 14, padding: 16, margin: 16 },
  addr: { fontSize: 15, fontWeight: "600" },
  btn: { borderRadius: 12, padding: 14, alignItems: "center" },
  btnText: { fontWeight: "700", fontSize: 15 },
  navChooser: { flexDirection: "row", gap: 10 },
  navOption: { flex: 1 },
  btnSec: { borderWidth: 1, borderRadius: 12, padding: 14, alignItems: "center" },
  btnSecText: { fontWeight: "600", fontSize: 14 },
  btnGhost: { borderWidth: 1, borderRadius: 12, padding: 13, alignItems: "center" },
  btnGhostText: { fontWeight: "600" },
});

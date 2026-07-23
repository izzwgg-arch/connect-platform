import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Linking, Alert } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
import { getStopNav, markArrived } from "../../delivery/deliveryClient";

// Current-stop screen: navigate (Waze) → arrive → deliver (proof) / report issue (exception).
export function DeliveryStopScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const { orderId, orderRef, addr } = route.params || {};
  const { token } = useAuth();
  const [arrived, setArrived] = useState(false);
  const [busy, setBusy] = useState(false);

  async function navigateToStop() {
    try {
      const { url } = await getStopNav(token!, orderId, "waze");
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
    <View style={[styles.fill, { paddingTop: insets.top + 8 }]}>
      <View style={styles.appbar}>
        <TouchableOpacity onPress={() => nav.goBack()}><Text style={styles.back}>‹</Text></TouchableOpacity>
        <Text style={styles.h1}>Stop {orderRef || ""}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.addr}>{addr || "Delivery address"}</Text>
      </View>

      <View style={{ flex: 1 }} />

      <View style={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 16, gap: 10 }}>
        <TouchableOpacity style={styles.btnSec} onPress={navigateToStop}>
          <Text style={styles.btnSecText}>🧭  Navigate with Waze</Text>
        </TouchableOpacity>

        {!arrived ? (
          <TouchableOpacity style={[styles.btn, busy && { opacity: 0.6 }]} disabled={busy} onPress={arrive}>
            <Text style={styles.btnText}>I've arrived</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity style={styles.btn} onPress={() => nav.navigate("DeliveryProof", { orderId, orderRef })}>
              <Text style={styles.btnText}>Deliver — capture proof</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnGhost} onPress={() => nav.navigate("DeliveryException", { orderId, orderRef })}>
              <Text style={styles.btnGhostText}>Report a problem</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#0c1218" },
  appbar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingBottom: 8 },
  back: { color: "#8ea0b2", fontSize: 26 },
  h1: { color: "#e1e9f1", fontSize: 18, fontWeight: "700" },
  card: { backgroundColor: "#141f2b", borderColor: "#26374a", borderWidth: 1, borderRadius: 14, padding: 16, margin: 16 },
  addr: { color: "#e1e9f1", fontSize: 15, fontWeight: "600" },
  btn: { backgroundColor: "#22a8ff", borderRadius: 12, padding: 14, alignItems: "center" },
  btnText: { color: "#00121f", fontWeight: "700", fontSize: 15 },
  btnSec: { backgroundColor: "#1a2635", borderColor: "#26374a", borderWidth: 1, borderRadius: 12, padding: 14, alignItems: "center" },
  btnSecText: { color: "#e1e9f1", fontWeight: "600", fontSize: 14 },
  btnGhost: { borderColor: "#26374a", borderWidth: 1, borderRadius: 12, padding: 13, alignItems: "center" },
  btnGhostText: { color: "#8ea0b2", fontWeight: "600" },
});

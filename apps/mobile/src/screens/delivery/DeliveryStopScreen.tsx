import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Linking, Alert, Platform } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { getStopNav, markArrived } from "../../delivery/deliveryClient";
import { getNavPrefs, setNavPrefs, type NavApp, type NavPrefs } from "../../delivery/navPrefs";
import { isDriverApp } from "../../driver/appKind";

// Current-stop screen: navigate (driver's chosen app, or the in-app map) →
// arrive → deliver (proof) / report issue (exception). The main Navigate
// button honors the driver's saved preference; "Choose app" changes it and
// remembers the choice — a one-time question, not a per-stop quiz.
export function DeliveryStopScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const { colors } = useTheme();
  const { orderId, orderRef, addr, customerName, instructions } = route.params || {};
  const { token } = useAuth();
  const [arrived, setArrived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showNavChooser, setShowNavChooser] = useState(false);
  const [prefs, setPrefs] = useState<NavPrefs | null>(null);

  useEffect(() => { getNavPrefs().then(setPrefs); }, []);

  async function openExternal(app: NavApp, remember: boolean) {
    setShowNavChooser(false);
    if (remember) setPrefs(await setNavPrefs({ navApp: app }));
    try {
      const { url } = await getStopNav(token!, orderId, app);
      await Linking.openURL(url);
    } catch (e: any) {
      Alert.alert("Navigation unavailable", e?.body?.code === "no_coords" ? "This stop has no map coordinates yet." : "Couldn't open navigation.");
    }
  }

  function navigatePrimary() {
    if (prefs?.mapMode === "inapp" && isDriverApp()) {
      // The in-app map lives on the DriverApp stack, above this nested navigator.
      nav.navigate("DriverMap", { focusOrderId: orderId });
      return;
    }
    void openExternal(prefs?.navApp ?? "waze", false);
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

  const navApps: Array<{ id: NavApp; label: string }> = [
    { id: "waze", label: "🧭 Waze" },
    { id: "google", label: "🗺 Google Maps" },
    ...(Platform.OS === "ios" ? [{ id: "apple" as NavApp, label: " Apple Maps" }] : []),
  ];

  return (
    <View style={[styles.fill, { backgroundColor: colors.bg, paddingTop: insets.top + 8 }]}>
      <View style={styles.appbar}>
        <TouchableOpacity onPress={() => nav.goBack()}><Text style={[styles.back, { color: colors.textSecondary }]}>‹</Text></TouchableOpacity>
        <Text style={[styles.h1, { color: colors.text }]}>Stop {orderRef || ""}</Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {customerName ? <Text style={[styles.who, { color: colors.text }]}>{customerName}</Text> : null}
        <Text style={[styles.addr, { color: customerName ? colors.textSecondary : colors.text }]}>{addr || "Delivery address"}</Text>
        {instructions ? <Text style={[styles.note, { color: colors.warningText }]}>⚠ {instructions}</Text> : null}
      </View>

      <View style={{ flex: 1 }} />

      <View style={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 16, gap: 10 }}>
        {!showNavChooser ? (
          <View style={styles.navRow}>
            <TouchableOpacity style={[styles.btnSec, styles.navMain, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} onPress={navigatePrimary}>
              <Text style={[styles.btnSecText, { color: colors.text }]}>
                🧭  Navigate{prefs?.mapMode === "inapp" && isDriverApp() ? " (map)" : prefs ? ` (${prefs.navApp === "google" ? "Google Maps" : prefs.navApp === "apple" ? "Apple Maps" : "Waze"})` : ""}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btnSec, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} onPress={() => setShowNavChooser(true)}>
              <Text style={[styles.btnSecText, { color: colors.textSecondary }]}>⋯</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.navChooser}>
            {navApps.map((a) => (
              <TouchableOpacity key={a.id} style={[styles.btnSec, styles.navOption, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} onPress={() => openExternal(a.id, true)}>
                <Text style={[styles.btnSecText, { color: colors.text }]}>{a.label}</Text>
              </TouchableOpacity>
            ))}
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
  who: { fontSize: 16, fontWeight: "700", marginBottom: 3 },
  addr: { fontSize: 15, fontWeight: "600" },
  note: { fontSize: 13, marginTop: 8, fontWeight: "600" },
  btn: { borderRadius: 12, padding: 14, alignItems: "center" },
  btnText: { fontWeight: "700", fontSize: 15 },
  navRow: { flexDirection: "row", gap: 10 },
  navMain: { flex: 1 },
  navChooser: { flexDirection: "row", gap: 10 },
  navOption: { flex: 1 },
  btnSec: { borderWidth: 1, borderRadius: 12, padding: 14, alignItems: "center" },
  btnSecText: { fontWeight: "600", fontSize: 14 },
  btnGhost: { borderWidth: 1, borderRadius: 12, padding: 13, alignItems: "center" },
  btnGhostText: { fontWeight: "600" },
});

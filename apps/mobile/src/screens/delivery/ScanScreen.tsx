import React, { useCallback, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { useDeliveryQueue } from "../../delivery/useDeliveryQueue";

// Phase 4 driver label-scan screen. Enqueues each scan as an offline op (idempotent),
// then flushes to the server. Works offline: the op persists and syncs when connectivity
// returns. Server is authoritative for every scan decision.
export function ScanScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { colors } = useTheme();
  const { token } = useAuth();
  const { enqueueScan, flush, unsyncedCount, blocked } = useDeliveryQueue(token);
  const [permission, requestPermission] = useCameraPermissions();
  const [banner, setBanner] = useState<{ tone: "ok" | "warn" | "info"; text: string } | null>(null);
  const lastScan = useRef<{ code: string; at: number }>({ code: "", at: 0 });

  const onScanned = useCallback(
    async ({ data }: { data: string }) => {
      const now = Date.now();
      // Debounce identical rapid re-reads of the same physical label.
      if (data === lastScan.current.code && now - lastScan.current.at < 2500) return;
      lastScan.current = { code: data, at: now };
      try {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {}
      enqueueScan(data);
      setBanner({ tone: "info", text: "Scanned — saving…" });
      await flush();
      setBanner({ tone: "ok", text: unsyncedCount > 0 ? "Saved. Will sync when online." : "Order added to your run." });
    },
    [enqueueScan, flush, unsyncedCount],
  );

  if (!permission) return <View style={[styles.center, { backgroundColor: colors.bg }]}><Text style={[styles.dim, { color: colors.textSecondary }]}>Preparing camera…</Text></View>;
  if (!permission.granted) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Text style={[styles.title, { color: colors.text }]}>Camera access needed</Text>
        <Text style={[styles.dim, { color: colors.textSecondary }]}>We use the camera only to scan order labels.</Text>
        <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary }]} onPress={requestPermission}>
          <Text style={[styles.btnText, { color: colors.white }]}>Allow camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: colors.bg }]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "ean13", "code39"] }}
        onBarcodeScanned={onScanned}
      />
      <View style={[styles.overlay, { paddingTop: insets.top + 12 }]}>
        <View style={[styles.reticle, { borderColor: colors.primary }]} />
        <Text style={[styles.hint, { color: colors.text }]}>Point at the label barcode</Text>
      </View>
      <View style={[styles.footer, { backgroundColor: colors.overlay, paddingBottom: insets.bottom + 12 }]}>
        {banner ? (
          <Text style={[styles.banner, { color: banner.tone === "warn" ? colors.warningText : banner.tone === "ok" ? colors.successText : colors.primary }]}>{banner.text}</Text>
        ) : null}
        {unsyncedCount > 0 ? <Text style={[styles.pending, { color: colors.textSecondary }]}>{unsyncedCount} action(s) pending sync</Text> : null}
        {blocked.length > 0 ? (
          <TouchableOpacity onPress={() => navigation.navigate("DeliverySync")}>
            <Text style={[styles.pending, styles.pendingLink, { color: colors.warningText }]}>{blocked.length} need your attention (open Sync)</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  reticle: { width: 220, height: 220, borderRadius: 20, borderWidth: 2 },
  hint: { marginTop: 16, fontSize: 14 },
  footer: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 16, gap: 6 },
  banner: { fontSize: 14, fontWeight: "600" },
  pending: { fontSize: 12 },
  pendingLink: { textDecorationLine: "underline", fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700" },
  dim: { fontSize: 13, textAlign: "center" },
  btn: { borderRadius: 12, paddingVertical: 12, paddingHorizontal: 22, marginTop: 8 },
  btnText: { fontWeight: "700" },
});

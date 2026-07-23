import React, { useCallback, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
import { useDeliveryQueue } from "../../delivery/useDeliveryQueue";

// Phase 4 driver label-scan screen. Enqueues each scan as an offline op (idempotent),
// then flushes to the server. Works offline: the op persists and syncs when connectivity
// returns. Server is authoritative for every scan decision.
export function ScanScreen() {
  const insets = useSafeAreaInsets();
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

  if (!permission) return <View style={styles.center}><Text style={styles.dim}>Preparing camera…</Text></View>;
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.dim}>We use the camera only to scan order labels.</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Allow camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "ean13", "code39"] }}
        onBarcodeScanned={onScanned}
      />
      <View style={[styles.overlay, { paddingTop: insets.top + 12 }]}>
        <View style={styles.reticle} />
        <Text style={styles.hint}>Point at the label barcode</Text>
      </View>
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        {banner ? (
          <Text style={[styles.banner, banner.tone === "warn" && styles.warn, banner.tone === "ok" && styles.ok]}>{banner.text}</Text>
        ) : null}
        {unsyncedCount > 0 ? <Text style={styles.pending}>{unsyncedCount} action(s) pending sync</Text> : null}
        {blocked.length > 0 ? (
          <Text style={[styles.pending, styles.warn]}>{blocked.length} need your attention (open Sync)</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#05090e" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24, backgroundColor: "#0c1218" },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  reticle: { width: 220, height: 220, borderRadius: 20, borderWidth: 2, borderColor: "#22a8ff" },
  hint: { color: "#e1e9f1", marginTop: 16, fontSize: 14 },
  footer: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 16, gap: 6, backgroundColor: "rgba(12,18,24,0.85)" },
  banner: { color: "#9fd6ff", fontSize: 14, fontWeight: "600" },
  ok: { color: "#8fe0b6" },
  warn: { color: "#f4cd86" },
  pending: { color: "#8ea0b2", fontSize: 12 },
  title: { color: "#e1e9f1", fontSize: 17, fontWeight: "700" },
  dim: { color: "#8ea0b2", fontSize: 13, textAlign: "center" },
  btn: { backgroundColor: "#22a8ff", borderRadius: 12, paddingVertical: 12, paddingHorizontal: 22, marginTop: 8 },
  btnText: { color: "#00121f", fontWeight: "700" },
});

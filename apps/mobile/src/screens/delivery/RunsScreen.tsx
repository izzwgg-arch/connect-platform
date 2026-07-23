import React, { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, RefreshControl, TouchableOpacity, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
import { getRuns } from "../../delivery/deliveryClient";

const DONE = new Set(["DONE", "DELIVERED", "FAILED", "SKIPPED", "CANCELED"]);

// Driver run list → tap a stop to open it (navigate → arrive → proof/exception).
export function RunsScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const { token } = useAuth();
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try { setRuns(await getRuns(token)); }
    catch (e: any) { setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for your account yet." : "Couldn't load your runs."); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  return (
    <View style={[styles.fill, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <Text style={styles.h1}>Today's runs</Text>
        <TouchableOpacity style={styles.scanBtn} onPress={() => nav.navigate("DeliveryScan")}>
          <Text style={styles.scanText}>⌗ Scan</Text>
        </TouchableOpacity>
      </View>
      {error ? (
        <Text style={styles.dim}>{error}</Text>
      ) : (
        <FlatList
          data={runs}
          keyExtractor={(r) => r.id}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#8ea0b2" />}
          ListEmptyComponent={loading ? null : <Text style={styles.dim}>No runs assigned yet.</Text>}
          contentContainerStyle={{ padding: 16, gap: 12 }}
          renderItem={({ item }) => {
            const stops = item.stops || [];
            const done = stops.filter((s: any) => DONE.has(s.status) || DONE.has(s.order?.status)).length;
            return (
              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.cardTitle}>Run {item.id.slice(-6)}</Text>
                  <Text style={styles.pill}>{item.status}</Text>
                </View>
                <Text style={styles.dim}>{stops.length} stops · {done} done</Text>
                <View style={{ height: 8 }} />
                {stops.map((s: any, i: number) => {
                  const o = s.order || {};
                  const finished = DONE.has(s.status) || DONE.has(o.status);
                  return (
                    <TouchableOpacity key={s.orderId || i} style={styles.stop} disabled={finished}
                      onPress={() => nav.navigate("DeliveryStop", { orderId: o.id || s.orderId, orderRef: `#${i + 1}`, addr: `${o.addrLine1 || "Stop"}${o.addrUnit ? ` ${o.addrUnit}` : ""}` })}>
                      <Text style={[styles.stopNum, finished && { color: "#34c27b" }]}>{finished ? "✓" : i + 1}</Text>
                      <Text style={[styles.stopText, finished && { color: "#5f7186" }]} numberOfLines={1}>
                        {o.addrLine1 || "Stop"}{o.addrUnit ? ` ${o.addrUnit}` : ""}
                      </Text>
                      {!finished && <Text style={styles.chev}>›</Text>}
                    </TouchableOpacity>
                  );
                })}
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#0c1218" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 8 },
  h1: { color: "#e1e9f1", fontSize: 20, fontWeight: "700" },
  scanBtn: { backgroundColor: "#1a2635", borderColor: "#26374a", borderWidth: 1, borderRadius: 10, paddingVertical: 7, paddingHorizontal: 12 },
  scanText: { color: "#22a8ff", fontWeight: "700", fontSize: 13 },
  dim: { color: "#8ea0b2", fontSize: 13, paddingHorizontal: 16 },
  card: { backgroundColor: "#141f2b", borderColor: "#26374a", borderWidth: 1, borderRadius: 14, padding: 14 },
  cardTitle: { color: "#e1e9f1", fontSize: 15, fontWeight: "600" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  pill: { color: "#22a8ff", fontSize: 11, fontWeight: "700", borderColor: "#26374a", borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2, overflow: "hidden" },
  stop: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, borderTopColor: "#26374a", borderTopWidth: 1 },
  stopNum: { width: 22, height: 22, borderRadius: 6, backgroundColor: "#1a2635", color: "#8ea0b2", textAlign: "center", lineHeight: 22, fontSize: 12, fontWeight: "700", overflow: "hidden" },
  stopText: { color: "#e1e9f1", fontSize: 13.5, flex: 1 },
  chev: { color: "#5f7186", fontSize: 18 },
});

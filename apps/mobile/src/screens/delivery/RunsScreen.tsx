import React, { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, RefreshControl, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
import { getRuns } from "../../delivery/deliveryClient";

// Phase 4 driver run list. Read-only view of runs assigned to this driver.
export function RunsScreen() {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      setRuns(await getRuns(token));
    } catch (e: any) {
      setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for your account yet." : "Couldn't load your runs.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={[styles.fill, { paddingTop: insets.top + 8 }]}>
      <Text style={styles.h1}>Today’s runs</Text>
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
            const done = stops.filter((s: any) => s.status === "DONE").length;
            return (
              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.cardTitle}>Run {item.id.slice(-6)}</Text>
                  <Text style={styles.pill}>{item.status}</Text>
                </View>
                <Text style={styles.dim}>
                  {stops.length} stops · {done} delivered
                </Text>
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
  h1: { color: "#e1e9f1", fontSize: 20, fontWeight: "700", paddingHorizontal: 16, paddingVertical: 8 },
  dim: { color: "#8ea0b2", fontSize: 13, paddingHorizontal: 16 },
  card: { backgroundColor: "#141f2b", borderColor: "#26374a", borderWidth: 1, borderRadius: 14, padding: 14 },
  cardTitle: { color: "#e1e9f1", fontSize: 15, fontWeight: "600" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  pill: {
    color: "#22a8ff", fontSize: 11, fontWeight: "700", borderColor: "#26374a", borderWidth: 1,
    borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2, overflow: "hidden",
  },
});

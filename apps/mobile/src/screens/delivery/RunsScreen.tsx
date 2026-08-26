import React, { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, RefreshControl, TouchableOpacity, StyleSheet, Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { getRuns } from "../../delivery/deliveryClient";
import { activeRunSession, startRunTracking, endRunTracking, type ActiveRunSession } from "../../delivery/runTracking";
import { isDriverApp } from "../../driver/appKind";

const DONE = new Set(["DONE", "DELIVERED", "FAILED", "SKIPPED", "CANCELED"]);

// Driver run list → start the run (tracking on) → tap a stop to open it
// (navigate → arrive → proof/exception). In the Loopcom Driver app the header
// also carries the route map and driver settings; the phone app's navigator
// does not register those routes, so the buttons only render there.
export function RunsScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const { colors } = useTheme();
  const { token } = useAuth();
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<ActiveRunSession | null>(null);
  const [trackBusy, setTrackBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try { setRuns(await getRuns(token)); }
    catch (e: any) { setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for your account yet." : "Couldn't load your runs."); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { activeRunSession().then(setSession); }, []);

  async function startRun(runId: string) {
    if (!token || trackBusy) return;
    setTrackBusy(true);
    try {
      const r = await startRunTracking(token, runId);
      if (r.ok) {
        setSession(await activeRunSession());
      } else if (r.code === "location_permission") {
        Alert.alert("Location is required", "Your run can't start without location. Allow location for Loopcom Driver and press Start run again.");
      } else {
        Alert.alert("Couldn't start the run", "Check your connection and try again.");
      }
    } finally {
      setTrackBusy(false);
    }
  }

  async function endRun() {
    if (!token || trackBusy) return;
    setTrackBusy(true);
    try {
      await endRunTracking(token);
      setSession(null);
    } finally {
      setTrackBusy(false);
    }
  }

  return (
    <View style={[styles.fill, { backgroundColor: colors.bg, paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <Text style={[styles.h1, { color: colors.text }]}>Today's runs</Text>
        <View style={styles.headerBtns}>
          {isDriverApp() && (
            <>
              <TouchableOpacity style={[styles.scanBtn, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} onPress={() => nav.navigate("DriverMap")}>
                <Text style={[styles.scanText, { color: colors.primary }]}>🗺 Map</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.scanBtn, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} onPress={() => nav.navigate("DriverSettings")}>
                <Text style={[styles.scanText, { color: colors.textSecondary }]}>⚙</Text>
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity style={[styles.scanBtn, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} onPress={() => nav.navigate("DeliveryScan")}>
            <Text style={[styles.scanText, { color: colors.primary }]}>⌗ Scan</Text>
          </TouchableOpacity>
        </View>
      </View>
      {session && (
        <View style={[styles.trackBar, { backgroundColor: colors.successMuted, borderColor: colors.border }]}>
          <Text style={[styles.trackText, { color: colors.successText }]}>● Location on — run in progress</Text>
          <TouchableOpacity disabled={trackBusy} onPress={endRun}>
            <Text style={[styles.trackEnd, { color: colors.successText }, trackBusy && { opacity: 0.5 }]}>End run</Text>
          </TouchableOpacity>
        </View>
      )}
      {error ? (
        <Text style={[styles.dim, { color: colors.textSecondary }]}>{error}</Text>
      ) : (
        <FlatList
          data={runs}
          keyExtractor={(r) => r.id}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.textSecondary} colors={[colors.textSecondary]} progressBackgroundColor={colors.surface} />}
          ListEmptyComponent={loading ? null : <Text style={[styles.dim, { color: colors.textSecondary }]}>No runs assigned yet.</Text>}
          contentContainerStyle={{ padding: 16, gap: 12 }}
          renderItem={({ item }) => {
            const stops = item.stops || [];
            const done = stops.filter((s: any) => DONE.has(s.status) || DONE.has(s.order?.status)).length;
            const isThisRun = session?.runId === item.id;
            return (
              <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={styles.rowBetween}>
                  <Text style={[styles.cardTitle, { color: colors.text }]}>Run {item.id.slice(-6)}</Text>
                  <Text style={[styles.pill, { color: colors.primary, borderColor: colors.border }]}>{item.status}</Text>
                </View>
                <Text style={[styles.dim, { color: colors.textSecondary }]}>{stops.length} stops · {done} done</Text>
                {!session && (
                  <TouchableOpacity
                    style={[styles.startBtn, { backgroundColor: colors.primary }, trackBusy && { opacity: 0.6 }]}
                    disabled={trackBusy}
                    onPress={() => startRun(item.id)}
                  >
                    <Text style={[styles.startText, { color: colors.white }]}>Start run</Text>
                  </TouchableOpacity>
                )}
                {!session && (
                  <Text style={[styles.startNote, { color: colors.textTertiary }]}>Location turns on when you start and stays on for the whole run.</Text>
                )}
                {isThisRun && <View style={{ height: 8 }} />}
                <View style={{ height: 8 }} />
                {stops.map((s: any, i: number) => {
                  const o = s.order || {};
                  const finished = DONE.has(s.status) || DONE.has(o.status);
                  return (
                    <TouchableOpacity key={s.orderId || i} style={[styles.stop, { borderTopColor: colors.border }]} disabled={finished}
                      onPress={() => nav.navigate("DeliveryStop", { orderId: o.id || s.orderId, orderRef: `#${i + 1}`, addr: `${o.addrLine1 || "Stop"}${o.addrUnit ? ` ${o.addrUnit}` : ""}`, customerName: o.customerName, instructions: o.instructions, lat: o.lat, lng: o.lng })}>
                      <Text style={[styles.stopNum, { backgroundColor: colors.surfaceElevated, color: colors.textSecondary }, finished && { color: colors.success }]}>{finished ? "✓" : i + 1}</Text>
                      <Text style={[styles.stopText, { color: colors.text }, finished && { color: colors.textTertiary }]} numberOfLines={1}>
                        {o.addrLine1 || "Stop"}{o.addrUnit ? ` ${o.addrUnit}` : ""}
                      </Text>
                      {!finished && <Text style={[styles.chev, { color: colors.textTertiary }]}>›</Text>}
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
  fill: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 8 },
  headerBtns: { flexDirection: "row", gap: 8 },
  h1: { fontSize: 20, fontWeight: "700" },
  scanBtn: { borderWidth: 1, borderRadius: 10, paddingVertical: 7, paddingHorizontal: 12 },
  scanText: { fontWeight: "700", fontSize: 13 },
  trackBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginHorizontal: 16, marginBottom: 4, borderWidth: 1, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  trackText: { fontSize: 12.5, fontWeight: "700" },
  trackEnd: { fontSize: 12.5, fontWeight: "800", textDecorationLine: "underline" },
  dim: { fontSize: 13, paddingHorizontal: 16 },
  card: { borderWidth: 1, borderRadius: 14, padding: 14 },
  cardTitle: { fontSize: 15, fontWeight: "600" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  pill: { fontSize: 11, fontWeight: "700", borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2, overflow: "hidden" },
  startBtn: { borderRadius: 10, paddingVertical: 11, alignItems: "center", marginTop: 10 },
  startText: { fontWeight: "800", fontSize: 14 },
  startNote: { fontSize: 11, textAlign: "center", marginTop: 6 },
  stop: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, borderTopWidth: 1 },
  stopNum: { width: 22, height: 22, borderRadius: 6, textAlign: "center", lineHeight: 22, fontSize: 12, fontWeight: "700", overflow: "hidden" },
  stopText: { fontSize: 13.5, flex: 1 },
  chev: { fontSize: 18 },
});

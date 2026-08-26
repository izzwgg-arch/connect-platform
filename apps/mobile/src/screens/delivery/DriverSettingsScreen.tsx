// Loopcom Driver settings (registered only in DriverApp's stack):
//  * where the route lives — inside the app's map, or handed off to a
//    navigation app per leg (Izzy 2026-08-25);
//  * which navigation app — Waze, Google Maps, or Apple Maps on iPhone;
//  * sign out.
// ⛔ There is deliberately NO tracking switch on this screen — location runs
// whenever a run is active, and only the phone's own permission can stop it
// (which alerts the dispatcher). Do not add one.
import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform, Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { getNavPrefs, setNavPrefs, type NavPrefs, type MapMode, type NavApp } from "../../delivery/navPrefs";
import { activeRunSession, endRunTracking } from "../../delivery/runTracking";

const MODES: Array<{ id: MapMode; title: string; sub: string }> = [
  { id: "external", title: "Open my navigation app", sub: "Each stop hands off to Waze, Google Maps, or Apple Maps for turn-by-turn." },
  { id: "inapp", title: "Keep the map in this app", sub: "See the whole route and your position here; Navigate still opens turn-by-turn when you want it." },
];

export function DriverSettingsScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const { colors } = useTheme();
  const { token, logout } = useAuth();
  const [prefs, setPrefs] = useState<NavPrefs | null>(null);

  useEffect(() => { getNavPrefs().then(setPrefs); }, []);

  async function update(next: Partial<NavPrefs>) {
    setPrefs(await setNavPrefs(next));
  }

  async function signOut() {
    // A signed-out phone must never keep reporting location.
    const session = await activeRunSession();
    if (session && token) await endRunTracking(token, "SIGNED_OUT").catch(() => {});
    await logout();
  }

  const apps: Array<{ id: NavApp; label: string }> = [
    { id: "waze", label: "Waze" },
    { id: "google", label: "Google Maps" },
    ...(Platform.OS === "ios" ? [{ id: "apple" as NavApp, label: "Apple Maps" }] : []),
  ];

  return (
    <View style={[styles.fill, { backgroundColor: colors.bg, paddingTop: insets.top + 8 }]}>
      <View style={styles.appbar}>
        <TouchableOpacity onPress={() => nav.goBack()}><Text style={[styles.back, { color: colors.textSecondary }]}>‹</Text></TouchableOpacity>
        <Text style={[styles.h1, { color: colors.text }]}>Settings</Text>
      </View>

      <Text style={[styles.section, { color: colors.textSecondary }]}>THE MAP</Text>
      {MODES.map((m) => {
        const on = prefs?.mapMode === m.id;
        return (
          <TouchableOpacity key={m.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: on ? colors.primary : colors.border }]} onPress={() => update({ mapMode: m.id })}>
            <View style={styles.rowBetween}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>{m.title}</Text>
              <Text style={[styles.radio, { color: on ? colors.primary : colors.textTertiary }]}>{on ? "●" : "○"}</Text>
            </View>
            <Text style={[styles.cardSub, { color: colors.textSecondary }]}>{m.sub}</Text>
          </TouchableOpacity>
        );
      })}

      <Text style={[styles.section, { color: colors.textSecondary }]}>NAVIGATION APP</Text>
      <View style={[styles.segment, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {apps.map((a) => {
          const on = prefs?.navApp === a.id;
          return (
            <TouchableOpacity key={a.id} style={[styles.segBtn, on && { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: 1 }]} onPress={() => update({ navApp: a.id })}>
              <Text style={[styles.segText, { color: on ? colors.primary : colors.textSecondary }]}>{a.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={{ flex: 1 }} />
      <Text style={[styles.note, { color: colors.textTertiary }]}>
        Location is shared only while you're on a run. There's no switch for it here — ending the run or the phone's own
        location permission are the only ways it stops, and your dispatcher is notified if it goes off mid-run.
      </Text>
      <TouchableOpacity
        style={[styles.signOut, { borderColor: colors.border, marginBottom: insets.bottom + 16 }]}
        onPress={() => Alert.alert("Sign out?", "You'll need your login from the setup email to sign back in.", [
          { text: "Cancel", style: "cancel" },
          { text: "Sign out", style: "destructive", onPress: signOut },
        ])}
      >
        <Text style={[styles.signOutText, { color: colors.danger }]}>Sign out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, paddingHorizontal: 16 },
  appbar: { flexDirection: "row", alignItems: "center", gap: 10, paddingBottom: 8 },
  back: { fontSize: 26 },
  h1: { fontSize: 18, fontWeight: "700" },
  section: { fontSize: 11, fontWeight: "800", letterSpacing: 1, marginTop: 18, marginBottom: 8 },
  card: { borderWidth: 1.5, borderRadius: 14, padding: 14, marginBottom: 10 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontSize: 15, fontWeight: "700" },
  cardSub: { fontSize: 12.5, marginTop: 4, lineHeight: 18 },
  radio: { fontSize: 18 },
  segment: { flexDirection: "row", borderWidth: 1, borderRadius: 12, padding: 4, gap: 4 },
  segBtn: { flex: 1, borderRadius: 9, paddingVertical: 11, alignItems: "center" },
  segText: { fontWeight: "700", fontSize: 13.5 },
  note: { fontSize: 12, lineHeight: 18, marginBottom: 12 },
  signOut: { borderWidth: 1, borderRadius: 12, padding: 14, alignItems: "center" },
  signOutText: { fontWeight: "700", fontSize: 14.5 },
});

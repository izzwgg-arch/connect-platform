import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Modal,
  Platform,
} from "react-native";
import Constants from "expo-constants";
import {
  getCallFlowSnapshot,
  subscribeCallFlowDebug,
  logCallFlow,
} from "./callFlowDebug";
import { useSip } from "../context/SipContext";
import { useIncomingNotifications } from "../context/NotificationsContext";

/** Recent buffer substring → checklist (best-effort). */
const STAGE_CHECKS: { label: string; needle: string }[] = [
  { label: "Push (foreground JS)", needle: "PUSH_RECEIVED_FOREGROUND" },
  { label: "Background task", needle: "BACKGROUND_TASK_FIRED" },
  { label: "FCM native handler", needle: "FCM_DATA_INCOMING_CALL" },
  { label: "Native ring start", needle: "RINGTONE_START" },
  { label: "Native ring stop", needle: "RINGTONE_STOP" },
  { label: "Native notification posted", needle: "NATIVE_NOTIFICATION_POSTED" },
  { label: "Incoming screen mount", needle: "INCOMING_CALL_SCREEN_MOUNT" },
  { label: "Answer tapped", needle: "ANSWER_TAPPED" },
  { label: "SIP answer start", needle: "SIP_ANSWER_START" },
  { label: "SIP connected (signaling)", needle: "SIP_CONNECTED" },
  { label: "SIP UA connected", needle: "SIP_CALL_STATE_CONNECTED" },
  { label: "Active call screen mount", needle: "ACTIVE_CALL_SCREEN_MOUNT" },
  { label: "SIP / call ended state", needle: "SIP_CALL_STATE_ENDED" },
  { label: "Ended UI shown", needle: "CALL_ENDED_SCREEN_SHOWN" },
  { label: "Navigate to Quick", needle: "NAVIGATE_BACK_TO_QUICK" },
];

function overlayEnabled(): boolean {
  if (__DEV__) return true;
  return Constants.expoConfig?.extra?.callFlowDebugOverlay === true;
}

export function CallFlowDebugOverlay() {
  const enabled = overlayEnabled();
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const bump = useCallback(() => tick((n) => n + 1), []);

  useEffect(() => subscribeCallFlowDebug(bump), [bump]);

  const sip = useSip();
  const { incomingInvite, incomingCallUiState } = useIncomingNotifications();

  const snap = useMemo(() => getCallFlowSnapshot(), [tick, sip.lastError, incomingInvite?.id]);

  const text = useMemo(() => {
    const lines = snap.recentLines.slice(-24);
    return lines.length ? lines.join("\n") : "(no CALL_FLOW events yet)";
  }, [snap.recentLines]);

  const joined = snap.recentLines.join(" ");

  if (!enabled) return null;

  return (
    <>
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setOpen(true)}
        activeOpacity={0.85}
        accessibilityLabel="Open call flow debug"
      >
        <Text style={styles.fabText}>DBG</Text>
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <View style={styles.panel}>
            <Text style={styles.title}>Call flow (live)</Text>
            <Text style={styles.meta}>
              appState={snap.appState} | sip={sip.callState} | incomingPhase={incomingCallUiState.phase}
            </Text>
            <Text style={styles.meta}>inviteId={snap.lastInviteId ?? incomingInvite?.id ?? "—"}</Text>
            <Text style={styles.meta}>SIP lastError={sip.lastError ?? snap.lastError ?? "—"}</Text>

            <Text style={styles.subTitle}>Stages (substring match on recent buffer)</Text>
            <ScrollView style={styles.checkScroll} nestedScrollEnabled>
              {STAGE_CHECKS.map(({ label, needle }) => (
                <Text key={needle} style={styles.checkRow}>
                  {joined.includes(needle) ? "✓ " : "· "}
                  {label}
                </Text>
              ))}
            </ScrollView>

            <Text style={styles.subTitle}>Recent CALL_FLOW</Text>
            <ScrollView style={styles.logScroll} nestedScrollEnabled>
              <Text style={styles.logText}>{text}</Text>
            </ScrollView>

            <View style={styles.row}>
              <TouchableOpacity
                style={styles.btn}
                onPress={() => {
                  logCallFlow("BLANK_SCREEN_MANUAL_MARK", {
                    inviteId: snap.lastInviteId ?? incomingInvite?.id ?? null,
                    extra: { note: "Tester observed blank UI" },
                  });
                }}
              >
                <Text style={styles.btnText}>Mark blank</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnPrimary} onPress={() => setOpen(false)}>
                <Text style={styles.btnText}>Close</Text>
              </TouchableOpacity>
            </View>
            {Platform.OS === "android" ? (
              <Text style={styles.hint}>
                adb: filter `ReactNativeJS` + tag `IncomingCallService` + `ConnectCallFlow`. See docs/android-incoming-call-live-debug.md
              </Text>
            ) : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: 10,
    bottom: 120,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(15,23,42,0.92)",
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.5)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 99999,
    elevation: 20,
  },
  fabText: { color: "#e2e8f0", fontSize: 12, fontWeight: "800" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  panel: {
    maxHeight: "88%",
    backgroundColor: "#0f172a",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    paddingBottom: 28,
  },
  title: { color: "#f8fafc", fontSize: 18, fontWeight: "700", marginBottom: 6 },
  subTitle: { color: "#94a3b8", fontSize: 12, marginTop: 10, marginBottom: 4 },
  meta: { color: "#cbd5e1", fontSize: 11, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  checkScroll: { maxHeight: 140, marginBottom: 6 },
  checkRow: { color: "#e2e8f0", fontSize: 11, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  logScroll: { maxHeight: 160, backgroundColor: "#020617", borderRadius: 8, padding: 8 },
  logText: { color: "#a5b4fc", fontSize: 10, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  row: { flexDirection: "row", gap: 10, marginTop: 12 },
  btn: {
    flex: 1,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#334155",
    alignItems: "center",
  },
  btnPrimary: {
    flex: 1,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#2563eb",
    alignItems: "center",
  },
  btnText: { color: "#fff", fontWeight: "600" },
  hint: { color: "#64748b", fontSize: 10, marginTop: 10 },
});

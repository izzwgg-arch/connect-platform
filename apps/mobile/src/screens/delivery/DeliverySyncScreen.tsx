import React, { useCallback, useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { useDeliveryQueue } from "../../delivery/useDeliveryQueue";
import type { QueuedOp, OpKind, OpState } from "../../delivery/offlineQueue";

// Sync status screen (mockup g1): transparency into the offline op-queue. Shows pending
// actions, conflicts needing attention, and last sync — never silently drops driver work.
// Reuses the existing flush path (useDeliveryQueue.flush → deliveryClient.syncOp); it does
// NOT introduce any new sync mechanism. Server stays authoritative.

const KIND_LABEL: Record<OpKind, string> = {
  scan: "Label scan",
  status: "Status update",
  arrive: "Arrival",
  proof: "Proof of delivery",
  exception: "Exception report",
};

function opLabel(op: QueuedOp): string {
  const base = KIND_LABEL[op.kind] || op.kind;
  const p = op.payload || {};
  const detail =
    (typeof p.orderRef === "string" && p.orderRef) ||
    (typeof p.token === "string" && p.token ? `#${String(p.token).slice(-6)}` : "") ||
    (typeof p.orderId === "string" ? String(p.orderId).slice(0, 8) : "");
  return detail ? `${base} · ${detail}` : base;
}

function fmtTime(ms: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return "—";
  }
}

export function DeliverySyncScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const { colors } = useTheme();
  const { token } = useAuth();
  const { queue, flush, flushing, retry, unsyncedCount, blocked } = useDeliveryQueue(token);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [needsFlush, setNeedsFlush] = useState(false);

  const runSync = useCallback(async () => {
    await flush();
    setLastSyncAt(Date.now());
  }, [flush]);

  // Attempt a sync when the driver opens this screen.
  useEffect(() => {
    runSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retry-all: reset every blocked op to pending, then flush once the queue state settles.
  const retryAll = useCallback(() => {
    blocked.forEach((o) => retry(o.opId));
    setNeedsFlush(true);
  }, [blocked, retry]);

  useEffect(() => {
    if (!needsFlush) return;
    setNeedsFlush(false);
    runSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, needsFlush]);

  const stateTone = useCallback(
    (state: OpState): string => {
      switch (state) {
        case "synced":
          return colors.successText;
        case "syncing":
          return colors.primary;
        case "failed":
          return colors.warningText;
        case "conflict":
          return colors.dangerText;
        default:
          return colors.textSecondary;
      }
    },
    [colors],
  );

  const pendingOps = queue.filter((q) => q.state !== "synced");
  const online = !flushing; // best-effort indicator; server remains authoritative.

  return (
    <View style={[styles.fill, { backgroundColor: colors.bg, paddingTop: insets.top + 8 }]}>
      <View style={styles.appbar}>
        <TouchableOpacity onPress={() => nav.goBack()}>
          <Text style={[styles.back, { color: colors.textSecondary }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.h1, { color: colors.text }]}>Sync</Text>
        <View style={{ flex: 1 }} />
        <View style={[styles.pill, { backgroundColor: colors.successMuted }]}>
          <Text style={[styles.pillText, { color: colors.successText }]}>{flushing ? "Syncing…" : "Ready"}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.bottom + 96 }}>
        <View style={styles.between}>
          <Text style={[styles.lab, { color: colors.textTertiary }]}>Last synced</Text>
          <Text style={[styles.mono, { color: colors.textSecondary }]}>{fmtTime(lastSyncAt)}</Text>
        </View>

        <View style={styles.statRow}>
          <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.statNum, { color: colors.text }]}>{unsyncedCount}</Text>
            <Text style={[styles.statLab, { color: colors.textSecondary }]}>Pending</Text>
          </View>
          <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.statNum, { color: blocked.length > 0 ? colors.dangerText : colors.text }]}>{blocked.length}</Text>
            <Text style={[styles.statLab, { color: colors.textSecondary }]}>Need you</Text>
          </View>
        </View>

        {blocked.length > 0 ? (
          <View style={[styles.banner, { backgroundColor: colors.dangerMuted, borderColor: colors.danger }]}>
            <Text style={[styles.bannerText, { color: colors.dangerText }]}>
              {blocked.length} action(s) need your attention — a conflict or repeated failure is holding them.
            </Text>
          </View>
        ) : null}

        <Text style={[styles.lab, { color: colors.textTertiary }]}>Queue</Text>
        {pendingOps.length === 0 ? (
          <Text style={[styles.empty, { color: colors.textSecondary }]}>Everything is synced. Nothing pending.</Text>
        ) : (
          pendingOps.map((op) => (
            <View key={op.opId} style={[styles.opRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.opTitle, { color: colors.text }]}>{opLabel(op)}</Text>
                <Text style={[styles.opMeta, { color: colors.textTertiary }]}>
                  {op.state}
                  {op.error ? ` · ${op.error}` : ""}
                  {op.attempts > 0 ? ` · ${op.attempts} attempt(s)` : ""}
                </Text>
              </View>
              <View style={[styles.dot, { backgroundColor: stateTone(op.state) }]} />
            </View>
          ))
        )}
      </ScrollView>

      <View style={[styles.footer, { backgroundColor: colors.bg, borderColor: colors.border, paddingBottom: insets.bottom + 12 }]}>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: colors.primary }, flushing && { opacity: 0.6 }]}
          disabled={flushing}
          onPress={runSync}
        >
          <Text style={[styles.btnText, { color: colors.white }]}>{flushing ? "Syncing…" : "Retry now / Sync"}</Text>
        </TouchableOpacity>
        {blocked.length > 0 ? (
          <TouchableOpacity style={[styles.btnGhost, { borderColor: colors.border }]} disabled={flushing} onPress={retryAll}>
            <Text style={[styles.btnGhostText, { color: colors.textSecondary }]}>Retry all blocked</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  appbar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingBottom: 8 },
  back: { fontSize: 26 },
  h1: { fontSize: 18, fontWeight: "700" },
  pill: { borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  pillText: { fontSize: 11, fontWeight: "700" },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 2 },
  lab: { fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: "700" },
  mono: { fontSize: 13, fontVariant: ["tabular-nums"] },
  statRow: { flexDirection: "row", gap: 12 },
  stat: { flex: 1, borderWidth: 1, borderRadius: 14, padding: 14, alignItems: "center", gap: 4 },
  statNum: { fontSize: 26, fontWeight: "800" },
  statLab: { fontSize: 12 },
  banner: { borderWidth: 1, borderRadius: 12, padding: 12 },
  bannerText: { fontSize: 12.5, fontWeight: "600" },
  empty: { fontSize: 13 },
  opRow: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 12, padding: 12 },
  opTitle: { fontSize: 13.5, fontWeight: "700" },
  opMeta: { fontSize: 11.5, marginTop: 3 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  footer: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopWidth: 1, padding: 16, gap: 10 },
  btn: { borderRadius: 12, padding: 14, alignItems: "center" },
  btnText: { fontWeight: "700", fontSize: 15 },
  btnGhost: { borderWidth: 1, borderRadius: 12, padding: 12, alignItems: "center" },
  btnGhostText: { fontWeight: "600" },
});

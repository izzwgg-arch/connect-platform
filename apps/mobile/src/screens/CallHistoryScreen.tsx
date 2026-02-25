import React, { useEffect, useState } from "react";
import { FlatList, Text, TouchableOpacity, View } from "react-native";
import { HeaderBar } from "../components/HeaderBar";
import { getCallHistory } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useSip } from "../context/SipContext";
import type { CallRecord } from "../types";
import { ui } from "../theme";

export function CallHistoryScreen() {
  const { token } = useAuth();
  const sip = useSip();
  const [rows, setRows] = useState<CallRecord[]>([]);

  useEffect(() => {
    (async () => {
      if (!token) return;
      const out = await getCallHistory(token).catch(() => []);
      setRows(out);
    })();
  }, [token]);

  return (
    <View style={ui.screen}>
      <HeaderBar title="Call History" />
      <View style={ui.content}>
        <View style={ui.card}>
          <Text style={ui.sectionTitle}>Recent Calls</Text>
          <FlatList
            data={rows}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View style={{ borderBottomWidth: 1, borderBottomColor: "#e3e8ed", paddingVertical: 8 }}>
                <Text style={ui.text}>{item.direction.toUpperCase()}  {item.fromNumber} -> {item.toNumber}</Text>
                <Text style={ui.text}>{new Date(item.startedAt).toLocaleString()}  Duration {item.durationSec}s</Text>
                <TouchableOpacity style={ui.button} onPress={() => sip.dial(item.toNumber)}>
                  <Text style={ui.buttonText}>Redial</Text>
                </TouchableOpacity>
              </View>
            )}
            ListEmptyComponent={<Text style={ui.text}>No calls found.</Text>}
          />
        </View>
      </View>
    </View>
  );
}

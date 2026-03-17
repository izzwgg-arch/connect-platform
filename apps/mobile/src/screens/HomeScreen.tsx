import React, { useCallback, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { HeaderBar } from "../components/HeaderBar";
import { StatusChip } from "../components/StatusChip";
import { getVoiceExtension, resetSipPassword } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useSip } from "../context/SipContext";
import type { VoiceExtension } from "../types";
import { ui } from "../theme";
import { useFocusEffect, useNavigation } from "@react-navigation/native";

export function HomeScreen() {
  const nav = useNavigation<any>();
  const { token, logout } = useAuth();
  const sip = useSip();
  const [voice, setVoice] = useState<VoiceExtension | null>(null);
  const [error, setError] = useState("");

  useFocusEffect(
    useCallback(() => {
      (async () => {
        if (!token) return;
        try {
          const ext = await getVoiceExtension(token);
          setVoice(ext);
        } catch (e: any) {
          setError(e?.message || "Unable to load extension");
        }
      })();
    }, [token])
  );

  const provisionViaReset = async () => {
    if (!token || !voice) return;
    const out = await resetSipPassword(token);
    await sip.saveProvisioning({
      sipUsername: out.provisioning.sipUsername,
      sipPassword: out.sipPassword,
      sipWsUrl: out.provisioning.sipWsUrl,
      sipDomain: out.provisioning.sipDomain,
      outboundProxy: out.provisioning.outboundProxy,
      iceServers: out.provisioning.iceServers,
      dtmfMode: out.provisioning.dtmfMode
    });
  };

  return (
    <View style={ui.screen}>
      <HeaderBar title="Softphone" />
      <View style={ui.content}>
        <View style={ui.card}>
          <Text style={ui.sectionTitle}>Extension</Text>
          <Text style={ui.text}>Number: {voice?.extensionNumber || "-"}</Text>
          <Text style={ui.text}>Display: {voice?.displayName || "-"}</Text>
          <View style={ui.row}>
            <StatusChip label={sip.registrationState.toUpperCase()} variant={sip.registrationState === "registered" ? "ok" : sip.registrationState === "failed" ? "danger" : "neutral"} />
            <StatusChip label={voice?.webrtcEnabled ? "WEBRTC ENABLED" : "WEBRTC DISABLED"} variant={voice?.webrtcEnabled ? "ok" : "warn"} />
          </View>
          {error ? <Text style={ui.text}>{error}</Text> : null}

          <View style={ui.row}>
            <TouchableOpacity style={ui.button} onPress={() => nav.navigate("QrProvision")}><Text style={ui.buttonText}>Provision Phone (QR)</Text></TouchableOpacity>
            <TouchableOpacity style={ui.button} onPress={provisionViaReset}><Text style={ui.buttonText}>Provision via Reset</Text></TouchableOpacity>
            <TouchableOpacity style={ui.button} onPress={() => sip.register()}><Text style={ui.buttonText}>Register</Text></TouchableOpacity>
            <TouchableOpacity style={ui.button} onPress={() => nav.navigate("Dialpad")}><Text style={ui.buttonText}>Dialpad</Text></TouchableOpacity>
            <TouchableOpacity style={ui.button} onPress={() => nav.navigate("IncomingCall")}><Text style={ui.buttonText}>Incoming</Text></TouchableOpacity>
            <TouchableOpacity style={ui.button} onPress={() => nav.navigate("CallHistory")}><Text style={ui.buttonText}>Call History</Text></TouchableOpacity>
            <TouchableOpacity style={ui.button} onPress={() => nav.navigate("Diagnostics")}><Text style={ui.buttonText}>Diagnostics</Text></TouchableOpacity>
            <TouchableOpacity style={ui.button} onPress={async () => { await sip.unregister(); await logout(); }}><Text style={ui.buttonText}>Logout</Text></TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
}

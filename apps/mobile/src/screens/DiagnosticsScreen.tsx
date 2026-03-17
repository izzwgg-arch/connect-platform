import React, { useCallback, useState } from "react";
import { Platform, ScrollView, Text, TouchableOpacity, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { Audio } from "expo-av";
import { useFocusEffect } from "@react-navigation/native";
import { HeaderBar } from "../components/HeaderBar";
import { useSip } from "../context/SipContext";
import { useAuth } from "../context/AuthContext";
import { getVoiceExtension } from "../api/client";
import type { VoiceExtension } from "../types";
import { ui } from "../theme";

// Key used by SipContext to store the provisioning bundle
const PROVISION_KEY = "cc_mobile_provision";

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean | null }) {
  const color =
    ok === true ? "#22c55e" : ok === false ? "#ef4444" : ok === null ? "#f59e0b" : undefined;
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: "#f3f4f6" }}>
      <Text style={[ui.text, { color: "#6b7280", fontSize: 12, flex: 1 }]}>{label}</Text>
      <Text style={[ui.text, { fontSize: 12, flex: 2, textAlign: "right", color: color ?? "#111" }]}>{value}</Text>
    </View>
  );
}

export function DiagnosticsScreen() {
  const sip = useSip();
  const { token } = useAuth();
  const [provBundle, setProvBundle] = useState<Record<string, unknown> | null>(null);
  const [voice, setVoice] = useState<VoiceExtension | null>(null);
  const [micPermission, setMicPermission] = useState<string>("unknown");
  const [loading, setLoading] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      (async () => {
        setLoading(true);
        try {
          // Load provisioning bundle from secure storage
          const raw = await SecureStore.getItemAsync(PROVISION_KEY);
          if (raw && mounted) {
            const parsed = JSON.parse(raw);
            setProvBundle(parsed);
          }

          // Check microphone permission
          const { status } = await Audio.requestPermissionsAsync();
          if (mounted) setMicPermission(status);

          // Fetch voice extension config from API
          if (token) {
            const ext = await getVoiceExtension(token).catch(() => null);
            if (mounted && ext) setVoice(ext);
          }
        } catch (e: unknown) {
          // Best-effort — show whatever loaded
        } finally {
          if (mounted) setLoading(false);
        }
      })();
      return () => { mounted = false; };
    }, [token]),
  );

  const bundle = provBundle as {
    sipUsername?: string;
    sipWsUrl?: string;
    sipDomain?: string;
    iceServers?: Array<{ urls: string | string[] }>;
    outboundProxy?: string;
  } | null;

  const hasStun = !!bundle?.iceServers?.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => String(u).startsWith("stun:"));
  });
  const hasTurn = !!bundle?.iceServers?.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => String(u).startsWith("turn:") || String(u).startsWith("turns:"));
  });

  return (
    <View style={ui.screen}>
      <HeaderBar title="Diagnostics" />
      <ScrollView>
        <View style={ui.content}>
          {/* ── Mobile platform ─────────────────────────────── */}
          <View style={ui.card}>
            <Text style={ui.sectionTitle}>Platform</Text>
            <Row label="OS" value={`${Platform.OS} ${Platform.Version}`} />
            <Row label="Microphone" value={micPermission} ok={micPermission === "granted" ? true : micPermission === "denied" ? false : null} />
          </View>

          {/* ── SIP registration ────────────────────────────── */}
          <View style={ui.card}>
            <Text style={ui.sectionTitle}>SIP Registration</Text>
            <Row
              label="State"
              value={sip.registrationState}
              ok={sip.registrationState === "registered" ? true : sip.registrationState === "failed" ? false : null}
            />
            <Row
              label="Call State"
              value={sip.callState}
              ok={null}
            />
            <Row
              label="Provisioned"
              value={sip.hasProvisioning ? "Yes" : "No"}
              ok={sip.hasProvisioning}
            />
            {sip.lastError && (
              <View style={{ marginTop: 6 }}>
                <Text style={[ui.text, { fontSize: 11, color: "#6b7280" }]}>Last Error:</Text>
                <Text style={[ui.text, { fontSize: 11, color: "#ef4444", marginTop: 2 }]} numberOfLines={3}>
                  {sip.lastError}
                </Text>
              </View>
            )}
          </View>

          {/* ── Provisioning bundle ─────────────────────────── */}
          <View style={ui.card}>
            <Text style={ui.sectionTitle}>Provisioning Bundle (stored)</Text>
            {bundle ? (
              <>
                <Row label="SIP Username" value={bundle.sipUsername ?? "—"} ok={!!bundle.sipUsername} />
                <Row label="SIP WSS URL" value={bundle.sipWsUrl ?? "NOT SET"} ok={!!bundle.sipWsUrl} />
                <Row label="SIP Domain" value={bundle.sipDomain ?? "NOT SET"} ok={!!bundle.sipDomain} />
                <Row label="Outbound Proxy" value={bundle.outboundProxy ?? "None"} />
                <Row label="STUN" value={hasStun ? "Present" : "Missing"} ok={hasStun ? true : null} />
                <Row label="TURN" value={hasTurn ? "Present" : "Not configured"} ok={hasTurn ? true : null} />
                {!hasTurn && (
                  <Text style={[ui.text, { fontSize: 11, color: "#d97706", marginTop: 4 }]}>
                    ⚠ No TURN server. Audio may fail behind strict NAT.
                  </Text>
                )}
              </>
            ) : (
              <Text style={[ui.text, { color: "#6b7280" }]}>
                No provisioning bundle found. Use QR Provision or Provision via Reset on the Home screen.
              </Text>
            )}
          </View>

          {/* ── Voice extension config from API ─────────────── */}
          <View style={ui.card}>
            <Text style={ui.sectionTitle}>Voice Extension (from API)</Text>
            {voice ? (
              <>
                <Row label="Extension" value={voice.extensionNumber} />
                <Row label="SIP Username" value={voice.sipUsername ?? "—"} ok={!!voice.sipUsername} />
                <Row label="WebRTC enabled" value={voice.webrtcEnabled ? "Yes" : "No"} ok={voice.webrtcEnabled} />
                <Row label="WSS URL" value={voice.sipWsUrl ?? "NOT SET"} ok={!!voice.sipWsUrl} />
                <Row label="SIP Domain" value={voice.sipDomain ?? "NOT SET"} ok={!!voice.sipDomain} />
                <Row label="Has SIP password" value={voice.hasSipPassword ? "Yes" : "No — needs reset"} ok={voice.hasSipPassword} />
              </>
            ) : loading ? (
              <Text style={[ui.text, { color: "#6b7280" }]}>Loading…</Text>
            ) : (
              <Text style={[ui.text, { color: "#6b7280" }]}>
                {token ? "Could not load extension. Check PBX link in admin." : "Not logged in."}
              </Text>
            )}
          </View>

          {/* ── Mobile VoIP constraints ─────────────────────── */}
          <View style={ui.card}>
            <Text style={ui.sectionTitle}>Mobile VoIP Limitations</Text>
            <Text style={[ui.text, { fontSize: 12, color: "#6b7280", lineHeight: 18 }]}>
              Current stack: Expo managed workflow (SDK 51){"\n\n"}
              ✓ Foreground calling — fully supported{"\n"}
              ✓ QR login, provisioning, registration{"\n"}
              ✓ Outbound calls{"\n"}
              ✓ Inbound calls while app is foregrounded{"\n\n"}
              ✗ Background incoming calls — requires native modules:{"\n"}
              {"  "}• iOS: react-native-callkeep + PushKit VoIP push{"\n"}
              {"  "}• Android: ConnectionService + FCM data push{"\n"}
              {"  "}• Both require ejecting to bare RN or custom dev client{"\n\n"}
              To enable full background calling:{"\n"}
              {"  "}1. Eject to bare React Native (expo eject){"\n"}
              {"  "}2. Install react-native-callkeep{"\n"}
              {"  "}3. Configure PushKit (iOS) / FCM (Android) on the backend{"\n"}
              {"  "}4. Wire CallKeep answer action to sip.answerIncomingInvite()
            </Text>
          </View>

          <TouchableOpacity
            style={[ui.button, { marginHorizontal: 16, marginBottom: 24 }]}
            onPress={async () => {
              setProvBundle(null);
              const raw = await SecureStore.getItemAsync(PROVISION_KEY);
              if (raw) setProvBundle(JSON.parse(raw));
              if (token) {
                const ext = await getVoiceExtension(token).catch(() => null);
                if (ext) setVoice(ext);
              }
            }}
          >
            <Text style={ui.buttonText}>Refresh</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

import React, { useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { HeaderBar } from "../components/HeaderBar";
import { useSip } from "../context/SipContext";
import type { ProvisioningBundle } from "../types";
import { ui } from "../theme";

function parseBundle(raw: string): ProvisioningBundle {
  const parsed = JSON.parse(raw);
  const sipUsername = parsed.sipUsername || parsed.provisioning?.sipUsername;
  const sipPassword = parsed.sipPassword || parsed.provisioning?.sipPassword;
  const sipWsUrl = parsed.sipWsUrl || parsed.provisioning?.sipWsUrl || parsed.websocketEndpoint;
  const sipDomain = parsed.sipDomain || parsed.provisioning?.sipDomain;
  const iceServers = parsed.iceServers || parsed.provisioning?.iceServers || [];
  const dtmfMode = parsed.dtmfMode || parsed.provisioning?.dtmfMode || "RFC2833";

  if (!sipUsername || !sipPassword || !sipWsUrl || !sipDomain) {
    throw new Error("Invalid provisioning QR payload");
  }

  return {
    sipUsername,
    sipPassword,
    sipWsUrl,
    sipDomain,
    outboundProxy: parsed.outboundProxy || parsed.provisioning?.outboundProxy || null,
    iceServers,
    dtmfMode
  };
}

export function QrProvisionScreen() {
  const sip = useSip();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  if (!permission) {
    return <View style={ui.screen}><HeaderBar title="QR Provisioning" /><View style={ui.content}><View style={ui.card}><Text style={ui.text}>Requesting camera permission...</Text></View></View></View>;
  }

  if (!permission.granted) {
    return (
      <View style={ui.screen}>
        <HeaderBar title="QR Provisioning" />
        <View style={ui.content}>
          <View style={ui.card}>
            <Text style={ui.text}>Camera access is required to scan provisioning QR codes.</Text>
            <TouchableOpacity style={ui.button} onPress={requestPermission}><Text style={ui.buttonText}>Enable Camera</Text></TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={ui.screen}>
      <HeaderBar title="QR Provisioning" />
      <View style={ui.content}>
        <View style={[ui.card, { height: 420, overflow: "hidden" }]}>
          <Text style={ui.sectionTitle}>Scan portal provisioning QR</Text>
          <Text style={ui.text}>On successful scan, credentials are stored in SecureStore and removed from memory.</Text>
          {!done ? (
            <CameraView
              style={{ flex: 1, borderRadius: 2 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={async ({ data }) => {
                if (done) return;
                try {
                  const bundle = parseBundle(data);
                  await sip.saveProvisioning(bundle);
                  setDone(true);
                } catch (e: any) {
                  setError(e?.message || "Unable to parse QR payload");
                }
              }}
            />
          ) : (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
              <Text style={ui.text}>Provisioning saved securely.</Text>
              <TouchableOpacity style={ui.button} onPress={() => sip.register()}><Text style={ui.buttonText}>Register Now</Text></TouchableOpacity>
            </View>
          )}
          {error ? <Text style={ui.text}>{error}</Text> : null}
        </View>
      </View>
    </View>
  );
}

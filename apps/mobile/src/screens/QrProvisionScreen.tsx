import React, { useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { HeaderBar } from "../components/HeaderBar";
import { useSip } from "../context/SipContext";
import { useAuth } from "../context/AuthContext";
import { exchangeQrToken, redeemMobileProvisioningToken } from "../api/client";
import type { ProvisioningBundle } from "../types";
import { ui } from "../theme";

type ParsedProvisionPayload =
  | { kind: "TOKEN"; token: string; apiBaseUrl?: string }
  | { kind: "LEGACY"; bundle: ProvisioningBundle };

function parseLegacyBundle(parsed: any): ProvisioningBundle {
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

function parseProvisionPayload(raw: string): ParsedProvisionPayload {
  const parsed = JSON.parse(raw);
  const kind = String(parsed?.type || "").toUpperCase();
  if (kind === "MOBILE_PROVISIONING") {
    if (!parsed?.token) throw new Error("Invalid tokenized provisioning QR payload");
    return { kind: "TOKEN", token: String(parsed.token), apiBaseUrl: parsed.apiBaseUrl ? String(parsed.apiBaseUrl) : undefined };
  }
  return { kind: "LEGACY", bundle: parseLegacyBundle(parsed) };
}

export function QrProvisionScreen() {
  const { token, setTokenFromQr } = useAuth();
  const sip = useSip();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [legacyWarning, setLegacyWarning] = useState("");

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
          <Text style={ui.text}>Tokenized flow redeems a short-lived one-time token and stores credentials in SecureStore.</Text>
          {!done ? (
            <CameraView
              style={{ flex: 1, borderRadius: 2 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={async ({ data }) => {
                if (done) return;
                try {
                  setError("");
                  const parsed = parseProvisionPayload(data);
                  if (parsed.kind === "TOKEN") {
                    const deviceInfo = {
                      platform: Device.osName || "unknown",
                      deviceName: Device.modelName || "unknown"
                    };

                    let provisioningData: { sipPassword: string; provisioning: any };

                    if (token) {
                      // User already has a session — use authenticated redeem
                      provisioningData = await redeemMobileProvisioningToken(token, {
                        token: parsed.token,
                        apiBaseUrl: parsed.apiBaseUrl,
                        deviceInfo
                      });
                    } else {
                      // No session yet — use unauthenticated QR exchange (logs in + provisions)
                      const exchanged = await exchangeQrToken(
                        { token: parsed.token, apiBaseUrl: parsed.apiBaseUrl },
                        deviceInfo
                      );
                      await setTokenFromQr(exchanged.sessionToken);
                      provisioningData = { sipPassword: exchanged.sipPassword, provisioning: exchanged.provisioning };
                    }

                    const bundle = parseLegacyBundle({
                      sipUsername: provisioningData.provisioning?.sipUsername,
                      sipPassword: provisioningData.sipPassword,
                      sipWsUrl: provisioningData.provisioning?.sipWsUrl,
                      sipDomain: provisioningData.provisioning?.sipDomain,
                      outboundProxy: provisioningData.provisioning?.outboundProxy,
                      iceServers: provisioningData.provisioning?.iceServers,
                      dtmfMode: provisioningData.provisioning?.dtmfMode
                    });
                    await sip.saveProvisioning(bundle);
                    setLegacyWarning("");
                    setDone(true);
                    return;
                  }

                  await sip.saveProvisioning(parsed.bundle);
                  setLegacyWarning("Legacy QR format detected. Please switch to tokenized provisioning QR in the portal.");
                  setDone(true);
                } catch (e: any) {
                  setError(e?.message || "Unable to parse or redeem provisioning QR payload");
                }
              }}
            />
          ) : (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
              <Text style={ui.text}>Provisioning saved securely.</Text>
              <TouchableOpacity style={ui.button} onPress={() => sip.register()}><Text style={ui.buttonText}>Register Now</Text></TouchableOpacity>
            </View>
          )}
          {legacyWarning ? <Text style={ui.text}>{legacyWarning}</Text> : null}
          {error ? <Text style={ui.text}>{error}</Text> : null}
        </View>
      </View>
    </View>
  );
}

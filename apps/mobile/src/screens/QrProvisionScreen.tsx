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
    dtmfMode,
  };
}

function parseProvisionPayload(raw: string): ParsedProvisionPayload {
  const parsed = JSON.parse(raw);
  const kind = String(parsed?.type || "").toUpperCase();
  if (kind === "MOBILE_PROVISIONING") {
    if (!parsed?.token) throw new Error("Invalid tokenized provisioning QR payload");
    return {
      kind: "TOKEN",
      token: String(parsed.token),
      apiBaseUrl: parsed.apiBaseUrl ? String(parsed.apiBaseUrl) : undefined,
    };
  }
  return { kind: "LEGACY", bundle: parseLegacyBundle(parsed) };
}

function buildDeviceInfo() {
  return {
    platform: (Device.osName === "iOS" ? "IOS" : "ANDROID") as "IOS" | "ANDROID",
    deviceName: Device.modelName ?? undefined,
  };
}

export function QrProvisionScreen() {
  const { token, setTokenFromQr } = useAuth();
  const sip = useSip();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [legacyWarning, setLegacyWarning] = useState("");
  const [scanning, setScanning] = useState(false);

  if (!permission) {
    return (
      <View style={ui.screen}>
        <HeaderBar title="QR Provisioning" />
        <View style={ui.content}>
          <View style={ui.card}>
            <Text style={ui.text}>Requesting camera permission…</Text>
          </View>
        </View>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={ui.screen}>
        <HeaderBar title="QR Provisioning" />
        <View style={ui.content}>
          <View style={ui.card}>
            <Text style={ui.text}>
              Camera access is required to scan provisioning QR codes.
            </Text>
            <TouchableOpacity style={ui.button} onPress={requestPermission}>
              <Text style={ui.buttonText}>Enable Camera</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={ui.screen}>
      <HeaderBar title="QR Provisioning" />
      <View style={ui.content}>
        <View style={[ui.card, { height: 480, overflow: "hidden" }]}>
          <Text style={ui.sectionTitle}>Scan portal provisioning QR</Text>
          <Text style={ui.text}>
            {token
              ? "Scan the QR code from the portal provisioning page."
              : "Scan the QR code to log in and provision this device."}
          </Text>

          {!done ? (
            <CameraView
              style={{ flex: 1, borderRadius: 2 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={async ({ data }) => {
                if (done || scanning) return;
                setScanning(true);
                setError("");
                try {
                  const parsed = parseProvisionPayload(data);

                  if (parsed.kind === "TOKEN") {
                    if (token) {
                      // Authenticated flow: redeem via existing session
                      const redeemed = await redeemMobileProvisioningToken(token, {
                        token: parsed.token,
                        apiBaseUrl: parsed.apiBaseUrl,
                        deviceInfo: buildDeviceInfo(),
                      });
                      const bundle = parseLegacyBundle({
                        sipUsername: redeemed?.provisioning?.sipUsername,
                        sipPassword: redeemed?.sipPassword,
                        sipWsUrl: redeemed?.provisioning?.sipWsUrl,
                        sipDomain: redeemed?.provisioning?.sipDomain,
                        outboundProxy: redeemed?.provisioning?.outboundProxy,
                        iceServers: redeemed?.provisioning?.iceServers,
                        dtmfMode: redeemed?.provisioning?.dtmfMode,
                      });
                      await sip.saveProvisioning(bundle);
                    } else {
                      // Unauthenticated flow: exchange token for session + provisioning
                      const exchanged = await exchangeQrToken(
                        parsed.token,
                        buildDeviceInfo(),
                        parsed.apiBaseUrl
                      );
                      // Store the session JWT first so the app transitions to authenticated state
                      await setTokenFromQr(exchanged.sessionToken);
                      const bundle = parseLegacyBundle({
                        sipUsername: exchanged.provisioning?.sipUsername,
                        sipPassword: exchanged.sipPassword,
                        sipWsUrl: exchanged.provisioning?.sipWsUrl,
                        sipDomain: exchanged.provisioning?.sipDomain,
                        outboundProxy: exchanged.provisioning?.outboundProxy,
                        iceServers: exchanged.provisioning?.iceServers,
                        dtmfMode: exchanged.provisioning?.dtmfMode,
                      });
                      await sip.saveProvisioning(bundle);
                    }
                    setLegacyWarning("");
                    setDone(true);
                    return;
                  }

                  // Legacy format (raw credentials in QR — not recommended)
                  await sip.saveProvisioning(parsed.bundle);
                  setLegacyWarning(
                    "Legacy QR format detected. Please switch to tokenized provisioning QR in the portal."
                  );
                  setDone(true);
                } catch (e: any) {
                  setError(e?.message || "Unable to parse or redeem provisioning QR payload");
                } finally {
                  setScanning(false);
                }
              }}
            />
          ) : (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
              <Text style={ui.text}>Provisioning saved securely.</Text>
              <TouchableOpacity style={ui.button} onPress={() => sip.register()}>
                <Text style={ui.buttonText}>Register Now</Text>
              </TouchableOpacity>
            </View>
          )}

          {legacyWarning ? (
            <Text style={[ui.text, { color: "#f59e0b" }]}>{legacyWarning}</Text>
          ) : null}
          {error ? (
            <Text style={[ui.text, { color: "#ef4444" }]}>{error}</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

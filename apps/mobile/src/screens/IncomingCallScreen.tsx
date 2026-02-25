import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { HeaderBar } from "../components/HeaderBar";
import { useIncomingNotifications } from "../context/NotificationsContext";
import { useAuth } from "../context/AuthContext";
import { respondInvite } from "../api/client";
import { useSip } from "../context/SipContext";
import { ui } from "../theme";

export function IncomingCallScreen() {
  const { token } = useAuth();
  const sip = useSip();
  const { incomingInvite, clearIncomingInvite } = useIncomingNotifications();

  if (!incomingInvite) {
    return (
      <View style={ui.screen}>
        <HeaderBar title="Incoming Call" />
        <View style={ui.content}><View style={ui.card}><Text style={ui.text}>No active incoming call.</Text></View></View>
      </View>
    );
  }

  return (
    <View style={ui.screen}>
      <HeaderBar title="Incoming Call" />
      <View style={ui.content}>
        <View style={ui.card}>
          <Text style={ui.title}>Incoming call</Text>
          <Text style={ui.text}>From: {incomingInvite.fromNumber}</Text>
          <Text style={ui.text}>To ext: {incomingInvite.toExtension}</Text>
          <View style={ui.row}>
            <TouchableOpacity
              style={ui.button}
              onPress={async () => {
                if (!token) return;
                await respondInvite(token, incomingInvite.id, "ACCEPTED").catch(() => undefined);
                await sip.register().catch(() => undefined);
                clearIncomingInvite();
              }}
            >
              <Text style={ui.buttonText}>Accept</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={ui.button}
              onPress={async () => {
                if (!token) return;
                await respondInvite(token, incomingInvite.id, "DECLINED").catch(() => undefined);
                clearIncomingInvite();
              }}
            >
              <Text style={ui.buttonText}>Decline</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
}

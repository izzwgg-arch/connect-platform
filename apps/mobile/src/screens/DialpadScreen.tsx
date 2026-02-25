import React, { useMemo, useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import { HeaderBar } from "../components/HeaderBar";
import { StatusChip } from "../components/StatusChip";
import { useSip } from "../context/SipContext";
import { ui } from "../theme";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export function DialpadScreen() {
  const sip = useSip();
  const [target, setTarget] = useState("");

  const timerLabel = useMemo(() => {
    if (sip.callState !== "connected") return "00:00";
    return "Connected";
  }, [sip.callState]);

  const statusVariant = sip.callState === "connected" ? "ok" : sip.callState === "ended" ? "danger" : "neutral";

  return (
    <View style={ui.screen}>
      <HeaderBar title="Dialpad" />
      <View style={ui.content}>
        <View style={ui.card}>
          <View style={ui.row}>
            <StatusChip label={sip.registrationState.toUpperCase()} variant={sip.registrationState === "registered" ? "ok" : "neutral"} />
            <StatusChip label={sip.callState.toUpperCase()} variant={statusVariant as any} />
            <StatusChip label={timerLabel} variant="neutral" />
          </View>

          <TextInput style={ui.input} value={target} onChangeText={setTarget} placeholder="Enter extension or number" />

          <View style={ui.row}>
            <TouchableOpacity style={ui.button} onPress={() => sip.dial(target)}><Text style={ui.buttonText}>Dial</Text></TouchableOpacity>
            <TouchableOpacity style={ui.button} onPress={() => sip.answer()}><Text style={ui.buttonText}>Answer</Text></TouchableOpacity>
            <TouchableOpacity style={ui.button} onPress={() => sip.hangup()}><Text style={ui.buttonText}>Hangup</Text></TouchableOpacity>
            <TouchableOpacity style={ui.button} onPress={sip.toggleMute}><Text style={ui.buttonText}>{sip.muted ? "Unmute" : "Mute"}</Text></TouchableOpacity>
            <TouchableOpacity style={ui.button} onPress={sip.toggleSpeaker}><Text style={ui.buttonText}>{sip.speakerOn ? "Earpiece" : "Speaker"}</Text></TouchableOpacity>
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 10 }}>
            {DIGITS.map((d) => (
              <TouchableOpacity key={d} style={[ui.button, { width: "30%", marginRight: "3%" }]} onPress={() => { setTarget((v) => v + d); sip.sendDtmf(d); }}>
                <Text style={ui.buttonText}>{d}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>
    </View>
  );
}

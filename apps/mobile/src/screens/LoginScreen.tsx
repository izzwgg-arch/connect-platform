import React, { useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useAuth } from "../context/AuthContext";
import { HeaderBar } from "../components/HeaderBar";
import { ui } from "../theme";

type UnauthParamList = {
  Login: undefined;
  QrProvision: undefined;
};

export function LoginScreen() {
  const { login } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<UnauthParamList, "Login">>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    try {
      await login(email.trim(), password);
    } catch (e: any) {
      setError(e?.message || "Login failed");
    }
  };

  return (
    <View style={ui.screen}>
      <HeaderBar title="Connect Communications" />
      <View style={ui.content}>
        <View style={ui.card}>
          <Text style={ui.title}>Sign In</Text>
          <TextInput
            style={ui.input}
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <TextInput
            style={ui.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            secureTextEntry
          />
          {error ? <Text style={[ui.text, { color: "#ef4444" }]}>{error}</Text> : null}
          <TouchableOpacity style={ui.button} onPress={submit}>
            <Text style={ui.buttonText}>Sign In</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[ui.button, { marginTop: 10, backgroundColor: "transparent", borderWidth: 1, borderColor: "#6366f1" }]}
            onPress={() => navigation.navigate("QrProvision")}
          >
            <Text style={[ui.buttonText, { color: "#6366f1" }]}>Scan QR Code to Link Device</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

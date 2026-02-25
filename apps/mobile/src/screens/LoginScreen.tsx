import React, { useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import { useAuth } from "../context/AuthContext";
import { HeaderBar } from "../components/HeaderBar";
import { ui } from "../theme";

export function LoginScreen() {
  const { login } = useAuth();
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
          <TextInput style={ui.input} value={email} onChangeText={setEmail} placeholder="Email" autoCapitalize="none" keyboardType="email-address" />
          <TextInput style={ui.input} value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
          {error ? <Text style={ui.text}>{error}</Text> : null}
          <TouchableOpacity style={ui.button} onPress={submit}><Text style={ui.buttonText}>Sign In</Text></TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

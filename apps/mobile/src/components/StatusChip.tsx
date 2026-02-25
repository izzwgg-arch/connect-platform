import React from "react";
import { Text, View } from "react-native";
import { colors, ui } from "../theme";

type Props = { label: string; variant?: "ok" | "warn" | "danger" | "neutral" };

export function StatusChip({ label, variant = "neutral" }: Props) {
  const style =
    variant === "ok"
      ? { backgroundColor: "#e6f7ea", borderColor: "#b7e5c2", color: colors.ok }
      : variant === "danger"
        ? { backgroundColor: "#fce9e9", borderColor: "#f2c6c6", color: colors.danger }
        : variant === "warn"
          ? { backgroundColor: "#fff4dd", borderColor: "#f2dcaa", color: "#8d6600" }
          : { backgroundColor: "#eef3f8", borderColor: "#d5e0ea", color: "#405b74" };

  return (
    <View style={[ui.chip, { backgroundColor: style.backgroundColor, borderColor: style.borderColor }]}>
      <Text style={[ui.chipText, { color: style.color }]}>{label}</Text>
    </View>
  );
}

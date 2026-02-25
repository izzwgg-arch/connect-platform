import React from "react";
import { Text, View } from "react-native";
import { ui } from "../theme";

export function HeaderBar({ title }: { title: string }) {
  return (
    <View style={ui.topbar}>
      <Text style={ui.topbarTitle}>{title}</Text>
      <View style={ui.topbarAvatar}><Text style={ui.topbarAvatarText}>IW</Text></View>
    </View>
  );
}

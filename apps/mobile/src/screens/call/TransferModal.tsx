import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Easing,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { playDtmfTone } from "../../audio/telephonyAudio";
import { useTheme } from "../../context/ThemeContext";

/**
 * TransferModal — cross-platform blind-transfer target picker.
 *
 * Renders a 2026-style glass-morphism keypad sheet that lets the user type
 * an extension or external number and then confirm the transfer. This
 * replaces the old iOS-only Alert.prompt path (which silently did nothing
 * on Android) so the Transfer button works identically on both platforms.
 *
 * Pure presentational — the parent owns the call id and does the actual
 * `callSessions.transfer(callId, target)` call on `onSubmit`.
 */

type Props = {
  visible: boolean;
  title?: string;
  subtitle?: string;
  initialValue?: string;
  /** Confirm-button label; defaults to the original "Transfer". */
  submitLabel?: string;
  /** Ionicons name for the confirm button; defaults to the transfer glyph. */
  submitIcon?: string;
  onCancel: () => void;
  onSubmit: (target: string) => void;
};

const KEYS = [
  { d: "1", s: "" },
  { d: "2", s: "ABC" },
  { d: "3", s: "DEF" },
  { d: "4", s: "GHI" },
  { d: "5", s: "JKL" },
  { d: "6", s: "MNO" },
  { d: "7", s: "PQRS" },
  { d: "8", s: "TUV" },
  { d: "9", s: "WXYZ" },
  { d: "*", s: "" },
  { d: "0", s: "+" },
  { d: "#", s: "" },
];

export function TransferModal({
  visible,
  title = "Blind transfer",
  subtitle = "Enter extension or number",
  initialValue = "",
  submitLabel = "Transfer",
  submitIcon = "git-network-outline",
  onCancel,
  onSubmit,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const slide = useRef(new Animated.Value(0)).current;
  const { isDark } = useTheme();

  // Same palette language as ActiveCallScreen's light/dark modes.
  const pal = isDark
    ? {
        overlay: "rgba(3, 7, 18, 0.72)",
        sheetBg: "rgba(10, 16, 30, 0.98)",
        sheetBorder: "rgba(148, 163, 184, 0.18)",
        handle: "rgba(148, 163, 184, 0.3)",
        title: "#f8fafc",
        subtitle: "rgba(148, 163, 184, 0.85)",
        closeIcon: "rgba(148, 163, 184, 0.9)",
        displayBg: "rgba(148, 163, 184, 0.08)",
        displayBorder: "rgba(148, 163, 184, 0.12)",
        displayText: "#f8fafc",
        bsIcon: "rgba(226, 232, 240, 0.85)",
        keyBg: "rgba(148, 163, 184, 0.06)",
        keyBorder: "rgba(148, 163, 184, 0.08)",
        keyDigit: "#f8fafc",
        keySub: "rgba(148, 163, 184, 0.8)",
        btnSecondaryBg: "rgba(148, 163, 184, 0.1)",
        btnSecondaryBorder: "rgba(148, 163, 184, 0.18)",
        btnSecondaryText: "rgba(226, 232, 240, 0.9)",
      }
    : {
        overlay: "rgba(15, 23, 42, 0.35)",
        sheetBg: "#ffffff",
        sheetBorder: "rgba(16, 35, 70, 0.12)",
        handle: "#c3d0e8",
        title: "#122344",
        subtitle: "rgba(91, 111, 150, 0.8)",
        closeIcon: "rgba(91, 111, 150, 0.9)",
        displayBg: "rgba(16, 35, 70, 0.05)",
        displayBorder: "rgba(16, 35, 70, 0.10)",
        displayText: "#122344",
        bsIcon: "rgba(59, 79, 120, 0.85)",
        keyBg: "rgba(16, 35, 70, 0.04)",
        keyBorder: "rgba(16, 35, 70, 0.08)",
        keyDigit: "#122344",
        keySub: "rgba(91, 111, 150, 0.8)",
        btnSecondaryBg: "rgba(16, 35, 70, 0.06)",
        btnSecondaryBorder: "rgba(16, 35, 70, 0.12)",
        btnSecondaryText: "#122344",
      };

  useEffect(() => {
    if (visible) {
      setValue(initialValue ?? "");
      Animated.timing(slide, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else {
      slide.setValue(0);
    }
  }, [visible, initialValue, slide]);

  const handlePressKey = useCallback(
    (digit: string) => {
      Haptics.selectionAsync().catch(() => undefined);
      // Play the short DTMF sidetone for tactile feedback — this does NOT
      // send a real DTMF to the PBX (that only happens inside an active
      // call via sip.sendDtmf). We're only collecting a transfer target.
      try { playDtmfTone(digit); } catch { /* sidetone best-effort */ }
      setValue((prev) => (prev + digit).slice(0, 32));
    },
    [],
  );

  const handleBackspace = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    setValue((prev) => prev.slice(0, -1));
  }, []);

  const handleClear = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    setValue("");
  }, []);

  const canSubmit = useMemo(() => value.trim().length > 0, [value]);

  const handleSubmit = useCallback(() => {
    const target = value.trim();
    if (!target) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => undefined,
    );
    onSubmit(target);
  }, [value, onSubmit]);

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [60, 0] });
  const opacity = slide;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={[styles.overlay, { backgroundColor: pal.overlay }]}>
        <Animated.View
          style={[
            styles.sheet,
            { backgroundColor: pal.sheetBg, borderColor: pal.sheetBorder },
            { transform: [{ translateY }], opacity },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: pal.handle }]} />

          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: pal.title }]}>{title}</Text>
              <Text style={[styles.subtitle, { color: pal.subtitle }]}>{subtitle}</Text>
            </View>
            <TouchableOpacity onPress={onCancel} hitSlop={12}>
              <Ionicons name="close" size={22} color={pal.closeIcon} />
            </TouchableOpacity>
          </View>

          <View style={[styles.displayWrap, { backgroundColor: pal.displayBg, borderColor: pal.displayBorder }]}>
            <Text
              style={[styles.displayValue, { color: pal.displayText }]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {value || " "}
            </Text>
            {value.length > 0 ? (
              <TouchableOpacity onPress={handleBackspace} style={styles.bsBtn} hitSlop={10}>
                <Ionicons name="backspace-outline" size={22} color={pal.bsIcon} />
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={styles.grid}>
            {KEYS.map(({ d, s }) => (
              <TouchableOpacity
                key={d}
                style={[styles.key, { backgroundColor: pal.keyBg, borderColor: pal.keyBorder }]}
                onPress={() => handlePressKey(d)}
                activeOpacity={0.6}
                onLongPress={d === "0" ? () => handlePressKey("+") : undefined}
              >
                <Text style={[styles.keyDigit, { color: pal.keyDigit }]}>{d}</Text>
                {s ? <Text style={[styles.keySub, { color: pal.keySub }]}>{s}</Text> : null}
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.btn, styles.btnSecondary, { backgroundColor: pal.btnSecondaryBg, borderColor: pal.btnSecondaryBorder }]}
              onPress={handleClear}
              disabled={value.length === 0}
              activeOpacity={0.8}
            >
              <Text style={[styles.btnSecondaryText, { color: pal.btnSecondaryText }, value.length === 0 && { opacity: 0.4 }]}>
                Clear
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary, !canSubmit && styles.btnPrimaryDisabled]}
              onPress={handleSubmit}
              disabled={!canSubmit}
              activeOpacity={0.85}
            >
              <Ionicons
                name={submitIcon as any}
                size={18}
                color="#fff"
                style={{ marginRight: 8 }}
              />
              <Text style={styles.btnPrimaryText}>{submitLabel}</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(3, 7, 18, 0.72)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "rgba(10, 16, 30, 0.98)",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.18)",
    paddingHorizontal: 20,
    paddingBottom: Platform.select({ ios: 32, android: 24, default: 24 }),
    paddingTop: 10,
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -8 },
    elevation: 20,
  },
  handle: {
    alignSelf: "center",
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(148, 163, 184, 0.3)",
    marginBottom: 14,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 14,
  },
  title: {
    color: "#f8fafc",
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  subtitle: {
    color: "rgba(148, 163, 184, 0.85)",
    fontSize: 12,
    marginTop: 2,
  },
  displayWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(148, 163, 184, 0.08)",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.12)",
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 14,
    minHeight: 56,
  },
  displayValue: {
    flex: 1,
    color: "#f8fafc",
    fontSize: 24,
    fontWeight: "600",
    letterSpacing: 1.5,
  },
  bsBtn: {
    paddingLeft: 10,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  key: {
    width: "30%",
    aspectRatio: 1.6,
    backgroundColor: "rgba(148, 163, 184, 0.06)",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.08)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  keyDigit: {
    color: "#f8fafc",
    fontSize: 24,
    fontWeight: "500",
    letterSpacing: 0.5,
  },
  keySub: {
    color: "rgba(148, 163, 184, 0.8)",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.2,
    marginTop: 2,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
  },
  btn: {
    flex: 1,
    height: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  btnSecondary: {
    backgroundColor: "rgba(148, 163, 184, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.18)",
  },
  btnSecondaryText: {
    color: "rgba(226, 232, 240, 0.9)",
    fontSize: 15,
    fontWeight: "600",
  },
  btnPrimary: {
    backgroundColor: "#3b82f6",
    shadowColor: "#3b82f6",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  btnPrimaryDisabled: {
    backgroundColor: "rgba(59, 130, 246, 0.35)",
    shadowOpacity: 0,
    elevation: 0,
  },
  btnPrimaryText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
});

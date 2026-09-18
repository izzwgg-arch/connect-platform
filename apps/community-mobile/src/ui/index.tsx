import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TouchableWithoutFeedback,
  View,
  type PressableProps,
} from "react-native";
import { mediaUrl } from "../api/client";
import { useTheme } from "../theme/ThemeProvider";
import { radius, spacing } from "../theme/tokens";
import { Icon, type IconName } from "./Icon";

// ── Avatar ──────────────────────────────────────────────────────────────
export function Avatar({ assetId, name, size = 40 }: { assetId?: string | null; name?: string | null; size?: number }) {
  const { theme } = useTheme();
  const uri = mediaUrl(assetId, "thumb");
  const initials = (name ?? "?")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
  if (uri) {
    return (
      <Image
        source={{ uri }}
        accessibilityLabel={name ? `${name}'s avatar` : "avatar"}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: theme.panel2 }}
      />
    );
  }
  return (
    <View
      accessibilityLabel={name ? `${name}'s avatar` : "avatar"}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.accent2,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: "#fff", fontSize: size * 0.4, fontWeight: "700" }}>{initials || "?"}</Text>
    </View>
  );
}

// ── Chip ────────────────────────────────────────────────────────────────
export function Chip({
  label,
  active,
  onPress,
  icon,
  testID,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  icon?: IconName;
  testID?: string;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      testID={testID}
      hitSlop={8}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: spacing.md,
        paddingVertical: 8,
        minHeight: 36,
        borderRadius: radius.pill,
        backgroundColor: active ? theme.accent : theme.panel2,
        borderWidth: 1,
        borderColor: active ? theme.accent : theme.border,
      }}
    >
      {icon ? <Icon name={icon} size={14} color={active ? "#fff" : theme.dim} /> : null}
      <Text style={{ color: active ? "#fff" : theme.text, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

// ── Button ──────────────────────────────────────────────────────────────
type ButtonKind = "primary" | "secondary" | "danger" | "ghost";
export function Button({
  title,
  onPress,
  kind = "secondary",
  icon,
  wide,
  disabled,
  loading,
  testID,
  accessibilityLabel,
}: {
  title: string;
  onPress?: () => void;
  kind?: ButtonKind;
  icon?: IconName;
  wide?: boolean;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
  accessibilityLabel?: string;
} & Pick<PressableProps, never>) {
  const { theme } = useTheme();
  const bg = kind === "primary" ? theme.accent : kind === "danger" ? theme.danger : kind === "ghost" ? "transparent" : theme.panel2;
  const fg = kind === "primary" || kind === "danger" ? "#fff" : theme.text;
  const border = kind === "ghost" ? "transparent" : kind === "secondary" ? theme.border : bg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minHeight: 44,
        paddingHorizontal: spacing.lg,
        borderRadius: radius.md,
        backgroundColor: bg,
        borderWidth: 1,
        borderColor: border,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        alignSelf: wide ? "stretch" : "flex-start",
      })}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} size={18} color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: "700", fontSize: 15 }}>{title}</Text>
    </Pressable>
  );
}

// ── Field ───────────────────────────────────────────────────────────────
export function Field({
  label,
  error,
  ...props
}: { label?: string; error?: string | null } & TextInputProps & { testID?: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {label ? (
        <Text accessibilityRole="text" style={{ color: theme.dim, fontSize: 13, fontWeight: "600" }}>
          {label}
        </Text>
      ) : null}
      <TextInput
        placeholderTextColor={theme.dim}
        accessibilityLabel={label ?? props.placeholder}
        style={[
          {
            minHeight: 44,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: error ? theme.danger : theme.border,
            backgroundColor: theme.panel2,
            color: theme.text,
            paddingHorizontal: spacing.md,
            fontSize: 15,
          },
          props.multiline ? { minHeight: 90, textAlignVertical: "top", paddingTop: 10 } : null,
        ]}
        {...props}
      />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.danger, fontSize: 12 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

// ── Card ────────────────────────────────────────────────────────────────
export function Card({ children, style, tight }: { children: ReactNode; style?: any; tight?: boolean }) {
  const { theme } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.panel,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: theme.border,
          padding: tight ? spacing.sm : spacing.md,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ── Empty ───────────────────────────────────────────────────────────────
export function Empty({ icon = "info", title, hint }: { icon?: IconName; title: string; hint?: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xxl, paddingHorizontal: spacing.lg }}>
      <Icon name={icon} size={32} color={theme.dim} />
      <Text style={{ color: theme.text, fontWeight: "700", fontSize: 16, textAlign: "center" }}>{title}</Text>
      {hint ? <Text style={{ color: theme.dim, fontSize: 13, textAlign: "center" }}>{hint}</Text> : null}
    </View>
  );
}

// ── Skeleton ────────────────────────────────────────────────────────────
export function Skeleton({ height = 16, width = "100%", radius: r = 6 }: { height?: number; width?: number | string; radius?: number }) {
  const { theme } = useTheme();
  return <View accessibilityLabel="loading" style={{ height, width: width as any, borderRadius: r, backgroundColor: theme.panel2 }} />;
}

// ── Toast ───────────────────────────────────────────────────────────────
type ToastKind = "ok" | "err";
type ToastFn = (msg: string, opts?: { kind?: ToastKind }) => void;
const ToastCtx = createContext<ToastFn>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const [toast, setToast] = useState<{ msg: string; kind: ToastKind } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback<ToastFn>((msg, opts) => {
    setToast({ msg, kind: opts?.kind ?? "ok" });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast ? (
        <View
          accessibilityLiveRegion="polite"
          style={{
            position: "absolute",
            left: spacing.lg,
            right: spacing.lg,
            bottom: spacing.xxl,
            backgroundColor: toast.kind === "err" ? theme.danger : theme.panel2,
            borderRadius: radius.md,
            padding: spacing.md,
            borderWidth: 1,
            borderColor: theme.border,
          }}
        >
          <Text style={{ color: toast.kind === "err" ? "#fff" : theme.text }}>{toast.msg}</Text>
        </View>
      ) : null}
    </ToastCtx.Provider>
  );
}
export function useToast(): ToastFn {
  return useContext(ToastCtx);
}

// ── Sheet (bottom sheet via Modal) ─────────────────────────────────────
export function Sheet({ visible, onClose, children, title }: { visible: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  const { theme } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
          <TouchableWithoutFeedback onPress={() => {}}>
            <View
              style={{
                backgroundColor: theme.panel,
                borderTopLeftRadius: radius.lg,
                borderTopRightRadius: radius.lg,
                padding: spacing.lg,
                maxHeight: "85%",
                borderWidth: 1,
                borderColor: theme.border,
                borderBottomWidth: 0,
              }}
            >
              <View style={{ alignItems: "center", marginBottom: spacing.sm }}>
                <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: theme.border }} />
              </View>
              {title ? (
                <Text accessibilityRole="header" style={{ color: theme.text, fontWeight: "700", fontSize: 16, marginBottom: spacing.sm }}>
                  {title}
                </Text>
              ) : null}
              {children}
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

export { Icon };
export type { IconName };

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { spacing } from '../../theme/spacing';
import { AppAlertOptions, registerAppAlertHandler } from './appAlert';

export type PopupAction = {
  key?: string;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  destructive?: boolean;
  muted?: boolean;
  disabled?: boolean;
  onPress?: () => void;
};

type ActionSheetProps = {
  visible: boolean;
  title?: string;
  message?: string;
  actions: PopupAction[];
  onClose: () => void;
};

type ConfirmProps = {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

function AnimatedPanel({ children, center }: { children: React.ReactNode; center?: boolean }) {
  const scale = useRef(new Animated.Value(0.96)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, speed: 24, bounciness: 6, useNativeDriver: true }),
    ]).start();
  }, [opacity, scale]);

  return (
    <Animated.View
      style={[
        center ? styles.centerPanel : styles.sheetPanel,
        { opacity, transform: [{ scale }] },
      ]}
    >
      {children}
    </Animated.View>
  );
}

export function AppActionSheet({ visible, title, message, actions, onClose }: ActionSheetProps) {
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <AnimatedPanel>
          <Pressable
            style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => undefined}
          >
            {(title || message) && (
              <View style={[styles.header, { borderBottomColor: colors.borderSubtle }]}>
                {title ? <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{title}</Text> : null}
                {message ? <Text style={[styles.message, { color: colors.textSecondary }]}>{message}</Text> : null}
              </View>
            )}
            {actions.map((action, index) => {
              const tint = action.destructive ? colors.danger : action.muted ? colors.textTertiary : colors.text;
              const iconTint = action.destructive ? colors.danger : action.muted ? colors.textTertiary : colors.primary;
              return (
                <TouchableOpacity
                  key={action.key ?? `${action.label}:${index}`}
                  activeOpacity={0.78}
                  disabled={action.disabled}
                  style={[styles.actionRow, action.disabled && { opacity: 0.45 }]}
                  onPress={() => {
                    onClose();
                    action.onPress?.();
                  }}
                >
                  <View style={[styles.actionIcon, { backgroundColor: action.destructive ? colors.dangerMuted : colors.primaryMuted }]}>
                    <Ionicons name={action.icon ?? 'ellipse-outline'} size={18} color={iconTint} />
                  </View>
                  <Text style={[styles.actionText, { color: tint }]}>{action.label}</Text>
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </AnimatedPanel>
      </Pressable>
    </Modal>
  );
}

export function AppConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'Yes',
  cancelLabel = 'Cancel',
  destructive,
  onConfirm,
  onClose,
}: ConfirmProps) {
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, styles.centerBackdrop]} onPress={onClose}>
        <AnimatedPanel center>
          <Pressable
            style={[styles.confirmCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => undefined}
          >
            <Text style={[styles.confirmTitle, { color: colors.text }]}>{title}</Text>
            {message ? <Text style={[styles.confirmMessage, { color: colors.textSecondary }]}>{message}</Text> : null}
            <View style={styles.confirmActions}>
              <TouchableOpacity
                activeOpacity={0.78}
                style={[styles.confirmButton, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
                onPress={onClose}
              >
                <Text style={[styles.confirmButtonText, { color: colors.textSecondary }]}>{cancelLabel}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.78}
                style={[styles.confirmButton, { backgroundColor: destructive ? colors.danger : colors.primary, borderColor: 'transparent' }]}
                onPress={() => {
                  onClose();
                  onConfirm();
                }}
              >
                <Text style={[styles.confirmButtonText, { color: '#fff' }]}>{confirmLabel}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </AnimatedPanel>
      </Pressable>
    </Modal>
  );
}

/**
 * Mount once near the app root. Registers the imperative `showAppAlert`
 * handler and renders a Connect-themed modal instead of the white system
 * dialog. Supports the same shape as `Alert.alert(title, message, buttons)`.
 */
export function AppAlertHost() {
  const { colors } = useTheme();
  const [current, setCurrent] = useState<AppAlertOptions | null>(null);

  useEffect(() => {
    registerAppAlertHandler((opts) => setCurrent(opts));
    return () => registerAppAlertHandler(null);
  }, []);

  const close = () => setCurrent(null);

  const buttons =
    current?.buttons && current.buttons.length > 0
      ? current.buttons
      : [{ text: 'OK' as const }];
  const stacked = buttons.length > 2;

  return (
    <Modal visible={!!current} transparent animationType="fade" onRequestClose={close}>
      <Pressable
        style={[styles.backdrop, styles.centerBackdrop]}
        onPress={() => {
          // Tapping the scrim behaves like a cancel button if one exists.
          const cancel = buttons.find((b) => b.style === 'cancel');
          close();
          cancel?.onPress?.();
        }}
      >
        <AnimatedPanel center>
          <Pressable
            style={[styles.confirmCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => undefined}
          >
            {current?.title ? (
              <Text style={[styles.confirmTitle, { color: colors.text }]}>{current.title}</Text>
            ) : null}
            {current?.message ? (
              <Text style={[styles.confirmMessage, { color: colors.textSecondary }]}>{current.message}</Text>
            ) : null}
            <View style={[styles.confirmActions, stacked && styles.alertActionsStacked]}>
              {buttons.map((btn, index) => {
                const isPrimary = btn.style !== 'cancel';
                const bg = btn.style === 'destructive'
                  ? colors.danger
                  : btn.style === 'cancel'
                    ? colors.surfaceElevated
                    : colors.primary;
                const fg = btn.style === 'cancel' ? colors.textSecondary : '#fff';
                return (
                  <TouchableOpacity
                    key={`${btn.text}:${index}`}
                    activeOpacity={0.78}
                    style={[
                      styles.confirmButton,
                      stacked && styles.alertButtonStacked,
                      { backgroundColor: bg, borderColor: btn.style === 'cancel' ? colors.border : 'transparent' },
                    ]}
                    onPress={() => {
                      close();
                      btn.onPress?.();
                    }}
                  >
                    <Text style={[styles.confirmButtonText, { color: fg }]}>{btn.text}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </Pressable>
        </AnimatedPanel>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.58)',
    padding: spacing['5'],
  },
  centerBackdrop: {
    justifyContent: 'center',
  },
  sheetPanel: {
    width: '100%',
  },
  centerPanel: {
    width: '100%',
  },
  card: {
    borderRadius: 20,
    borderWidth: 1,
    padding: spacing['3'],
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.32,
    shadowRadius: 28,
    elevation: 14,
  },
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing['2'],
    paddingBottom: spacing['3'],
    marginBottom: spacing['1'],
  },
  title: {
    fontSize: 17,
    lineHeight: 23,
    fontWeight: '900',
    letterSpacing: -0.2,
  },
  message: {
    marginTop: 3,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
  },
  actionRow: {
    minHeight: 54,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['3'],
    paddingHorizontal: spacing['2'],
  },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '800',
  },
  confirmCard: {
    borderRadius: 20,
    borderWidth: 1,
    padding: spacing['5'],
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.32,
    shadowRadius: 28,
    elevation: 14,
  },
  confirmTitle: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '900',
    letterSpacing: -0.2,
  },
  confirmMessage: {
    marginTop: spacing['2'],
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '600',
  },
  confirmActions: {
    flexDirection: 'row',
    gap: spacing['3'],
    marginTop: spacing['5'],
  },
  alertActionsStacked: {
    flexDirection: 'column-reverse',
  },
  alertButtonStacked: {
    flex: 0,
    width: '100%',
  },
  confirmButton: {
    flex: 1,
    height: 46,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmButtonText: {
    fontSize: 14,
    fontWeight: '900',
  },
});

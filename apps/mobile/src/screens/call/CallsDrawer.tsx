/**
 * CallsDrawer — unified multi-call control surface rendered on top of the
 * ActiveCallScreen. Replaces the older HeldCallsStrip and collapses all
 * active + held + ringing + dialing calls into one compact panel.
 *
 * Design goal: "SaaS 2026" — clean, quiet, professional. No giant chrome,
 * no shouting gradients. Every row is a dense, glass-ish pill with:
 *   - state dot (subtle pulse only for active/ringing)
 *   - caller name / number
 *   - status label
 *   - a single  ⋮  overflow button that opens an in-row menu with the
 *     full set of actions (Answer / Decline / Resume / Hold / Transfer /
 *     Merge / Hangup) depending on the call's state.
 *
 * For ringing rows the big green Answer button is still presented inline
 * so the user can take the call in one tap; all other actions live behind
 * the 3-dot menu to keep the row visually quiet.
 *
 * Hidden entirely when total calls < 2. Single-call flow stays unchanged.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Pressable,
  Platform,
  Easing,
  Alert,
  Dimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useCallSessions } from "../../context/CallSessionManager";
import type { CallSession } from "../../types/callSession";
import { TransferModal } from "./TransferModal";

// ── Palette ───────────────────────────────────────────────────────────────────
// Deliberately muted. The drawer sits on top of the ActiveCallScreen's dark
// backdrop and shouldn't compete for attention.

type RowAccent = "active" | "held" | "ringing" | "dialing";

const ACCENT: Record<RowAccent, string> = {
  active: "#34d399",
  held: "#fbbf24",
  ringing: "#60a5fa",
  dialing: "#818cf8",
};

function accentFor(session: CallSession): RowAccent {
  if (session.state === "active" || session.state === "connecting") return "active";
  if (session.state === "held") return "held";
  if (session.state === "ringing_inbound") return "ringing";
  return "dialing";
}

function statusLabel(session: CallSession): string {
  switch (session.state) {
    case "active":
      return "On call";
    case "connecting":
      return "Connecting…";
    case "held":
      return "On hold";
    case "ringing_inbound":
      return "Incoming";
    case "dialing_outbound":
      return "Dialing…";
    case "ended":
      return "Ended";
    default:
      return "";
  }
}

// ── Row menu ──────────────────────────────────────────────────────────────────

type MenuAction = {
  key: string;
  label: string;
  icon: string;
  tone?: "default" | "primary" | "warning" | "danger";
  rotate?: string;
  onPress: () => void;
};

function RowMenu({ actions, onClose }: { actions: MenuAction[]; onClose: () => void }) {
  return (
    <>
      {/* Transparent scrim — tapping outside closes the menu. */}
      <Pressable
        onPress={onClose}
        style={StyleSheet.absoluteFill}
        // Relative to the dropdown, NOT full screen — kept fully transparent.
      />
      <View style={styles.menuPanel} pointerEvents="box-none">
        {actions.map((a, idx) => (
          <TouchableOpacity
            key={a.key}
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              onClose();
              a.onPress();
            }}
            activeOpacity={0.7}
            style={[
              styles.menuItem,
              idx === actions.length - 1 ? null : styles.menuItemDivider,
            ]}
          >
            <Ionicons
              name={a.icon as any}
              size={16}
              color={
                a.tone === "danger"
                  ? "#fca5a5"
                  : a.tone === "warning"
                    ? "#fbbf24"
                    : a.tone === "primary"
                      ? "#34d399"
                      : "#e2e8f0"
              }
              style={a.rotate ? { transform: [{ rotate: a.rotate }] } : undefined}
            />
            <Text
              style={[
                styles.menuText,
                a.tone === "danger" ? { color: "#fca5a5" } : null,
                a.tone === "warning" ? { color: "#fbbf24" } : null,
                a.tone === "primary" ? { color: "#34d399" } : null,
              ]}
            >
              {a.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

type RowProps = {
  session: CallSession;
  isOnlyOther: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onAnswer: (id: string) => void;
  onDecline: (id: string) => void;
  onResume: (id: string) => void;
  onHold: () => void;
  onHangup: (id: string) => void;
  onTransfer: (id: string) => void;
  onMerge: () => void;
  canMerge: boolean;
};

function Row({
  session,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onAnswer,
  onDecline,
  onResume,
  onHold,
  onHangup,
  onTransfer,
  onMerge,
  canMerge,
}: RowProps) {
  const accent = accentFor(session);
  const primary = ACCENT[accent];
  const isRinging = accent === "ringing";
  const isActive = accent === "active";
  const isHeld = accent === "held";

  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isActive && !isRinging) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 900,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.ease),
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.ease),
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isActive, isRinging, pulse]);

  const name = session.remoteName?.trim() || session.remoteNumber || "Unknown";
  const subtitle =
    session.remoteName && session.remoteNumber && session.remoteName !== session.remoteNumber
      ? session.remoteNumber
      : null;

  // Build the menu actions based on call state. Keep them ordered most-used
  // first and group destructive actions at the bottom.
  const menuActions = useMemo<MenuAction[]>(() => {
    const out: MenuAction[] = [];
    if (isRinging) {
      out.push({
        key: "answer",
        label: "Answer",
        icon: "call",
        tone: "primary",
        onPress: () => onAnswer(session.id),
      });
      out.push({
        key: "decline",
        label: "Decline",
        icon: "call",
        rotate: "135deg",
        tone: "danger",
        onPress: () => onDecline(session.id),
      });
      return out;
    }
    if (isHeld) {
      out.push({
        key: "resume",
        label: "Resume",
        icon: "play",
        tone: "primary",
        onPress: () => onResume(session.id),
      });
    }
    if (isActive) {
      out.push({
        key: "hold",
        label: "Hold",
        icon: "pause",
        tone: "warning",
        onPress: () => onHold(),
      });
    }
    if (isActive || isHeld) {
      out.push({
        key: "transfer",
        label: "Transfer",
        icon: "git-network-outline",
        onPress: () => onTransfer(session.id),
      });
      if (canMerge) {
        out.push({
          key: "merge",
          label: "Merge calls",
          icon: "git-merge-outline",
          onPress: () => onMerge(),
        });
      }
    }
    out.push({
      key: "hangup",
      label: "Hang up",
      icon: "call",
      rotate: "135deg",
      tone: "danger",
      onPress: () => onHangup(session.id),
    });
    return out;
  }, [
    isRinging,
    isHeld,
    isActive,
    canMerge,
    onAnswer,
    onDecline,
    onResume,
    onHold,
    onTransfer,
    onMerge,
    onHangup,
    session.id,
  ]);

  return (
    <View style={styles.rowWrapper}>
      <View style={[styles.row, { borderColor: primary + "33" }]}>
        <Animated.View
          style={[styles.dot, { backgroundColor: primary, opacity: pulse }]}
        />

        <View style={styles.rowText}>
          <Text style={[styles.rowStatus, { color: primary }]}>
            {statusLabel(session)}
          </Text>
          <Text style={styles.rowName} numberOfLines={1}>
            {name}
          </Text>
          {subtitle ? (
            <Text style={styles.rowSub} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {/* Inline quick-answer for ringing rows — keeps the "swipe to pick
            up" reflex. All other actions live behind the overflow menu. */}
        {isRinging && (
          <TouchableOpacity
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
              onAnswer(session.id);
            }}
            activeOpacity={0.85}
            accessibilityLabel="Answer"
            style={[styles.quickBtn, { backgroundColor: "#10b981" }]}
          >
            <Ionicons name="call" size={15} color="#fff" />
          </TouchableOpacity>
        )}

        <TouchableOpacity
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            onToggleMenu();
          }}
          activeOpacity={0.7}
          accessibilityLabel="More actions"
          style={styles.moreBtn}
        >
          <Ionicons
            name="ellipsis-horizontal"
            size={18}
            color="rgba(226, 232, 240, 0.9)"
          />
        </TouchableOpacity>
      </View>

      {menuOpen && <RowMenu actions={menuActions} onClose={onCloseMenu} />}
    </View>
  );
}

// ── Drawer ────────────────────────────────────────────────────────────────────

export function CallsDrawer() {
  const {
    activeCall,
    heldCalls,
    ringingCalls,
    answerWaiting,
    declineWaiting,
    resume,
    holdActive,
    hangup,
    transfer,
  } = useCallSessions();

  // Freshness guard: ignore ringing rows that don't have a SIP session
  // attached AND are older than a few seconds. Those are phantoms from a
  // stale push/pending-list invite that never materialised — rendering
  // them as "INCOMING" misleads the user and gives them an Answer button
  // that does nothing. The CallSessionManager sweep will GC them shortly
  // afterwards; this keeps them off screen in the interim.
  const PHANTOM_TOLERATION_MS = 4_000;
  const nowTick = Date.now();
  const liveRingingCalls = useMemo(
    () =>
      ringingCalls.filter((c) => {
        if (c.sipSessionId) return true;
        return nowTick - c.startedAt < PHANTOM_TOLERATION_MS;
      }),
    [ringingCalls, nowTick],
  );

  const allCalls = useMemo<CallSession[]>(() => {
    const out: CallSession[] = [];
    if (activeCall) out.push(activeCall);
    for (const c of heldCalls) out.push(c);
    for (const c of liveRingingCalls) {
      if (activeCall && c.id === activeCall.id) continue;
      out.push(c);
    }
    return out;
  }, [activeCall, heldCalls, liveRingingCalls]);

  const totalCalls = allCalls.length;
  const hasIncoming = liveRingingCalls.some(
    (c) => !activeCall || c.id !== activeCall.id,
  );
  const canMerge = !!activeCall && heldCalls.length > 0;

  // Diagnostic: every render logs the roster of calls we know about so we
  // can verify (via logcat) that the drawer is in sync with the multi-
  // call state. Helps root-cause "I can't see the second call" reports.
  useEffect(() => {
    console.log(
      "[MULTICALL] drawer_render",
      JSON.stringify({
        total: totalCalls,
        hasIncoming,
        active: activeCall?.id ?? null,
        held: heldCalls.map((c) => c.id),
        ringing: ringingCalls.map((c) => ({
          id: c.id,
          state: c.state,
          hasSip: !!c.sipSessionId,
          from: c.remoteNumber,
        })),
      }),
    );
  }, [totalCalls, hasIncoming, activeCall, heldCalls, ringingCalls]);

  const [expanded, setExpanded] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const slide = useRef(new Animated.Value(0)).current;
  const pillPulse = useRef(new Animated.Value(0)).current;

  // Auto-collapse when the drawer has nothing meaningful to show. We do NOT
  // auto-expand on incoming — the CallWaitingBanner is the high-visibility
  // prompt for "there's a call ringing right now". The drawer is strictly a
  // USER-initiated call manager: tap the pill to expand and see all calls
  // with their caller IDs + per-call actions.
  useEffect(() => {
    if (totalCalls < 2) {
      setExpanded(false);
      setOpenMenuId(null);
    }
  }, [totalCalls]);

  useEffect(() => {
    Animated.spring(slide, {
      toValue: expanded ? 1 : 0,
      useNativeDriver: true,
      speed: 22,
      bounciness: 4,
    }).start();
  }, [expanded, slide]);

  useEffect(() => {
    if (!hasIncoming) {
      pillPulse.stopAnimation();
      pillPulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pillPulse, {
          toValue: 1,
          duration: 700,
          useNativeDriver: false,
          easing: Easing.inOut(Easing.ease),
        }),
        Animated.timing(pillPulse, {
          toValue: 0,
          duration: 700,
          useNativeDriver: false,
          easing: Easing.inOut(Easing.ease),
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [hasIncoming, pillPulse]);

  const handleHangupRow = useCallback(
    (id: string) => {
      hangup(id).catch(() => undefined);
    },
    [hangup],
  );

  const handleAnswer = useCallback(
    (id: string) => {
      answerWaiting(id).catch(() => undefined);
    },
    [answerWaiting],
  );

  const handleDecline = useCallback(
    (id: string) => {
      declineWaiting(id).catch(() => undefined);
    },
    [declineWaiting],
  );

  // Cross-platform blind-transfer: open the TransferModal (shared with
  // ActiveCallScreen) with the target call id stashed in state. On
  // submit, forward to the multi-call manager.
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null);
  const transferTargetSession = useMemo<CallSession | null>(() => {
    if (!transferTargetId) return null;
    return (
      allCalls.find((c) => c.id === transferTargetId) ?? null
    );
  }, [transferTargetId, allCalls]);

  const handleTransfer = useCallback(
    (id: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      setOpenMenuId(null);
      setTransferTargetId(id);
    },
    [],
  );

  const handleTransferSubmit = useCallback(
    (target: string) => {
      const id = transferTargetId;
      setTransferTargetId(null);
      if (!id) return;
      const ok = transfer(id, target);
      if (!ok) {
        Alert.alert("Transfer failed", "Unable to dispatch transfer.");
      }
    },
    [transfer, transferTargetId],
  );

  const handleMerge = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    Alert.alert(
      "Merge calls",
      "Conference bridging requires PBX conference-room support. Contact your admin to configure a conference extension.",
      [{ text: "OK" }],
    );
  }, []);

  const togglePill = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    setOpenMenuId(null);
    setExpanded((x) => !x);
  }, []);

  if (totalCalls < 2) return null;

  const pillBorder = pillPulse.interpolate({
    inputRange: [0, 1],
    outputRange: ["rgba(148, 163, 184, 0.25)", "rgba(96, 165, 250, 0.75)"],
  });

  const pillBg = pillPulse.interpolate({
    inputRange: [0, 1],
    outputRange: ["rgba(15, 23, 42, 0.78)", "rgba(30, 58, 138, 0.62)"],
  });

  return (
    <View style={styles.wrapper} pointerEvents="box-none">
      {/* The pill self-centers inside the full-width wrapper. Keeping the
          pill compact while letting the dropdown panel below take a proper
          width is what lets the caller rows render with full names. */}
      <Pressable
        onPress={togglePill}
        accessibilityRole="button"
        accessibilityLabel={`${totalCalls} calls — tap to manage`}
        style={styles.pillWrap}
      >
        <Animated.View
          style={[
            styles.pill,
            { borderColor: pillBorder, backgroundColor: pillBg },
          ]}
        >
          <View
            style={[
              styles.pillDot,
              {
                backgroundColor: hasIncoming ? "#60a5fa" : "#34d399",
              },
            ]}
          />
          <Text style={styles.pillText}>
            {totalCalls} CALLS{hasIncoming ? " · INCOMING" : ""}
          </Text>
          <Ionicons
            name={expanded ? "chevron-up" : "chevron-down"}
            size={13}
            color="rgba(203, 213, 225, 0.85)"
            style={{ marginLeft: 6 }}
          />
        </Animated.View>
      </Pressable>

      {/* Dropdown card — only mounted when expanded. This keeps the UI
          quiet while a call is simply ringing (banner handles that) and
          only reveals the full call roster when the user explicitly taps
          the pill to manage their calls. */}
      {expanded && (
        <Animated.View
          style={[
            styles.dropdown,
            {
              opacity: slide,
              transform: [
                {
                  translateY: slide.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-6, 0],
                  }),
                },
              ],
            },
          ]}
          pointerEvents="auto"
        >
          <View style={styles.dropdownCard}>
            {allCalls.map((session, idx) => (
              <React.Fragment key={session.id}>
                {idx > 0 ? <View style={styles.rowDivider} /> : null}
                <Row
                  session={session}
                  isOnlyOther={totalCalls === 2}
                  menuOpen={openMenuId === session.id}
                  onToggleMenu={() =>
                    setOpenMenuId((prev) =>
                      prev === session.id ? null : session.id,
                    )
                  }
                  onCloseMenu={() => setOpenMenuId(null)}
                  onAnswer={handleAnswer}
                  onDecline={handleDecline}
                  onResume={resume}
                  onHold={holdActive}
                  onHangup={handleHangupRow}
                  onTransfer={handleTransfer}
                  onMerge={handleMerge}
                  canMerge={canMerge}
                />
              </React.Fragment>
            ))}
          </View>
        </Animated.View>
      )}

      {/* Shared transfer modal — same UI as the ActiveCallScreen's
          Transfer button. Opening it from any row's ⋮ → Transfer pipes
          the chosen call id through on submit. */}
      <TransferModal
        visible={!!transferTargetId}
        title="Transfer call"
        subtitle={
          transferTargetSession
            ? `Transfer ${transferTargetSession.remoteName || transferTargetSession.remoteNumber || 'this call'} to…`
            : 'Enter extension or number'
        }
        onCancel={() => setTransferTargetId(null)}
        onSubmit={handleTransferSubmit}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const SCREEN_WIDTH = Dimensions.get("window").width;
const DROPDOWN_WIDTH = Math.min(SCREEN_WIDTH - 24, 380);

const styles = StyleSheet.create({
  wrapper: {
    width: "100%",
    alignItems: "center",
    paddingTop: Platform.select({ ios: 2, android: 2, default: 2 }),
    zIndex: 50,
  },

  pillWrap: {
    alignSelf: "center",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  pillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 7,
  },
  pillText: {
    color: "rgba(226, 232, 240, 0.92)",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.1,
  },

  dropdown: {
    marginTop: 10,
    width: DROPDOWN_WIDTH,
    alignSelf: "center",
  },
  dropdownCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.18)",
    backgroundColor: "rgba(10, 16, 30, 0.94)",
    paddingVertical: 4,
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
    overflow: "visible",
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(148, 163, 184, 0.14)",
    marginHorizontal: 14,
  },

  rowWrapper: {
    position: "relative",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "transparent",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 12,
  },
  rowText: {
    flex: 1,
    marginRight: 8,
  },
  rowStatus: {
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 1.2,
    marginBottom: 2,
    textTransform: "uppercase",
  },
  rowName: {
    color: "#f8fafc",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: -0.1,
  },
  rowSub: {
    color: "rgba(148, 163, 184, 0.85)",
    fontSize: 12,
    marginTop: 1,
  },

  quickBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 6,
    shadowColor: "#10b981",
    shadowOpacity: 0.45,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  moreBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(30, 41, 59, 0.72)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.18)",
  },

  menuPanel: {
    position: "absolute",
    top: "100%",
    right: 6,
    marginTop: 4,
    minWidth: 170,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.22)",
    backgroundColor: "rgba(17, 24, 39, 0.98)",
    paddingVertical: 4,
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
    zIndex: 100,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  menuItemDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(148, 163, 184, 0.14)",
  },
  menuText: {
    color: "#e2e8f0",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.1,
  },
});

/**
 * CallWaitingBanner — compact call-waiting chip shown above the active call
 * screen when a new inbound INVITE arrives mid-call.
 *
 * Styling target: "modern sassy 2026" — thin glassy chip, subtle gradient
 * accent, spring-in on mount, auto-fades the moment the user taps Answer
 * (the underlying CallSessionManager optimistically pops the call out of
 * `ringingCallIds` so this component re-renders to `null`).
 *
 * Behaviour:
 *   - Shown ONLY when there is an active call and a different ringing call.
 *   - Never shown for the initial incoming call (that's the full-screen
 *     IncomingCallScreen's job).
 *   - Answer → current active is held, waiting call becomes active.
 *   - Decline → this call is ended with 486; current active stays put.
 *
 * Defensive filters guard against a duplicate-CallSession race where the
 * push-layer registerInboundInvite() and the SIP onSessionAdded() briefly
 * register two rows for the same real call; matching normalised remote
 * numbers are filtered so the banner never shows a ghost of the active call.
 */

import React, { useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Easing,
  Platform,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useCallSessions } from "../../context/CallSessionManager";

export function CallWaitingBanner() {
  const { ringingCalls, answerWaiting, declineWaiting, activeCall } =
    useCallSessions();

  const normaliseRemote = (s: string | null | undefined) =>
    (s ?? "").replace(/[^\d]/g, "");
  const activeRemote = activeCall ? normaliseRemote(activeCall.remoteNumber) : "";
  // Require a live SIP session on the waiting call (or a very recent
  // registration), otherwise the Answer button would fail silently —
  // this also keeps stale backend-pending invites from ghosting the
  // banner forever.
  const PHANTOM_TOLERATION_MS = 4_000;
  const now = Date.now();
  const waitingCalls = ringingCalls.filter((c) => {
    if (!activeCall) return true;
    if (c.id === activeCall.id) return false;
    const r = normaliseRemote(c.remoteNumber);
    if (r && activeRemote && r === activeRemote) return false;
    if (c.state !== "ringing_inbound") return false;
    if (!c.sipSessionId && now - c.startedAt >= PHANTOM_TOLERATION_MS) {
      return false;
    }
    return true;
  });

  const shouldShow = !!activeCall && waitingCalls.length > 0;
  const incoming = waitingCalls[0] ?? null;

  const slide = useRef(new Animated.Value(-120)).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!shouldShow) {
      Animated.timing(slide, {
        toValue: -120,
        duration: 180,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    Animated.spring(slide, {
      toValue: 0,
      useNativeDriver: true,
      speed: 16,
      bounciness: 7,
    }).start();

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1.035,
          duration: 780,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 780,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    pulseLoop.start();

    const shimmerLoop = Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: 2200,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    shimmer.setValue(0);
    shimmerLoop.start();

    return () => {
      pulseLoop.stop();
      shimmerLoop.stop();
    };
  }, [shouldShow, slide, pulse, shimmer]);

  const handleAnswer = useCallback(async () => {
    if (!incoming) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    await answerWaiting(incoming.id);
  }, [incoming, answerWaiting]);

  const handleDecline = useCallback(async () => {
    if (!incoming) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    await declineWaiting(incoming.id);
  }, [incoming, declineWaiting]);

  if (!shouldShow || !incoming) return null;

  const name = incoming.remoteName?.trim() || incoming.remoteNumber || "Unknown";
  const subtitle = incoming.remoteName && incoming.remoteNumber && incoming.remoteName !== incoming.remoteNumber
    ? incoming.remoteNumber
    : null;

  const shimmerX = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [-180, 320],
  });

  return (
    <Animated.View
      style={[
        styles.container,
        { transform: [{ translateY: slide }] },
      ]}
      pointerEvents="box-none"
    >
      <Animated.View style={[styles.card, { transform: [{ scale: pulse }] }]}>
        {/* Ambient gradient backdrop — the "sassy" accent */}
        <LinearGradient
          colors={[
            "rgba(16, 185, 129, 0.22)",
            "rgba(14, 165, 233, 0.10)",
            "rgba(17, 24, 39, 0.0)",
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {/* Shimmer streak */}
        <Animated.View
          style={[
            styles.shimmer,
            { transform: [{ translateX: shimmerX }, { rotate: "12deg" }] },
          ]}
          pointerEvents="none"
        >
          <LinearGradient
            colors={[
              "rgba(255,255,255,0)",
              "rgba(255,255,255,0.16)",
              "rgba(255,255,255,0)",
            ]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>

        {/* Status dot + icon */}
        <View style={styles.leftIcon}>
          <View style={styles.leftDot} />
          <Ionicons name="call" size={18} color="#10b981" />
        </View>

        <View style={styles.textCol}>
          <Text style={styles.label}>CALL WAITING</Text>
          <Text style={styles.name} numberOfLines={1}>{name}</Text>
          {subtitle ? (
            <Text style={styles.sub} numberOfLines={1}>{subtitle}</Text>
          ) : null}
        </View>

        <TouchableOpacity
          style={[styles.btn, styles.declineBtn]}
          onPress={handleDecline}
          activeOpacity={0.82}
          accessibilityLabel="Decline waiting call"
        >
          <Ionicons
            name="call"
            size={18}
            color="#fff"
            style={{ transform: [{ rotate: "135deg" }] }}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.answerBtn]}
          onPress={handleAnswer}
          activeOpacity={0.82}
          accessibilityLabel="Answer waiting call"
        >
          <Ionicons name="call" size={18} color="#fff" />
        </TouchableOpacity>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Positioning is owned by the ActiveCallScreen overlay wrapper; this
    // component only controls horizontal padding + its own slide transform.
    paddingHorizontal: 10,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(10, 16, 30, 0.82)",
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(52, 211, 153, 0.45)",
    shadowColor: "#10b981",
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
    overflow: "hidden",
  },
  shimmer: {
    position: "absolute",
    top: -10,
    bottom: -10,
    width: 70,
  },
  leftIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(16, 185, 129, 0.18)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
    position: "relative",
  },
  leftDot: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#22c55e",
    shadowColor: "#22c55e",
    shadowOpacity: 0.9,
    shadowRadius: 6,
  },
  textCol: {
    flex: 1,
    marginRight: 8,
  },
  label: {
    color: "rgba(167, 243, 208, 0.95)",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  name: {
    color: "#f8fafc",
    fontSize: 15,
    fontWeight: "600",
    marginTop: 2,
    letterSpacing: -0.1,
  },
  sub: {
    color: "rgba(148, 163, 184, 0.85)",
    fontSize: 11,
    marginTop: 1,
  },
  btn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 6,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  declineBtn: { backgroundColor: "#ef4444" },
  answerBtn:  { backgroundColor: "#10b981" },
});

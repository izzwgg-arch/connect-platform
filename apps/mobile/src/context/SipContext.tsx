import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import { createSipClient } from "../sip";
import { postCallQualityReport, postCallQualityPing, clearCallQualityPing } from "../api/client";
import { appendCallRecord } from "../storage/callHistory";
import type { CallState, CallRecord, ProvisioningBundle, SipRegistrationState } from "../types";
import { useAuth } from "./AuthContext";

const PROVISION_KEY = "cc_mobile_provision";
const LAST_DIALED_KEY = "cc_mobile_last_dialed";

type AudioRoute = "earpiece" | "speaker" | "bluetooth";

type SipState = {
  registrationState: SipRegistrationState;
  callState: CallState;
  remoteParty: string | null;
  muted: boolean;
  speakerOn: boolean;
  onHold: boolean;
  hasProvisioning: boolean;
  lastError: string | null;
  /** Last number the user dialed outbound — persisted across restarts */
  lastDialed: string | null;
  /** Current audio output route during a call */
  audioRoute: AudioRoute;
  saveProvisioning: (bundle: ProvisioningBundle) => Promise<void>;
  register: () => Promise<void>;
  unregister: () => Promise<void>;
  dial: (target: string) => Promise<void>;
  answer: () => Promise<void>;
  answerIncomingInvite: (
    match: { fromNumber?: string | null; toExtension?: string | null; pbxCallId?: string | null; sipCallTarget?: string | null },
    timeoutMs?: number,
  ) => Promise<boolean>;
  rejectIncomingInvite: (match?: {
    fromNumber?: string | null;
    toExtension?: string | null;
    pbxCallId?: string | null;
    sipCallTarget?: string | null;
  }) => Promise<boolean>;
  hangup: () => Promise<void>;
  toggleMute: () => void;
  toggleSpeaker: () => void;
  /** Cycle audio route: earpiece → speaker → bluetooth (if available) → earpiece */
  cycleAudioRoute: () => void;
  toggleHold: () => void;
  sendDtmf: (digit: string) => void;
};

const SipContext = createContext<SipState | undefined>(undefined);

export function SipProvider({ children }: { children: React.ReactNode }) {
  const { token: authToken } = useAuth();
  const clientRef = useRef(createSipClient());
  const [registrationState, setRegistrationState] = useState<SipRegistrationState>("idle");
  const [callState, setCallState] = useState<CallState>("idle");
  const [remoteParty, setRemoteParty] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [onHold, setOnHold] = useState(false);
  const [hasProvisioning, setHasProvisioning] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastDialed, setLastDialed] = useState<string | null>(null);
  const [audioRoute, setAudioRoute] = useState<AudioRoute>("earpiece");

  // Refs for call record tracking — updated synchronously, read when call ends
  const callInfoRef = useRef({
    direction: "outbound" as "inbound" | "outbound",
    answered: false,
    startMs: null as number | null,
    remoteParty: null as string | null,
  });

  // Auto-reset callState from 'ended' back to 'idle' after a brief pause
  // so the ended-call screen can show a farewell state before dismissing.
  useEffect(() => {
    if (callState === "ended") {
      setOnHold(false);
      setMuted(false);
      setAudioRoute("earpiece");

      // Save call record locally — this is the reliable path for call history
      const info = callInfoRef.current;
      if (info.startMs) {
        const durationSec = info.answered
          ? Math.max(0, Math.round((Date.now() - info.startMs) / 1000))
          : 0;
        const disposition = info.answered
          ? "answered"
          : info.direction === "inbound"
          ? "missed"
          : "canceled";
        const record: CallRecord = {
          id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          direction: info.direction === "inbound" ? "inbound" : "outbound",
          fromNumber: info.direction === "inbound" ? (info.remoteParty ?? "") : "",
          toNumber: info.direction === "outbound" ? (info.remoteParty ?? "") : "",
          startedAt: new Date(info.startMs).toISOString(),
          durationSec,
          disposition,
        };
        appendCallRecord(record).catch(() => {});
        // Reset so next call gets a fresh record
        callInfoRef.current = {
          direction: "outbound",
          answered: false,
          startMs: null,
          remoteParty: null,
        };
      }

      const t = setTimeout(() => setCallState("idle"), 2500);
      return () => clearTimeout(t);
    }
  }, [callState]);

  // Wire the quality report callback — fires at end of each call
  // Wire the live ping callback — fires every ~10 s during a call
  useEffect(() => {
    const client = clientRef.current as any;
    if ("onCallQualityReport" in client || typeof client.onCallQualityReport !== "undefined") {
      client.onCallQualityReport = (report: Record<string, unknown>) => {
        if (!authToken) return;
        postCallQualityReport(authToken, report).catch(() => {
          // Non-fatal — telemetry loss acceptable
        });
      };
    }
    if ("onCallQualityPing" in client || typeof client.onCallQualityPing !== "undefined") {
      client.onCallQualityPing = (snapshot: Record<string, unknown>) => {
        if (!authToken) return;
        if (snapshot._clear) {
          clearCallQualityPing(authToken).catch(() => {});
        } else {
          postCallQualityPing(authToken, snapshot).catch(() => {});
        }
      };
    }
  }, [authToken]);

  useEffect(() => {
    clientRef.current.setEvents({
      onRegistrationState: setRegistrationState,
      onCallState: (state) => {
        if (state === "connected") {
          callInfoRef.current.answered = true;
        }
        setCallState(state);
      },
      onIncomingCall: (callerNumber: string) => {
        const party = callerNumber || "Unknown";
        setRemoteParty(party);
        callInfoRef.current = {
          direction: "inbound",
          answered: false,
          startMs: Date.now(),
          remoteParty: party,
        };
        setCallState("ringing");
      },
      onError: (msg) => {
        setLastError(msg);
      },
    });

    (async () => {
      // Load last-dialed number
      const savedLastDialed = await SecureStore.getItemAsync(LAST_DIALED_KEY).catch(() => null);
      if (savedLastDialed) setLastDialed(savedLastDialed);

      const raw = await SecureStore.getItemAsync(PROVISION_KEY);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as ProvisioningBundle;
        clientRef.current.configure(parsed);
        setHasProvisioning(true);
        // Auto-register on boot
        await clientRef.current.register().catch((e) => {
          console.warn("[SIP] Auto-register failed:", e?.message);
        });
      } catch (e) {
        console.warn("[SIP] Failed to load provisioning:", e);
      }
    })();

    const sub = AppState.addEventListener("change", async (state) => {
      if (state === "active") {
        const raw = await SecureStore.getItemAsync(PROVISION_KEY).catch(() => null);
        if (!raw) return;
        await clientRef.current.register().catch(() => undefined);
      }
    });

    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<SipState>(
    () => ({
      registrationState,
      callState,
      remoteParty,
      muted,
      speakerOn,
      onHold,
      hasProvisioning,
      lastError,
      lastDialed,
      audioRoute,

      saveProvisioning: async (bundle) => {
        await SecureStore.setItemAsync(PROVISION_KEY, JSON.stringify(bundle));
        clientRef.current.configure(bundle);
        setHasProvisioning(true);
        // Immediately re-register with the new credentials
        await clientRef.current.register().catch((e) => {
          console.warn("[SIP] Re-register after provisioning failed:", e?.message);
        });
      },

      register: async () => {
        await clientRef.current.register();
      },

      unregister: async () => {
        await clientRef.current.unregister();
      },

      dial: async (target) => {
        setRemoteParty(target);
        setLastError(null);
        // Persist last dialed number for "redial" feature
        setLastDialed(target);
        SecureStore.setItemAsync(LAST_DIALED_KEY, target).catch(() => {});
        // Track call info for local history
        callInfoRef.current = {
          direction: "outbound",
          answered: false,
          startMs: Date.now(),
          remoteParty: target,
        };
        setAudioRoute("earpiece");
        await clientRef.current.dial(target);
      },

      answer: async () => {
        await clientRef.current.answer();
      },

      answerIncomingInvite: async (match, timeoutMs = 5000) => {
        return clientRef.current.answerIncoming(match, timeoutMs);
      },

      rejectIncomingInvite: async (match) => {
        return clientRef.current.rejectIncoming(match);
      },

      hangup: async () => {
        await clientRef.current.hangup();
      },

      toggleMute: () => {
        const next = !muted;
        clientRef.current.setMute(next);
        setMuted(next);
      },

      toggleSpeaker: () => {
        const next = !speakerOn;
        clientRef.current.setSpeaker(next);
        setSpeakerOn(next);
        setAudioRoute(next ? "speaker" : "earpiece");
      },

      cycleAudioRoute: () => {
        // Cycle: earpiece → speaker → bluetooth → earpiece
        // Bluetooth step is attempted; if no BT headset, it stays on earpiece
        const cycle: AudioRoute[] = ["earpiece", "speaker", "bluetooth"];
        const currentIdx = cycle.indexOf(audioRoute);
        const next = cycle[(currentIdx + 1) % cycle.length];
        try {
          const ICMModule = require("react-native-incall-manager").default;
          if (next === "speaker") {
            ICMModule.setSpeakerphoneOn(true);
            setSpeakerOn(true);
          } else if (next === "bluetooth") {
            ICMModule.setSpeakerphoneOn(false);
            if (typeof ICMModule.chooseAudioRoute === "function") {
              ICMModule.chooseAudioRoute("BLUETOOTH");
            }
            setSpeakerOn(false);
          } else {
            ICMModule.setSpeakerphoneOn(false);
            if (typeof ICMModule.chooseAudioRoute === "function") {
              ICMModule.chooseAudioRoute("EARPIECE");
            }
            setSpeakerOn(false);
          }
          setAudioRoute(next);
        } catch {
          // InCallManager not linked — fall back to simple toggle
          const next2 = !speakerOn;
          clientRef.current.setSpeaker(next2);
          setSpeakerOn(next2);
          setAudioRoute(next2 ? "speaker" : "earpiece");
        }
      },

      toggleHold: () => {
        if (onHold) {
          clientRef.current.unhold();
          setOnHold(false);
        } else {
          clientRef.current.hold();
          setOnHold(true);
        }
      },

      sendDtmf: (digit) => {
        clientRef.current.sendDtmf(digit);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registrationState, callState, remoteParty, muted, speakerOn, onHold, hasProvisioning, lastError, lastDialed, audioRoute],
  );

  return <SipContext.Provider value={value}>{children}</SipContext.Provider>;
}

export function useSip() {
  const ctx = useContext(SipContext);
  if (!ctx) throw new Error("useSip must be used within SipProvider");
  return ctx;
}

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import { createSipClient } from "../sip";
import { postCallQualityReport } from "../api/client";
import type { CallState, ProvisioningBundle, SipRegistrationState } from "../types";
import { useAuth } from "./AuthContext";

const PROVISION_KEY = "cc_mobile_provision";

type SipState = {
  registrationState: SipRegistrationState;
  callState: CallState;
  remoteParty: string | null;
  muted: boolean;
  speakerOn: boolean;
  onHold: boolean;
  hasProvisioning: boolean;
  lastError: string | null;
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

  // Auto-reset callState from 'ended' back to 'idle' after a brief pause
  // so the ended-call screen can show a farewell state before dismissing.
  useEffect(() => {
    if (callState === "ended") {
      setOnHold(false);
      setMuted(false);
      const t = setTimeout(() => setCallState("idle"), 2500);
      return () => clearTimeout(t);
    }
  }, [callState]);

  // Wire the quality report callback — fires at end of each call
  useEffect(() => {
    const client = clientRef.current as any;
    if (typeof client.onCallQualityReport !== "undefined" || "onCallQualityReport" in client) {
      client.onCallQualityReport = (report: Record<string, unknown>) => {
        if (!authToken) return;
        postCallQualityReport(authToken, report).catch(() => {
          // Non-fatal — telemetry loss acceptable
        });
      };
    }
  }, [authToken]);

  useEffect(() => {
    clientRef.current.setEvents({
      onRegistrationState: setRegistrationState,
      onCallState: setCallState,
      onIncomingCall: (callerNumber: string) => {
        setRemoteParty(callerNumber || "Unknown");
        setCallState("ringing");
      },
      onError: (msg) => {
        setLastError(msg);
      },
    });

    (async () => {
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

      saveProvisioning: async (bundle) => {
        await SecureStore.setItemAsync(PROVISION_KEY, JSON.stringify(bundle));
        clientRef.current.configure(bundle);
        setHasProvisioning(true);
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
    [registrationState, callState, remoteParty, muted, speakerOn, onHold, hasProvisioning, lastError],
  );

  return <SipContext.Provider value={value}>{children}</SipContext.Provider>;
}

export function useSip() {
  const ctx = useContext(SipContext);
  if (!ctx) throw new Error("useSip must be used within SipProvider");
  return ctx;
}

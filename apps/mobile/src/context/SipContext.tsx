import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import { createSipClient } from "../sip";
import type { CallState, ProvisioningBundle, SipRegistrationState } from "../types";

const PROVISION_KEY = "cc_mobile_provision";

type SipState = {
  registrationState: SipRegistrationState;
  callState: CallState;
  muted: boolean;
  speakerOn: boolean;
  hasProvisioning: boolean;
  lastError: string | null;
  saveProvisioning: (bundle: ProvisioningBundle) => Promise<void>;
  register: () => Promise<void>;
  unregister: () => Promise<void>;
  dial: (target: string) => Promise<void>;
  answer: () => Promise<void>;
  answerIncomingInvite: (match: { fromNumber?: string | null; toExtension?: string | null; pbxCallId?: string | null; sipCallTarget?: string | null }, timeoutMs?: number) => Promise<boolean>;
  rejectIncomingInvite: (match?: { fromNumber?: string | null; toExtension?: string | null; pbxCallId?: string | null; sipCallTarget?: string | null }) => Promise<boolean>;
  hangup: () => Promise<void>;
  toggleMute: () => void;
  toggleSpeaker: () => void;
  sendDtmf: (digit: string) => void;
};

const SipContext = createContext<SipState | undefined>(undefined);

export function SipProvider({ children }: { children: React.ReactNode }) {
  const clientRef = useRef(createSipClient());
  const [registrationState, setRegistrationState] = useState<SipRegistrationState>("idle");
  const [callState, setCallState] = useState<CallState>("idle");
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [hasProvisioning, setHasProvisioning] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    clientRef.current.setEvents({
      onRegistrationState: setRegistrationState,
      onCallState: setCallState,
      onIncomingCall: () => setCallState("ringing"),
      onError: setLastError,
    });

    (async () => {
      const raw = await SecureStore.getItemAsync(PROVISION_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ProvisioningBundle;
      clientRef.current.configure(parsed);
      setHasProvisioning(true);
    })();

    const sub = AppState.addEventListener("change", async (state) => {
      if (state === "active" && hasProvisioning) {
        await clientRef.current.register().catch(() => undefined);
      }
    });

    return () => sub.remove();
  }, [hasProvisioning]);

  const state = useMemo<SipState>(
    () => ({
      registrationState,
      callState,
      muted,
      speakerOn,
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
      sendDtmf: (digit) => {
        clientRef.current.sendDtmf(digit);
      }
    }),
    [registrationState, callState, muted, speakerOn, hasProvisioning, lastError]
  );

  return <SipContext.Provider value={state}>{children}</SipContext.Provider>;
}

export function useSip() {
  const ctx = useContext(SipContext);
  if (!ctx) throw new Error("useSip must be used within SipProvider");
  return ctx;
}

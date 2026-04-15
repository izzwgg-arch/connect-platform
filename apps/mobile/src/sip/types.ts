import type { CallState, ProvisioningBundle, SipRegistrationState } from "../types";

export type SipEvents = {
  onRegistrationState?: (state: SipRegistrationState) => void;
  /** Fires when an incoming call arrives. `callerNumber` is the remote party. */
  onIncomingCall?: (callerNumber: string) => void;
  onCallState?: (state: CallState) => void;
  onError?: (message: string) => void;
};

export type SipMatch = {
  inviteId?: string | null;
  fromNumber?: string | null;
  toExtension?: string | null;
  pbxCallId?: string | null;
  sipCallTarget?: string | null;
};

export type SipAnswerTraceEvent = {
  phase: "sent" | "confirmed" | "failed";
  timestamp: number;
  code?: number | null;
  reason?: string | null;
  message?: string | null;
};

export type SipClient = {
  configure: (bundle: ProvisioningBundle) => void;
  register: () => Promise<void>;
  unregister: () => Promise<void>;
  dial: (target: string) => Promise<void>;
  answer: () => Promise<void>;
  answerIncoming: (
    match?: SipMatch,
    timeoutMs?: number,
    onTrace?: (event: SipAnswerTraceEvent) => void,
  ) => Promise<boolean>;
  rejectIncoming: (match?: SipMatch) => Promise<boolean>;
  hangup: () => Promise<void>;
  setMute: (mute: boolean) => void;
  setSpeaker: (speakerOn: boolean) => void;
  hold: () => void;
  unhold: () => void;
  sendDtmf: (digit: string) => void;
  setEvents: (events: SipEvents) => void;
};

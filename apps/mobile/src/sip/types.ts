import type { CallState, ProvisioningBundle, SipRegistrationState } from "../types";

export type SipEvents = {
  onRegistrationState?: (state: SipRegistrationState) => void;
  onIncomingCall?: () => void;
  onCallState?: (state: CallState) => void;
  onError?: (message: string) => void;
};

export type SipMatch = {
  fromNumber?: string | null;
  toExtension?: string | null;
  pbxCallId?: string | null;
  sipCallTarget?: string | null;
};

export type SipClient = {
  configure: (bundle: ProvisioningBundle) => void;
  register: () => Promise<void>;
  unregister: () => Promise<void>;
  dial: (target: string) => Promise<void>;
  answer: () => Promise<void>;
  answerIncoming: (match?: SipMatch, timeoutMs?: number) => Promise<boolean>;
  rejectIncoming: (match?: SipMatch) => Promise<boolean>;
  hangup: () => Promise<void>;
  setMute: (mute: boolean) => void;
  setSpeaker: (speakerOn: boolean) => void;
  sendDtmf: (digit: string) => void;
  setEvents: (events: SipEvents) => void;
};

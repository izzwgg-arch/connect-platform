import type { CallState, ProvisioningBundle, SipRegistrationState } from "../types";

export type SipEvents = {
  onRegistrationState?: (state: SipRegistrationState) => void;
  onIncomingCall?: () => void;
  onCallState?: (state: CallState) => void;
};

export type SipClient = {
  configure: (bundle: ProvisioningBundle) => void;
  register: () => Promise<void>;
  unregister: () => Promise<void>;
  dial: (target: string) => Promise<void>;
  answer: () => Promise<void>;
  hangup: () => Promise<void>;
  setMute: (mute: boolean) => void;
  setSpeaker: (speakerOn: boolean) => void;
  sendDtmf: (digit: string) => void;
  setEvents: (events: SipEvents) => void;
};

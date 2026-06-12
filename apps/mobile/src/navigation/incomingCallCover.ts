/** Phases where IncomingCallScreen may still be mounted after invite clears. */
export type IncomingCallUiPhase = 'idle' | 'incoming' | 'connecting' | 'ended' | 'failed';

/**
 * Whether TabsWrapper should paint the black pre-incoming cover.
 *
 * IMPORTANT: Do NOT key this on raw SIP `callState === 'ringing'`. JsSIP fires
 * `onIncomingCall` hundreds of ms before FCM / ForegroundInvite / safeSetInvite
 * populate `incomingInvite`. Covering tabs during that gap with no IncomingCall
 * modal mounted is the foreground "blank screen" bug.
 */
export function shouldShowIncomingCallCover(params: {
  hasIncomingInvite: boolean;
  answering: boolean;
  incomingUiPhase: IncomingCallUiPhase;
}): boolean {
  if (params.hasIncomingInvite) return true;
  if (params.answering) return true;
  if (params.incomingUiPhase === 'ended' || params.incomingUiPhase === 'failed') {
    return true;
  }
  return false;
}

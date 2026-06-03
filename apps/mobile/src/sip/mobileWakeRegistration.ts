/**
 * Decide whether an incoming-call wake should tear down and recreate the JsSIP UA.
 * A healthy connected+registered stack must stay up so PBX INVITEs are not dropped.
 */

export type WakeRegistrationInput = {
  sipConnected: boolean;
  sipRegistered: boolean;
};

export function shouldForceRestartOnWake(input: WakeRegistrationInput): boolean {
  return !(input.sipConnected && input.sipRegistered);
}

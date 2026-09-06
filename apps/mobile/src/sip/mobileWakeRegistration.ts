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

/**
 * How long a SUSPENDED iOS app keeps its PBX contact.
 *
 * The PBX qualifies every contact with `qualify_frequency 30` /
 * `qualify_timeout 3`. An iPhone app that iOS has suspended cannot answer
 * the OPTIONS ping, so its contact reads Unreachable at the first missed
 * ping and is dropped — at most ~33 s after the app went to the background
 * (measured on Fixup Group 2026-09-04: backgrounded ~14:10:49Z, contact
 * gone at 14:11:22Z). The app itself never notices: JsSIP still reports
 * "registered" (registrationAgeMs 156 681 on that call, 162 675 on 08-07),
 * so every "skip when already registered" guard keeps the dead
 * registration and the PBX never dials the phone.
 *
 * So a registration OLDER than one qualify period, held by an app that is
 * NOT in the foreground when the ring push arrives, must be treated as
 * gone and replaced with a fresh REGISTER. 30 s is deliberately the
 * qualify period itself, not a tuned guess: a shorter age cannot have
 * missed a ping.
 */
export const IOS_PBX_CONTACT_DROP_MS = 30_000;

export type RingRegisterInput = {
  platform: string;
  /** JsSIP's own view: "registered" | "registering" | "unregistered" | … */
  registrationState: string;
  /** Milliseconds since the last successful REGISTER; null when not registered. */
  registrationAgeMs: number | null;
  /** react-native AppState.currentState at the moment the ring push arrived. */
  appState: string;
};

export type RingRegisterDecision = "register" | "force_restart" | "skip";

/**
 * What to do with the SIP stack the moment a ring push is observed.
 *
 *  - not registered / not registering → "register" (the pre-existing eager
 *    pre-register; JsSIP's own state machine handles "registering").
 *  - iOS, app not active, registration older than the PBX contact-drop
 *    window → "force_restart": the PBX has almost certainly dropped this
 *    contact; only a fresh REGISTER puts the phone back in the dial list
 *    (and gives the Mode-B late-join rescue a fresh contact to redirect to).
 *  - otherwise → "skip" (a live foreground registration must never be torn
 *    down mid-ring; Android's contact survives suspension because its
 *    foreground service keeps answering qualify).
 */
export function decideRingRegister(input: RingRegisterInput): RingRegisterDecision {
  const state = input.registrationState;
  if (state !== "registered" && state !== "registering") return "register";
  if (state !== "registered") return "skip";
  if (input.platform !== "ios") return "skip";
  if (input.appState === "active") return "skip";
  const age = input.registrationAgeMs;
  if (typeof age !== "number" || !Number.isFinite(age)) return "skip";
  if (age > IOS_PBX_CONTACT_DROP_MS) return "force_restart";
  return "skip";
}

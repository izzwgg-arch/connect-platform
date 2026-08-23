/**
 * "Do everything in your power to get every single phone connected." — Izzy, 2026-08-21.
 *
 * That is a LADDER, not a licence. The agent keeps going, in order, using only moves
 * it is allowed to make, and it stops at the exact point where the only remaining
 * move belongs to somebody else — the previous provider who still owns the handset,
 * or whoever runs the customer's router.
 *
 * ⛔⛔ THE OUTPUT IS A NAMED ACTION FROM A CLOSED LIST. This is what keeps an LLM out
 * of a customer's network: the model may choose between these, and it can express
 * nothing else. There is no "send this request to this device" action, because that
 * one action would be the whole vulnerability.
 *
 * ⛔ Least destructive first, always. A wipe is rung six, never rung one.
 */

import { decideReset, type PhoneRecord } from "./states";

export const SETUP_ACTIONS = [
  "do_nothing",
  "check_sync",
  "set_provisioning",
  "trigger_autop",
  "try_default_credentials",
  "ask_for_password",
  "request_reset_authorization",
  "reset_over_sip",
  "reset_over_lan",
  "rediscover",
  "generate_template",
  "verify_registration",
  "halt",
] as const;

export type SetupAction = (typeof SETUP_ACTIONS)[number];

/** Everything we know about one phone right now, as facts rather than conclusions. */
export type PhoneCondition = {
  /** Asterisk says this endpoint is registered. The only thing that proves "working". */
  registeredToUs: boolean;
  /** The phone's provisioning address is ours. */
  provisioningIsOurs: boolean;
  /** We can reach the phone's web interface from the office machine. */
  reachableOnLan: boolean;
  /** The web interface refused the credentials we have. */
  locked: boolean;
  /** We have already spent the one documented default-password attempt. */
  defaultCredentialsTried: boolean;
  /** The customer has given us a password for this phone. */
  haveCustomerCredentials: boolean;
  /** Settings from the old system that cannot be safely overwritten in place. */
  oldSettingsInWay: boolean;
  /** We have no settings profile for this model yet. */
  modelProfileMissing: boolean;
  /** Firmware too old to support what we need. */
  firmwareTooOld: boolean;
  /** After a reset, the phone's provisioning address went back to the old provider. */
  provisioningRevertedAfterReset: boolean;
  /**
   * The customer's own network is handing the phone the old provider's address.
   * ⛔ This is what tells a DHCP override apart from a manufacturer redirect, and
   * they need completely different help despite looking identical to a customer.
   */
  networkSuppliesOldProvisioning: boolean;
  /** The phone has gone quiet since we asked it to restart. */
  awaitingReboot: boolean;
  /** Somebody is on a call on this phone right now. */
  onACall: boolean;
  /**
   * The person said they do not have this phone's password. ⛔ Without this fact the
   * wizard asks for the password forever — the exact wall Izzy called out: "what if
   * they don't know their password?" The answer has to be a graceful hand-off, never
   * a screen that keeps asking.
   */
  passwordUnavailable: boolean;
  /**
   * The person chose NOT to clear this phone (unticked it on the approval screen).
   * A deliberate no is an answer, not a condition to retry out of them.
   */
  resetDeclined: boolean;
};

export type Escalation = {
  action: SetupAction;
  /** Which rung of the ladder this is, for diagnostics and for the admin view. */
  rung: number;
  /** Why, for a technician. Never shown to a customer. */
  reason: string;
  /** What the customer is told, if anything. */
  customerMessage?: string;
  /** True when nothing further will be attempted without a person. */
  halted?: boolean;
  /** Set when the halt is somebody else's to resolve. */
  handOff?: "previous_provider" | "customer_network" | "support";
};

/**
 * Pick the next move.
 *
 * ⛔ Order is the safety property. Reading top to bottom IS the policy — do not
 * reorder these branches to "simplify", and do not add a branch above the
 * already-working check.
 */
export function nextEscalation(c: PhoneCondition, rec: PhoneRecord): Escalation {
  // 0 — it already works. Do nothing at all. This must be first: a phone that is
  // fine must never be touched because some later branch looked appealing.
  if (c.registeredToUs && c.provisioningIsOurs) {
    return { action: "do_nothing", rung: 0, reason: "already registered and pointed at us" };
  }

  // ⛔ Somebody is talking. Nothing that restarts a phone may happen now. Taking a
  // person off a customer call to save ninety seconds is never the right trade.
  if (c.onACall) {
    return {
      action: "do_nothing",
      rung: 0,
      reason: "a call is in progress on this phone; wait and come back",
    };
  }

  // Out of attempts, whatever the reason. Said before anything else is tried.
  if (rec.attempts >= 2) {
    return {
      action: "halt",
      rung: -1,
      halted: true,
      handOff: "support",
      reason: "attempt cap reached",
      customerMessage: "We could not finish setting up this phone. Loopcom Support can take it from here.",
    };
  }

  // 1 — waiting for a phone we already told to restart. Not a failure; a wait.
  if (c.awaitingReboot) {
    return { action: "rediscover", rung: 8, reason: "phone restarting; find it again by hardware id" };
  }

  // 2 — the two stopping conditions, checked BEFORE anything that would touch the
  // phone again. Both are somebody else's to fix and neither improves with retries.
  if (c.provisioningRevertedAfterReset && c.networkSuppliesOldProvisioning) {
    return {
      action: "halt",
      rung: -1,
      halted: true,
      handOff: "customer_network",
      reason: "the customer network is advertising the previous provider's provisioning address",
      customerMessage:
        "Your network is automatically sending this phone to your previous phone provider. " +
        "Loopcom will not change your router, but Support can talk whoever manages it through the one setting.",
    };
  }
  if (c.provisioningRevertedAfterReset) {
    return {
      action: "halt",
      rung: -1,
      halted: true,
      handOff: "previous_provider",
      reason: "manufacturer redirect still claims this hardware for the previous provider",
      customerMessage:
        "This phone is still registered to your old provider. Every time it restarts they send it back to " +
        "their system, and only they or the manufacturer can release it. Loopcom Support will ask for you.",
    };
  }

  // 3 — we have no settings for this model. Build them before touching the phone.
  if (c.modelProfileMissing) {
    return { action: "generate_template", rung: 9, reason: "no settings profile exists for this model yet" };
  }

  // 4 — firmware genuinely cannot do what we need. Deliberately NOT automatic.
  if (c.firmwareTooOld) {
    return {
      action: "halt",
      rung: -1,
      halted: true,
      handOff: "support",
      reason: "firmware predates the features required; upgrade is a supervised operation",
      customerMessage: "This phone needs a software update before it can join Loopcom. Support will arrange it.",
    };
  }

  // 5 — registered to us but pointed somewhere stale: the cheapest fix there is.
  // Sent from the PBX. No restart, no office access, nobody notices.
  if (c.registeredToUs && !c.provisioningIsOurs) {
    return { action: "check_sync", rung: 2, reason: "registered to us; ask it to re-read its settings" };
  }

  // 6 — old settings in the way. Reset, but only ever with a person's approval.
  if (c.oldSettingsInWay) {
    // ⛔ A deliberate "no" ends the conversation about this phone. Asking again is
    // how a wizard turns a choice into a wall.
    if (c.resetDeclined) {
      return {
        action: "halt",
        rung: -1,
        halted: true,
        handOff: "support",
        reason: "the customer chose not to clear this phone",
        customerMessage:
          "Okay — we left this phone exactly as it was. Run setup again whenever you are ready, " +
          "or Loopcom Support can move it over for you.",
      };
    }
    const verdict = decideReset(rec);
    if (!verdict.allowed) {
      if (verdict.reason === "not_authorized") {
        return {
          action: "request_reset_authorization",
          rung: 6,
          reason: "reset needed and nobody has approved it",
          customerMessage: "This phone still holds settings from your previous phone system.",
        };
      }
      return {
        action: "halt",
        rung: -1,
        halted: true,
        handOff: "support",
        reason: `reset refused: ${verdict.reason}`,
        customerMessage: verdict.explain,
      };
    }
    // ⛔ Prefer the PBX. A phone that has ever registered to us can be reset over SIP
    // with no password and no office access at all.
    if (c.registeredToUs) {
      return { action: "reset_over_sip", rung: 7, reason: "approved reset, sent from the PBX" };
    }
    if (c.reachableOnLan && (!c.locked || c.haveCustomerCredentials)) {
      return { action: "reset_over_lan", rung: 6, reason: "approved reset, sent over the office network" };
    }
    // Approved but we cannot deliver it. Fall through to the credential rungs.
  }

  // 7 — locked. One documented default attempt, then a person. Never a third guess.
  if (c.reachableOnLan && c.locked && !c.haveCustomerCredentials) {
    if (!c.defaultCredentialsTried) {
      return { action: "try_default_credentials", rung: 4, reason: "one documented default attempt" };
    }
    // ⛔ "I don't know the password" is a complete answer and it ends here, kindly.
    // Before this branch existed the wizard asked forever — a wall for exactly the
    // person this wizard is for.
    if (c.passwordUnavailable) {
      return {
        action: "halt",
        rung: -1,
        halted: true,
        handOff: "support",
        reason: "locked, and the customer does not have the password",
        customerMessage:
          "No problem — plenty of people never got that password. Loopcom Support will sort this " +
          "phone out for you. The rest of your phones keep going.",
      };
    }
    return {
      action: "ask_for_password",
      rung: 5,
      reason: "locked and the default was refused",
      customerMessage: "Your old provider set a password on this phone. We need it once to hand the phone over.",
    };
  }

  // 8 — reachable, unlocked, wrong provisioning: just point it at us.
  if (c.reachableOnLan && !c.provisioningIsOurs) {
    return { action: "set_provisioning", rung: 3, reason: "reachable and unlocked; redirect without a reset" };
  }

  // 9 — pointed at us but not registered yet: make it fetch, then wait for Asterisk.
  if (c.provisioningIsOurs && !c.registeredToUs) {
    if (c.reachableOnLan) {
      return { action: "trigger_autop", rung: 3, reason: "pointed at us; tell it to fetch now" };
    }
    return { action: "verify_registration", rung: 10, reason: "pointed at us; waiting for it to register" };
  }

  // 10 — nothing reachable and nothing registered. We genuinely cannot see it.
  return {
    action: "halt",
    rung: -1,
    halted: true,
    handOff: "support",
    reason: "phone is not reachable on the office network and has never registered",
    customerMessage:
      "We could not reach this phone. Check it is switched on and plugged into the same office network, then try again.",
  };
}

/**
 * Turn whatever a device or a protocol said into something a customer can act on.
 *
 * ⛔⛔ A CUSTOMER NEVER SEES A STATUS CODE. Not "HTTP 401", not "SIP 403", not
 * "Option 66", not "RPS lookup failure". Those are real and they belong in
 * diagnostics; on the customer's screen they are noise that makes a solvable problem
 * feel like a broken product.
 */
export type FailureKind =
  | "auth_required"
  | "unreachable"
  | "reset_timeout"
  | "provisioning_rejected"
  | "registration_timeout"
  | "previous_provider"
  | "network_override"
  | "model_unsupported"
  | "unknown";

export function customerFacingFailure(kind: FailureKind): { message: string; canRetry: boolean; getHelp: boolean } {
  switch (kind) {
    case "auth_required":
      return { message: "Administrator password needed for this phone.", canRetry: true, getHelp: false };
    case "unreachable":
      return { message: "We couldn't reach this phone. Check it is switched on and connected.", canRetry: true, getHelp: false };
    case "reset_timeout":
      return { message: "We couldn't reach this phone after it restarted.", canRetry: true, getHelp: true };
    case "provisioning_rejected":
      return { message: "This phone would not accept its new settings.", canRetry: true, getHelp: true };
    case "registration_timeout":
      // ⛔ The distinction matters: the phone took the settings and still is not
      // working, which is a different problem from never having taken them.
      return { message: "The phone connected to Loopcom, but did not finish starting up.", canRetry: true, getHelp: true };
    case "previous_provider":
      return { message: "This phone may still be linked to your previous provider.", canRetry: false, getHelp: true };
    case "network_override":
      return { message: "Your network is sending this phone back to your previous provider.", canRetry: false, getHelp: true };
    case "model_unsupported":
      return { message: "Loopcom cannot set this model up automatically yet.", canRetry: false, getHelp: true };
    default:
      return { message: "Something went wrong setting up this phone.", canRetry: true, getHelp: true };
  }
}

/**
 * ⛔ Anything a device says is untrusted text. A phone's own error string, a
 * provisioning URL and a firmware banner are all attacker-influenceable in principle
 * and end up in a diagnostics pane and an AI prompt. Bound the length, strip control
 * characters and bidirectional overrides, and never let it near a customer message.
 */
export function sanitizeDeviceText(raw: unknown, max = 200): string {
  return String(raw ?? "")
    // control characters -> space (they break log lines and terminal panes)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    // bidirectional overrides -> gone (they can reorder text a reviewer reads)
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}


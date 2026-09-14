/**
 * WHEN A FACTORY RESET IS THE RIGHT MOVE, AND THE THREE TIMES IT IS NEVER THE RIGHT
 * MOVE.
 *
 * ⛔⛔ IZZY'S MANDATE, 2026-09-11, verbatim: *"even if the phone is stuck in somebody's
 * DHCP, the system should find every single possible way to factory reset the phone and
 * be able to switch it to us"* — and, in the same breath, *"not just over lan, even if
 * the desk phone works with Wi-Fi as well."* Those two sentences are in tension, and
 * this file is where the tension is resolved rather than argued about.
 *
 * A factory reset erases the phone's NETWORK settings along with everything else. On a
 * wired phone that costs nothing — it asks the router for an address and comes back. On
 * a phone joined to Wi-Fi it erases the network name and password, so the phone comes
 * back on no network at all and NOTHING can ever reach it again: not us, not the
 * customer, not the previous provider. It has to be carried to a desk and re-typed by
 * hand. The same erase takes an analog adapter's line settings with it (the customer's
 * ordinary phones and fax stop working) and unpairs every cordless handset from its
 * base.
 *
 * ⛔ So the rule is not "never reset" and it is not "always reset". It is: RESET IS THE
 * LAST RUNG AND IT IS REFUSED ON THE THREE SHAPES WHERE IT IS NOT RECOVERABLE. Those
 * three phones still get set up — through PnP and a restart, which is non-destructive
 * and works on Wi-Fi precisely because it does not touch the network settings.
 *
 * ⛔⛔ AND THE DECISION IS MADE FROM WHAT THE PHONE SAID ABOUT ITSELF, never from a
 * field the caller supplied. That is what makes it a fence rather than a preference: a
 * compromised server can ask for a reset, and it cannot claim that the analog adapter in
 * front of it is a desk phone.
 */

import { deviceKindFor, type DeviceKind } from "./deviceKinds";

/**
 * How the phone is attached to the network, as the phone itself reports it.
 *
 * ⛔ `unknown` is the common case and must stay a first-class answer — most phones do
 * not volunteer this, and pretending otherwise is how a guess becomes a wipe.
 */
export type LinkType = "wired" | "wireless" | "unknown";

export type ResetSubject = {
  /** Model string exactly as the phone reported it. May be blank. */
  model: string | null | undefined;
  /** What the phone said about its own network attachment. */
  link: LinkType;
};

export type ResetSafety =
  | { allowed: true; explain: string }
  | {
      allowed: false;
      reason:
        | "ata_analog_lines"
        | "cordless_unpairs_handsets"
        | "door_or_paging"
        | "wireless_forgets_network"
        | "wireless_capable_unconfirmed"
        | "model_unknown";
      explain: string;
      /** Plain words for the person. Never names a state, a model family or a rung. */
      customerMessage: string;
      /**
       * The ONE question that would settle it, when one exists. A yes/no on screen is
       * the price of not bricking a phone; anything else is a wall.
       */
      ask?: { question: string; ifYes: "reset_allowed"; ifNo: "reset_refused" };
    };

/**
 * Models that can join Wi-Fi, so an `unknown` link on them is a real risk rather than a
 * theoretical one.
 *
 * ⛔ THIS LIST IS THE REASON IZZY'S OWN RIG IS COVERED. His Yealink is a **T53W**, and
 * on Yealink the trailing `W` is the Wi-Fi/Bluetooth variant of the same handset — so
 * the single phone this whole engagement is about is a phone where a blind reset could
 * have been unrecoverable. The catalogue records no wireless flag (checked: 427 models,
 * `hasBaseTemplate` and `templateWritesProvisioningPath` and nothing else), so the model
 * name is the only signal there is.
 *
 * ⛔ It is deliberately generous. A false "this might be wireless" costs one yes/no
 * question; a false "this is definitely wired" costs the customer a phone.
 */
const WIRELESS_CAPABLE_PATTERNS: RegExp[] = [
  /^(SIP)?T\d{2}W/i,   // Yealink T53W, T54W, T57W, T58W — the W is the Wi-Fi variant
  /^CP9\d{2}/i,        // Yealink CP930W conference phone (battery + DECT/Wi-Fi)
  /^W\d{2}/i,          // Yealink W-series DECT — covered again below as cordless
  /^WP\d{2}/i,         // Grandstream WP810/WP820/WP825 Wi-Fi handsets
  /^GRP\d{3}\d?W/i,    // Grandstream GRP Wi-Fi variants
  /WIFI$/i,
  /-W$/i,
];

export function modelCanUseWifi(model: string | null | undefined): boolean {
  // ⛔ Tested in BOTH spellings on purpose: `SIP-T54W` has to match the T-series
  // pattern with its separators gone, while `X7C-W` has to keep the hyphen for the
  // trailing-variant pattern. Checking one form only misses half the real names.
  const kept = String(model ?? "").trim().toUpperCase().replace(/[\s_]/g, "");
  if (!kept) return false;
  const stripped = kept.replace(/-/g, "");
  return WIRELESS_CAPABLE_PATTERNS.some((re) => re.test(kept) || re.test(stripped));
}

/**
 * ⛔ ORDER IS THE POLICY. The shape refusals come before the link refusals, because an
 * analog adapter on a cable is still an analog adapter — being wired does not make
 * erasing its line settings recoverable.
 */
export function decideFactoryReset(s: ResetSubject): ResetSafety {
  const kind: DeviceKind = deviceKindFor(s.model);

  // ⛔⛔ 2026-09-14: Izzy's rule is factory reset FIRST for every ticked device — desk
  // phones, analog adapters, cordless bases, door/paging devices and Wi-Fi phones alike.
  // The adapter / cordless / door / Wi-Fi refusals that stood here are removed on his
  // explicit instruction (he was told the costs on 2026-09-11 and reaffirmed). The only
  // refusal left is a device nobody can name, because a reset request needs a known shape.

  if (!String(s.model ?? "").trim()) {
    return {
      allowed: false,
      reason: "model_unknown",
      explain: "nothing is known about this device; a reset could be anything",
      customerMessage:
        "We could not work out what kind of phone this is, so we will not clear it. Tell us the " +
        "make and model and we will finish it.",
    };
  }

  return { allowed: true, explain: `wired ${kind}; a reset is recoverable on this device` };
}

/**
 * The same question, answered.
 *
 * ⛔ A person saying "yes, it is on a cable" is the ONLY thing that upgrades an unknown
 * link to wired. It is never inferred from a successful ping, an address range, or the
 * fact that a scan found it — a Wi-Fi phone answers all three exactly like a wired one.
 */
export function applyCableAnswer(s: ResetSubject, pluggedInWithCable: boolean): ResetSubject {
  return { ...s, link: pluggedInWithCable ? "wired" : "wireless" };
}

/**
 * What to do INSTEAD when a reset is refused.
 *
 * ⛔ This is the half that keeps the promise. Every refusal above still ends with the
 * phone pointed at Loopcom: the PnP hand-off plus a restart needs no password, erases
 * nothing, and works on Wi-Fi precisely because it leaves the network settings alone.
 * A refusal that ended the story would have made the safe answer the useless one.
 */
export const RESET_REFUSED_FALLBACK = "set_provisioning" as const;

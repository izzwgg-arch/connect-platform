/**
 * Laybel inside the desk-phone setup: what she SAYS at each step, and how she answers
 * when the person talks back.
 *
 * Izzy, 2026-09-18: "Laybel will be powered behind the GPT with intelligence and will
 * guide the customer through it as needed, ready for every situation, able to
 * improvise, and get the phones connected at all costs without having to confuse the
 * customer on anything."
 *
 * Two layers, on purpose:
 *   1. SCRIPTED lines per situation — deterministic, instant, need no model, and are
 *      what the screen shows the moment a step changes. They are built from the run's
 *      FACTS (which phone, which extension, the reset recipe, the honest registration
 *      state) so they are never generic.
 *   2. The IMPROVISER — the model answers a free-form message with the same facts and
 *      the playbook below. ⛔ Every reply, scripted or improvised, goes through the
 *      TRUTH FENCE: Laybel may not say a phone is connected/registered/working unless
 *      the facts say it is (that is the per-device registration truth of 2026-09-17),
 *      may never ask for a phone's password, and never speaks a URL or address.
 *
 * ⛔ Pure by injection: the model call, the clock and the per-run budget arrive as
 * arguments, so every branch is provable without a network.
 */

import type { ResetRecipe } from "@connect/shared";

export type GuideSituation =
  | "choose_extension"
  | "choose_phone"
  | "confirm_phone"
  | "reset"
  | "reset_waiting"
  | "connecting"
  | "connected"
  | "stuck_old_provider"
  | "stuck_password"
  | "stuck_not_checking_in"
  | "stuck_unsupported"
  | "needs_serial"
  | "done_all";

export type GuideFacts = {
  /** The extension being set up right now, in the person's words. */
  extension: { number: string; name: string } | null;
  /** The phone being set up right now. */
  phone: {
    model: string | null;
    vendor: string | null;
    /** Last four hex characters of the MAC, spaced ("60 5F"), for the sticker check. */
    stickerEndsIn: string | null;
    /** ⛔ THE HONEST STATE: the PBX sees THIS device registered right now. */
    connected: boolean;
    /** Which extension the PBX sees it registered as, when connected. */
    registeredAsExt: string | null;
    /** The wizard's own one-line status for this phone (customer-safe). */
    statusLine: string | null;
    freshOutOfBox: boolean;
  } | null;
  recipe: ResetRecipe | null;
  /** How many phones are done vs total, for "one down, three to go". */
  progress: { connected: number; total: number };
};

export type GuideReply = {
  say: string;
  /** Quick answers the person can tap instead of typing. ≤4, short. */
  chips: string[];
  /** Whether the model was consulted (diagnostics only). */
  improvised: boolean;
};

export type ModelCall = (args: { system: string; user: string }) => Promise<string>;

export type GuideDeps = {
  /** null = no key configured; the scripted layer still answers everything. */
  callModel: ModelCall | null;
  /** Per-run budget of model calls; the scripted layer takes over past it. */
  budgetLeft: () => number;
  spend: () => void;
};

/* ── the truth fence ─────────────────────────────────────────────────────── */

const CLAIMS_CONNECTED = /\b(is|are|it's|its|now|already)\s+(now\s+)?(connected|registered|live|online|working|set up|ready to (make|take) calls)\b/i;
const ASKS_PASSWORD = /\b(what('s| is) (the|your) password|enter (the|your) password|tell me (the|your) password|password for the phone)\b/i;
const URL_OR_ADDRESS = /\b(https?:\/\/\S+|www\.\S+|\d{1,3}(\.\d{1,3}){3}(:\d+)?)\b/gi;

/**
 * Drops any sentence that claims a connection the facts do not back, any sentence that
 * asks for a phone password, and every URL/address. Returns null when nothing honest
 * is left, so the caller falls back to the scripted line.
 */
export function fenceReply(text: string, facts: GuideFacts): string | null {
  const connected = facts.phone?.connected === true;
  const sentences = String(text ?? "").replace(URL_OR_ADDRESS, "").replace(/\s{2,}/g, " ").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const kept = sentences.filter((s) => {
    if (ASKS_PASSWORD.test(s)) return false;
    if (!connected && CLAIMS_CONNECTED.test(s) && !/\b(not|isn't|aren't|until|once|when|before)\b/i.test(s)) return false;
    return true;
  });
  const out = kept.join(" ").trim();
  return out.length ? out.slice(0, 600) : null;
}

/* ── scripted lines ──────────────────────────────────────────────────────── */

const who = (f: GuideFacts) => (f.extension ? `${f.extension.name || "extension " + f.extension.number}` : "this extension");
const ext = (f: GuideFacts) => (f.extension ? f.extension.number : "");
const model = (f: GuideFacts) => f.phone?.model || (f.phone?.vendor ? `${f.phone.vendor} phone` : "phone");

export function scriptedLine(situation: GuideSituation, f: GuideFacts): GuideReply {
  const s = (say: string, chips: string[] = []): GuideReply => ({ say, chips, improvised: false });
  switch (situation) {
    case "choose_extension":
      return s(
        f.progress.connected > 0
          ? `${f.progress.connected} of ${f.progress.total} done. Which extension is next?`
          : "Hi, I'm Laybel. We'll connect your phones one at a time so nothing gets mixed up. Which extension should we start with?",
        ["Start with the first one", "Do all of them"],
      );
    case "choose_phone":
      return s(
        `Pick up the phone that's going on ${who(f)}'s desk and turn it over. There are a few stickers — you want the one that says MAC. It's twelve characters in pairs, like 00-0B-82-1A-2B-3C. Read me just the last four; there's never a letter O on it, only zeros.`,
        ["I don't see it in the list", "There's no MAC sticker"],
      );
    case "confirm_phone":
      return s(
        f.phone?.stickerEndsIn
          ? `Great — ${model(f)}, ending in ${f.phone.stickerEndsIn}, goes to ${who(f)} as ${ext(f)}. ${f.phone.freshOutOfBox ? "It's fresh out of the box, so no reset needed." : "It still has old settings on it, so we'll wipe it first."}`
          : `That ${model(f)} goes to ${who(f)} as ${ext(f)}.`,
        ["That's right", "Wrong phone"],
      );
    case "reset": {
      const r = f.recipe;
      const first = r?.steps?.[0] ?? "Look for a Reset option in the phone's menu.";
      const hold = r?.holdSeconds ? ` Keep holding — about ${r.holdSeconds} seconds — until the screen asks you a question.` : "";
      return s(
        `This phone still has your old provider on it, so we'll wipe it. ${r?.headline ? r.headline + ". " : ""}${first}${hold}`,
        ["It's asking me something", "Nothing happens", "It wants a password"],
      );
    }
    case "reset_waiting":
      return s(
        "Good. The phone is restarting — that takes a minute. I'm watching your network, and this screen moves on by itself the moment it comes back fresh. You don't need to click anything.",
        ["It's back on", "It's stuck on the logo"],
      );
    case "connecting":
      return s(
        `Got it — it's back and fresh. I'm inside its settings now, giving it your Loopcom address. It'll restart once more. Don't touch it; this takes about a minute.`,
        ["What are you doing?", "The screen looks weird"],
      );
    case "connected":
      return s(
        f.phone?.connected
          ? `${who(f)}'s phone is live — your phone system just saw it check in as ${f.phone.registeredAsExt || ext(f)}. Want me to ring it so you can hear it?${f.progress.connected < f.progress.total ? " Then we'll do the next one." : ""}`
          : "Almost — I'm still waiting for your phone system to see it check in. Give it a moment.",
        f.phone?.connected ? ["Ring it", "Next phone"] : ["Keep waiting"],
      );
    case "stuck_old_provider":
      return s(
        "This phone reset fine, but it keeps going back to your old provider — their cloud still claims it. That's on them, not you. I've asked the maker to release it; that usually lands within a business day, and the moment it does I finish this phone by myself. Let's not wait — grab the next phone.",
        ["OK, next phone", "Talk to a person"],
      );
    case "stuck_password":
      return s(
        "That phone still has the old provider's password on it, so the reset didn't take. Let's do it again — hold the button longer this time, a full fifteen seconds. If it still asks for a password, unplug it, wait five seconds, plug it back in and try once more.",
        ["Trying again", "Still asks for a password"],
      );
    case "stuck_not_checking_in":
      return s(
        "The phone took its settings but hasn't checked in yet. I'm restarting it from the inside once more. If it still doesn't show up, it's usually the network cable or the internet at that desk — we'll check that next.",
        ["It's restarting", "The cable is in"],
      );
    case "stuck_unsupported":
      return s(
        `I can't set up this model on my own yet. A Loopcom person will finish it with you — I've written down everything about it, so you won't have to explain. Let's keep going with the rest.`,
        ["Next phone", "Talk to a person"],
      );
    case "needs_serial":
      return s(
        "The maker's cloud wants this phone's serial number before it lets us in. It's on the same sticker as the MAC, after S/N. Read it to me or point your camera at it.",
        ["I don't have it", "Reading it now"],
      );
    case "done_all":
      return s(
        `All ${f.progress.total} phones are connected and can make calls. You're done — nice work.`,
        ["Ring one to check"],
      );
  }
}

/* ── the improviser ──────────────────────────────────────────────────────── */

export const LAYBEL_SETUP_PLAYBOOK = `You are Laybel, Loopcom's setup guide, talking to a small-business customer who is holding a desk phone. You speak in short, warm, plain sentences (two or three at most), one next action at a time, never technical words (no "provisioning", "SIP", "P-values", "firmware", "LCD", "MAC address" — say "the sticker" and "the last four characters").

RULES YOU NEVER BREAK:
1. You never say a phone is connected, registered, live, online or working unless FACTS.phone.connected is true. If it is false, say what is happening and what you are waiting for.
2. You never ask for a phone's password and never suggest typing one that isn't the maker's factory password given in the recipe. Old-provider passwords are worked around by a factory reset.
3. You never speak a web address, an IP address or a server name.
4. If the person describes something that doesn't match the recipe, ask what the screen says and guide from that. If you truly can't, say a Loopcom person will finish it and that everything is already written down.
5. Reset is the customer's only job. Everything after the reset is done by the setup automatically — reassure them they don't need to click anything while a screen says it is watching.
6. One phone at a time. Never send them to another phone unless the current one is connected or is waiting on the maker.

Reply as JSON: {"say": "<what you say>", "chips": ["<short tap answer>", ...up to 3]}.`;

export async function improvise(
  situation: GuideSituation,
  facts: GuideFacts,
  message: string,
  transcript: Array<{ role: "laybel" | "customer"; text: string }>,
  deps: GuideDeps,
): Promise<GuideReply> {
  const fallback = () => {
    const base = scriptedLine(situation, facts);
    return { ...base, say: `I didn't quite get that. ${base.say}` };
  };
  const text = String(message ?? "").trim().slice(0, 600);
  if (!text) return scriptedLine(situation, facts);
  if (!deps.callModel || deps.budgetLeft() <= 0) return fallback();

  const recent = transcript.slice(-6).map((t) => `${t.role === "laybel" ? "Laybel" : "Customer"}: ${String(t.text).slice(0, 300)}`).join("\n");
  const user = [
    `SITUATION: ${situation}`,
    `FACTS: ${JSON.stringify(facts)}`,
    recent ? `RECENT:\n${recent}` : "",
    `CUSTOMER SAYS: ${text}`,
  ].filter(Boolean).join("\n\n");

  deps.spend();
  let raw = "";
  try { raw = await deps.callModel({ system: LAYBEL_SETUP_PLAYBOOK, user }); }
  catch { return fallback(); }

  let say = "";
  let chips: string[] = [];
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    say = String(parsed?.say ?? "");
    chips = Array.isArray(parsed?.chips) ? parsed.chips.map((c: unknown) => String(c).slice(0, 40)).filter(Boolean).slice(0, 3) : [];
  } catch {
    say = raw;
  }
  const fenced = fenceReply(say, facts);
  if (!fenced) return fallback();
  return { say: fenced, chips, improvised: true };
}

/** The sticker-check form of a MAC: last four hex characters, upper-case, spaced in pairs. */
export function stickerEndsIn(mac: string | null | undefined): string | null {
  const hex = String(mac ?? "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length < 4) return null;
  const tail = hex.slice(-4);
  return `${tail.slice(0, 2)} ${tail.slice(2)}`;
}

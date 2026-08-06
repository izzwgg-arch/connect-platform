// ── IVR plain language ───────────────────────────────────────────────────────
//
// One module owns two things that MUST agree:
//   1. how a menu key's destination is written down (the dialplan reference), and
//   2. how that destination is said out loud in ordinary English.
//
// It is shared because three places need the same answers:
//   • the IVR Studio, so a customer building their own menu sees plain words
//   • the AI agent, so it can build a menu for a customer AND explain, A to Z,
//     exactly what will happen on the call
//   • the API, when it needs to describe what it is about to publish
//
// If the agent and the Studio each had their own copy of this, they would drift,
// and the customer would be told two different stories about the same menu —
// which is worse than no explanation at all, because one of them is wrong.
//
// ── The four kinds ───────────────────────────────────────────────────────────
// Callers and the people configuring menus think in four categories, not the
// nine destination types the database stores:
//
//   person    → ring one person's phone
//   team      → ring several phones at once (ring group OR queue — same idea to
//               the person setting it up; the difference stays under the hood)
//   voicemail → go straight to someone's mailbox without ringing
//   menu      → play another set of choices
//   hangup    → end the call
//
// Anything else that already exists in the database (announcements, dial-through,
// hand-backs to the PBX) is readable and describable but is NOT offered as a
// choice — see OFFERABLE_KINDS.
//
// ── Dialplan references ──────────────────────────────────────────────────────
// Every reference below was verified against the live generated dialplan on
// 2026-08-03. They are not conventions copied from other phone systems:
//
//   person    T<t>_cos-all,<extension>,1        Goto(T2_cos-all,108,1)
//   team/rg   T<t>_ext-ringgroups,<number>,1    exten => 800,1,NoOp(Ring Group: main)
//   team/q    T<t>_ext-queues,<number>,1        exten => 600,1,NoOp(Queue: main q)
//   voicemail sub-extensions-vm,VM-<ext>,1      Goto(sub-extensions-vm,VM-101,1)
//   recording connect-play-prompt,s,1           plays opt_<digit>/announce, then
//                                               opt_<digit>/after (empty = replay menu)
//   menu      connect-tenant-ivr,<profileId>,1  Connect's own IVR context
//   hangup    connect-default-fallback,s,1
//
// The voicemail one matters: an earlier build wrote `ext-local,vmu<ext>,1`, a
// convention from different phone software. There is no [ext-local] context on
// this PBX at all, so every caller sent to voicemail fell out of the dialplan.

export type MenuChoiceKind = "person" | "team" | "forward" | "voicemail" | "recording" | "menu" | "hangup" | "other";

/** The kinds a person is offered when assigning a key. "other" is readable but
 *  never offered — it exists so menus imported from the PBX still describe
 *  themselves rather than showing a blank. */
export const OFFERABLE_KINDS: Exclude<MenuChoiceKind, "other">[] = ["person", "team", "forward", "voicemail", "recording", "menu", "hangup"];

export const KIND_LABEL: Record<MenuChoiceKind, string> = {
  person: "A person",
  team: "A team",
  forward: "A phone number",
  voicemail: "Voicemail",
  recording: "A recording",
  menu: "Another menu",
  hangup: "Hang up",
  other: "Something else",
};

export const KIND_BLURB: Record<MenuChoiceKind, string> = {
  person: "Rings one person's phone. If they don't pick up it goes to their voicemail.",
  team: "Rings several phones at once. Whoever answers first gets the call.",
  forward: "Rings a phone outside the office — a cell, or another business.",
  voicemail: "Goes straight to someone's voicemail without ringing.",
  recording: "Plays a recording — directions, hours, an announcement — then continues.",
  menu: "Plays another set of choices, like \"press 1 for…\".",
  hangup: "Politely ends the call.",
  other: "Set up outside the Studio.",
};

/** The Goto target every "play a recording" key stores. The context reads the
 *  recording and the after-destination from the same per-digit AstDB keys the
 *  publish writes (`opt_<digit>/announce`, `opt_<digit>/after`), so the ref
 *  itself never varies. Installed by scripts/pbx/patch-connect-play-prompt.sh. */
export const PLAY_PROMPT_DESTINATION_REF = "connect-play-prompt,s,1";

/** Where the caller goes after a recording key finishes playing.
 *  "replay" is the default: the same menu's choices play again. */
export type AfterRecordingChoice =
  | { kind: "replay" }
  | { kind: "voicemail"; extension: string }
  | { kind: "hangup" };

export interface DirectoryPerson { extension: string; name?: string | null }
export interface DirectoryTeam { number: string; name?: string | null; kind: "ring_group" | "queue" }
export interface DirectoryMenu { id: string; name: string }
export interface DirectoryRecording { promptRef: string; name?: string | null }
/** An outside phone number the PBX can already reach, via the internal number
 *  a Custom Application answers on. `extension` is what the dialplan jumps to;
 *  `phoneNumber` is only ever shown to a person. */
export interface DirectoryForward { extension: string; phoneNumber: string; name?: string | null }

/** "5622096644" → "(562) 209-6644". Anything that isn't a plain 10/11-digit US
 *  number is handed back untouched rather than mangled. */
export function formatPhone(raw: string | null | undefined): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length !== 10) return String(raw ?? "").trim();
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

/** Everything this tenant actually has. A kind with an empty list is not
 *  offered — showing "A team" to a customer with no teams invites them to pick
 *  something that cannot work. */
export interface TenantDirectory {
  /** VitalPBX tenant number, e.g. 2 → contexts "T2_cos-all". */
  pbxTenantId: string | number | null;
  people: DirectoryPerson[];
  teams: DirectoryTeam[];
  menus: DirectoryMenu[];
  /** The tenant's recording library. Optional because most callers of this
   *  module don't offer recording keys; leaving it out only disables them. */
  recordings?: DirectoryRecording[];
  /** Outside numbers already reachable through a Custom Application. */
  forwards?: DirectoryForward[];
}

export interface StoredDestination {
  destinationType: string;
  destinationRef: string;
  label?: string | null;
  /** Recording keys only: what plays, and where the caller goes after.
   *  Empty after-destination = replay the same menu. */
  announcePromptRef?: string | null;
  afterDestinationType?: string | null;
  afterDestinationRef?: string | null;
}

/** What a stored destination turns back into for the UI and the agent. */
export interface ReadDestination {
  kind: MenuChoiceKind;
  /** Extension number, team number, or menu id — whatever the kind points at. */
  targetId: string | null;
  /** Plain-English name, e.g. "Leah Fulop" or "Sales". */
  name: string | null;
  /** False when the target is no longer in the directory (deleted extension,
   *  menu removed). The UI must show this rather than a confident wrong name. */
  known: boolean;
}

const DIGIT_GLYPH: Record<string, string> = { star: "*", hash: "#" };
const DIGIT_SPOKEN: Record<string, string> = { star: "the star key", hash: "the pound key" };

/** "star" → "*", "7" → "7". For display on a keypad. */
export function digitGlyph(digit: string): string {
  return DIGIT_GLYPH[digit] ?? digit;
}

/** How a digit is referred to in a sentence: "presses 7", "presses the star key". */
export function digitSpoken(digit: string): string {
  return DIGIT_SPOKEN[digit] ?? digit;
}

function ctxPrefix(dir: TenantDirectory): string | null {
  const t = String(dir.pbxTenantId ?? "").trim();
  return /^\d+$/.test(t) ? `T${t}` : null;
}

/**
 * Write down a destination the dialplan can follow.
 * Returns null when the choice cannot be expressed — a missing tenant number,
 * or a target that isn't in the directory. Callers must treat null as "refuse
 * to save", never as "save something approximate".
 */
export function buildDestination(
  kind: MenuChoiceKind,
  targetId: string,
  dir: TenantDirectory,
  /** Recording keys only: what happens after the recording ends. */
  after?: AfterRecordingChoice,
): StoredDestination | null {
  const id = String(targetId ?? "").trim();
  const prefix = ctxPrefix(dir);

  if (kind === "hangup") {
    return { destinationType: "terminate", destinationRef: "connect-default-fallback,s,1", label: "Hang up" };
  }
  if (!id) return null;

  if (kind === "recording") {
    const rec = (dir.recordings ?? []).find((x) => x.promptRef === id);
    if (!rec) return null;
    // The after-destination reuses the exact refs the direct kinds write, so
    // the dialplan's generic Goto handles it with no new cases.
    let afterDest: StoredDestination | null = null;
    const choice = after ?? { kind: "replay" as const };
    if (choice.kind === "voicemail") {
      afterDest = buildDestination("voicemail", choice.extension, dir);
      if (!afterDest) return null; // refuse rather than save a recording that dead-ends
    } else if (choice.kind === "hangup") {
      afterDest = buildDestination("hangup", "", dir);
    }
    return {
      destinationType: "announcement",
      destinationRef: PLAY_PROMPT_DESTINATION_REF,
      label: rec.name || "A recording",
      announcePromptRef: id,
      afterDestinationType: afterDest?.destinationType ?? null,
      afterDestinationRef: afterDest?.destinationRef ?? null,
    };
  }

  if (kind === "person") {
    const p = dir.people.find((x) => x.extension === id);
    if (!p || !prefix) return null;
    return { destinationType: "extension", destinationRef: `${prefix}_cos-all,${id},1`, label: p.name || `Extension ${id}` };
  }
  if (kind === "team") {
    const team = dir.teams.find((x) => x.number === id);
    if (!team || !prefix) return null;
    const ctx = team.kind === "queue" ? `${prefix}_ext-queues` : `${prefix}_ext-ringgroups`;
    return { destinationType: team.kind, destinationRef: `${ctx},${id},1`, label: team.name || `Team ${id}` };
  }
  if (kind === "forward") {
    // `id` is the INTERNAL number a Custom Application answers on — never the
    // outside number. The PBX reaches the outside world through the Custom
    // Destination behind it, which is also what forces the call out on the
    // system's own caller ID rather than the customer's choice.
    const f = (dir.forwards ?? []).find((x) => x.extension === id);
    if (!f || !prefix) return null;
    return {
      destinationType: "custom",
      // Deliberately NOT `T<t>_cos-all,<ext>,1`: that form is typed "extension",
      // which sends the call through the wake-and-wait dialer to rouse a mobile
      // app that a forwarding number does not have. This ref is a plain jump.
      destinationRef: `${prefix}_app-custom-application,${id},1`,
      label: f.name?.trim() || formatPhone(f.phoneNumber),
    };
  }
  if (kind === "voicemail") {
    const p = dir.people.find((x) => x.extension === id);
    if (!p) return null;
    return { destinationType: "voicemail", destinationRef: `sub-extensions-vm,VM-${id},1`, label: `${p.name || id}'s voicemail` };
  }
  if (kind === "menu") {
    const m = dir.menus.find((x) => x.id === id);
    if (!m) return null;
    return { destinationType: "ivr", destinationRef: `connect-tenant-ivr,${id},1`, label: m.name };
  }
  return null;
}

/** Read a stored destination back into the four-kind vocabulary. */
export function readDestination(stored: StoredDestination | null | undefined, dir: TenantDirectory): ReadDestination {
  const type = String(stored?.destinationType ?? "").trim();
  const ref = String(stored?.destinationRef ?? "").trim();
  if (!type || !ref) return { kind: "other", targetId: null, name: null, known: false };

  if (type === "terminate") return { kind: "hangup", targetId: null, name: "Hang up", known: true };

  // Connect-owned recording keys. VitalPBX announcement objects also store
  // type "announcement" but point at T<t>_app-announcement — those keep
  // falling through to "other" (readable, never offered).
  if (type === "announcement" && ref.startsWith("connect-play-prompt,")) {
    const promptRef = String(stored?.announcePromptRef ?? "").trim() || null;
    const rec = promptRef ? (dir.recordings ?? []).find((x) => x.promptRef === promptRef) : undefined;
    return {
      kind: "recording",
      targetId: promptRef,
      name: rec?.name || stored?.label || (promptRef ? "A recording" : null),
      // A directory without a recordings list can't tell whether the recording
      // still exists — only flag "unknown" when the list was provided and the
      // recording genuinely isn't in it.
      known: dir.recordings ? Boolean(rec) : Boolean(promptRef),
    };
  }

  if (type === "extension") {
    const m = ref.match(/^[A-Za-z0-9_\-]+,([^,]+),\d+$/);
    const ext = m?.[1] ?? null;
    const p = ext ? dir.people.find((x) => x.extension === ext) : undefined;
    return { kind: "person", targetId: ext, name: p?.name || (ext ? `Extension ${ext}` : null), known: Boolean(p) };
  }
  if (type === "ring_group" || type === "queue") {
    const m = ref.match(/^[A-Za-z0-9_\-]+,([^,]+),\d+$/);
    const num = m?.[1] ?? null;
    const t = num ? dir.teams.find((x) => x.number === num) : undefined;
    return { kind: "team", targetId: num, name: t?.name || (num ? `Team ${num}` : null), known: Boolean(t) };
  }
  if (type === "voicemail") {
    // Current form, plus the dead ext-local form so imported/legacy rows still
    // name the right mailbox instead of showing blank.
    const m = ref.match(/^sub-extensions-vm,VM[BU]?-([^,]+),\d+$/i) ?? ref.match(/^ext-local,vmu([^,]+),\d+$/i);
    const ext = m?.[1] ?? null;
    const p = ext ? dir.people.find((x) => x.extension === ext) : undefined;
    return { kind: "voicemail", targetId: ext, name: p?.name ? `${p.name}'s voicemail` : (ext ? `Voicemail ${ext}` : null), known: Boolean(p) };
  }
  // A forward is stored as type "custom" (so the option router does a plain
  // Goto), so the REF is what distinguishes it from anything else hand-built
  // outside the Studio. Only the Custom Application shape counts.
  if (type === "custom") {
    const m = ref.match(/^T\d+_app-custom-application,([^,]+),\d+$/i);
    if (m) {
      const ext = m[1];
      const f = (dir.forwards ?? []).find((x) => x.extension === ext);
      return {
        kind: "forward",
        targetId: ext,
        name: f ? (f.name?.trim() || formatPhone(f.phoneNumber)) : null,
        // "We have the list and it isn't in it" means deleted. "We have no
        // list" means we couldn't find out — and must NOT be reported as
        // deleted, or a perfectly good forward reads as broken every time the
        // PBX is briefly unreachable.
        known: dir.forwards ? Boolean(f) : true,
      };
    }
  }
  if (type === "ivr") {
    const m = ref.match(/^connect-tenant-ivr,([^,]+),\d+$/);
    const id = m?.[1] ?? null;
    const menu = id ? dir.menus.find((x) => x.id === id) : undefined;
    return { kind: "menu", targetId: id, name: menu?.name ?? null, known: Boolean(menu) };
  }
  return { kind: "other", targetId: null, name: stored?.label ?? null, known: false };
}

// ── Hand-backs to the old phone system ───────────────────────────────────────
//
// Izzy's rule (2026-08-06): once a number is taken over by Connect, everything
// it can reach must be in Connect. No flip-flopping back and forth.
//
// The line is about who DECIDES, not who answers. Ringing an extension, a team,
// or dropping into voicemail is a leaf — the call ends there and nothing is
// half-owned. But sending the caller into a VitalPBX IVR or time condition
// hands the call flow itself back: from that point the old system chooses what
// happens, Connect's Studio can't see it or change it, and the number is
// half-migrated no matter what the Studio shows.
//
// Deliberately NOT a hand-back: `T<t>_app-custom-application`, which is how
// Connect's own "forward to a phone number" keys reach the outside world. It
// lives in a PBX-shaped context but Connect creates and owns it.

const PBX_HANDBACK_KINDS: Array<{ re: RegExp; what: string }> = [
  { re: /^T\d+_app-ivr,/i,            what: "a menu on the old phone system" },
  { re: /^T\d+_app-time-condition,/i, what: "an opening-hours rule on the old phone system" },
  { re: /^T\d+_app-announcement,/i,   what: "an announcement on the old phone system" },
  { re: /^T\d+_app-disa,/i,           what: "a dial-through service on the old phone system" },
  { re: /^T\d+_app-queues-priority,/i,what: "a queue rule on the old phone system" },
];

/**
 * Does this destination hand the call back to the old phone system?
 * Returns what it hands back to, in plain words, or null when it doesn't.
 */
export function pbxHandBack(stored: StoredDestination | null | undefined): string | null {
  const ref = String(stored?.destinationRef ?? "").trim();
  if (!ref) return null;
  for (const { re, what } of PBX_HANDBACK_KINDS) if (re.test(ref)) return what;
  return null;
}

/** How a recording key's "afterwards" reads in a sentence. */
export function describeAfterRecording(stored: StoredDestination | null | undefined, dir: TenantDirectory): string {
  const afterType = String(stored?.afterDestinationType ?? "").trim();
  const afterRef = String(stored?.afterDestinationRef ?? "").trim();
  if (!afterType || !afterRef) return "then the menu plays again";
  const after = readDestination({ destinationType: afterType, destinationRef: afterRef }, dir);
  if (after.kind === "hangup") return "then the call ends politely";
  return `then they go to ${describeDestination({ destinationType: afterType, destinationRef: afterRef }, dir)}`;
}

/** Short phrase naming where a caller ends up: "Leah Fulop on extension 101". */
export function describeDestination(stored: StoredDestination | null | undefined, dir: TenantDirectory): string {
  const d = readDestination(stored, dir);
  switch (d.kind) {
    case "hangup":
      return "the call ends";
    case "person":
      return d.known ? `${d.name} on extension ${d.targetId}` : `extension ${d.targetId} — which no longer exists`;
    case "team":
      return d.known ? `the ${d.name} team` : `a team on ${d.targetId} — which no longer exists`;
    case "forward":
      if (!d.known) return `an outside number set up on ${d.targetId} — which no longer exists`;
      return d.name ? `${d.name} — a phone outside the office` : "a phone outside the office";
    case "voicemail":
      return d.known ? String(d.name) : `voicemail for ${d.targetId} — which no longer exists`;
    case "recording":
      return d.known
        ? `the “${d.name}” recording, ${describeAfterRecording(stored, dir)}`
        : "a recording that no longer exists — the caller is sent back to the menu";
    case "menu":
      return d.known ? `the “${d.name}” menu` : "another menu — which has been deleted";
    default:
      return stored?.label?.trim() || "somewhere set up outside the Studio";
  }
}

/** One full sentence for a single key. */
export function explainKeyPress(digit: string, stored: StoredDestination | null | undefined, dir: TenantDirectory): string {
  const where = describeDestination(stored, dir);
  const d = readDestination(stored, dir);
  const press = `If they press ${digitSpoken(digit)}`;
  if (d.kind === "hangup") return `${press}, the call ends politely.`;
  if (d.kind === "person") return `${press}, we ring ${where}. If nobody answers, the caller goes to that person's voicemail.`;
  if (d.kind === "team") return `${press}, we ring every phone in ${where} at once, and whoever picks up first gets the call.`;
  if (d.kind === "forward") {
    if (!d.known) return `${press}, we call an outside number set up on ${d.targetId} — which no longer exists.`;
    const which = d.name ? `${d.name} — a phone outside the office` : "a phone outside the office";
    return `${press}, we call ${which}. Whoever answers takes the call, and they'll see your business's number, not the caller's.`;
  }
  if (d.kind === "voicemail") return `${press}, they go straight to ${where} without any phone ringing.`;
  if (d.kind === "recording") return `${press}, we play ${where}.`;
  if (d.kind === "menu") return `${press}, they hear ${where} and choose again from there.`;
  return `${press}, they go to ${where}.`;
}

// ── Whole-call explanation ───────────────────────────────────────────────────

export interface MenuForExplain {
  id: string;
  name: string;
  /** Recording name the caller hears, e.g. "A plus main". */
  greetingName?: string | null;
  timeoutSeconds?: number | null;
  options: Array<{ optionDigit: string; destinationType: string; destinationRef: string; label?: string | null }>;
  timeoutDestination?: StoredDestination | null;
  invalidDestination?: StoredDestination | null;
}

export interface CallStep {
  kind: "arrive" | "greeting" | "key" | "silence" | "wrongkey" | "end";
  /** Short line, for a heading or a chip. */
  headline: string;
  /** The full sentence, in ordinary English. */
  detail: string;
  digit?: string;
  /** Set when this step leads into another menu — lets a caller-flow view draw
   *  the branch, and lets the agent recurse when explaining. */
  leadsToMenuId?: string | null;
}

export interface ExplainContext {
  dir: TenantDirectory;
  /** Numbers that reach this menu, for the opening line. */
  phoneNumbers?: string[];
  /** Business hours summary, when this menu is the open-hours one. */
  hoursSummary?: string | null;
}

/**
 * Every place a menu still hands the call back to the old phone system.
 *
 * Used before publishing and on the map, so a half-migrated number is visible
 * as a fact about the call rather than something a caller discovers.
 */
export function findPbxHandBacks(menu: MenuForExplain): Array<{ where: string; what: string }> {
  const out: Array<{ where: string; what: string }> = [];
  for (const o of menu.options) {
    const what = pbxHandBack(o);
    if (what) out.push({ where: `Key ${digitGlyph(o.optionDigit)}`, what });
  }
  const timeout = pbxHandBack(menu.timeoutDestination);
  if (timeout) out.push({ where: "When the caller presses nothing", what: timeout });
  const invalid = pbxHandBack(menu.invalidDestination);
  if (invalid) out.push({ where: "When the caller presses a wrong key", what: invalid });
  return out;
}

/**
 * Turn one menu into an ordered, plain-English account of the call.
 *
 * This is what the agent reads out when a customer asks "what happens when
 * someone calls?", and what the Studio draws as the flow map — same source, so
 * the screen and the assistant always tell the same story.
 */
export function explainCallFlow(menu: MenuForExplain, ctx: ExplainContext): CallStep[] {
  const { dir } = ctx;
  const steps: CallStep[] = [];

  const numbers = (ctx.phoneNumbers ?? []).filter(Boolean);
  steps.push({
    kind: "arrive",
    headline: numbers.length ? `Someone calls ${numbers.join(" or ")}` : "Someone calls in",
    detail: numbers.length
      ? `A caller dials ${numbers.join(" or ")} and reaches the “${menu.name}” menu.`
      : `A caller reaches the “${menu.name}” menu.`,
  });

  if (ctx.hoursSummary) {
    steps.push({
      kind: "arrive",
      headline: "We check whether you're open",
      detail: `${ctx.hoursSummary} Outside those hours callers hear your after-hours menu instead.`,
    });
  }

  steps.push({
    kind: "greeting",
    headline: menu.greetingName ? `They hear “${menu.greetingName}”` : "They hear your greeting",
    detail: menu.greetingName
      ? `Your recording “${menu.greetingName}” plays, which should tell them which key to press.`
      : "Your greeting plays. No recording is set yet, so callers currently hear a stand-in message.",
  });

  const sorted = [...menu.options].sort((a, b) => keyOrder(a.optionDigit) - keyOrder(b.optionDigit));
  for (const o of sorted) {
    const read = readDestination(o, dir);
    steps.push({
      kind: "key",
      headline: `They press ${digitGlyph(o.optionDigit)} — ${read.name ?? KIND_LABEL[read.kind]}`,
      detail: explainKeyPress(o.optionDigit, o, dir),
      digit: o.optionDigit,
      leadsToMenuId: read.kind === "menu" ? read.targetId : null,
    });
  }

  if (sorted.length === 0) {
    steps.push({
      kind: "key",
      headline: "No keys are set up yet",
      detail: "Right now no key does anything, so every caller ends up at the fallback below.",
    });
  }

  const wait = menu.timeoutSeconds && menu.timeoutSeconds > 0 ? menu.timeoutSeconds : 7;
  steps.push({
    kind: "silence",
    headline: `They press nothing for ${wait} seconds`,
    detail: menu.timeoutDestination
      ? `If the caller stays silent for ${wait} seconds, we send them to ${describeDestination(menu.timeoutDestination, dir)}.`
      : `If the caller stays silent for ${wait} seconds, we play the greeting again. After a few tries the call ends.`,
  });

  steps.push({
    kind: "wrongkey",
    headline: "They press a key you haven't set up",
    detail: menu.invalidDestination
      ? `We tell them it wasn't a valid choice and replay the menu. If they keep getting it wrong we send them to ${describeDestination(menu.invalidDestination, dir)}.`
      : "We tell them it wasn't a valid choice and replay the menu. After a few tries the call ends.",
  });

  return steps;
}

function keyOrder(digit: string): number {
  if (digit === "star") return 10;
  if (digit === "0") return 11;
  if (digit === "hash") return 12;
  const n = Number(digit);
  return Number.isFinite(n) ? n : 99;
}

/**
 * Flatten the steps into something the agent can say in a chat message.
 * Deliberately prose, not a bulleted dump — a customer asking "what happens
 * when someone calls?" wants to be talked through it.
 */
export function narrateCallFlow(steps: CallStep[]): string {
  return steps.map((s) => s.detail).join(" ");
}

/** Weekly hours in one readable line: "You're open Mon–Thu 9:30am–5pm and Sun 11am–5pm." */
export function summariseHours(
  rules: Array<{ day: number; open: string; close: string }>,
  timezone?: string | null,
): string {
  if (!rules || rules.length === 0) return "No opening hours are set, so callers get the after-hours menu at every time of day.";
  const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byWindow = new Map<string, number[]>();
  for (const r of [...rules].sort((a, b) => a.day - b.day)) {
    const k = `${r.open}-${r.close}`;
    byWindow.set(k, [...(byWindow.get(k) ?? []), r.day]);
  }
  const parts: string[] = [];
  for (const [window, days] of byWindow) {
    const [open, close] = window.split("-");
    parts.push(`${describeDayRun(days, SHORT, NAMES)} ${prettyTime(open)}–${prettyTime(close)}`);
  }
  const tz = timezone ? ` (${timezone.split("/").pop()?.replace(/_/g, " ")} time)` : "";
  return `You're open ${joinWithAnd(parts)}${tz}.`;
}

function describeDayRun(days: number[], SHORT: string[], NAMES: string[]): string {
  if (days.length === 1) return NAMES[days[0]];
  const consecutive = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (consecutive && days.length > 2) return `${SHORT[days[0]]}–${SHORT[days[days.length - 1]]}`;
  return joinWithAnd(days.map((d) => SHORT[d]));
}

function prettyTime(hhmm: string): string {
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = m[2];
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === "00" ? `${h12}${ampm}` : `${h12}:${min}${ampm}`;
}

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

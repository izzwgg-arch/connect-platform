// ── Creating ring groups and queues on the PBX ───────────────────────────────
//
// There is no API for this. VitalPbxClient.createRingGroup throws
// NOT_SUPPORTED (the endpoint doesn't exist in VitalPBX 4), and while queues
// DO have a REST create, `apply_changes` is broken on this build — it reports
// success without regenerating config, so a REST write can silently never
// reach live routing. Both therefore go through the panel robot, the same path
// onboarding already uses.
//
// Every field below is REPLAYED from a capture of Izzy's own browser session
// (2026-08-03). Nothing is guessed. Full contract:
// docs/ai-context/PBX_PANEL_RING_GROUP_QUEUE_CONTRACT.md
//
// ⛔ This module NEVER calls Apply Changes. `generateConfigurations` regenerates
//    the whole PBX and is Izzy's click, always. These writes sit pending until
//    he applies them.

import {
  PanelSession, assertSaved, findOptionInSelect,
} from "../onboarding/panelClient";
import { nextTeamNumber, type TeamKind, type UsedNumbers } from "@connect/shared";

/** How a ring group hunts through its members. */
export type RingStrategy = "ringall" | "one_by_one";

export interface TeamMember {
  /** VitalPBX ombu_extensions.extension_id — NOT the dialled number. */
  extensionId: string;
  /**
   * Queue only. Lower rings first; members share a tier when equal. The panel
   * sends "" when unset, so undefined must stay "" rather than become 0 —
   * 0 is a real, meaningful penalty.
   */
  penalty?: number;
}

/**
 * The panel sends an EMPTY STRING for a numeric field left blank, not "0".
 * The difference matters: `servicelevel=0` and `servicelevel=` mean different
 * things to VitalPBX, and 0 is a legitimate value for several of these.
 */
function numField(v: number | undefined | null): string {
  return v == null ? "" : String(v);
}

export interface RingGroupSpec {
  name: string;
  /** Prepended to caller ID so staff see which line rang. */
  prefix?: string;
  strategy: RingStrategy;
  /** IN ORDER. This IS the ring order for one_by_one. */
  members: TeamMember[];
  /** Seconds to keep trying; 0 = system default. */
  ringTime?: number;
  /** Where the caller goes if nobody answers. */
  lastDestination?: { categoryId: string; targetId: string };
  /** Omit to have one allocated from the 800s. */
  number?: string;
}

/**
 * How a queue picks which agent to ring.
 *
 * ⛔ The panel contract doc records that only `ringall` was ever captured from
 * a real panel save. These are Asterisk's own `app_queue` strategies, and the
 * value passes STRAIGHT THROUGH into the generated `queues.conf` — verified on
 * the live box, where `strategy=ringall` and `strategy=linear` both appear in
 * `/etc/asterisk/vitalpbx/queues__*.conf`. A value the panel refuses fails
 * loudly through `assertSaved` rather than silently storing rubbish, which is
 * why offering the full set is safe.
 */
export type QueueStrategy =
  | "ringall"
  | "linear"
  | "leastrecent"
  | "fewestcalls"
  | "random"
  | "rrmemory"
  | "rrordered"
  | "wrandom";

export const QUEUE_STRATEGIES: readonly QueueStrategy[] = [
  "ringall", "linear", "leastrecent", "fewestcalls", "random", "rrmemory", "rrordered", "wrandom",
] as const;

/** Strategies proven live on this PBX today, as opposed to merely accepted. */
export const QUEUE_STRATEGIES_PROVEN: readonly QueueStrategy[] = ["ringall", "linear"] as const;

export interface QueueSpec {
  name: string;
  prefix?: string;
  members: TeamMember[];
  /** How the queue hunts. Defaults to ringall, the previous hardcoded value. */
  strategy?: QueueStrategy;
  /** Seconds each agent's phone rings before moving on. */
  ringTime?: number;
  /** Seconds to wait between rounds. */
  retry?: number;
  musicGroupId?: string;
  joinAnnouncementId?: string;
  periodicAnnouncementId?: string;
  periodicAnnounceFrequency?: number;
  /** true = repeat timer starts when the message FINISHES (avoids overlap). */
  relativePeriodicAnnounce?: boolean;
  announcePosition?: boolean;
  /** 0 = unlimited. */
  maxCallers?: number;
  /** Longest total wait, seconds. 0 = unlimited. */
  maxWaitSeconds?: number;
  lastDestination?: { categoryId: string; targetId: string };
  number?: string;

  // ── Advanced ─────────────────────────────────────────────────────────────
  /**
   * Seconds an agent is left alone after a call before the queue may ring them
   * again. Was hardcoded 0.
   */
  wrapUpSeconds?: number;
  /**
   * The "answered within N seconds" target this queue is judged against.
   * ⛔ VitalPBX leaves this NULL by default — every queue on this box has no
   * target — which is why the reports have to state whose target they used.
   * Setting it here is what lets a queue carry its OWN service level.
   */
  serviceLevelSeconds?: number;
  /** Let callers in when no agent is logged on. Was hardcoded "yes". */
  joinWhenEmpty?: boolean;
  /** Throw waiting callers out if every agent disappears. Was hardcoded "no". */
  leaveWhenEmpty?: boolean;
  /** Feed callers to agents as they free up rather than strictly in turn. */
  autofill?: boolean;
  /** Auto-pause an agent who doesn't answer. Was hardcoded "no". */
  autoPause?: boolean;
  /** Seconds to wait before connecting the two legs. */
  memberDelaySeconds?: number;
  /** Relative weight when one agent sits on several queues. */
  weight?: number;
  /** Only ring members whose penalty is within this many of the lowest. */
  penaltyMembersLimit?: number;
  /** How often to repeat the caller's position, seconds. */
  announceFrequency?: number;
  /** Never announce position more often than this, seconds. */
  minAnnounceFrequency?: number;
  /** Stop announcing position past this place in the queue. */
  announcePositionLimit?: number;
  /** Round the announced hold time to this many seconds. */
  announceRoundSeconds?: number;
  /** SIP Alert-Info, so handsets can ring differently for this queue. */
  alertInfo?: string;
  /** Where a caller goes when the queue gives up. Distinct from lastDestination. */
  hangupDestination?: { categoryId: string; targetId: string };
}

export interface TeamCreateResult {
  ok: true;
  kind: TeamKind;
  number: string;
  name: string;
  /** Always false — this module never applies. */
  applied: false;
  note: string;
}

const NOT_APPLIED =
  "Created on the phone system but NOT yet live — it goes live when Apply Changes is pressed on the PBX.";

/**
 * Multipart, because that is what the panel's own save sends. A url-encoded
 * body is silently mis-parsed, which is how a whole recording session was lost
 * to "[object FormData]".
 *
 * The GLOBAL FormData, deliberately — not `undici`'s. They are the same
 * implementation (Node's global comes from undici), but `undici` is not a
 * declared dependency of apps/api, so importing it here only worked while
 * nothing in the running server reached this file. The moment a route did, the
 * API container died on `Cannot find module 'undici'` and the blue/green
 * rollout refused to cut over. The global also matches `postForm`'s signature,
 * so the `as any` casts at the call sites can go.
 */
function form(fields: Array<[string, string]>): FormData {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  return fd;
}

/**
 * Delete a team through the panel — the same two-step dance a human's click
 * performs, replayed exactly. ⛔ The single-step delete "succeeds" WITHOUT
 * deleting (the onboarding wipes learned this twice): the first POST only
 * returns a confirmation modal, and the deletion happens when the modal's own
 * hidden inputs are posted back. So step 1 must find `confirmation-modal` in
 * the response, step 2 replays its hidden fields verbatim, and the caller must
 * verify by re-listing — a success notification alone is not proof.
 */
export async function deleteTeam(
  session: PanelSession,
  kind: "ring_group" | "queue",
  panelRowId: string,
): Promise<void> {
  const cls = kind === "queue" ? "queues" : "ring_group";
  const r = await session.postForm(form([
    ["class", cls],
    ["method", "delete"],
    ["mode", "delete"],
    ["data", panelRowId],
  ]));
  const html = String((r.json as any)?.html || "");
  if (/module-error-list/i.test(html)) {
    const items = (html.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || []).map((x) => x.replace(/<[^>]+>/g, " ").trim()).filter(Boolean);
    throw new Error(`panel_refused_delete: ${items.join(" | ") || "unknown reason"}`);
  }
  if (!/confirmation-modal/i.test(html)) {
    throw new Error(`unexpected_delete_response: ${r.text.slice(0, 200)}`);
  }
  const pairs: Array<[string, string]> = [];
  for (const m of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
    const n = (m[0].match(/name=["']([^"']+)["']/i) || [])[1];
    const v = (m[0].match(/value=["']([^"']*)["']/i) || [])[1] || "";
    if (n) pairs.push([n, v]);
  }
  const r2 = await session.postForm(form(pairs));
  if ((r2.json as any)?.notification?.type !== "success") {
    throw new Error(`delete_confirm_failed: ${r2.text.slice(0, 200)}`);
  }
}

/**
 * An unchecked checkbox is OMITTED by a real browser. Sending `foo=no` CHECKS
 * it — that is how a trunk got disabled during onboarding. So checkbox fields
 * appear here only when they should be on.
 */
function checkbox(name: string, on: boolean): Array<[string, string]> {
  return on ? [[name, "yes"]] : [];
}

/** Pick a free number in the right series unless one was supplied. */
function resolveNumber(kind: TeamKind, spec: { number?: string }, used: UsedNumbers): string {
  if (spec.number && spec.number.trim()) return spec.number.trim();
  const n = nextTeamNumber(kind, used);
  if (!n) throw new Error(`no_free_${kind}_number`);
  return n;
}

/**
 * Create a ring group. `members` order is preserved exactly — the panel sends
 * the whole membership as an ordered `list[]` and rewrites it on every save,
 * which is why ombu_ring_group_members needs no sort column.
 */
export async function createRingGroup(
  session: PanelSession,
  spec: RingGroupSpec,
  used: UsedNumbers,
): Promise<TeamCreateResult> {
  if (spec.members.length === 0) throw new Error("ring_group_needs_at_least_one_member");
  const number = resolveNumber("ring_group", spec, used);
  const csrf = await session.ensureCsrf("ring_group");
  if (!csrf) throw new Error("csrf_token_unavailable");

  const fields: Array<[string, string]> = [
    ["class", "ring_group"],
    ["method", "put"],
    ["mode", "add"],
    ["csfr_token", csrf],
    ["extension", number],
    ["description", spec.name],
    ["strategy", spec.strategy],
    ["ringtime", String(spec.ringTime ?? 0)],
    ["prefix", spec.prefix ?? spec.name],
    ["class_of_service_id", "1"],
    ["music_group_id", ""],
    ["announ_id", ""],
    // Captured as checked on the real save.
    ...checkbox("answerchannel", true),
    ...checkbox("no_release", true),
  ];
  // ORDER MATTERS: this array is the ring order.
  for (const m of spec.members) fields.push(["list[]", String(m.extensionId)]);
  if (spec.lastDestination) {
    fields.push(["mod_dest", spec.lastDestination.categoryId]);
    fields.push(["destination", spec.lastDestination.targetId]);
  }

  const res = await session.postForm(form(fields));
  assertSaved(`create ring group ${number}`, res);
  return { ok: true, kind: "ring_group", number, name: spec.name, applied: false, note: NOT_APPLIED };
}

/** Create a queue. Same replay discipline as above. */
export async function createQueue(
  session: PanelSession,
  spec: QueueSpec,
  used: UsedNumbers,
): Promise<TeamCreateResult> {
  if (spec.members.length === 0) throw new Error("queue_needs_at_least_one_agent");
  const number = resolveNumber("queue", spec, used);
  const csrf = await session.ensureCsrf("queues");
  if (!csrf) throw new Error("csrf_token_unavailable");

  const fields: Array<[string, string]> = [
    ["class", "queues"],
    ["method", "put"],
    ["mode", "add"],
    ["csfr_token", csrf],
    ["extension", number],
    ["description", spec.name],
    ["strategy", spec.strategy ?? "ringall"],
    ["prefix", spec.prefix ?? spec.name],
    ["join_announcement_id", spec.joinAnnouncementId ?? ""],
    ["announcement_id", ""],
    ["servicelevel", numField(spec.serviceLevelSeconds)],
    // ⛔ An unchecked box is ABSENT from the panel's form, never "no" — but
    // these two are selects, not checkboxes, so they DO carry a literal value.
    ["joinempty", spec.joinWhenEmpty === false ? "no" : "yes"],
    ["leavewhenempty", spec.leaveWhenEmpty === true ? "yes" : "no"],
    ["alertinfo", spec.alertInfo ?? ""],
    ["queue_timeout", String(spec.maxWaitSeconds ?? 0)],
    ["timeout", String(spec.ringTime ?? 15)],
    ["retry", String(spec.retry ?? 5)],
    ["wrapuptime", String(spec.wrapUpSeconds ?? 0)],
    // ⛔ Callback stays empty on purpose. `queue_callback_id` points at a row
    // in ombu_queues_callback, configured on a panel screen that was never
    // recorded — so we cannot offer it without guessing the contract.
    ["queue_callback_id", ""],
    ["music_group_id", spec.musicGroupId ?? ""],
    ["periodic_announcement_id", spec.periodicAnnouncementId ?? ""],
    ["periodic_announce_frequency", numField(spec.periodicAnnounceFrequency)],
    ["relative_periodic_announce", spec.relativePeriodicAnnounce === false ? "no" : "yes"],
    ["announce_position", spec.announcePosition ? "yes" : "no"],
    ["announce_position_limit", numField(spec.announcePositionLimit)],
    ["announce_frequency", numField(spec.announceFrequency)],
    ["min_announce_frequency", numField(spec.minAnnounceFrequency)],
    ["announce_round_seconds", String(spec.announceRoundSeconds ?? 0)],
    ["autopause", spec.autoPause === true ? "yes" : "no"],
    ["penaltymemberslimit", numField(spec.penaltyMembersLimit)],
    ["memberdelay", numField(spec.memberDelaySeconds)],
    ["weight", numField(spec.weight)],
    ["maxlen", String(spec.maxCallers ?? 0)],
    ["cron_profile_id", ""],
    ["ivr_id", ""],
    ["queue_vip_list_id", ""],
    ["autofill", spec.autofill === false ? "no" : "yes"],
    ...checkbox("answerchannel", true),
  ];

  // The browser sends a placeholder row alongside the real ones; the form
  // expects it. Note the extension_id key uses UNDERSCORES while its siblings
  // use brackets — that asymmetry is real and must be reproduced.
  const ph = "{{row-count-placeholder}}";
  fields.push([`queue_members[${ph}][member_id]`, ""]);
  fields.push([`queue_members_${ph}_extension_id`, String(spec.members[0].extensionId)]);
  fields.push([`queue_members[${ph}][penalty]`, ""]);
  fields.push([`queue_members[${ph}][type]`, "dynamic"]);
  spec.members.forEach((m, i) => {
    fields.push([`queue_members[${i}][member_id]`, ""]);
    fields.push([`queue_members_${i}_extension_id`, String(m.extensionId)]);
    fields.push([`queue_members[${i}][penalty]`, numField(m.penalty)]);
    fields.push([`queue_members[${i}][type]`, "static"]);
  });

  if (spec.lastDestination) {
    fields.push(["mod_dest", spec.lastDestination.categoryId]);
    fields.push(["destination", spec.lastDestination.targetId]);
  }

  // Where a caller goes when the queue gives up on them — a different exit
  // from `lastDestination`, and the panel keeps them in separate fields.
  if (spec.hangupDestination) {
    fields.push(["mod_hangup_dest", spec.hangupDestination.categoryId]);
    fields.push(["hangup_dest", spec.hangupDestination.targetId]);
  }

  const res = await session.postForm(form(fields));
  assertSaved(`create queue ${number}`, res);
  return { ok: true, kind: "queue", number, name: spec.name, applied: false, note: NOT_APPLIED };
}

/** Destination categories the customer-facing picker offers. */
export const LAST_DESTINATION_CATEGORIES = {
  extension: "1",
  voicemail: "25", // vm_direct
  ivr: "16",
} as const;

export { findOptionInSelect };

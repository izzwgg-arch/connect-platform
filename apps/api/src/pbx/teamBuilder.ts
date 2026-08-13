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

export interface QueueSpec {
  name: string;
  prefix?: string;
  members: TeamMember[];
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
    ["strategy", "ringall"],
    ["prefix", spec.prefix ?? spec.name],
    ["join_announcement_id", spec.joinAnnouncementId ?? ""],
    ["announcement_id", ""],
    ["servicelevel", ""],
    ["joinempty", "yes"],
    ["leavewhenempty", "no"],
    ["alertinfo", ""],
    ["queue_timeout", String(spec.maxWaitSeconds ?? 0)],
    ["timeout", String(spec.ringTime ?? 15)],
    ["retry", String(spec.retry ?? 5)],
    ["wrapuptime", "0"],
    ["queue_callback_id", ""],
    ["music_group_id", spec.musicGroupId ?? ""],
    ["periodic_announcement_id", spec.periodicAnnouncementId ?? ""],
    ["periodic_announce_frequency", spec.periodicAnnounceFrequency ? String(spec.periodicAnnounceFrequency) : ""],
    ["relative_periodic_announce", spec.relativePeriodicAnnounce === false ? "no" : "yes"],
    ["announce_position", spec.announcePosition ? "yes" : "no"],
    ["announce_position_limit", ""],
    ["announce_frequency", ""],
    ["min_announce_frequency", ""],
    ["announce_round_seconds", "0"],
    ["autopause", "no"],
    ["penaltymemberslimit", ""],
    ["memberdelay", ""],
    ["weight", ""],
    ["maxlen", String(spec.maxCallers ?? 0)],
    ["cron_profile_id", ""],
    ["ivr_id", ""],
    ["queue_vip_list_id", ""],
    ["autofill", "yes"],
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
    fields.push([`queue_members[${i}][penalty]`, ""]);
    fields.push([`queue_members[${i}][type]`, "static"]);
  });

  if (spec.lastDestination) {
    fields.push(["mod_dest", spec.lastDestination.categoryId]);
    fields.push(["destination", spec.lastDestination.targetId]);
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

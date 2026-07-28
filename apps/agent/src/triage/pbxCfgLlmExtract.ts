/**
 * LLM-first understanding for PBX config requests — M3 (inbound routing),
 * M4 (IVR recordings + menu options), M10 (queue members / hold music /
 * announcements). Owner directive 2026-07-28: "the agent knows all possible
 * phrases and checks and diagnoses each one of these things — make it smart."
 *
 * Same contract as mohLlmExtract: the frontier model READS the request with
 * the tenant's REAL inventory in front of it (DIDs + current targets, IVRs +
 * entries, queues + members, extensions, recordings, hold-music profiles) and
 * returns STRUCTURED JSON. Deterministic code then re-resolves every name
 * against that same inventory — an unknown queue, an unowned extension or a
 * hallucinated recording is discarded and the caller asks for clarification.
 * The model never executes anything; validated output only fills M3/M4/M10
 * params that still flow through policy gates, approval binding, snapshots,
 * PBX-side ownership checks, verification and the revert scheduler.
 */
import type { ExtractorLlm } from "./mohLlmExtract";

/** Catalog shape returned by the api door's list_catalog / native_list. */
export interface PbxCatalog {
  tenantId: string;
  extensions: Array<{ id: number; extension: string; name: string }>;
  queues: Array<{
    id: number;
    extension: string;
    description: string;
    strategy?: string;
    musicGroupId?: number | null;
    announcementId?: number | null;
    periodicAnnouncementId?: number | null;
    joinAnnouncementId?: number | null;
    members: Array<{ extension: string; name: string }>;
  }>;
  ringGroups: Array<{ id: number; extension: string; description: string }>;
  ivrs: Array<{
    id: number;
    description: string;
    welcomeRecordingId?: number | null;
    welcomeRecordingName?: string | null;
    entries: Array<{ option: string; target: { type: string; targetId: string | null; label: string | null } | null }>;
  }>;
  recordings: Array<{ id: number; name: string; durationSec?: number }>;
  timeConditions: Array<{ id: number; description: string; code?: string }>;
  customApplications: Array<{ id: number; extension: string; description: string }>;
  routes: Array<{ did: string; description: string; destinationId: number | null; target: { type: string; targetId: string | null; label: string | null } | null }>;
}

export type PbxTargetType = "extension" | "queue" | "ring_group" | "ivr" | "time_condition" | "custom_application";

export interface ResolvedTarget {
  type: PbxTargetType;
  /** Primary key in the corresponding ombu table (what the helper verifies). */
  id: string;
  label: string;
}

export type PbxCfgOperation =
  | { domain: "route"; op: "status"; did: string | null }
  | { domain: "route"; op: "set"; did: string; target: ResolvedTarget }
  | { domain: "route"; op: "restore"; did: string }
  | { domain: "ivr"; op: "status"; ivrId: number | null }
  | { domain: "ivr"; op: "set_entry"; ivrId: number; ivrName: string; option: string; target: ResolvedTarget }
  | { domain: "ivr"; op: "clear_entry"; ivrId: number; ivrName: string; option: string }
  | { domain: "ivr"; op: "set_welcome"; ivrId: number; ivrName: string; recordingId: number; recordingName: string }
  | { domain: "queue"; op: "status"; queueId: number | null }
  | { domain: "queue"; op: "add_member" | "remove_member"; queueId: number; queueExtension: string; queueName: string; extension: string }
  | { domain: "queue"; op: "set_moh"; queueId: number; queueExtension: string; queueName: string; mohClass: string; mohLabel: string }
  | {
      domain: "queue";
      op: "set_announcement";
      queueId: number;
      queueExtension: string;
      queueName: string;
      slot: "announcement" | "periodic" | "join";
      recordingId: number | null;
      recordingName: string | null;
    };

export type PbxCfgExtractOutcome =
  | { kind: "op"; op: PbxCfgOperation }
  | { kind: "clarify"; question: string }
  | { kind: "not_pbx_config" };

export interface PbxCfgExtractInput {
  text: string;
  catalog: PbxCatalog;
  /** Tenant hold-music profiles (name → Asterisk class) — valid values for queue set_moh. */
  mohProfiles: Array<{ name: string; mohClass: string }>;
  conversationId?: string;
}

function fmtTarget(t: { type: string; targetId: string | null; label: string | null } | null): string {
  if (!t) return "(unset)";
  return `${t.type.replace(/_/g, " ")} ${t.label ?? t.targetId ?? "?"}`.trim();
}

export function buildCatalogBlock(c: PbxCatalog, mohProfiles: Array<{ name: string; mohClass: string }>): string {
  const lines: string[] = [];
  lines.push(`PHONE NUMBERS (DIDs) and where each currently routes:`);
  for (const r of c.routes) lines.push(`- ${r.did}${r.description ? ` ("${r.description}")` : ""} → ${fmtTarget(r.target)}`);
  if (!c.routes.length) lines.push(`- (none)`);
  lines.push(`EXTENSIONS: ${c.extensions.map((e) => `${e.extension}${e.name ? ` "${e.name}"` : ""}`).join(", ") || "(none)"}`);
  lines.push(`QUEUES:`);
  for (const q of c.queues) lines.push(`- queue ${q.extension} "${q.description}" — members: ${q.members.map((m) => m.extension).join(", ") || "(none)"}`);
  if (!c.queues.length) lines.push(`- (none)`);
  lines.push(`IVR MENUS:`);
  for (const i of c.ivrs) {
    const opts = i.entries.map((e) => `${e.option}→${fmtTarget(e.target)}`).join("; ");
    lines.push(`- "${i.description}" — greeting: ${i.welcomeRecordingName ? `"${i.welcomeRecordingName}"` : "(none)"}; options: ${opts || "(none)"}`);
  }
  if (!c.ivrs.length) lines.push(`- (none)`);
  lines.push(`RING GROUPS: ${c.ringGroups.map((g) => `${g.extension} "${g.description}"`).join(", ") || "(none)"}`);
  lines.push(`TIME CONDITIONS: ${c.timeConditions.map((t) => `"${t.description}"`).join(", ") || "(none)"}`);
  lines.push(`CUSTOM APPLICATIONS: ${c.customApplications.map((a) => `${a.extension} "${a.description}"`).join(", ") || "(none)"}`);
  lines.push(`RECORDINGS (announcements/greetings): ${c.recordings.map((r) => `"${r.name}"`).join(", ") || "(none)"}`);
  lines.push(`HOLD-MUSIC PROFILES (valid queue hold music): ${mohProfiles.map((p) => `"${p.name}"`).join(", ") || "(none)"}`);
  return lines.join("\n");
}

function buildPrompt(input: PbxCfgExtractInput): string {
  return [
    `You extract a structured phone-system configuration request from a client's message.`,
    `THE CLIENT'S PHONE SYSTEM INVENTORY (the ONLY valid names/numbers — never invent):`,
    buildCatalogBlock(input.catalog, input.mohProfiles),
    ``,
    `Reply with ONE minified JSON object and NOTHING else. Schema:`,
    `{"is_pbx_config":boolean,` +
      `"domain":"route"|"ivr"|"queue",` +
      `"operation":"status"|"set"|"restore"|"set_entry"|"clear_entry"|"set_welcome"|"add_member"|"remove_member"|"set_moh"|"set_announcement",` +
      `"did":string|null,` +
      `"ivr":string|null,` +
      `"queue":string|null,` +
      `"option":string|null,` +
      `"target_type":"extension"|"queue"|"ring_group"|"ivr"|"time_condition"|"custom_application"|null,` +
      `"target":string|null,` +
      `"extension":string|null,` +
      `"recording":string|null,` +
      `"moh":string|null,` +
      `"slot":"announcement"|"periodic"|"join"|null,` +
      `"confidence":number}`,
    ``,
    `Rules:`,
    `- is_pbx_config=false when the message is NOT about call routing, IVR menus, or queue configuration (e.g. plain hold-music changes for the company/an extension, DND, voicemail, billing, complaints that something is broken).`,
    `- domain "route" = where a PHONE NUMBER (DID) sends incoming calls. operation "set" (point it somewhere), "restore" (put it back the way it was), "status" ("where does my number go?").`,
    `  Phrases: "route my number to…", "when people call 845… it should go to…", "point the main number at the sales queue", "send calls to the IVR", "put my number back".`,
    `- domain "ivr" = an IVR/auto-attendant menu. operation "set_entry" (change what pressing a digit does), "clear_entry" (remove a digit), "set_welcome" (change the greeting/recording it plays), "status" ("what are my menu options?").`,
    `  Phrases: "press 2 should go to…", "option 3 on the main menu → billing", "remove option 4", "change the greeting on the menu to <recording>", "use the recording I uploaded".`,
    `- domain "queue" = a call queue. operation "add_member"/"remove_member" (extensions answering the queue), "set_moh" (the queue's hold music), "set_announcement" (announcement recordings: slot "periodic" = repeats while waiting, "join" = plays when joining, "announcement" = agent announcement), "status" ("who is in the queue?").`,
    `  Phrases: "add extension 102 to the sales queue", "take 101 out of the queue", "change the queue hold music to Jazz", "set the queue announcement to <recording>".`,
    `- Copy names EXACTLY as listed in the inventory (match case-insensitively, output the exact listed spelling). "did" is the digits of the phone number. "queue" may be the queue number or its name. "extension" is the member extension NUMBER for add/remove.`,
    `- When the inventory has exactly ONE phone number / ONE IVR / ONE queue and the client doesn't name one, use that one.`,
    `- "target" is where calls should GO (for route set / ivr set_entry): a name or number from the inventory; set "target_type" to its type. An extension number like "101" is target_type "extension".`,
    `- Never guess a value the client didn't state (except the single-item default above). Use null.`,
    `- confidence: 0..1 for the WHOLE extraction. Below 0.6 means unsure.`,
  ].join("\n");
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

/** Resolve a name/number to a tenant-owned target using the catalog. */
export function resolveTarget(catalog: PbxCatalog, typeHint: string | null, ref: string): ResolvedTarget | null {
  const r = norm(ref);
  const rd = digits(ref);
  const tryOrder: PbxTargetType[] = typeHint && ["extension", "queue", "ring_group", "ivr", "time_condition", "custom_application"].includes(typeHint)
    ? [typeHint as PbxTargetType]
    : ["extension", "queue", "ring_group", "ivr", "time_condition", "custom_application"];
  for (const t of tryOrder) {
    if (t === "extension") {
      const hit = catalog.extensions.find((e) => e.extension === rd || (r.length > 1 && norm(e.name) === r)) ??
        catalog.extensions.find((e) => r.length > 2 && norm(e.name).includes(r));
      if (hit) return { type: "extension", id: String(hit.id), label: `extension ${hit.extension}${hit.name ? ` (${hit.name})` : ""}` };
    } else if (t === "queue") {
      const hit = catalog.queues.find((q) => q.extension === rd || norm(q.description) === r) ??
        catalog.queues.find((q) => r.length > 2 && norm(q.description).includes(r));
      if (hit) return { type: "queue", id: String(hit.id), label: `queue ${hit.extension} ("${hit.description}")` };
    } else if (t === "ring_group") {
      const hit = catalog.ringGroups.find((g) => g.extension === rd || norm(g.description) === r) ??
        catalog.ringGroups.find((g) => r.length > 2 && norm(g.description).includes(r));
      if (hit) return { type: "ring_group", id: String(hit.id), label: `ring group ${hit.extension} ("${hit.description}")` };
    } else if (t === "ivr") {
      const hit = catalog.ivrs.find((i) => norm(i.description) === r) ??
        catalog.ivrs.find((i) => r.length > 2 && norm(i.description).includes(r)) ??
        (catalog.ivrs.length === 1 && (r === "ivr" || r === "menu" || r === "the menu") ? catalog.ivrs[0] : undefined);
      if (hit) return { type: "ivr", id: String(hit.id), label: `IVR "${hit.description}"` };
    } else if (t === "time_condition") {
      const hit = catalog.timeConditions.find((c) => norm(c.description) === r) ??
        catalog.timeConditions.find((c) => r.length > 2 && norm(c.description).includes(r));
      if (hit) return { type: "time_condition", id: String(hit.id), label: `time condition "${hit.description}"` };
    } else {
      const hit = catalog.customApplications.find((a) => a.extension === rd || norm(a.description) === r) ??
        catalog.customApplications.find((a) => r.length > 2 && norm(a.description).includes(r));
      if (hit) return { type: "custom_application", id: String(hit.id), label: `custom app ${hit.extension} ("${hit.description}")` };
    }
  }
  return null;
}

function resolveDid(catalog: PbxCatalog, ref: string | null): { did: string } | { clarify: string } | null {
  if (ref) {
    const rd = digits(ref);
    // Suffix match BOTH ways (≥7 digits): stored "8455577768" vs spoken
    // "+1 845 557 7768", or stored E.164 vs a bare local number.
    const hit = catalog.routes.find(
      (r) => digits(r.did) === rd || (rd.length >= 7 && (digits(r.did).endsWith(rd) || rd.endsWith(digits(r.did)))),
    );
    if (hit) return { did: hit.did };
    return { clarify: `I couldn't find ${ref} among your numbers. Your numbers are: ${catalog.routes.map((r) => r.did).join(", ") || "(none on file)"}.` };
  }
  if (catalog.routes.length === 1) return { did: catalog.routes[0].did };
  if (catalog.routes.length === 0) return { clarify: `I don't see any phone numbers set up for your account, so there's nothing to reroute — I've flagged this for our team.` };
  return { clarify: `Which phone number? You have: ${catalog.routes.map((r) => r.did).join(", ")}.` };
}

function resolveIvr(catalog: PbxCatalog, ref: string | null): { id: number; name: string } | { clarify: string } {
  if (ref) {
    const r = norm(ref);
    const hit = catalog.ivrs.find((i) => norm(i.description) === r) ?? catalog.ivrs.find((i) => r.length > 2 && norm(i.description).includes(r));
    if (hit) return { id: hit.id, name: hit.description };
    return { clarify: `I couldn't find an IVR menu called "${ref}". Your menus are: ${catalog.ivrs.map((i) => `"${i.description}"`).join(", ") || "(none)"}.` };
  }
  if (catalog.ivrs.length === 1) return { id: catalog.ivrs[0].id, name: catalog.ivrs[0].description };
  if (catalog.ivrs.length === 0) return { clarify: `Your phone system doesn't have any IVR menus yet — I've flagged this for our team.` };
  return { clarify: `Which IVR menu? You have: ${catalog.ivrs.map((i) => `"${i.description}"`).join(", ")}.` };
}

function resolveQueue(catalog: PbxCatalog, ref: string | null): { id: number; extension: string; name: string } | { clarify: string } {
  if (ref) {
    const r = norm(ref);
    const rd = digits(ref);
    const hit = catalog.queues.find((q) => q.extension === rd || norm(q.description) === r) ??
      catalog.queues.find((q) => r.length > 2 && norm(q.description).includes(r));
    if (hit) return { id: hit.id, extension: hit.extension, name: hit.description };
    return { clarify: `I couldn't find a queue called "${ref}". Your queues are: ${catalog.queues.map((q) => `${q.extension} "${q.description}"`).join(", ") || "(none)"}.` };
  }
  if (catalog.queues.length === 1) return { id: catalog.queues[0].id, extension: catalog.queues[0].extension, name: catalog.queues[0].description };
  if (catalog.queues.length === 0) return { clarify: `Your phone system doesn't have any call queues yet — I've flagged this for our team.` };
  return { clarify: `Which queue? You have: ${catalog.queues.map((q) => `${q.extension} "${q.description}"`).join(", ")}.` };
}

function resolveRecording(catalog: PbxCatalog, ref: string): { id: number; name: string } | null {
  const r = norm(ref);
  return (
    (catalog.recordings.find((x) => norm(x.name) === r) ??
      catalog.recordings.find((x) => r.length > 2 && norm(x.name).includes(r)) ??
      catalog.recordings.find((x) => r.length > 2 && r.includes(norm(x.name)))) ?? null
  ) as any;
}

/** Validate + resolve the model's raw JSON against the catalog. */
export function validatePbxCfgExtraction(rawText: string, input: PbxCfgExtractInput): PbxCfgExtractOutcome | null {
  let j: any;
  try {
    j = JSON.parse(rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  if (j.is_pbx_config !== true) return { kind: "not_pbx_config" };
  if (typeof j.confidence !== "number" || j.confidence < 0.6) return null;
  const c = input.catalog;

  if (j.domain === "route") {
    if (j.operation === "status") return { kind: "op", op: { domain: "route", op: "status", did: j.did ? String(j.did) : null } };
    const did = resolveDid(c, j.did != null ? String(j.did) : null);
    if (!did) return null;
    if ("clarify" in did) return { kind: "clarify", question: did.clarify };
    if (j.operation === "restore") return { kind: "op", op: { domain: "route", op: "restore", did: did.did } };
    if (j.operation !== "set" || j.target == null) return { kind: "clarify", question: `Where should calls to ${did.did} go? (an extension, queue, ring group, IVR, time condition, or custom app)` };
    const target = resolveTarget(c, j.target_type ?? null, String(j.target));
    if (!target) return { kind: "clarify", question: `I couldn't find "${j.target}" in your phone system. Valid destinations: extensions (${c.extensions.map((e) => e.extension).join(", ") || "none"}), queues (${c.queues.map((q) => `"${q.description}"`).join(", ") || "none"}), ring groups, IVRs, time conditions, custom apps.` };
    return { kind: "op", op: { domain: "route", op: "set", did: did.did, target } };
  }

  if (j.domain === "ivr") {
    if (j.operation === "status") return { kind: "op", op: { domain: "ivr", op: "status", ivrId: null } };
    const ivr = resolveIvr(c, j.ivr != null ? String(j.ivr) : null);
    if ("clarify" in ivr) return { kind: "clarify", question: ivr.clarify };
    if (j.operation === "set_welcome") {
      if (j.recording == null) return { kind: "clarify", question: `Which recording should "${ivr.name}" play? Your recordings: ${c.recordings.map((r) => `"${r.name}"`).join(", ") || "(none — upload one first via the paperclip)"}.` };
      const rec = resolveRecording(c, String(j.recording));
      if (!rec) return { kind: "clarify", question: `I couldn't find a recording called "${j.recording}". Your recordings: ${c.recordings.map((r) => `"${r.name}"`).join(", ") || "(none — upload one first via the paperclip)"}.` };
      return { kind: "op", op: { domain: "ivr", op: "set_welcome", ivrId: ivr.id, ivrName: ivr.name, recordingId: rec.id, recordingName: rec.name } };
    }
    const option = j.option != null && /^(?:\d|\*|#)$/.test(String(j.option).trim()) ? String(j.option).trim() : null;
    if (!option) return { kind: "clarify", question: `Which menu option (digit) on "${ivr.name}" should I change?` };
    if (j.operation === "clear_entry") return { kind: "op", op: { domain: "ivr", op: "clear_entry", ivrId: ivr.id, ivrName: ivr.name, option } };
    if (j.operation !== "set_entry" || j.target == null) return { kind: "clarify", question: `Where should option ${option} on "${ivr.name}" go?` };
    const target = resolveTarget(c, j.target_type ?? null, String(j.target));
    if (!target) return { kind: "clarify", question: `I couldn't find "${j.target}" in your phone system to point option ${option} at.` };
    return { kind: "op", op: { domain: "ivr", op: "set_entry", ivrId: ivr.id, ivrName: ivr.name, option, target } };
  }

  if (j.domain === "queue") {
    if (j.operation === "status") return { kind: "op", op: { domain: "queue", op: "status", queueId: null } };
    const q = resolveQueue(c, j.queue != null ? String(j.queue) : null);
    if ("clarify" in q) return { kind: "clarify", question: q.clarify };
    if (j.operation === "add_member" || j.operation === "remove_member") {
      const ext = digits(j.extension);
      if (!ext) return { kind: "clarify", question: `Which extension should I ${j.operation === "add_member" ? "add to" : "remove from"} queue "${q.name}"?` };
      const owned = c.extensions.find((e) => e.extension === ext);
      if (!owned) return { kind: "clarify", question: `Extension ${ext} isn't one of your extensions. Yours: ${c.extensions.map((e) => e.extension).join(", ")}.` };
      return { kind: "op", op: { domain: "queue", op: j.operation, queueId: q.id, queueExtension: q.extension, queueName: q.name, extension: ext } };
    }
    if (j.operation === "set_moh") {
      if (j.moh == null) return { kind: "clarify", question: `Which hold music should queue "${q.name}" play? Your options: ${input.mohProfiles.map((p) => `"${p.name}"`).join(", ") || "(none)"}.` };
      const want = norm(j.moh);
      const prof = input.mohProfiles.find((p) => norm(p.name) === want) ?? input.mohProfiles.find((p) => want.length > 2 && norm(p.name).includes(want));
      if (!prof) return { kind: "clarify", question: `I couldn't find hold music called "${j.moh}". Your options: ${input.mohProfiles.map((p) => `"${p.name}"`).join(", ") || "(none)"}.` };
      return { kind: "op", op: { domain: "queue", op: "set_moh", queueId: q.id, queueExtension: q.extension, queueName: q.name, mohClass: prof.mohClass, mohLabel: prof.name } };
    }
    if (j.operation === "set_announcement") {
      const slot = j.slot === "periodic" || j.slot === "join" || j.slot === "announcement" ? j.slot : "periodic";
      if (j.recording == null) {
        return { kind: "op", op: { domain: "queue", op: "set_announcement", queueId: q.id, queueExtension: q.extension, queueName: q.name, slot, recordingId: null, recordingName: null } };
      }
      const rec = resolveRecording(c, String(j.recording));
      if (!rec) return { kind: "clarify", question: `I couldn't find a recording called "${j.recording}". Your recordings: ${c.recordings.map((r) => `"${r.name}"`).join(", ") || "(none — upload one first via the paperclip)"}.` };
      return { kind: "op", op: { domain: "queue", op: "set_announcement", queueId: q.id, queueExtension: q.extension, queueName: q.name, slot, recordingId: rec.id, recordingName: rec.name } };
    }
    return null;
  }

  return null;
}

/**
 * Ask the model to read the request. Returns null when no provider is
 * configured, the call fails, or the answer doesn't survive validation
 * (caller then asks a generic clarifying question). Never throws.
 */
export async function extractPbxCfgRequest(llm: ExtractorLlm | null, input: PbxCfgExtractInput): Promise<PbxCfgExtractOutcome | null> {
  if (!llm || llm.available().length === 0) return null;
  try {
    const res = await llm.complete(
      "task_extraction",
      [
        { role: "system", content: buildPrompt(input) },
        { role: "user", content: input.text },
      ],
      { maxTokens: 400, conversationId: input.conversationId },
    );
    return validatePbxCfgExtraction(res.text ?? "", input);
  } catch {
    return null;
  }
}

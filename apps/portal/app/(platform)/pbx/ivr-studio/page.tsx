"use client";

// ── IVR Studio ───────────────────────────────────────────────────────────────
// A phone-menu builder aimed at someone who has never seen a phone system.
//
// Three things drive the design (mockups approved 2026-08-03):
//
//  1. THE MAP IS THE PAGE. The call flow used to be a thin strip down the side
//     showing the first four keys of one menu. It is now the main surface, read
//     top to bottom like a list of what happens, and a key that leads to
//     another menu opens that menu underneath it as an indented branch. Nobody
//     has to hold the shape of the thing in their head.
//
//  2. PLAIN CHOICES, NOT NINE DIALPLAN CONCEPTS. Assigning a key offers "a
//     person / a team / a phone number / voicemail / a recording / another
//     menu / hang up". Every one is ALWAYS shown: a choice the customer can't
//     use yet is greyed with the reason, never hidden. Hiding them made a
//     brand-new tenant's screen look broken — three choices simply absent,
//     with nothing to say why.
//
//  3. EVERY CHOICE READS ITSELF BACK in the words a person would use, so a
//     mistake is obvious before Publish.
//
// The wording and the dialplan references both come from @connect/shared's
// ivrPlainLanguage — the SAME module the AI agent uses when it builds a menu
// for a customer or explains one. That is deliberate: if the agent and this
// screen each had their own copy, they would drift and tell the customer two
// different stories about the same menu.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  buildDestination, readDestination, describeDestination, describeAfterRecording,
  explainCallFlow, summariseHours, digitGlyph, formatPhone,
  KIND_LABEL, KIND_BLURB, OFFERABLE_KINDS,
  type MenuChoiceKind, type TenantDirectory, type CallStep, type AfterRecordingChoice,
} from "@connect/shared";
import { useAppContext } from "../../../../hooks/useAppContext";
import { useUiLanguage, LanguageToggle } from "../../../../hooks/useUiLanguage";
import { FirstRunSetup, type FirstRunAnswers } from "./FirstRunSetup";
import { MakeRecording } from "./MakeRecording";
import { MakeTeam } from "./MakeTeam";
import { NumberStep, fmtUs, type TenantNumber, type NumberPlan, type AnnouncementPlan } from "./NumberStep";
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, getPortalApiBaseUrl } from "../../../../services/apiClient";

interface RouteProfile {
  id: string; tenantId: string; name: string; type: string;
  pbxPromptRef: string | null; pbxInvalidPromptRef: string | null; pbxTimeoutPromptRef: string | null;
  timeoutSeconds: number; maxRetries: number; directDialEnabled: boolean;
  invalidDestinationType: string | null; invalidDestinationRef: string | null;
  timeoutDestinationType: string | null; timeoutDestinationRef: string | null;
  isActive: boolean;
}
interface OptionRow {
  id: string; profileId: string; optionDigit: string;
  destinationType: string; destinationRef: string; label: string | null; enabled: boolean;
  // Recording keys only: what plays, and where the caller goes after.
  announcePromptRef?: string | null;
  afterDestinationType?: string | null;
  afterDestinationRef?: string | null;
}
interface PromptRow { id: string; promptRef: string; displayName: string; category: string; hasAudio?: boolean }
interface ScheduleRow {
  timezone: string;
  businessHoursRules: Array<{ day: number; open: string; close: string }>;
  holidayDates: string[];
  defaultProfileId: string | null;
  afterHoursProfileId: string | null;
  holidayProfileId: string | null;
  isActive: boolean;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
];
const EMPTY_SCHEDULE: ScheduleRow = {
  timezone: "America/New_York", businessHoursRules: [], holidayDates: [],
  defaultProfileId: null, afterHoursProfileId: null, holidayProfileId: null, isActive: true,
};
/** Keypad order — the order keys appear on the map and in the "add a key" picker. */
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "star", "0", "hash"];

const KIND_GLYPH: Record<MenuChoiceKind, string> = {
  person: "👤", team: "👥", forward: "📱", voicemail: "📼", recording: "📣", menu: "🔢", hangup: "⛔", other: "⚙️",
};

/** Stable colour per name for the little person avatars. */
function avatarColor(seed: string): string {
  const palette = ["#3ba0f2", "#c2688f", "#4fae7d", "#d3903c", "#8b78d0", "#5c93bd", "#d2685f", "#3fa5a5"];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Every fixed phrase this screen shows, so they're fetched in one batch.
 *  Anything not yet translated by Yiddish Labs simply stays in English. */
const UI_PHRASES = [
  "Phone menus", "IVR Studio", "Publish", "Not published yet", "Rename", "New menu",
  "No phone menu yet", "Create my first menu", "What happens on a call",
  "Read it top to bottom — this is exactly what a caller goes through",
  "Someone calls in", "They hear your greeting", "Play", "Change", "Add another key",
  "Change number", "Switches over", "ends", "Cancel switch", "Publish and switch",
  "Explain it to me", "The whole call, in plain words", "Read it", "Hide",
  "Recordings", "Opening hours", "Time zone", "Save hours", "Closed all day",
  "While you're open", "When you're closed", "Choose a menu…", "Not saved yet",
  "A person", "A team", "Voicemail", "A recording", "Another menu", "Hang up",
  "Which person?", "Whose voicemail?", "Which team?", "Which menu?", "Which recording?",
  "After it plays, what happens?", "Back to this menu", "A voicemail",
  "Or add a new one:", "Upload a recording", "Uploading…", "Make one with AI",
  "A phone number", "Which phone number?", "Or send it to a new number:",
  "Add this number", "Setting it up…",
  "No teams yet — make the first one:", "Or make a new one:", "Make a team",
  "Rings a phone outside the office — a cell, or another business.",
  "Plays a recording — directions, hours, an announcement — then continues.",
  "Remove this key", "Cancel", "Save name", "Loading…",
  "Your phone number", "Your recording", "No recording set — callers hear a stand-in message",
  "No number points at this menu yet", "We replay the menu, then the call ends",
  "They press a key you haven't set up", "We tell them it wasn't valid and replay the menu",
  "Which key should the caller press?", "No recordings yet.", "Nothing to choose yet.",
  "This menu has no keys set up yet.", "None yet", "Add",
  "Callers never hear this name. It's only so you can find it later.",
  "This is the menu to play when we're closed", "Days you're closed all day (holidays)",
  "Not set — callers always get the closed menu",
  "Something else", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  "not live yet", "Teams marked “not live yet” start taking calls the next time changes are applied to the phone system.",
  "Publishing…", "Published — live for callers now",
  "This is what callers hear from now on.",
  "Callers will hear it once a phone number points at this menu.",
  "Not published — nothing changed for callers",
  "These recordings aren't on the phone system yet:",
];

/** Publish blockers the API can return WITHOUT a human-readable `detail`.
 *  Anything with a `detail` uses the server's wording; this only covers the
 *  bare-slug cases so an admin never sees "prompt_refs_not_in_catalog". */
const PUBLISH_ERROR_TEXT: Record<string, string> = {
  invalid_payload: "Something was missing from the publish request. Reload the page and try again.",
  tenant_not_linked: "This customer isn't linked to the phone system yet, so there's nothing to publish to.",
  no_active_menu_for_mode: "No menu is set to play right now. Open the opening-hours step and choose which menu answers while you're open and while you're closed.",
  prompt_refs_not_in_catalog: "Some recordings this menu uses aren't on the phone system yet.",
  publish_failed: "The phone system didn't accept the change, so callers still get the old routing. Try again in a moment.",
  forbidden: "You don't have permission to publish phone menus.",
};

/** Turns an API blocker key ("active_prompt_invalid", "opt_3/announce") into
 *  a spot on screen the admin can actually go fix. */
function describeMissingSpot(key: string, profileType?: string | null): string {
  const menu = profileType === "after_hours" ? "the after-hours menu" : "this menu";
  if (key === "active_prompt") return `the greeting on ${menu}`;
  if (key === "active_prompt_invalid") return `the “that wasn't a valid key” message on ${menu}`;
  if (key === "active_prompt_timeout") return `the “nothing was pressed” message on ${menu}`;
  if (key === "active_prompt_retry") return `the retry message on ${menu}`;
  const opt = /^opt_(.+)\/announce$/.exec(key);
  if (opt) return `the recording that plays when a caller presses ${opt[1]}`;
  return key;
}

export default function IvrStudioPage() {
  const { tenantId, tenant, can } = useAppContext();
  const { t } = useUiLanguage(UI_PHRASES);
  const search = useSearchParams();
  const canManage = can("can_manage_ivr_routing");
  const canPublish = can("can_publish_ivr_routing") || canManage;

  const [profiles, setProfiles] = useState<RouteProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Options for EVERY menu, not just the open one — the map has to walk into
   *  branches, and it can't do that with only the active menu's keys. */
  const [optionsByProfile, setOptionsByProfile] = useState<Record<string, OptionRow[]>>({});
  const [prompts, setPrompts] = useState<PromptRow[]>([]);
  const [schedule, setSchedule] = useState<ScheduleRow | null>(null);
  const [people, setPeople] = useState<Array<{ extension: string; name: string | null }>>([]);
  const [teams, setTeams] = useState<Array<{ number: string; name: string | null; kind: "ring_group" | "queue" }>>([]);
  /** Whether each list was actually READ, as opposed to came back empty.
   *  These are different facts and must not be conflated: "this customer has
   *  no teams" means hide the choice, but "we couldn't find out" means show it
   *  and say so. /voice/pbx/ring-groups answers 200 with `rows: []` and a
   *  `skipReason` when the tenant isn't linked — a soft failure that looks
   *  exactly like success, so it has to be checked explicitly. */
  const [peopleLoaded, setPeopleLoaded] = useState(true);
  const [teamsLoaded, setTeamsLoaded] = useState(true);
  /** Outside numbers this tenant can already reach (Custom Applications on the
   *  PBX). `null` means we couldn't find out — which must not be shown as
   *  "there are none", or a saved key reads as broken during a PBX hiccup. */
  const [forwards, setForwards] = useState<Array<{ extension: string; phoneNumber: string; name: string }> | null>(null);
  const [pbxTenantId, setPbxTenantId] = useState<string | null>(null);
  const [dids, setDids] = useState<string[]>([]);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editingDigit, setEditingDigit] = useState<string | null>(null);
  const [openBranches, setOpenBranches] = useState<Record<string, boolean>>({});
  const [recPickerOpen, setRecPickerOpen] = useState(false);
  const [namingFor, setNamingFor] = useState<null | { mode: "create"; forDigit: string | null } | { mode: "rename" }>(null);
  const [showScript, setShowScript] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /** The assistant sends the customer here after building a menu for them. */
  const fromAssistant = search?.get("from") === "assistant";
  /** Sent here straight after paying — walk them through it rather than
   *  dropping someone who has never seen a phone system into the full Studio. */
  const [firstRun, setFirstRun] = useState(search?.get("firstrun") === "1");
  const [firstRunBusy, setFirstRunBusy] = useState(false);
  /** Shown inside the walkthrough. While set, the modal stays open with the
   *  customer's answers intact and the button reads "Try again" — right after
   *  a build the PBX link is often not ready for a minute, and throwing the
   *  five answers away over that would mean starting from scratch. */
  const [firstRunError, setFirstRunError] = useState<string | null>(null);
  /** Teams made in this session that exist on the phone system but don't take
   *  calls until changes are applied there. The list endpoints can't say this
   *  (they read the same tables whether applied or not), so the create
   *  response's live:false is remembered here and shown as a badge. */
  const [pendingTeamNumbers, setPendingTeamNumbers] = useState<string[]>([]);
  /** Things that make Publish's "this is what callers hear from now on" claim
   *  untrue — asked about up front instead of discovered by a caller. */
  const [publishWarnings, setPublishWarnings] = useState<string[] | null>(null);
  /** Proof the publish landed, kept on screen until the next edit. A 3-second
   *  toast was the only signal before, and admins who missed it assumed the
   *  publish had failed and clicked again — two duplicate publishes 16s apart
   *  went live on 2026-08-06. */
  const [published, setPublished] = useState<null | {
    at: Date; keysWritten: number; switched: string | null; pointed: boolean;
  }>(null);
  /** Structured 422 from the API: the human-readable `detail` plus the list of
   *  recordings that blocked the publish. */
  const [publishBlocked, setPublishBlocked] = useState<null | {
    detail: string; missing: Array<{ key: string; ref: string; profileType?: string | null }>;
  }>(null);
  /** Generate a greeting instead of recording one — see MakeRecording.tsx. */
  const [makeRecOpen, setMakeRecOpen] = useState(false);
  /** Set when the recording modal/upload was opened FROM the key editor for a
   *  digit: the result becomes that key's recording, not the menu greeting. */
  const [makeRecForKey, setMakeRecForKey] = useState<string | null>(null);
  /** Same idea for teams: "A team" with none yet should MAKE one, not send the
   *  customer away to find the button. */
  const [makeTeamForKey, setMakeTeamForKey] = useState<string | null>(null);
  const [adoptTeam, setAdoptTeam] = useState<{ digit: string; number: string } | null>(null);
  /** A recording just made/uploaded for a key, waiting for that key's editor
   *  to select it. Cleared by the editor once adopted. */
  const [adoptRecording, setAdoptRecording] = useState<{ digit: string; promptRef: string } | null>(null);
  /** Create a ring group or a waiting line - see MakeTeam.tsx. */
  const [makeTeamOpen, setMakeTeamOpen] = useState(false);
  /** Which number rings this menu + when it switches — see NumberStep.tsx. */
  const [numberStepOpen, setNumberStepOpen] = useState(false);
  const [tenantNumbers, setTenantNumbers] = useState<TenantNumber[]>([]);
  const [numbersError, setNumbersError] = useState<string | null>(null);
  /** Held until Publish when the switch is "now"; a dated switch is booked at
   *  save time and shown as a banner. */
  const [numberPlan, setNumberPlan] = useState<NumberPlan | null>(null);
  const deepLinkProfile = search?.get("menu");

  const active = useMemo(() => profiles.find((p) => p.id === activeId) ?? null, [profiles, activeId]);
  const options = useMemo(() => (activeId ? optionsByProfile[activeId] ?? [] : []), [optionsByProfile, activeId]);
  const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };

  /** Everything this tenant actually has — the shared module refuses to build a
   *  destination for anything not in here, which is what stops a key being
   *  pointed at an extension that was deleted last month. */
  const directory: TenantDirectory = useMemo(() => ({
    pbxTenantId,
    people,
    teams,
    menus: profiles.map((p) => ({ id: p.id, name: p.name })),
    recordings: prompts.map((p) => ({ promptRef: p.promptRef, name: p.displayName })),
    // Left undefined when unknown — the shared reader treats "no list" as
    // "couldn't find out" rather than "deleted".
    ...(forwards ? { forwards } : {}),
  }), [pbxTenantId, people, teams, profiles, prompts, forwards]);

  const streamUrl = useCallback((promptId: string) => {
    const base = getPortalApiBaseUrl();
    const token = (typeof window !== "undefined" && (localStorage.getItem("token") || localStorage.getItem("cc-token"))) || "";
    return `${base}/voice/ivr/prompts/${encodeURIComponent(promptId)}/stream?token=${encodeURIComponent(token)}`;
  }, []);

  const play = useCallback((promptRef: string | null | undefined) => {
    if (!promptRef) { flash("No recording set yet"); return; }
    const row = prompts.find((p) => p.promptRef === promptRef);
    if (!row) { flash("That recording isn't in your library"); return; }
    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.src = streamUrl(row.id);
    audioRef.current.play().catch(() => flash("Couldn't play it — the audio hasn't been uploaded"));
  }, [prompts, streamUrl]);

  const loadAll = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true); setError(null);
    const safe = async <T,>(path: string): Promise<T | null> => { try { return await apiGet<T>(path); } catch { return null; } };
    try {
      const [p, pr, sc, ext, q, rg, dm, nums, fwd] = await Promise.all([
        apiGet<{ profiles: RouteProfile[] }>(`/voice/ivr/route-profiles${qs}`),
        apiGet<{ prompts: PromptRow[] }>(`/voice/ivr/prompts${qs}`),
        safe<{ schedule: ScheduleRow | null }>(`/voice/ivr/schedule${qs}`),
        safe<{ rows: any[] }>(`/voice/pbx/resources/extensions${qs}`),
        safe<{ rows: any[] }>(`/voice/pbx/resources/queues${qs}`),
        safe<{ rows: any[] }>(`/voice/pbx/ring-groups${qs}`),
        safe<{ mappings: any[] }>(`/voice/did/mappings${qs}`),
        safe<{ numbers: TenantNumber[] }>(`/voice/ivr/numbers${qs}`),
        safe<{ forwards: any[]; read: boolean }>(`/voice/forwards${qs}`),
      ]);
      // `read: false` means the PBX couldn't be reached — keep null so the map
      // says "a phone outside the office" rather than claiming it's deleted.
      setForwards(fwd?.read
        ? (fwd.forwards || []).map((f: any) => ({
            extension: String(f.extension), phoneNumber: String(f.phoneNumber ?? ""), name: String(f.name ?? ""),
          }))
        : null);
      setTenantNumbers(nums?.numbers ?? []);
      setNumbersError(nums ? null : "Couldn't read your numbers just now.");

      const list = p.profiles || [];
      setProfiles(list);
      setPrompts(pr.prompts || []);
      setSchedule(sc?.schedule ? { ...EMPTY_SCHEDULE, ...sc.schedule } : null);

      const extRows = (ext?.rows || []).map((x) => ({
        extension: String(x.extension),
        name: (x.name ?? null) as string | null,
        pbxDeviceName: x.pbxDeviceName ?? null,
        pbxSipUsername: x.pbxSipUsername ?? null,
      }));
      setPeople(extRows.map((x) => ({ extension: x.extension, name: x.name })));

      // The tenant's VitalPBX number, needed to write any destination. It's
      // embedded in the device names ("T2_101"), which is how the rest of the
      // Studio has always derived it.
      let pbxT: string | null = null;
      for (const r of extRows) {
        const m = String(r.pbxDeviceName || r.pbxSipUsername || "").match(/^T(\d+)_/i);
        if (m) { pbxT = m[1]; break; }
      }
      setPbxTenantId(pbxT);

      // The two sources name things differently, verified live 2026-08-03:
      //   ring groups → { name: "Sales", number: "1010" }        name IS the label
      //   queues      → { name: "T2_Q600", description: "main q",
      //                   extension: "600" }                     name is an internal id
      // Reading `name` first for both would offer a customer "T2_Q600" as a
      // place to send callers, which is precisely the jargon this screen exists
      // to get rid of. So queues prefer `description`.
      const teamRows = [
        ...(rg?.rows || []).map((x) => ({ number: String(x.number ?? x.group_number ?? x.extension ?? ""), name: (x.name ?? x.description ?? null) as string | null, kind: "ring_group" as const })),
        ...(q?.rows || []).map((x) => ({ number: String(x.number ?? x.queue_number ?? x.extension ?? ""), name: (x.description ?? x.name ?? null) as string | null, kind: "queue" as const })),
      ].filter((x) => x.number);
      setTeams(teamRows);
      // "A team" is a ring group OR a queue, so we only know this customer has
      // none when BOTH lists were actually read. Ring groups answer 200 with a
      // `skipReason` instead of an error when they can't be read; queues 404
      // (which `safe` turns into null).
      //
      // Requiring both is not pedantry — Landau Home has zero ring groups and
      // exactly one queue, and /voice/pbx/resources/queues answers 404
      // PBX_LINK_NOT_FOUND for them even though ring groups resolve their
      // VitalPBX tenant fine. Accepting one good source hid a team they really
      // have. If we already found teams, the choice is offered regardless.
      const rgUnknown = rg === null || Boolean((rg as any)?.skipReason);
      const qUnknown = q === null;
      setTeamsLoaded((!rgUnknown && !qUnknown) || teamRows.length > 0);
      setPeopleLoaded(ext !== null);

      // Every menu's keys, so branches can be drawn without another round trip
      // each time someone opens one.
      const allOptions: Record<string, OptionRow[]> = {};
      await Promise.all(list.map(async (prof) => {
        try {
          const r = await apiGet<{ options: OptionRow[] }>(`/voice/ivr/route-profiles/${prof.id}/options${qs}`);
          allOptions[prof.id] = r.options || [];
        } catch { allOptions[prof.id] = []; }
      }));
      setOptionsByProfile(allOptions);

      const chosen = deepLinkProfile && list.some((x) => x.id === deepLinkProfile) ? deepLinkProfile : null;
      setActiveId((cur) => chosen ?? (cur && list.some((x) => x.id === cur) ? cur : (list.find((x) => x.isActive)?.id ?? list[0]?.id ?? null)));

      const mappings = dm?.mappings || [];
      const profIds = new Set(list.map((x) => x.id));
      setDids(mappings.filter((m: any) => m.ivrProfileId && profIds.has(m.ivrProfileId)).map((m: any) => String(m.e164)));
    } catch (e: any) {
      setError(e?.message || "Couldn't load your phone menus");
    } finally { setLoading(false); }
  }, [tenantId, qs, deepLinkProfile]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const optionByDigit = useMemo(() => {
    const m = new Map<string, OptionRow>();
    for (const o of options) m.set(o.optionDigit, o);
    return m;
  }, [options]);

  const hoursSummary = useMemo(
    () => (schedule && schedule.businessHoursRules.length ? summariseHours(schedule.businessHoursRules, schedule.timezone) : null),
    [schedule],
  );

  /** The A-to-Z account of the call — the exact text the assistant would read
   *  out if a customer asked "what happens when someone calls?" */
  const callSteps: CallStep[] = useMemo(() => {
    if (!active) return [];
    return explainCallFlow({
      id: active.id,
      name: active.name,
      greetingName: prompts.find((p) => p.promptRef === active.pbxPromptRef)?.displayName ?? active.pbxPromptRef ?? null,
      timeoutSeconds: active.timeoutSeconds,
      options,
      timeoutDestination: active.timeoutDestinationType && active.timeoutDestinationRef
        ? { destinationType: active.timeoutDestinationType, destinationRef: active.timeoutDestinationRef } : null,
      invalidDestination: active.invalidDestinationType && active.invalidDestinationRef
        ? { destinationType: active.invalidDestinationType, destinationRef: active.invalidDestinationRef } : null,
    }, {
      dir: directory,
      phoneNumbers: dids,
      hoursSummary: schedule?.defaultProfileId === active.id ? hoursSummary : null,
    });
  }, [active, options, prompts, directory, dids, schedule, hoursSummary]);

  // ── writes ────────────────────────────────────────────────────────────────

  async function patchProfile(patch: Record<string, unknown>) {
    if (!active) return;
    setSaving(true);
    try {
      await apiPatch(`/voice/ivr/route-profiles/${active.id}${qs}`, patch);
      setProfiles((ps) => ps.map((p) => p.id === active.id ? { ...p, ...patch } as RouteProfile : p));
      setDirty(true); flash("Saved");
    } catch (e: any) { setError(e?.message || "Couldn't save that"); } finally { setSaving(false); }
  }

  async function saveKey(digit: string, kind: MenuChoiceKind, targetId: string, after?: AfterRecordingChoice) {
    if (!active) return;
    const dest = buildDestination(kind, targetId, directory, after);
    if (!dest) { flash("Pick where that key should go first"); return; }
    setSaving(true);
    try {
      const existing = optionByDigit.get(digit);
      const body = {
        destinationType: dest.destinationType, destinationRef: dest.destinationRef, label: dest.label ?? null,
        // Recording keys carry what plays + what happens after; explicit nulls
        // on every other kind clear stale fields when a key is repointed.
        announcePromptRef: dest.announcePromptRef ?? null,
        afterDestinationType: dest.afterDestinationType ?? null,
        afterDestinationRef: dest.afterDestinationRef ?? null,
      };
      let row: OptionRow;
      if (existing) {
        const r = await apiPatch<{ option: OptionRow }>(`/voice/ivr/route-profiles/${active.id}/options/${existing.id}${qs}`, body);
        row = r.option;
      } else {
        const r = await apiPost<{ option: OptionRow }>(`/voice/ivr/route-profiles/${active.id}/options${qs}`, { optionDigit: digit, ...body });
        row = r.option;
      }
      setOptionsByProfile((m) => ({
        ...m,
        [active.id]: [...(m[active.id] ?? []).filter((o) => o.optionDigit !== digit), row],
      }));
      setDirty(true); setEditingDigit(null);
      flash(`Key ${digitGlyph(digit)} now goes to ${dest.label}`);
    } catch (e: any) { setError(e?.message || "Couldn't save that key"); } finally { setSaving(false); }
  }

  /**
   * Upload a file straight from the key editor: catalog row first, then the
   * audio bytes (the server converts any common format to phone-quality WAV
   * and installs it on the phone system). Returns the new promptRef, or null
   * after surfacing the error — the editor stays open either way.
   */
  async function uploadRecordingForKey(digit: string, file: File): Promise<string | null> {
    try {
      const base = file.name.replace(/\.[^.]+$/, "");
      const safe = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "recording";
      const suffix = Math.random().toString(16).slice(2, 8);
      const created = await apiPost<{ prompt: PromptRow }>(`/voice/ivr/prompts${qs}`, {
        tenantId,
        promptRef: `custom/${safe}_${suffix}`,
        displayName: base.trim() || "Recording",
        category: "general",
      });
      const row = created.prompt;
      const fd = new FormData();
      fd.append("file", file, file.name);
      const token = (typeof window !== "undefined" && (localStorage.getItem("token") || localStorage.getItem("cc-token"))) || "";
      const r = await fetch(`${getPortalApiBaseUrl()}/voice/ivr/prompts/${encodeURIComponent(row.id)}/audio`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as any));
        throw new Error(body?.message || body?.error || `Upload failed (${r.status})`);
      }
      setPrompts((ps) => [
        ...ps.filter((p) => p.id !== row.id),
        { id: row.id, promptRef: row.promptRef, displayName: row.displayName, category: row.category, hasAudio: true },
      ]);
      setAdoptRecording({ digit, promptRef: row.promptRef });
      flash(`“${row.displayName}” uploaded.`);
      return row.promptRef;
    } catch (e: any) {
      setError(e?.message || "Couldn't upload that recording.");
      return null;
    }
  }

  /**
   * Make the phone system able to reach an outside number, and hand back the
   * internal number a key can point at. Nothing is wired to a key here — the
   * editor selects the result and the person still presses Save.
   */
  async function createForward(phoneNumber: string, label: string): Promise<string | null> {
    try {
      const r = await apiPost<{ forward: { extension: string; phoneNumber: string; name: string }; message: string }>(
        `/voice/forwards${qs}`,
        { tenantId, phoneNumber, label },
      );
      const f = r.forward;
      setForwards((cur) => [...(cur ?? []).filter((x) => x.extension !== f.extension), f]);
      flash(r.message);
      return f.extension;
    } catch (e: any) {
      setError(e?.body?.message || e?.message || "Couldn't set that number up on the phone system.");
      return null;
    }
  }

  async function clearKey(digit: string) {
    if (!active) return;
    const existing = optionByDigit.get(digit);
    if (!existing) { setEditingDigit(null); return; }
    setSaving(true);
    try {
      await apiDelete(`/voice/ivr/route-profiles/${active.id}/options/${existing.id}${qs}`);
      setOptionsByProfile((m) => ({ ...m, [active.id]: (m[active.id] ?? []).filter((o) => o.id !== existing.id) }));
      setDirty(true); setEditingDigit(null); flash(`Key ${digitGlyph(digit)} cleared`);
    } catch (e: any) { setError(e?.message || "Couldn't clear that key"); } finally { setSaving(false); }
  }

  /** Create a menu. When `forDigit` is set we also point that key at the new
   *  menu, because that is the only reason someone creates one mid-flow. */
  async function createMenu(name: string, type: "business_hours" | "after_hours", forDigit: string | null) {
    if (!tenantId) return;
    setSaving(true);
    try {
      const r = await apiPost<{ profile: RouteProfile }>(`/voice/ivr/route-profiles${qs}`, { tenantId, name, type });
      const created = r.profile;
      setProfiles((ps) => [...ps, created]);
      setOptionsByProfile((m) => ({ ...m, [created.id]: [] }));
      setNamingFor(null);

      if (forDigit && active) {
        const dest = buildDestination("menu", created.id, { ...directory, menus: [...directory.menus, { id: created.id, name }] });
        if (dest) {
          const existing = optionByDigit.get(forDigit);
          const body = { destinationType: dest.destinationType, destinationRef: dest.destinationRef, label: dest.label ?? null };
          const saved = existing
            ? (await apiPatch<{ option: OptionRow }>(`/voice/ivr/route-profiles/${active.id}/options/${existing.id}${qs}`, body)).option
            : (await apiPost<{ option: OptionRow }>(`/voice/ivr/route-profiles/${active.id}/options${qs}`, { optionDigit: forDigit, ...body })).option;
          setOptionsByProfile((m) => ({
            ...m,
            [active.id]: [...(m[active.id] ?? []).filter((o) => o.optionDigit !== forDigit), saved],
          }));
          setOpenBranches((b) => ({ ...b, [forDigit]: true }));
        }
        setEditingDigit(null);
        flash(`Key ${digitGlyph(forDigit)} now opens “${name}”`);
      } else {
        setActiveId(created.id);
        flash(`“${name}” created`);
      }

      if (type === "after_hours") {
        const next = { ...(schedule ?? EMPTY_SCHEDULE), afterHoursProfileId: created.id };
        setSchedule(next);
        await apiPut(`/voice/ivr/schedule`, { ...next, tenantId });
      }
      setDirty(true);
    } catch (e: any) { setError(e?.message || "Couldn't create that menu"); } finally { setSaving(false); }
  }

  async function renameMenu(name: string) {
    if (!active) return;
    setNamingFor(null);
    await patchProfile({ name });
  }

  async function saveSchedule(next: ScheduleRow) {
    if (!tenantId) return;
    setSaving(true);
    try {
      await apiPut(`/voice/ivr/schedule`, { ...next, tenantId });
      setSchedule(next); setDirty(true); flash("Opening hours saved");
    } catch (e: any) { setError(e?.message || "Couldn't save the hours"); } finally { setSaving(false); }
  }

  /**
   * Turn the five answers into a working menu.
   *
   * Uses the same server-side builder the assistant uses, so a menu made by the
   * walkthrough and one made by the assistant are identical — there is no
   * second, lesser way to create a menu.
   */
  async function finishFirstRun(a: FirstRunAnswers) {
    if (!tenantId) return;
    setFirstRunBusy(true);
    try {
      const soleExt = people.length === 1 ? people[0].extension : "";
      const answerTarget = a.answerTarget || soleExt;
      const fallbackTarget = a.fallbackTarget || soleExt;

      const keys: Array<{ digit: string; kind: string; targetId?: string }> = [];
      if (answerTarget || a.answerKind === "hangup") {
        keys.push({ digit: "1", kind: a.answerKind, targetId: answerTarget });
      }

      const built = await apiPost<{ menus?: Array<{ id: string; name: string; type: string }> }>(
        `/voice/ivr/menus/build${qs}`,
        {
          tenantId,
          name: "Main menu",
          // "Ring straight away" means the caller should not sit through a menu
          // they were never offered — give the shortest wait the builder allows
          // and let the timeout exit below carry them to a person.
          timeoutSeconds: a.opening === "straight" ? 3 : 7,
          keys,
          ...(a.hours === "weekdays"
            ? {
                hours: {
                  timezone: schedule?.timezone || "America/New_York",
                  rules: [1, 2, 3, 4, 5].map((day) => ({ day, open: "09:00", close: "17:00" })),
                },
              }
            : {}),
        },
      );

      // The builder has no field for what happens when a caller presses
      // nothing, and "nothing" is what almost every caller does. Without this
      // the walkthrough's read-back would be a promise the menu doesn't keep:
      // it says the call reaches a person, or voicemail, and this is the part
      // that actually makes it true.
      //
      // It can fail to be written: buildDestination refuses when the PBX
      // tenant number is unknown (the extensions read is a soft-fail), and the
      // patch itself can error. Neither failure may be silent — a menu that
      // quietly drops no-input callers is exactly what commit 17d87774 fixed —
      // but neither is a reason to re-run the build, which would make a second
      // "Main menu". So the gap is surfaced instead of retried.
      let wiringGap = false;
      const mainProfile = (built?.menus ?? []).find((x) => x.type === "business_hours");
      if (mainProfile) {
        const onNoInput = a.opening === "straight"
          ? buildDestination(a.answerKind, answerTarget, directory)
          : a.fallbackKind === "hangup"
            ? buildDestination("hangup", "", directory)
            : buildDestination("voicemail", fallbackTarget, directory);
        if (onNoInput) {
          try {
            await apiPatch(`/voice/ivr/route-profiles/${mainProfile.id}${qs}`, {
              timeoutDestinationType: onNoInput.destinationType,
              timeoutDestinationRef: onNoInput.destinationRef,
            });
          } catch { wiringGap = true; }
        } else {
          wiringGap = true;
        }
      }

      await loadAll();
      setFirstRun(false);
      setFirstRunError(null);
      // The menu is a draft until Publish. The "Not published yet" pill is the
      // reminder that outlives the 3-second toast, and it only shows if dirty
      // is set here.
      setDirty(true);
      if (wiringGap) {
        setError(
          "Your menu is made, but one part couldn't be wired up: where the call goes when the caller presses nothing. " +
          "In the map below, find the “They press nothing” step and set it to a person or voicemail, then press Publish.",
        );
      } else {
        flash("Your phone menu is set up. Press Publish when you're happy with it.");
      }
    } catch (e: any) {
      // Build failure: keep the modal open with the answers intact. Right
      // after sign-up these three are usually just the PBX link catching up.
      const code = e?.body?.error;
      const notReady = code === "tenant_not_linked_to_pbx" || code === "pbx_helper_not_configured" ||
        code === "pbx_unreachable" || code === "pbx_tenant_not_found";
      setFirstRunError(notReady
        ? "Your phone system is still being set up — give it a minute, then press Try again."
        : (e?.body?.detail || e?.body?.message || e?.message || "Couldn't set that up — try again in a moment."));
    } finally { setFirstRunBusy(false); }
  }

  /**
   * The modal saved. A dated switch is BOOKED immediately (the scheduler keeps
   * the promise even if this browser tab never comes back); a "now" switch
   * waits for Publish, which is the moment routing is allowed to change. The
   * announcement is booked immediately either way — it isn't routing.
   */
  async function saveNumberChoice(plan: NumberPlan | null, announcement: AnnouncementPlan | null) {
    setNumberStepOpen(false);
    try {
      if (announcement) {
        await apiPost(`/voice/ivr/announcement${qs}`, {
          tenantId,
          promptRef: announcement.promptRef,
          startAt: announcement.startAt,
          endAt: announcement.endAt,
        });
        flash(announcement.startAt === "now" ? "Announcement is on." : "Announcement booked.");
      }
      if (!plan) {
        setNumberPlan(null);
        // Un-point every number that aims at this menu. Draft only — a number
        // already LIVE on Connect keeps ringing until someone publishes or
        // switches it elsewhere; silently going dark is never the right move.
        if (active) {
          const pointing = tenantNumbers.filter((n) => n.ivrProfileId === active.id);
          for (const n of pointing) {
            await apiPost(`/voice/ivr/numbers/${encodeURIComponent(n.mappingId)}/assign${qs}`, { profileId: null }).catch(() => null);
          }
        }
        await loadAll();
        return;
      }
      if (plan.when === "now") {
        // Assign as a draft now; the flip itself belongs to Publish.
        await apiPost(`/voice/ivr/numbers/${encodeURIComponent(plan.mappingId)}/assign${qs}`, { profileId: active?.id ?? null });
        setNumberPlan(plan);
        flash(`${fmtUs(plan.e164)} will switch to this menu when you publish.`);
      } else {
        await apiPost(`/voice/ivr/numbers/${encodeURIComponent(plan.mappingId)}/schedule${qs}`, {
          profileId: active?.id,
          activateAt: plan.when,
          endAt: plan.endAt,
        });
        setNumberPlan(null);
        flash(`${fmtUs(plan.e164)} is booked to switch to this menu.`);
      }
      await loadAll();
    } catch (e: any) {
      setError(e?.body?.detail || e?.body?.message || e?.message || "Couldn't save that.");
    }
  }

  async function cancelPendingSwitch(scheduleId: string) {
    try {
      await apiPost(`/voice/ivr/numbers/schedule/${encodeURIComponent(scheduleId)}/cancel${qs}`, {});
      flash("Booked switch canceled.");
      await loadAll();
    } catch (e: any) {
      setError(e?.body?.detail || e?.body?.message || e?.message || "Couldn't cancel that.");
    }
  }

  /**
   * Publish's message is "this is what callers hear from now on". Before
   * saying that, check it's true — anything that makes it a lie is put in
   * front of the person as a question, not left for a caller to discover.
   */
  function requestPublish() {
    if (!active) return;
    const warnings: string[] = [];

    const hasNumber = Boolean(numberPlan && numberPlan.when === "now")
      || tenantNumbers.some((n) => n.ivrProfileId === active.id && n.routingMode === "connect")
      || tenantNumbers.some((n) => n.pendingSwitch?.ivrProfileId === active.id);
    if (!hasNumber) {
      warnings.push(
        "No phone number points at this menu yet, so publishing won't change anything for callers. " +
        "You can publish now and connect a number later with “Change number” at the top of the map.",
      );
    }

    if (pendingTeamNumbers.length > 0) {
      const dests = [
        ...(optionsByProfile[active.id] ?? []),
        ...(active.timeoutDestinationType && active.timeoutDestinationRef
          ? [{ destinationType: active.timeoutDestinationType, destinationRef: active.timeoutDestinationRef }] : []),
        ...(active.invalidDestinationType && active.invalidDestinationRef
          ? [{ destinationType: active.invalidDestinationType, destinationRef: active.invalidDestinationRef }] : []),
      ];
      const pendingHit = new Set<string>();
      for (const d of dests) {
        const r = readDestination(d, directory);
        if (r.kind === "team" && r.targetId && pendingTeamNumbers.includes(r.targetId)) {
          pendingHit.add(r.name ?? `Team ${r.targetId}`);
        }
      }
      for (const name of pendingHit) {
        warnings.push(
          `“${name}” is brand new and doesn't take calls until changes are applied on the phone system. ` +
          "Callers sent there before that won't get through.",
        );
      }
    }

    if (warnings.length > 0) { setPublishWarnings(warnings); return; }
    void publish();
  }

  async function publish() {
    if (!active) return;
    // `saving` also disables the button, but guard here too: the warnings
    // dialog and the assistant deep-link can both call publish() directly.
    if (saving) return;
    setSaving(true);
    setError(null);
    setPublishBlocked(null);
    setPublished(null);
    try {
      const res = await apiPost<{ keysWritten?: number }>(
        `/voice/ivr/publish${qs}`, { tenantId, profileId: active.id });
      const keysWritten = Number(res?.keysWritten ?? 0);
      // The held "switch right now" plan executes here — Publish is the one
      // moment routing is allowed to change, so this is where the inbound
      // route flips to the menu's custom context.
      if (numberPlan && numberPlan.when === "now") {
        const e164 = numberPlan.e164;
        try {
          await apiPost(`/voice/did/${encodeURIComponent(numberPlan.mappingId)}/switch-to-connect${qs}`, {});
          setNumberPlan(null);
          setDirty(false);
          setPublished({ at: new Date(), keysWritten, switched: e164, pointed: true });
        } catch (e: any) {
          const detail = e?.body?.detail || e?.body?.error || e?.message || "";
          setError(
            `The menu is published, but ${fmtUs(e164)} could NOT be switched — callers still get the old routing. ` +
            `Open “Change number”, pick it again, and publish to retry.` + (detail ? ` (Technical detail: ${detail})` : ""),
          );
        }
        await loadAll();
        return;
      }
      setDirty(false);
      // Only claim callers hear it if a number actually rings this menu.
      const pointed = tenantNumbers.some((n) => n.ivrProfileId === active.id && n.routingMode === "connect");
      setPublished({ at: new Date(), keysWritten, switched: null, pointed });
    } catch (e: any) {
      // ApiError carries the parsed JSON body on `.body`. Reading `.payload`
      // (which never exists) is what collapsed every 422 down to the bare
      // error slug, hiding the `detail` and `missing` list the API sends.
      const body = (e?.body ?? null) as
        | { error?: string; detail?: string; missing?: Array<{ key: string; ref: string; profileType?: string | null }> }
        | null;
      const missing = Array.isArray(body?.missing) ? body!.missing! : [];
      const detail = String(body?.detail ?? "").trim()
        || PUBLISH_ERROR_TEXT[String(body?.error ?? "").trim()]
        || "";
      if (detail || missing.length > 0) setPublishBlocked({ detail: detail || "Couldn't publish.", missing });
      else setError(e?.message || "Couldn't publish");
    } finally { setSaving(false); }
  }

  const greetingRow = prompts.find((p) => p.promptRef === active?.pbxPromptRef);
  const assignedDigits = DIGITS.filter((d) => optionByDigit.has(d));
  const freeDigits = DIGITS.filter((d) => !optionByDigit.has(d));

  return (
    <div className="ivrs">
      <StudioStyles />

      <div className="topbar">
        <div className="crumbs">{t("Phone menus")}<span>›</span><b>{tenant?.name ?? "—"}</b></div>
        <div className="spacer" />
        {dirty && <span className="pill warn"><i />{t("Not published yet")}</span>}
        <LanguageToggle />
        <button className="btn primary" disabled={!canPublish || saving || !active} onClick={requestPublish}>
          {saving
            ? t("Publishing…")
            : numberPlan && numberPlan.when === "now"
              ? `${t("Publish and switch")} ${fmtUs(numberPlan.e164)}`
              : t("Publish")}
        </button>
      </div>

      {fromAssistant && (
        <div className="banner assistant">
          <span className="ai">AI</span>
          <div>
            <b>Your assistant set this up for you.</b>
            <p>Nothing has changed for callers yet. Read through it below — if it looks right, press Publish.</p>
          </div>
        </div>
      )}

      <div className="titlerow">
        <div>
          <div className="eyebrow">{t("IVR Studio")}</div>
          <div className="menupick">
            <select className="menusel" value={activeId ?? ""} onChange={(e) => { setEditingDigit(null); setActiveId(e.target.value || null); }}>
              {profiles.length === 0 && <option value="">No menus yet</option>}
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}{p.type === "after_hours" ? " · after hours" : ""}</option>)}
            </select>
            {active && <button className="btn ghost sm" disabled={!canManage} onClick={() => setNamingFor({ mode: "rename" })}>{t("Rename")}</button>}
            <button className="btn ghost sm" disabled={!canManage} onClick={() => setNamingFor({ mode: "create", forDigit: null })}>+ New menu</button>
          </div>
        </div>
      </div>

      {error && <div className="banner err">{error}<button onClick={() => setError(null)} aria-label="Dismiss">×</button></div>}

      {/* Stays up until the next edit (any change sets `dirty`), so the answer
          to "did that work?" is on screen rather than gone in 3 seconds. */}
      {published && !dirty && (
        <div className="banner ok" role="status">
          <div className="btxt">
            <b>{t("Published — live for callers now")}</b>
            <p>
              {published.switched
                ? `${fmtUs(published.switched)} now rings this menu.`
                : published.pointed
                  ? t("This is what callers hear from now on.")
                  : t("Callers will hear it once a phone number points at this menu.")}
              {published.keysWritten > 0 && ` ${published.keysWritten} setting${published.keysWritten === 1 ? "" : "s"} written`}
              {` at ${published.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`}
            </p>
          </div>
          <button onClick={() => setPublished(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {publishBlocked && (
        <div className="banner err" role="alert">
          <div className="btxt">
            <b>{t("Not published — nothing changed for callers")}</b>
            <p>{publishBlocked.detail}</p>
            {publishBlocked.missing.length > 0 && (
              <>
                <p>{t("These recordings aren't on the phone system yet:")}</p>
                <ul className="misslist">
                  {publishBlocked.missing.map((m, i) => (
                    <li key={`${m.key}-${m.ref}-${i}`}>
                      <b>{m.ref}</b> — {describeMissingSpot(m.key, m.profileType)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <button onClick={() => setPublishBlocked(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {loading && <div className="banner">Loading…</div>}

      {!loading && profiles.length === 0 && (
        <div className="empty">
          <div className="eglyph">☎️</div>
          <h2>{t("No phone menu yet")}</h2>
          <p>A phone menu is the recorded message callers hear — “press 1 for sales, press 2 for accounts”. Make your first one and set up what each key does.</p>
          <button className="btn primary big" disabled={!canManage} onClick={() => setNamingFor({ mode: "create", forDigit: null })}>{t("Create my first menu")}</button>
        </div>
      )}

      {!loading && active && (
        <div className="grid">
          <div>
            {/* ── the map ── */}
            <div className="card">
              <div className="card-h">
                <div><h2>{t("What happens on a call")}</h2><div className="sub">Read it top to bottom — this is exactly what a caller goes through</div></div>
              </div>
              <div className="card-b">
                <div className="flow">
                  {(() => {
                    const mine = tenantNumbers.filter((n) => n.ivrProfileId === active.id && n.routingMode === "connect");
                    const booked = tenantNumbers.find((n) => n.pendingSwitch?.ivrProfileId === active.id);
                    const title = numberPlan
                      ? `Someone calls ${fmtUs(numberPlan.e164)}`
                      : mine.length
                        ? `Someone calls ${mine.map((n) => fmtUs(n.e164)).join(" or ")}`
                        : booked
                          ? `Someone calls ${fmtUs(booked.e164)}`
                          : "Someone calls in";
                    const sub = numberPlan
                      ? "Switches to this menu when you publish"
                      : mine.length
                        ? "Your phone number"
                        : booked
                          ? "Booked to switch to this menu"
                          : "No phone number — reached from another menu";
                    return (
                      <>
                        <Step glyph="☎️"
                          title={title}
                          sub={numbersError ?? sub}
                          actions={
                            <button className="btn sm" disabled={!canManage} onClick={() => setNumberStepOpen(true)}>
                              {t("Change number")}
                            </button>
                          } />
                        {booked?.pendingSwitch && (
                          <div className="switchbanner">
                            <span aria-hidden>⏰</span>
                            <span className="sb-txt">
                              {t("Switches over")} {new Date(booked.pendingSwitch.activateAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                              {booked.pendingSwitch.endAt
                                ? ` · ${t("ends")} ${new Date(booked.pendingSwitch.endAt).toLocaleDateString([], { month: "short", day: "numeric" })}`
                                : ""}
                            </span>
                            {canPublish && (
                              <button className="btn sm" onClick={() => cancelPendingSwitch(booked.pendingSwitch!.id)}>
                                {t("Cancel switch")}
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    );
                  })()}

                  <Step glyph="♪"
                    title={greetingRow ? `They hear “${greetingRow.displayName}”` : "They hear your greeting"}
                    sub={greetingRow ? "Your recording" : "No recording set — callers hear a stand-in message"}
                    actions={
                      <>
                        <button className="btn sm" onClick={() => play(active.pbxPromptRef)}>{t("Play")}</button>
                        <button className="btn sm" disabled={!canManage} onClick={() => setRecPickerOpen(!recPickerOpen)}>{t("Change")}</button>
                        <button className="btn sm" disabled={!canManage} onClick={() => setMakeRecOpen(true)}>{t("Make one")}</button>
                      </>
                    } />

                  {recPickerOpen && (
                    <div className="reclist">
                      {prompts.length === 0 && (
                        <div className="dimtxt">
                          {t("No recordings yet for this customer.")}{" "}
                          <button className="linkbtn" onClick={() => { setRecPickerOpen(false); setMakeRecOpen(true); }}>
                            {t("Make one now")}
                          </button>
                        </div>
                      )}
                      {prompts.map((r) => (
                        <button key={r.id} className={"recrow" + (active.pbxPromptRef === r.promptRef ? " on" : "")}
                          onClick={() => { patchProfile({ pbxPromptRef: r.promptRef }); setRecPickerOpen(false); }}>
                          <span className="p" onClick={(e) => { e.stopPropagation(); play(r.promptRef); }}>▶</span>
                          <span className="nm">{r.displayName}</span>
                          {active.pbxPromptRef === r.promptRef && <span className="cur">current</span>}
                        </button>
                      ))}
                    </div>
                  )}

                  {assignedDigits.map((digit) => {
                    const o = optionByDigit.get(digit)!;
                    const read = readDestination(o, directory);
                    const branchOpen = !!openBranches[digit];
                    const branchMenu = read.kind === "menu" && read.targetId ? profiles.find((p) => p.id === read.targetId) : null;
                    const branchKeys = branchMenu ? (optionsByProfile[branchMenu.id] ?? []) : [];
                    return (
                      <div key={digit}>
                        <Step
                          digit={digitGlyph(digit)}
                          title={read.name ?? KIND_LABEL[read.kind]}
                          sub={describeDestination(o, directory)}
                          kind={read.kind}
                          warn={!read.known && read.kind !== "hangup" && read.kind !== "other"}
                          onClick={canManage ? () => setEditingDigit(editingDigit === digit ? null : digit) : undefined}
                          actions={branchMenu ? (
                            <button className="btn sm" onClick={(e) => { e.stopPropagation(); setOpenBranches((b) => ({ ...b, [digit]: !branchOpen })); }}>
                              {branchOpen ? "Hide" : `Show its ${branchKeys.length} key${branchKeys.length === 1 ? "" : "s"}`}
                            </button>
                          ) : undefined}
                        />

                        {branchMenu && branchOpen && (
                          <div className="branch">
                            <div className="bhead">Inside “{branchMenu.name}”</div>
                            {branchKeys.length === 0 && <div className="dimtxt">{t("This menu has no keys set up yet.")}</div>}
                            {branchKeys
                              .slice()
                              .sort((a, b) => DIGITS.indexOf(a.optionDigit) - DIGITS.indexOf(b.optionDigit))
                              .map((bo) => {
                                const br = readDestination(bo, directory);
                                return (
                                  <div key={bo.id} className="bkey">
                                    <span className="d">{digitGlyph(bo.optionDigit)}</span>
                                    <span className="t">{br.name ?? KIND_LABEL[br.kind]}</span>
                                    <span className={`tag ${br.kind}`}>{t(KIND_LABEL[br.kind])}</span>
                                  </div>
                                );
                              })}
                            <button className="btn sm" onClick={() => { setActiveId(branchMenu.id); setEditingDigit(null); }}>
                              Open “{branchMenu.name}” to edit it
                            </button>
                          </div>
                        )}

                        {editingDigit === digit && (
                          <KeyEditor
                            digit={digit}
                            current={o}
                            directory={directory}
                            peopleLoaded={peopleLoaded}
                            teamsLoaded={teamsLoaded}
                            pendingTeamNumbers={pendingTeamNumbers}
                            disabled={saving}
                            onSave={(kind, target, after) => saveKey(digit, kind, target, after)}
                            onClear={() => clearKey(digit)}
                            onClose={() => setEditingDigit(null)}
                            onCreateMenu={() => setNamingFor({ mode: "create", forDigit: digit })}
                            onMakeRecording={() => { setMakeRecForKey(digit); setMakeRecOpen(true); }}
                            onUploadRecording={(file) => uploadRecordingForKey(digit, file)}
                            adoptPromptRef={adoptRecording?.digit === digit ? adoptRecording.promptRef : null}
                            onAdopted={() => setAdoptRecording(null)}
                            onCreateForward={createForward}
                            onMakeTeam={() => { setMakeTeamForKey(digit); setMakeTeamOpen(true); }}
                            adoptTeamNumber={adoptTeam?.digit === digit ? adoptTeam.number : null}
                            onAdoptedTeam={() => setAdoptTeam(null)}
                          />
                        )}
                      </div>
                    );
                  })}

                  {/* add-a-key */}
                  {canManage && freeDigits.length > 0 && (
                    <>
                      <Step add
                        title={t("Add another key")}
                        sub={`${freeDigits.length} key${freeDigits.length === 1 ? "" : "s"} still free`}
                        onClick={() => setEditingDigit(editingDigit === "__new" ? null : "__new")} />
                      {editingDigit === "__new" && (
                        <div className="editor">
                          <div className="editor-h"><b>{t("Which key should the caller press?")}</b></div>
                          <div className="editor-b">
                            <div className="digitgrid">
                              {freeDigits.map((d) => (
                                <button key={d} className="digitbtn" onClick={() => setEditingDigit(d)}>{digitGlyph(d)}</button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                      {editingDigit && editingDigit !== "__new" && !optionByDigit.has(editingDigit) && (
                        <KeyEditor
                          digit={editingDigit}
                          current={null}
                          directory={directory}
                          peopleLoaded={peopleLoaded}
                          teamsLoaded={teamsLoaded}
                          pendingTeamNumbers={pendingTeamNumbers}
                          disabled={saving}
                          onSave={(kind, target, after) => saveKey(editingDigit, kind, target, after)}
                          onClear={() => setEditingDigit(null)}
                          onClose={() => setEditingDigit(null)}
                          onCreateMenu={() => setNamingFor({ mode: "create", forDigit: editingDigit })}
                          onMakeRecording={() => { setMakeRecForKey(editingDigit); setMakeRecOpen(true); }}
                          onUploadRecording={(file) => uploadRecordingForKey(editingDigit, file)}
                          adoptPromptRef={adoptRecording?.digit === editingDigit ? adoptRecording.promptRef : null}
                          onAdopted={() => setAdoptRecording(null)}
                          onCreateForward={createForward}
                          onMakeTeam={() => { setMakeTeamForKey(editingDigit); setMakeTeamOpen(true); }}
                          adoptTeamNumber={adoptTeam?.digit === editingDigit ? adoptTeam.number : null}
                          onAdoptedTeam={() => setAdoptTeam(null)}
                        />
                      )}
                    </>
                  )}

                  <Step glyph="⏱" muted
                    title={`They press nothing for ${active.timeoutSeconds || 7} seconds`}
                    sub={active.timeoutDestinationRef
                      ? `We send them to ${describeDestination({ destinationType: active.timeoutDestinationType || "", destinationRef: active.timeoutDestinationRef }, directory)}`
                      : "We replay the menu, then the call ends"} />

                  <Step glyph="⚠️" muted last
                    title={t("They press a key you haven't set up")}
                    sub={active.invalidDestinationRef
                      ? `After a few tries we send them to ${describeDestination({ destinationType: active.invalidDestinationType || "", destinationRef: active.invalidDestinationRef }, directory)}`
                      : "We tell them it wasn't valid and replay the menu"} />
                </div>
              </div>
            </div>

            <HoursCard
              schedule={schedule}
              profiles={profiles}
              disabled={!canManage || saving}
              onSave={saveSchedule}
              onCreateAfterHours={() => setNamingFor({ mode: "create", forDigit: null })}
            />
          </div>

          {/* ── side: the script + recordings ── */}
          <div className="sticky">
            <div className="card">
              <div className="card-h">
                <div><h2>{t("Explain it to me")}</h2><div className="sub">{t("The whole call, in plain words")}</div></div>
                <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setShowScript(!showScript)}>
                  {showScript ? "Hide" : "Read it"}
                </button>
              </div>
              {showScript && (
                <div className="card-b">
                  <ol className="script">
                    {callSteps.map((s, i) => <li key={i}>{s.detail}</li>)}
                  </ol>
                  <p className="dimtxt" style={{ marginTop: 12 }}>
                    Your assistant reads this same explanation — ask it anything about the call and it&apos;ll answer from here.
                  </p>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-h">
                <div><h2>{t("Teams")}</h2><div className="sub">{directory.teams.length} set up</div></div>
                <button className="btn sm" disabled={!canManage} onClick={() => setMakeTeamOpen(true)}>{t("New team")}</button>
              </div>
              <div className="card-b">
                <div className="reclist flat">
                  {directory.teams.length === 0 && (
                    <div className="dimtxt">
                      {t("No teams yet - a team is several phones ringing instead of one.")}
                    </div>
                  )}
                  {directory.teams.map((tm) => (
                    <div key={tm.number} className="recrow" style={{ cursor: "default" }}>
                      <span className="p">{tm.kind === "queue" ? "⏳" : "\u{1f4f3}"}</span>
                      <span className="nm">{tm.name || `Team ${tm.number}`}</span>
                      {pendingTeamNumbers.includes(tm.number) && <span className="tag voicemail">{t("not live yet")}</span>}
                      <span className="cur">{tm.number}</span>
                    </div>
                  ))}
                  {directory.teams.some((tm) => pendingTeamNumbers.includes(tm.number)) && (
                    <div className="dimtxt">
                      {t("Teams marked “not live yet” start taking calls the next time changes are applied to the phone system.")}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-h"><div><h2>{t("Recordings")}</h2><div className="sub">{prompts.length} available</div></div></div>
              <div className="card-b">
                <div className="reclist flat">
                  {prompts.length === 0 && <div className="dimtxt">{t("No recordings yet.")}</div>}
                  {prompts.map((r) => (
                    <button key={r.id} className="recrow" onClick={() => play(r.promptRef)}>
                      <span className="p">▶</span><span className="nm">{r.displayName}</span>
                      {r.hasAudio === false && <span className="cur">no audio</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {publishWarnings && (
        <div className="backdrop" onClick={() => setPublishWarnings(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Before you publish</h3>
            {publishWarnings.map((w, i) => (
              <p key={i} className="dimtxt" style={{ margin: "10px 0 0", fontSize: 13.5, lineHeight: 1.6 }}>{w}</p>
            ))}
            <div className="foot">
              <button className="btn ghost" onClick={() => setPublishWarnings(null)}>{t("Cancel")}</button>
              <button className="btn primary" onClick={() => { setPublishWarnings(null); void publish(); }}>Publish anyway</button>
            </div>
          </div>
        </div>
      )}

      {namingFor && (
        <NameDialog
          mode={namingFor.mode}
          initial={namingFor.mode === "rename" ? (active?.name ?? "") : (namingFor.forDigit ? "" : "New menu")}
          forDigit={namingFor.mode === "create" ? namingFor.forDigit : null}
          busy={saving}
          onCancel={() => setNamingFor(null)}
          onSubmit={(name, type) => namingFor.mode === "rename" ? renameMenu(name) : createMenu(name, type, namingFor.forDigit)}
        />
      )}

      {numberStepOpen && active && (
        <NumberStep
          numbers={tenantNumbers}
          loading={loading}
          loadError={numbersError}
          currentProfileId={active.id}
          recordings={prompts.map((r) => ({ promptRef: r.promptRef, displayName: r.displayName }))}
          onSave={saveNumberChoice}
          onClose={() => setNumberStepOpen(false)}
        />
      )}

      {makeTeamOpen && (
        <MakeTeam
          people={directory.people}
          tenantQs={qs}
          apiBase={getPortalApiBaseUrl()}
          authToken={(typeof window !== "undefined" && (localStorage.getItem("token") || localStorage.getItem("cc-token"))) || ""}
          onCreated={async (team, message) => {
            // The create response said live:false — remember it so the badge
            // and the publish warning can say so long after this toast fades.
            setPendingTeamNumbers((p) => (p.includes(team.number) ? p : [...p, team.number]));
            await loadAll();
            setMakeTeamOpen(false);
            if (makeTeamForKey) {
              // Made from a key editor: point that key at the new team and
              // leave the editor open, so the person still presses Save.
              setAdoptTeam({ digit: makeTeamForKey, number: team.number });
              setMakeTeamForKey(null);
            }
            flash(message);
          }}
          onClose={() => { setMakeTeamOpen(false); setMakeTeamForKey(null); }}
        />
      )}

      {makeRecOpen && (
        <MakeRecording
          tenantQs={qs}
          apiBase={getPortalApiBaseUrl()}
          authToken={(typeof window !== "undefined" && (localStorage.getItem("token") || localStorage.getItem("cc-token"))) || ""}
          onCreated={async (prompt) => {
            // Splice the one new row in rather than reloading everything —
            // Play and the picker need it now, and nothing else changed.
            setPrompts((ps) => [
              ...ps.filter((p) => p.id !== prompt.id),
              { id: prompt.id, promptRef: prompt.promptRef, displayName: prompt.displayName, category: prompt.category, hasAudio: true },
            ]);
            if (makeRecForKey) {
              // Opened from a key editor: the recording belongs to that key,
              // not to the menu greeting. The editor adopts it and stays open
              // so "afterwards" can still be chosen before saving.
              setAdoptRecording({ digit: makeRecForKey, promptRef: prompt.promptRef });
              setMakeRecForKey(null);
              setMakeRecOpen(false);
              flash(`“${prompt.displayName}” is ready — save the key when you're done.`);
              return;
            }
            // Point the menu at what was just made — nobody generates a
            // greeting and then wants to go and select it separately.
            await patchProfile({ pbxPromptRef: prompt.promptRef });
            setMakeRecOpen(false);
            flash(`“${prompt.displayName}” is now your greeting.`);
          }}
          onClose={() => { setMakeRecOpen(false); setMakeRecForKey(null); }}
        />
      )}

      {firstRun && (
        <FirstRunSetup
          directory={directory}
          phoneNumber={dids[0] ?? null}
          busy={firstRunBusy}
          errorText={firstRunError}
          onRefresh={loadAll}
          onFinish={finishFirstRun}
          onSkip={() => { setFirstRun(false); setFirstRunError(null); }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ── one row of the map ───────────────────────────────────────────────────────
function Step({ digit, glyph, title, sub, kind, actions, onClick, muted, add, last, warn }: {
  digit?: string; glyph?: string; title: string; sub: string; kind?: MenuChoiceKind;
  actions?: React.ReactNode; onClick?: () => void; muted?: boolean; add?: boolean; last?: boolean; warn?: boolean;
}) {
  const { t } = useUiLanguage();
  const Tag: any = onClick ? "button" : "div";
  return (
    <div className="steprow">
      <div className="rail">
        <div className={"knob" + (muted ? " muted" : "") + (add ? " add" : "")}>{digit ?? glyph ?? "+"}</div>
        {!last && <div className="line" />}
      </div>
      <Tag className={"stepcard" + (onClick ? " tappable" : "") + (add ? " add" : "") + (warn ? " warn" : "")} onClick={onClick} type={onClick ? "button" : undefined}>
        <div className="txt">
          <b>{title}</b>
          <span>{sub}</span>
        </div>
        {kind && <span className={`tag ${kind}`}>{KIND_LABEL[kind]}</span>}
        {actions && <div className="acts">{actions}</div>}
      </Tag>
    </div>
  );
}

// ── the four choices ─────────────────────────────────────────────────────────
function KeyEditor({ digit, current, directory, peopleLoaded, teamsLoaded, pendingTeamNumbers, disabled, onSave, onClear, onClose, onCreateMenu, onMakeRecording, onUploadRecording, adoptPromptRef, onAdopted, onCreateForward, onMakeTeam, adoptTeamNumber, onAdoptedTeam }: {
  digit: string;
  current: OptionRow | null;
  directory: TenantDirectory;
  peopleLoaded: boolean;
  teamsLoaded: boolean;
  /** Teams that exist but don't take calls until PBX changes are applied. */
  pendingTeamNumbers?: string[];
  disabled?: boolean;
  onSave: (kind: MenuChoiceKind, targetId: string, after?: AfterRecordingChoice) => void;
  onClear: () => void;
  onClose: () => void;
  onCreateMenu: () => void;
  /** Open the ElevenLabs modal for THIS key; the result comes back via adoptPromptRef. */
  onMakeRecording?: () => void;
  /** Upload a file for THIS key; resolves with the new promptRef or null on failure. */
  onUploadRecording?: (file: File) => Promise<string | null>;
  /** A recording just made/uploaded for this key — select it. */
  adoptPromptRef?: string | null;
  onAdopted?: () => void;
  /** Teach the phone system a new outside number; resolves with the internal
   *  number to point this key at, or null if it couldn't be set up. */
  onCreateForward?: (phoneNumber: string, label: string) => Promise<string | null>;
  /** Open the team builder for THIS key; the result arrives via adoptTeamNumber. */
  onMakeTeam?: () => void;
  adoptTeamNumber?: string | null;
  onAdoptedTeam?: () => void;
}) {
  const { t } = useUiLanguage();
  const read = current ? readDestination(current, directory) : null;
  const [kind, setKind] = useState<MenuChoiceKind>(read && read.kind !== "other" ? read.kind : "person");
  const [target, setTarget] = useState<string>(read?.targetId ?? "");
  // Recording keys: what happens after the recording finishes. Initialised
  // from the saved key so reopening the editor shows the truth, not the default.
  const savedAfter = ((): { kind: "replay" | "voicemail" | "hangup"; ext: string } => {
    if (read?.kind !== "recording" || !current?.afterDestinationType || !current?.afterDestinationRef) {
      return { kind: "replay", ext: "" };
    }
    const a = readDestination({ destinationType: current.afterDestinationType, destinationRef: current.afterDestinationRef }, directory);
    if (a.kind === "voicemail" && a.targetId) return { kind: "voicemail", ext: a.targetId };
    if (a.kind === "hangup") return { kind: "hangup", ext: "" };
    return { kind: "replay", ext: "" };
  })();
  const [afterKind, setAfterKind] = useState<"replay" | "voicemail" | "hangup">(savedAfter.kind);
  const [afterExt, setAfterExt] = useState<string>(savedAfter.ext);
  const [uploading, setUploading] = useState(false);
  /** Typing a brand-new outside number to forward to. */
  const [newPhone, setNewPhone] = useState("");
  const [addingPhone, setAddingPhone] = useState(false);

  // A recording made or uploaded for this key while the editor was open:
  // select it, but leave "afterwards" and Save to the person — the recording
  // existing is not the same as the key being wired.
  useEffect(() => {
    if (adoptPromptRef) {
      setKind("recording");
      setTarget(adoptPromptRef);
      onAdopted?.();
    }
  }, [adoptPromptRef, onAdopted]);

  // A team just made for this key — select it, but leave Save to the person.
  useEffect(() => {
    if (adoptTeamNumber) {
      setKind("team");
      setTarget(adoptTeamNumber);
      onAdoptedTeam?.();
    }
  }, [adoptTeamNumber, onAdoptedTeam]);

  /**
   * EVERY choice is always shown. Two states only:
   *   offered   — pick a target
   *   blocked   — shown, greyed, with the reason why it can't be used yet
   *
   * It used to have a third state, hidden, for "this customer genuinely has
   * none". That was wrong and it looked like a bug: a brand-new tenant with no
   * extensions and no teams yet saw THREE of the seven choices simply vanish —
   * "A person", "Voicemail" and "A team" — with nothing to explain where they
   * went. A menu builder that hides the most ordinary choice on a phone system
   * reads as broken, not as helpful. Say why instead of disappearing.
   */
  const shown = OFFERABLE_KINDS.map((k) => {
    if (k === "person" || k === "voicemail") {
      if (!peopleLoaded) return { k, blocked: "Couldn't load this customer's extensions — refresh and try again." };
      if (directory.people.length === 0) {
        return { k, blocked: "No phones on this account yet. Add extensions to the phone system, then come back." };
      }
      return { k, blocked: null };
    }
    if (k === "team") {
      if (!teamsLoaded) return { k, blocked: "Couldn't load this customer's teams — check they're linked to the phone system." };
      // Having no team is NOT a blocker: picking this offers to make one right
      // here. It only becomes impossible with no phones to put in it.
      if (directory.teams.length === 0 && directory.people.length === 0) {
        return { k, blocked: "Add phones to this account first — a team is several of them ringing at once." };
      }
      return { k, blocked: null };
    }
    // Recordings and phone numbers can be made right here, so having none is a
    // starting point rather than a dead end.
    return { k, blocked: null };
  }) as Array<{ k: MenuChoiceKind; blocked: string | null }>;

  const blockedReason = shown.find((s) => s.k === kind)?.blocked ?? null;

  const targets: Array<{ id: string; name: string; meta: string }> =
    kind === "person" || kind === "voicemail"
      ? directory.people.map((p) => ({ id: p.extension, name: p.name || `Extension ${p.extension}`, meta: p.extension }))
      : kind === "team"
        ? directory.teams.map((t) => ({
            id: t.number,
            name: t.name || `Team ${t.number}`,
            meta: pendingTeamNumbers?.includes(t.number) ? "not live yet" : t.kind === "queue" ? "queue" : "rings together",
          }))
        : kind === "recording"
          ? (directory.recordings ?? []).map((r) => ({ id: r.promptRef, name: r.name || r.promptRef, meta: "recording" }))
        : kind === "forward"
          ? (directory.forwards ?? []).map((f) => ({
              id: f.extension,
              name: f.name?.trim() || formatPhone(f.phoneNumber),
              meta: "rings outside",
            }))
          : kind === "menu"
            ? directory.menus.map((m) => ({ id: m.id, name: m.name, meta: "menu" }))
            : [];

  const after: AfterRecordingChoice | undefined = kind === "recording"
    ? (afterKind === "voicemail" ? { kind: "voicemail", extension: afterExt } : { kind: afterKind })
    : undefined;
  const preview = target || kind === "hangup" ? buildDestination(kind, target, directory, after) : null;
  const canSave = blockedReason ? false : kind === "hangup" ? true : Boolean(preview);

  return (
    <div className="editor">
      <div className="editor-h">
        <span className="kb">{digitGlyph(digit)}</span>
        <b>When a caller presses {digitGlyph(digit)}</b>
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="editor-b">
        <div className="choices">
          {shown.map(({ k, blocked }) => (
            <button key={k} className={"choice" + (kind === k ? " on" : "") + (blocked ? " blocked" : "")}
              onClick={() => { setKind(k); setTarget(""); }}>
              <span className="glyph">{KIND_GLYPH[k]}</span>
              <b>{t(KIND_LABEL[k])}</b>
              <span>{blocked ?? t(KIND_BLURB[k])}</span>
            </button>
          ))}
        </div>

        {blockedReason && <div className="blocknote">{blockedReason}</div>}

        {!blockedReason && kind !== "hangup" && (
          <div className="picker">
            <div className="plabel">
              {t(kind === "person" ? "Which person?" : kind === "voicemail" ? "Whose voicemail?" : kind === "team" ? "Which team?" : kind === "recording" ? "Which recording?" : kind === "forward" ? "Which phone number?" : "Which menu?")}
            </div>
            {targets.length === 0 ? (
              <div className="dimtxt">{t("Nothing to choose yet.")}</div>
            ) : (
              <div className="targets">
                {targets.map((t) => (
                  <button key={t.id} className={"target" + (target === t.id ? " on" : "")} onClick={() => setTarget(t.id)}>
                    <span className="av" style={{ background: avatarColor(t.name) }}>{initials(t.name)}</span>
                    <span className="nm"><b>{t.name}</b><span>{t.meta}</span></span>
                  </button>
                ))}
              </div>
            )}
            {kind === "menu" && (
              <button className="btn sm" style={{ marginTop: 10 }} onClick={onCreateMenu}>+ Make a new menu for this key</button>
            )}

            {kind === "team" && onMakeTeam && (
              <div className="recmakerow">
                <span className="dimtxt">
                  {directory.teams.length === 0 ? t("No teams yet — make the first one:") : t("Or make a new one:")}
                </span>
                <button className="btn sm" disabled={disabled} onClick={onMakeTeam}>
                  {t("Make a team")}
                </button>
              </div>
            )}

            {kind === "forward" && onCreateForward && (
              <div className="recmakerow">
                <span className="dimtxt">{t("Or send it to a new number:")}</span>
                <input
                  className="inp"
                  style={{ maxWidth: 190 }}
                  placeholder="(845) 555-1234"
                  value={newPhone}
                  disabled={addingPhone || disabled}
                  onChange={(e) => setNewPhone(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                />
                <button
                  className="btn sm"
                  disabled={addingPhone || disabled || newPhone.replace(/\D/g, "").length < 10}
                  onClick={async () => {
                    setAddingPhone(true);
                    try {
                      // The label is only ever seen in the PBX panel; naming it
                      // after the key is what makes a forward findable later.
                      const ext = await onCreateForward(newPhone, `Key ${digitGlyph(digit)}`);
                      if (ext) { setTarget(ext); setNewPhone(""); }
                    } finally { setAddingPhone(false); }
                  }}
                >
                  {addingPhone ? t("Setting it up…") : t("Add this number")}
                </button>
              </div>
            )}

            {kind === "recording" && (
              <div className="recmakerow">
                <span className="dimtxt">{t("Or add a new one:")}</span>
                {onUploadRecording && (
                  <label className={"btn sm" + (uploading || disabled ? " disabled" : "")}>
                    {uploading ? t("Uploading…") : t("Upload a recording")}
                    <input
                      type="file"
                      accept="audio/*,.wav,.mp3,.m4a,.ogg"
                      style={{ display: "none" }}
                      disabled={uploading || disabled}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        setUploading(true);
                        try { await onUploadRecording(file); } finally { setUploading(false); }
                      }}
                    />
                  </label>
                )}
                {onMakeRecording && (
                  <button className="btn sm" disabled={disabled} onClick={onMakeRecording}>{t("Make one with AI")}</button>
                )}
              </div>
            )}

            {kind === "recording" && (
              <div className="afterbox">
                <div className="plabel">{t("After it plays, what happens?")}</div>
                <div className="afterrow">
                  {([
                    { k: "replay" as const, label: t("Back to this menu") },
                    { k: "voicemail" as const, label: t("A voicemail") },
                    { k: "hangup" as const, label: t("Hang up") },
                  ]).map((c) => (
                    <button key={c.k} className={"afterbtn" + (afterKind === c.k ? " on" : "")}
                      onClick={() => { setAfterKind(c.k); if (c.k !== "voicemail") setAfterExt(""); }}>
                      {c.label}
                    </button>
                  ))}
                </div>
                {afterKind === "voicemail" && (
                  <div className="targets" style={{ marginTop: 8 }}>
                    {directory.people.map((p) => {
                      const nm = p.name || `Extension ${p.extension}`;
                      return (
                        <button key={p.extension} className={"target" + (afterExt === p.extension ? " on" : "")} onClick={() => setAfterExt(p.extension)}>
                          <span className="av" style={{ background: avatarColor(nm) }}>{initials(nm)}</span>
                          <span className="nm"><b>{nm}</b><span>{p.extension}</span></span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* the safety net: read the choice back before it's saved */}
        <div className={"readback" + (canSave ? "" : " idle")}>
          {canSave
            ? kind === "hangup"
              ? <>When a caller presses <span className="k">{digitGlyph(digit)}</span> the call ends politely.</>
              : kind === "recording"
                ? <>When a caller presses <span className="k">{digitGlyph(digit)}</span> we play <b>{preview?.label}</b>, {preview ? describeAfterRecording(preview, directory) : ""}.</>
                : <>When a caller presses <span className="k">{digitGlyph(digit)}</span> they&apos;ll reach <b>{preview?.label}</b>.</>
            : blockedReason
              ? <>{blockedReason}</>
              : kind === "recording" && target && afterKind === "voicemail" && !afterExt
                ? <>Choose whose voicemail the caller lands in after the recording.</>
                : <>Choose where key {digitGlyph(digit)} should send the caller.</>}
        </div>

        <div className="foot">
          {current && <button className="btn ghost" disabled={disabled} onClick={onClear}>Remove this key</button>}
          <button className="btn primary" disabled={disabled || !canSave} onClick={() => onSave(kind, target, after)}>
            Save key {digitGlyph(digit)}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── naming a menu ────────────────────────────────────────────────────────────
function NameDialog({ mode, initial, forDigit, busy, onCancel, onSubmit }: {
  mode: "create" | "rename"; initial: string; forDigit: string | null; busy?: boolean;
  onCancel: () => void; onSubmit: (name: string, type: "business_hours" | "after_hours") => void;
}) {
  const { t } = useUiLanguage();
  const [name, setName] = useState(initial);
  const [afterHours, setAfterHours] = useState(false);
  const ok = name.trim().length > 0;
  return (
    <div className="backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === "rename" ? "Rename this menu" : forDigit ? `New menu for key ${digitGlyph(forDigit)}` : "New menu"}</h3>
        <p className="dimtxt">Callers never hear this name. It&apos;s only so you can find it later.</p>
        <input className="inp" autoFocus value={name} onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Appointments" onKeyDown={(e) => { if (e.key === "Enter" && ok) onSubmit(name.trim(), afterHours ? "after_hours" : "business_hours"); }} />
        {mode === "create" && !forDigit && (
          <label className="check">
            <input type="checkbox" checked={afterHours} onChange={(e) => setAfterHours(e.target.checked)} />
            This is the menu to play when we&apos;re closed
          </label>
        )}
        <div className="foot">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!ok || busy} onClick={() => onSubmit(name.trim(), afterHours ? "after_hours" : "business_hours")}>
            {mode === "rename" ? "Save name" : `Create “${name.trim() || "…"}”`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── opening hours ────────────────────────────────────────────────────────────
// Connect's schedule holds ONE open/close window per weekday, so this offers
// one per day rather than pretending split shifts work and silently dropping
// the second one.
function HoursCard({ schedule, profiles, disabled, onSave, onCreateAfterHours }: {
  schedule: ScheduleRow | null;
  profiles: RouteProfile[];
  disabled?: boolean;
  onSave: (next: ScheduleRow) => void;
  onCreateAfterHours: () => void;
}) {
  const { t } = useUiLanguage();
  const [draft, setDraft] = useState<ScheduleRow>(schedule ?? EMPTY_SCHEDULE);
  const [newHoliday, setNewHoliday] = useState("");
  const savedJson = useRef<string>(JSON.stringify(schedule ?? EMPTY_SCHEDULE));

  useEffect(() => {
    const incoming = JSON.stringify(schedule ?? EMPTY_SCHEDULE);
    if (incoming !== savedJson.current) { savedJson.current = incoming; setDraft(schedule ?? EMPTY_SCHEDULE); }
  }, [schedule]);

  const changed = JSON.stringify(draft) !== savedJson.current;
  const ruleFor = (day: number) => draft.businessHoursRules.find((r) => r.day === day) ?? null;
  const setDay = (day: number, open: string | null, close?: string) => {
    setDraft((d) => {
      const rest = d.businessHoursRules.filter((r) => r.day !== day);
      if (open === null) return { ...d, businessHoursRules: rest.sort((a, b) => a.day - b.day) };
      const ex = d.businessHoursRules.find((r) => r.day === day);
      return { ...d, businessHoursRules: [...rest, { day, open, close: close ?? ex?.close ?? "17:00" }].sort((a, b) => a.day - b.day) };
    });
  };
  const openCount = draft.businessHoursRules.length;

  return (
    <div className="card">
      <div className="card-h">
        <div><h2>{t("Opening hours")}</h2><div className="sub">{openCount === 0 ? "Not set — callers always get the closed menu" : summariseHours(draft.businessHoursRules, draft.timezone)}</div></div>
      </div>
      <div className="card-b">
        <div className="field" style={{ maxWidth: 280 }}>
          <label>{t("Time zone")}</label>
          <select className="sel" disabled={disabled} value={draft.timezone} onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}>
            {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz.split("/")[1].replace(/_/g, " ")}</option>)}
            {!TIMEZONES.includes(draft.timezone) && <option value={draft.timezone}>{draft.timezone}</option>}
          </select>
        </div>

        <div className="days">
          {DAY_NAMES.map((nm, day) => {
            const r = ruleFor(day);
            return (
              <div key={day} className={"dayrow" + (r ? "" : " closed")}>
                <label className="daytoggle">
                  <input type="checkbox" disabled={disabled} checked={!!r}
                    onChange={(e) => setDay(day, e.target.checked ? "09:00" : null, e.target.checked ? "17:00" : undefined)} />
                  <span>{nm}</span>
                </label>
                {r ? (
                  <div className="daytimes">
                    <input className="inp time" type="time" disabled={disabled} value={r.open} onChange={(e) => setDay(day, e.target.value, r.close)} />
                    <span className="to">to</span>
                    <input className="inp time" type="time" disabled={disabled} value={r.close} onChange={(e) => setDay(day, r.open, e.target.value)} />
                  </div>
                ) : <div className="daytimes closedtxt">{t("Closed all day")}</div>}
              </div>
            );
          })}
        </div>

        <div className="fb">
          <div className="fbx">
            <h3>While you&apos;re open</h3>
            <select className="sel" disabled={disabled} value={draft.defaultProfileId ?? ""} onChange={(e) => setDraft((d) => ({ ...d, defaultProfileId: e.target.value || null }))}>
              <option value="">Choose a menu…</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="fbx">
            <h3>When you&apos;re closed</h3>
            <select className="sel" disabled={disabled} value={draft.afterHoursProfileId ?? ""} onChange={(e) => setDraft((d) => ({ ...d, afterHoursProfileId: e.target.value || null }))}>
              <option value="">Choose a menu…</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {!profiles.some((p) => p.type === "after_hours") && (
              <button className="btn sm" style={{ marginTop: 9 }} disabled={disabled} onClick={onCreateAfterHours}>+ Make a closed-hours menu</button>
            )}
          </div>
        </div>

        <div className="field">
          <label>Days you&apos;re closed all day (holidays)</label>
          <div className="holidays">
            {draft.holidayDates.length === 0 && <span className="dimtxt">{t("None yet")}</span>}
            {draft.holidayDates.map((d) => (
              <span key={d} className="hchip">{d}
                <button disabled={disabled} onClick={() => setDraft((s) => ({ ...s, holidayDates: s.holidayDates.filter((x) => x !== d) }))} aria-label={`Remove ${d}`}>×</button>
              </span>
            ))}
          </div>
          <div className="rowmini" style={{ marginTop: 8 }}>
            <input className="inp" type="date" disabled={disabled} value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)} />
            <button className="btn sm" disabled={disabled || !newHoliday || draft.holidayDates.includes(newHoliday)}
              onClick={() => { setDraft((s) => ({ ...s, holidayDates: [...s.holidayDates, newHoliday].sort() })); setNewHoliday(""); }}>{t("Add")}</button>
          </div>
        </div>

        <div className="foot">
          {changed && <span className="pill" style={{ marginRight: "auto" }}>Not saved yet</span>}
          <button className="btn primary" disabled={disabled || !changed} onClick={() => onSave(draft)}>{t("Save hours")}</button>
        </div>
      </div>
    </div>
  );
}

function StudioStyles() {
  return (
    <style jsx global>{`
      .ivrs{--accent:#3ba0f2;--accent-soft:rgba(59,160,242,.14);--accent-line:rgba(59,160,242,.38);
        --panel:#16212e;--panel-2:#1c2937;--bg-soft:#111c27;--text:#e4ecf4;--dim:#8ba0b6;--faint:#64798f;
        --line:#2a3a4c;--line-soft:rgba(140,166,196,.16);
        --person:#3ec37e;--team:#3ba0f2;--vm:#e8a33d;--menu:#a98fe0;--stop:#e2606a;--ok:#3ec37e;
        --r:16px;--shadow:0 20px 54px -34px rgba(0,0,0,.75),0 6px 18px -14px rgba(0,0,0,.55);
        color:var(--text);max-width:1240px;margin:0 auto;padding:6px 2px 70px}
      :root[data-theme="light"] .ivrs{--panel:#fff;--panel-2:#f6f9fc;--bg-soft:#eef2f7;--text:#132030;--dim:#5d6f84;--faint:#8496a8;
        --accent:#1f74d0;--accent-soft:rgba(31,116,208,.09);--accent-line:rgba(31,116,208,.30);
        --line:rgba(19,32,48,.13);--line-soft:rgba(19,32,48,.08);
        --person:#1a9d5c;--team:#1f74d0;--vm:#b57718;--menu:#7659c4;--stop:#c9414c;--ok:#1a9d5c;
        --shadow:0 20px 50px -38px rgba(28,45,68,.42),0 6px 18px -14px rgba(28,45,68,.14)}
      .ivrs *{box-sizing:border-box}
      .ivrs .topbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 4px 0}
      .ivrs .crumbs{color:var(--dim);font-size:13.5px;display:flex;gap:8px;align-items:center}
      .ivrs .crumbs b{color:var(--text)}
      .ivrs .spacer{flex:1}
      .ivrs .btn{font:inherit;font-size:13.5px;font-weight:640;border-radius:10px;padding:9px 15px;border:1px solid var(--line);
        background:var(--panel);color:var(--text);cursor:pointer;display:inline-flex;align-items:center;gap:7px;transition:.14s;white-space:nowrap}
      .ivrs .btn:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
      .ivrs .btn:disabled{opacity:.5;cursor:not-allowed}
      .ivrs .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
      .ivrs .btn.primary:hover:not(:disabled){filter:brightness(1.08);color:#fff}
      .ivrs .btn.ghost{background:transparent}
      .ivrs .btn.sm{font-size:12.5px;padding:6px 11px;border-radius:9px}
      .ivrs .btn.big{font-size:15px;padding:12px 22px}
      .ivrs .btn:focus-visible,.ivrs .choice:focus-visible,.ivrs .target:focus-visible,.ivrs .stepcard:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
      .ivrs .pill{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:650;padding:5px 11px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
      .ivrs .pill.warn{color:var(--vm);border-color:color-mix(in srgb,var(--vm) 40%,transparent);background:color-mix(in srgb,var(--vm) 12%,transparent)}
      .ivrs .pill.warn i{width:7px;height:7px;border-radius:50%;background:var(--vm)}
      .ivrs .titlerow{margin:20px 4px 14px}
      .ivrs .eyebrow{font-size:11px;font-weight:740;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:9px}
      .ivrs .menupick{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
      .ivrs .menusel{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:9px 13px;font-size:16px;font-weight:660;color:var(--text);font-family:inherit;cursor:pointer}
      .ivrs .banner{margin:0 4px 14px;padding:12px 15px;border-radius:12px;background:var(--accent-soft);border:1px solid var(--line);color:var(--dim);font-size:13.5px;display:flex;align-items:flex-start;gap:11px}
      .ivrs .banner.err{background:color-mix(in srgb,var(--stop) 10%,transparent);border-color:color-mix(in srgb,var(--stop) 35%,transparent);color:var(--stop)}
      .ivrs .banner.ok{background:color-mix(in srgb,var(--ok) 10%,transparent);border-color:color-mix(in srgb,var(--ok) 35%,transparent);color:var(--ok)}
      .ivrs .banner .btxt{min-width:0}
      .ivrs .banner .btxt b{display:block;font-size:14px;color:inherit}
      .ivrs .banner .btxt p{margin:3px 0 0;color:var(--dim)}
      .ivrs .misslist{margin:6px 0 0;padding-left:18px;color:var(--dim);font-size:13px;line-height:1.7}
      .ivrs .misslist b{display:inline;font-size:13px;color:var(--text)}
      .ivrs .banner.assistant{background:var(--accent-soft);border-color:var(--accent-line)}
      .ivrs .banner.assistant b{color:var(--text);display:block;font-size:14px}
      .ivrs .banner.assistant p{margin:3px 0 0}
      .ivrs .banner .ai{flex:none;width:30px;height:30px;border-radius:9px;background:var(--accent);color:#fff;display:grid;place-items:center;font-size:11px;font-weight:780}
      .ivrs .banner button{margin-left:auto;background:none;border:none;color:inherit;font-size:19px;cursor:pointer;line-height:1}
      .ivrs .empty{text-align:center;padding:60px 20px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);margin:0 4px}
      .ivrs .empty .eglyph{font-size:40px}
      .ivrs .empty h2{margin:14px 0 8px;font-size:21px}
      .ivrs .empty p{color:var(--dim);font-size:14.5px;max-width:52ch;margin:0 auto 20px;line-height:1.6}
      .ivrs .grid{display:grid;grid-template-columns:1.6fr .9fr;gap:18px;align-items:start;padding:0 4px}
      @media (max-width:1000px){.ivrs .grid{grid-template-columns:1fr}}
      .ivrs .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);overflow:hidden}
      .ivrs .card+.card{margin-top:18px}
      .ivrs .card-h{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--line-soft)}
      .ivrs .card-h h2{font-size:15.5px;margin:0;font-weight:670}
      .ivrs .card-h .sub{color:var(--dim);font-size:12.5px;margin-top:2px}
      .ivrs .card-b{padding:18px}
      .ivrs .sticky{position:sticky;top:18px}
      /* flow */
      .ivrs .flow{display:flex;flex-direction:column}
      .ivrs .steprow{display:grid;grid-template-columns:56px 1fr;align-items:stretch}
      .ivrs .rail{position:relative;display:flex;flex-direction:column;align-items:center}
      .ivrs .knob{margin-top:10px;flex:none;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;
        font-size:16px;font-weight:760;background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent-line);font-variant-numeric:tabular-nums}
      .ivrs .knob.muted{background:var(--panel-2);color:var(--dim);border-color:var(--line);font-size:15px}
      .ivrs .knob.add{border-style:dashed;background:transparent;color:var(--dim)}
      .ivrs .line{width:2px;flex:1;min-height:14px;background:var(--line)}
      .ivrs .stepcard{width:100%;text-align:left;font:inherit;color:var(--text);margin:8px 0 8px 14px;padding:13px 15px;border:1px solid var(--line);
        border-radius:13px;background:var(--panel-2);display:flex;gap:13px;align-items:center;flex-wrap:wrap;transition:.14s}
      .ivrs .stepcard.tappable{cursor:pointer}
      .ivrs .stepcard.tappable:hover{border-color:var(--accent-line)}
      .ivrs .stepcard.add{border-style:dashed;background:transparent}
      .ivrs .stepcard.warn{border-color:color-mix(in srgb,var(--stop) 45%,transparent)}
      .ivrs .stepcard .txt{flex:1;min-width:140px}
      .ivrs .stepcard .txt b{display:block;font-size:14.5px;font-weight:640}
      .ivrs .stepcard .txt span{display:block;font-size:12.5px;color:var(--dim);margin-top:2px}
      .ivrs .stepcard .acts{display:flex;gap:7px}
      .ivrs .tag{font-size:11px;font-weight:670;padding:4px 10px;border-radius:999px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
      .ivrs .tag.person{color:var(--person);border-color:color-mix(in srgb,var(--person) 40%,transparent);background:color-mix(in srgb,var(--person) 12%,transparent)}
      .ivrs .tag.team{color:var(--team);border-color:var(--accent-line);background:var(--accent-soft)}
      .ivrs .tag.voicemail{color:var(--vm);border-color:color-mix(in srgb,var(--vm) 40%,transparent);background:color-mix(in srgb,var(--vm) 12%,transparent)}
      .ivrs .tag.menu{color:var(--menu);border-color:color-mix(in srgb,var(--menu) 42%,transparent);background:color-mix(in srgb,var(--menu) 13%,transparent)}
      .ivrs .tag.hangup{color:var(--stop);border-color:color-mix(in srgb,var(--stop) 40%,transparent);background:color-mix(in srgb,var(--stop) 12%,transparent)}
      .ivrs .tag.recording{color:var(--vm);border-color:color-mix(in srgb,var(--vm) 40%,transparent);background:color-mix(in srgb,var(--vm) 12%,transparent)}
      .ivrs .tag.forward{color:var(--person);border-color:color-mix(in srgb,var(--person) 40%,transparent);background:color-mix(in srgb,var(--person) 12%,transparent)}
      .ivrs .recmakerow{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:10px}
      .ivrs .recmakerow .btn{cursor:pointer}
      .ivrs .recmakerow .btn.disabled{opacity:.5;pointer-events:none}
      .ivrs .afterbox{margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)}
      .ivrs .afterrow{display:flex;gap:8px;flex-wrap:wrap}
      .ivrs .afterbtn{font:inherit;font-size:13px;font-weight:620;padding:8px 14px;border-radius:999px;cursor:pointer;
        border:1px solid var(--line);background:var(--panel-2);color:var(--text)}
      .ivrs .afterbtn.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
      /* branch */
      .ivrs .branch{margin:0 0 10px 70px;border-left:2px solid var(--accent-line);padding:6px 0 8px 16px}
      .ivrs .bhead{font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;font-weight:720;color:var(--faint);margin-bottom:9px}
      .ivrs .bkey{display:flex;gap:11px;align-items:center;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel-2);margin-bottom:7px;font-size:13.5px;flex-wrap:wrap}
      .ivrs .bkey .d{width:26px;height:26px;border-radius:8px;flex:none;display:grid;place-items:center;font-size:12.5px;font-weight:750;background:var(--accent-soft);color:var(--accent)}
      .ivrs .bkey .t{flex:1;min-width:110px}
      /* editor */
      .ivrs .editor{margin:2px 0 12px 70px;border:1px solid var(--accent);border-radius:14px;overflow:hidden;background:var(--panel)}
      .ivrs .editor-h{display:flex;align-items:center;gap:11px;padding:12px 15px;background:var(--accent-soft);border-bottom:1px solid var(--line-soft);font-size:14px}
      .ivrs .editor-h .kb{width:28px;height:28px;border-radius:8px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:760;font-size:13px}
      .ivrs .editor-h .x{margin-left:auto;background:none;border:none;color:var(--dim);font-size:19px;cursor:pointer;line-height:1}
      .ivrs .editor-b{padding:15px}
      .ivrs .choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:9px}
      .ivrs .choice{display:flex;flex-direction:column;gap:6px;text-align:left;padding:13px;border-radius:12px;border:1px solid var(--line);
        background:var(--panel-2);cursor:pointer;font-family:inherit;color:var(--text);transition:.14s}
      .ivrs .choice:hover{border-color:var(--accent-line)}
      .ivrs .choice.on{border-color:var(--accent);background:var(--accent-soft)}
      .ivrs .choice.blocked{border-style:dashed;opacity:.75}
      .ivrs .choice.blocked span{color:var(--vm)}
      .ivrs .blocknote{margin-top:12px;padding:11px 13px;border-radius:10px;font-size:13px;
        color:var(--vm);background:color-mix(in srgb,var(--vm) 10%,transparent);border:1px solid color-mix(in srgb,var(--vm) 34%,transparent)}
      .ivrs .choice .glyph{font-size:19px}
      .ivrs .choice b{font-size:14px;font-weight:660}
      .ivrs .choice span{font-size:12px;color:var(--dim);line-height:1.45}
      .ivrs .picker{margin-top:14px}
      .ivrs .plabel{font-size:11.5px;font-weight:710;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);margin-bottom:9px}
      .ivrs .targets{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:8px;max-height:250px;overflow:auto}
      .ivrs .target{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--line);border-radius:11px;
        background:var(--panel-2);cursor:pointer;font-family:inherit;color:var(--text);text-align:left;transition:.14s}
      .ivrs .target:hover{border-color:var(--accent-line)}
      .ivrs .target.on{border-color:var(--accent);background:var(--accent-soft)}
      .ivrs .av{width:31px;height:31px;border-radius:9px;flex:none;display:grid;place-items:center;font-size:12px;font-weight:730;color:#fff}
      .ivrs .target .nm{min-width:0}
      .ivrs .target .nm b{display:block;font-size:13.5px;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ivrs .target .nm span{display:block;font-size:11.5px;color:var(--faint)}
      .ivrs .digitgrid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}
      .ivrs .digitbtn{aspect-ratio:1;border-radius:11px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);
        font:inherit;font-size:18px;font-weight:740;cursor:pointer;transition:.14s}
      .ivrs .digitbtn:hover{border-color:var(--accent);color:var(--accent)}
      .ivrs .readback{margin-top:14px;padding:13px 15px;border-radius:11px;border:1px dashed var(--accent-line);background:var(--accent-soft);font-size:14.5px;line-height:1.55}
      .ivrs .readback.idle{border-color:var(--line);background:var(--bg-soft);color:var(--dim)}
      .ivrs .readback .k{display:inline-grid;place-items:center;width:23px;height:23px;border-radius:7px;background:var(--accent);color:#fff;font-weight:750;font-size:12px;vertical-align:-5px;margin:0 2px}
      .ivrs .foot{display:flex;gap:10px;justify-content:flex-end;align-items:center;margin-top:15px;flex-wrap:wrap}
      /* script */
      .ivrs .script{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:11px;font-size:13.5px;line-height:1.6}
      .ivrs .script li::marker{color:var(--faint);font-weight:700}
      /* recordings */
      .ivrs .reclist{display:flex;flex-direction:column;gap:8px;margin:10px 0 4px 70px;max-height:260px;overflow:auto}
      .ivrs .reclist.flat{margin:0;max-height:320px}
      .ivrs .recrow{display:flex;align-items:center;gap:11px;padding:9px 11px;border:1px solid var(--line);border-radius:11px;
        background:var(--panel-2);cursor:pointer;font-family:inherit;color:var(--text);text-align:left;width:100%;transition:.14s}
      .ivrs .recrow:hover{border-color:var(--accent-line)}
      .ivrs .recrow.on{border-color:var(--accent)}
      .ivrs .recrow .p{width:28px;height:28px;border-radius:8px;flex:none;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);font-size:11px}
      .ivrs .recrow .nm{flex:1;font-size:13.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ivrs .recrow .cur{font-size:11.5px;color:var(--faint)}
      .ivrs .dimtxt{color:var(--dim);font-size:12.5px}
      .ivrs .switchbanner{display:flex;align-items:center;gap:9px;margin:6px 0 0 46px;padding:8px 12px;
        border-radius:10px;font-size:12.5px;color:#8a6a12;background:rgba(239,159,39,.12);
        border:1px solid rgba(239,159,39,.35)}
      :root[data-theme="dark"] .ivrs .switchbanner{color:#fac775;background:rgba(239,159,39,.12);border-color:rgba(239,159,39,.4)}
      .ivrs .switchbanner .sb-txt{flex:1}
      .ivrs .linkbtn{background:none;border:none;font:inherit;font-size:12.5px;font-weight:640;
        color:var(--ac);text-decoration:underline;cursor:pointer;padding:0}
      /* hours */
      .ivrs .field{margin-top:12px}
      .ivrs .field label{display:block;font-size:11.5px;color:var(--dim);margin-bottom:6px;font-weight:640}
      .ivrs .sel,.ivrs .inp{width:100%;font:inherit;font-size:13.5px;color:var(--text);background:var(--bg-soft);border:1px solid var(--line);border-radius:10px;padding:9px 11px}
      .ivrs .sel:focus,.ivrs .inp:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
      .ivrs .rowmini{display:flex;gap:9px}
      .ivrs .days{display:flex;flex-direction:column;gap:7px;margin-top:14px}
      .ivrs .dayrow{display:flex;align-items:center;gap:12px;background:var(--panel-2);border:1px solid var(--line);border-radius:11px;padding:8px 12px;flex-wrap:wrap}
      .ivrs .dayrow.closed{border-style:dashed}
      .ivrs .daytoggle{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:620;min-width:118px;cursor:pointer}
      .ivrs .daytoggle input{width:16px;height:16px;accent-color:var(--accent);cursor:pointer}
      .ivrs .dayrow.closed .daytoggle{color:var(--dim);font-weight:540}
      .ivrs .daytimes{display:flex;align-items:center;gap:9px;font-size:13px}
      .ivrs .daytimes .to{color:var(--dim);font-size:12px}
      .ivrs .daytimes.closedtxt{color:var(--dim);font-size:12.5px}
      .ivrs .inp.time{width:auto;padding:6px 9px}
      .ivrs .fb{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px}
      @media (max-width:620px){.ivrs .fb{grid-template-columns:1fr}}
      .ivrs .fbx{background:var(--panel-2);border:1px solid var(--line);border-radius:12px;padding:13px}
      .ivrs .fbx h3{margin:0 0 9px;font-size:13.5px;font-weight:650}
      .ivrs .holidays{display:flex;flex-wrap:wrap;gap:7px;align-items:center;min-height:22px}
      .ivrs .hchip{display:inline-flex;align-items:center;gap:6px;font-size:12px;background:var(--bg-soft);border:1px solid var(--line);border-radius:999px;padding:4px 6px 4px 11px}
      .ivrs .hchip button{background:none;border:none;color:var(--dim);cursor:pointer;font-size:15px;line-height:1;padding:0 4px}
      /* dialog */
      .ivrs .backdrop{position:fixed;inset:0;background:rgba(4,10,17,.6);display:grid;place-items:center;padding:22px;z-index:70}
      .ivrs .dialog{background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);width:min(440px,100%);padding:20px}
      .ivrs .dialog h3{margin:0 0 6px;font-size:17px;font-weight:670}
      .ivrs .dialog .inp{margin-top:13px;font-size:15px;padding:11px 13px}
      .ivrs .check{display:flex;align-items:center;gap:9px;margin-top:13px;font-size:13.5px;cursor:pointer;color:var(--dim)}
      .ivrs .check input{width:16px;height:16px;accent-color:var(--accent);cursor:pointer}
      .ivrs .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--accent);
        color:var(--text);padding:12px 19px;border-radius:12px;box-shadow:var(--shadow);font-size:13.5px;font-weight:620;z-index:80;max-width:min(520px,92vw);text-align:center}
    `}</style>
  );
}

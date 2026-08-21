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
  explainCallFlow, summariseHours, digitGlyph, formatPhone, pbxHandBack, findPbxHandBacks,
  KIND_LABEL, KIND_BLURB, OFFERABLE_KINDS,
  type MenuChoiceKind, type TenantDirectory, type CallStep, type AfterRecordingChoice,
} from "@connect/shared";
import { useAppContext } from "../../../../hooks/useAppContext";
import { useUiLanguage, LanguageToggle } from "../../../../hooks/useUiLanguage";
import { FirstRunSetup, type FirstRunAnswers } from "./FirstRunSetup";
import { MakeRecording } from "./MakeRecording";
import { ConvertRecording } from "./ConvertRecording";
import { MakeTeam } from "./MakeTeam";
import { NumberStep, fmtUs, type TenantNumber, type NumberPlan, type AnnouncementPlan } from "./NumberStep";
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, getPortalApiBaseUrl } from "../../../../services/apiClient";
import { JewishCalendarCard } from "./JewishCalendar";

interface RouteProfile {
  id: string; tenantId: string; name: string; type: string;
  pbxPromptRef: string | null; pbxInvalidPromptRef: string | null; pbxTimeoutPromptRef: string | null;
  /** Not edited on this screen, but a recording used here still counts as "in
   *  use" — leaving it out of the check would let someone delete a recording
   *  the retry message still points at, which blocks the next publish. */
  pbxRetryPromptRef?: string | null;
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
  "Or add a new one:", "Upload a recording", "Uploading…", "Make one with AI", "Change my voice",
  "A phone number", "Which phone number?", "Or send it to a new number:",
  "Add this number", "Setting it up…",
  "No teams yet — make the first one:", "Or make a new one:", "Make a team",
  "Rings a phone outside the office — a cell, or another business.",
  "Plays a recording — directions, hours, an announcement — then continues.",
  "Remove this key", "Cancel", "Save name", "Loading…",
  "Your phone number", "Your recording", "No recording set — callers hear a stand-in message",
  "No number points at this menu yet", "We replay the menu, then the call ends",
  "They press a key you haven't set up", "We tell them it wasn't valid and replay the menu",
  "They can dial someone's extension", "They can't dial an extension", "Turn off", "Turn on",
  "A caller who knows an extension can type it instead of picking from the menu.",
  "If a caller types an extension we tell them that option is invalid.",
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
  "Stop", "Delete", "Deleting…", "Close", "Delete this menu",
  "Are you sure you want to delete this?",
  "Callers can't reach it any more, and it can't be brought back.",
  "You can't delete this yet", "It's still being used here:",
  "Change these to something else first, then you can delete it.",
  "Play this recording", "Stop playing", "Delete this recording",
  "Make a recording", "Rename this recording", "Rename recording", "Save name",
  "What should it be called?", "That name is already taken by another recording.",
  "Callers never hear this name — it's only so you can find the recording later.",
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

/** Saving the opening hours can be refused too, and those codes have no
 *  `detail` worth reading. A bare "profile_not_found" on screen is what a
 *  customer saw on 2026-08-06 while stuck in a loop they couldn't get out of. */
const SCHEDULE_ERROR_TEXT: Record<string, string> = {
  profile_not_found: "One of the menus chosen here no longer exists. Pick the menus again and save.",
  profile_wrong_tenant: "One of the menus chosen here belongs to a different customer. Pick the menus again and save.",
  tenant_not_linked: "This customer isn't linked to the phone system yet, so opening hours can't be saved.",
  forbidden: "You don't have permission to change the opening hours.",
  invalid_payload: "Something was missing from the hours. Reload the page and try again.",
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
  /** Recordings are their own permission on the API side — someone who may
   *  point keys around isn't automatically allowed to delete the audio. */
  const canManagePrompts = can("can_manage_ivr_prompts");

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
  /** Teams arrive AFTER first paint — see the deferred load in loadAll().
   *  ⛔ This is a third state and must not be folded into `teamsLoaded`:
   *  "still arriving" and "we tried and failed" produce different sentences,
   *  and showing the failure sentence while a request is still in flight tells
   *  the customer their phone system is broken when it isn't. */
  const [teamsLoading, setTeamsLoading] = useState(false);
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
  /** Which recording is playing right now, so its button can offer Stop.
   *  There was no way to stop a recording once it started — the only escape
   *  was to leave the page. */
  const [playingRef, setPlayingRef] = useState<string | null>(null);
  /** The "are you sure?" for deleting a recording or a whole menu. `blockers`
   *  non-empty means it can't be deleted yet and the dialog explains why
   *  instead of offering the button. */
  const [confirmDelete, setConfirmDelete] = useState<null | {
    kind: "recording" | "menu" | "team"; id: string; name: string; blockers: string[];
  }>(null);
  const [deleting, setDeleting] = useState(false);
  /** Which recording is being renamed, and the name being typed. */
  const [renaming, setRenaming] = useState<null | { id: string; name: string }>(null);

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
  /** Change the VOICE of a recording instead of generating one — see
   *  ConvertRecording.tsx. Shares makeRecForKey/makeRecForLibrary, because
   *  "what is this recording for" is the same question either way. */
  const [convertOpen, setConvertOpen] = useState(false);
  /** ⛔ null while unknown, so the button is not drawn OR hidden on a guess.
   *  Someone without `can_use_voice_changer` must never see the option at all —
   *  the server answers 200 allowed:false for them, which is not an error. */
  const [voiceChangerAllowed, setVoiceChangerAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token =
          (typeof window !== "undefined" && (localStorage.getItem("token") || localStorage.getItem("cc-token"))) || "";
        const r = await fetch(`${getPortalApiBaseUrl()}/voice/elevenlabs/voice-changer/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (!cancelled) setVoiceChangerAllowed(Boolean(j?.allowed));
      } catch {
        // An older API answers 404 and a hiccup answers 5xx. Either way the
        // safe reading is "no option", never a button that fails on click.
        if (!cancelled) setVoiceChangerAllowed(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * Shared by both recording dialogs: a generated greeting and a re-voiced one
   * are the same kind of thing once they exist, so where the row goes must not
   * depend on which dialog made it.
   *
   * Declared as a function (not a const) so it can sit here among the state
   * while referring to patchProfile/flash, which are defined further down.
   */
  async function onRecordingCreated(prompt: { id: string; promptRef: string; displayName: string; category: string }) {
    // Splice the one new row in rather than reloading everything —
    // Play and the picker need it now, and nothing else changed.
    setPrompts((ps) => [
      ...ps.filter((p) => p.id !== prompt.id),
      { id: prompt.id, promptRef: prompt.promptRef, displayName: prompt.displayName, category: prompt.category, hasAudio: true },
    ]);
    const closeBoth = () => { setMakeRecOpen(false); setConvertOpen(false); };
    if (makeRecForLibrary) {
      // Made from the Recordings card: it joins the library and
      // nothing on the menu moves.
      setMakeRecForLibrary(false);
      closeBoth();
      flash(`“${prompt.displayName}” added to your recordings.`);
      return;
    }
    if (makeRecForKey) {
      // Opened from a key editor: the recording belongs to that key,
      // not to the menu greeting. The editor adopts it and stays open
      // so "afterwards" can still be chosen before saving.
      setAdoptRecording({ digit: makeRecForKey, promptRef: prompt.promptRef });
      setMakeRecForKey(null);
      closeBoth();
      flash(`“${prompt.displayName}” is ready — save the key when you're done.`);
      return;
    }
    // Point the menu at what was just made — nobody makes a greeting and then
    // wants to go and select it separately.
    await patchProfile({ pbxPromptRef: prompt.promptRef });
    closeBoth();
    flash(`“${prompt.displayName}” is now your greeting.`);
  }
  /** Set when the recording modal/upload was opened FROM the key editor for a
   *  digit: the result becomes that key's recording, not the menu greeting. */
  const [makeRecForKey, setMakeRecForKey] = useState<string | null>(null);
  /** Opened from the Recordings library rather than from a greeting or a key.
   *  The result is added to the library and assigned to NOTHING — silently
   *  repointing the live greeting because someone made an announcement is the
   *  kind of change a caller notices before the customer does. */
  const [makeRecForLibrary, setMakeRecForLibrary] = useState(false);
  /** Same idea for teams: "A team" with none yet should MAKE one, not send the
   *  customer away to find the button. */
  const [makeTeamForKey, setMakeTeamForKey] = useState<string | null>(null);
  const [adoptTeam, setAdoptTeam] = useState<{ digit: string; number: string } | null>(null);
  /** Forwards made in this session. They exist on the phone system but do NOT
   *  ring until Apply Changes is pressed there — creating one deliberately
   *  never fires it. A toast said so and vanished, and a real forward went out
   *  to a caller as a busy signal, so it is now said again at Publish. */
  const [pendingForwards, setPendingForwards] = useState<Array<{ extension: string; phoneNumber: string }>>([]);
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

  const stopPlaying = useCallback(() => {
    const a = audioRef.current;
    if (a) { a.pause(); try { a.currentTime = 0; } catch { /* not seekable yet */ } }
    setPlayingRef(null);
  }, []);

  /** Play, or stop if this same recording is already playing.
   *  ⛔ The element's own `pause` event is deliberately NOT wired to clear
   *  `playingRef`: it fires asynchronously, so the pause we do below before
   *  switching tracks would land AFTER we set the new one and blank the button
   *  while audio is playing. Every stop path goes through stopPlaying(). */
  const play = useCallback((promptRef: string | null | undefined) => {
    if (!promptRef) { flash("No recording set yet"); return; }
    const row = prompts.find((p) => p.promptRef === promptRef);
    if (!row) { flash("That recording isn't in your library"); return; }
    if (playingRef === promptRef) { stopPlaying(); return; }
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.onended = () => setPlayingRef(null);
      audioRef.current.onerror = () => setPlayingRef(null);
    }
    audioRef.current.pause();
    audioRef.current.src = streamUrl(row.id);
    setPlayingRef(promptRef);
    audioRef.current.play().catch(() => {
      setPlayingRef(null);
      flash("Couldn't play it — the audio hasn't been uploaded");
    });
  }, [prompts, streamUrl, playingRef, stopPlaying]);

  /** Leaving the page mid-playback used to leave the audio running. */
  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const loadAll = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true); setError(null);
    const safe = async <T,>(path: string): Promise<T | null> => { try { return await apiGet<T>(path); } catch { return null; } };
    try {
      // ⛔ Ring groups and queues are NOT in this batch on purpose.
      // /voice/pbx/ring-groups is a live Ombutel MySQL read and measured 1.8s
      // average / 2.2s max — the slowest thing on this page by a wide margin and,
      // inside a Promise.all, the floor the entire screen waited on. Nothing
      // above the fold needs it: it feeds the Teams card and the "A team" choice
      // in the key editor, both of which handle arriving late. Queues rides along
      // because the two are merged into one `teams` list — splitting them would
      // flash a wrong team count before the second one landed.
      const [p, pr, sc, ext, dm, nums, fwd] = await Promise.all([
        apiGet<{ profiles: RouteProfile[] }>(`/voice/ivr/route-profiles${qs}`),
        apiGet<{ prompts: PromptRow[] }>(`/voice/ivr/prompts${qs}`),
        safe<{ schedule: ScheduleRow | null }>(`/voice/ivr/schedule${qs}`),
        safe<{ rows: any[] }>(`/voice/pbx/resources/extensions${qs}`),
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

      setPeopleLoaded(ext !== null);

      // Teams, off the critical path. Fired without await so the screen paints
      // and becomes usable while the slow PBX read is still going; it fills the
      // Teams card and the "A team" choice in place when it lands.
      setTeamsLoading(true);
      void (async () => {
        try {
          const [rg, q] = await Promise.all([
            safe<{ rows: any[] }>(`/voice/pbx/ring-groups${qs}`),
            safe<{ rows: any[] }>(`/voice/pbx/resources/queues${qs}`),
          ]);
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
        } catch {
          setTeamsLoaded(false);
        } finally {
          setTeamsLoading(false);
        }
      })();

      // Every menu's keys in ONE request. This used to be a second wave of
      // requests — one per menu, each ~half a second, and none of them could
      // start until the batch above had finished. On a tenant with several
      // menus that was most of the page's load time for a single table read.
      const allOptions: Record<string, OptionRow[]> = {};
      const bulk = await safe<{ optionsByProfile: Record<string, OptionRow[]> }>(`/voice/ivr/route-profiles/options${qs}`);
      if (bulk?.optionsByProfile) {
        for (const prof of list) allOptions[prof.id] = bulk.optionsByProfile[prof.id] ?? [];
      } else {
        // Older API (or a hiccup): fall back to the per-menu reads so the map
        // still draws rather than showing every menu as empty.
        await Promise.all(list.map(async (prof) => {
          try {
            const r = await apiGet<{ options: OptionRow[] }>(`/voice/ivr/route-profiles/${prof.id}/options${qs}`);
            allOptions[prof.id] = r.options || [];
          } catch { allOptions[prof.id] = []; }
        }));
      }
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
  /** The library is only usable if every name is distinct — an upload of the
   *  same file twice would otherwise produce two rows nobody can tell apart.
   *  Adds a number rather than refusing: an upload is already in flight by the
   *  time we know, and the name is editable afterwards. */
  function uniqueRecordingName(base: string): string {
    const taken = new Set(prompts.map((p) => p.displayName.trim().toLowerCase()));
    const wanted = base.trim() || "Recording";
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; n < 100; n++) {
      const candidate = `${wanted} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return wanted;
  }

  async function uploadRecordingForKey(digit: string, file: File): Promise<string | null> {
    try {
      const base = file.name.replace(/\.[^.]+$/, "");
      const safe = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "recording";
      const suffix = Math.random().toString(16).slice(2, 8);
      const created = await apiPost<{ prompt: PromptRow }>(`/voice/ivr/prompts${qs}`, {
        tenantId,
        promptRef: `custom/${safe}_${suffix}`,
        displayName: uniqueRecordingName(base),
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
      const r = await apiPost<{ forward: { extension: string; phoneNumber: string; name: string }; live?: boolean; message: string }>(
        `/voice/forwards${qs}`,
        { tenantId, phoneNumber, label },
      );
      const f = r.forward;
      setForwards((cur) => [...(cur ?? []).filter((x) => x.extension !== f.extension), f]);
      // It exists on the phone system but will NOT ring until Apply Changes is
      // pressed there. Remembered so Publish can say so long after this toast.
      // Connect applies the change itself now, so this only fires when the
      // phone system genuinely refused — in which case callers WOULD get a
      // busy signal and Publish must say so.
      if (r.live === false) {
        setPendingForwards((p) => (p.some((x) => x.extension === f.extension) ? p : [...p, { extension: f.extension, phoneNumber: f.phoneNumber }]));
      }
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

      // Claim whichever slot this menu is for, if nothing holds it yet. The
      // very first menu a customer makes has to be the one that answers the
      // phone — leaving both slots empty is how a new tenant used to reach
      // Publish and be told no menu was selected to play, with no way to fix
      // it from the menu they were looking at.
      const base = schedule ?? EMPTY_SCHEDULE;
      const next = { ...base };
      if (type === "after_hours") {
        if (!base.afterHoursProfileId) next.afterHoursProfileId = created.id;
      } else if (!base.defaultProfileId) {
        next.defaultProfileId = created.id;
      }
      if (next.defaultProfileId !== base.defaultProfileId || next.afterHoursProfileId !== base.afterHoursProfileId) {
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

  // ── Deleting ───────────────────────────────────────────────────────────────
  // Both deletes refuse while something still points at the thing, and say
  // exactly what. That is not politeness — it is the only way to keep the
  // system publishable.
  //
  //  · A recording is soft-deleted (isActive=false). Any menu still naming it
  //    then fails the pre-publish catalog check with `prompt_refs_not_in_catalog`
  //    and NOTHING can be published for that customer until it's put back. So a
  //    recording in use is not deletable until the spots using it are changed.
  //  · A menu is soft-deleted too. A key or a phone number still pointing at a
  //    deleted menu dead-ends the caller, which is worse than a wrong menu
  //    because there is nothing on screen to explain it.

  /** Every place on this screen that still names this recording, in the words
   *  the customer would use for that spot. */
  function recordingUses(promptRef: string): string[] {
    const uses: string[] = [];
    for (const p of profiles) {
      if (p.pbxPromptRef === promptRef) uses.push(`the greeting on “${p.name}”`);
      if (p.pbxInvalidPromptRef === promptRef) uses.push(`the “that wasn't a valid key” message on “${p.name}”`);
      if (p.pbxTimeoutPromptRef === promptRef) uses.push(`the “nothing was pressed” message on “${p.name}”`);
      if (p.pbxRetryPromptRef === promptRef) uses.push(`the retry message on “${p.name}”`);
      for (const o of optionsByProfile[p.id] ?? []) {
        if (o.announcePromptRef === promptRef) {
          uses.push(`what plays when a caller presses ${digitGlyph(o.optionDigit)} on “${p.name}”`);
        }
      }
    }
    return uses;
  }

  /** Every place that still sends callers into this menu. */
  function menuUses(profileId: string): string[] {
    const uses: string[] = [];
    for (const n of tenantNumbers) {
      if (n.ivrProfileId === profileId) uses.push(`${fmtUs(n.e164)} rings it`);
      else if (n.pendingSwitch?.ivrProfileId === profileId) uses.push(`${fmtUs(n.e164)} is booked to switch to it`);
    }
    for (const p of profiles) {
      if (p.id === profileId) continue;
      for (const o of optionsByProfile[p.id] ?? []) {
        const read = readDestination(o, directory);
        if (read.kind === "menu" && read.targetId === profileId) {
          uses.push(`key ${digitGlyph(o.optionDigit)} on “${p.name}” opens it`);
        }
      }
    }
    if (schedule?.defaultProfileId === profileId) uses.push("it's the menu that answers while you're open");
    if (schedule?.afterHoursProfileId === profileId) uses.push("it's the menu that answers while you're closed");
    if (schedule?.holidayProfileId === profileId) uses.push("it's the menu that answers on holidays");
    return uses;
  }

  /** Renaming touches nothing a caller hears: the promptRef and the audio on
   *  the phone system are untouched, so no republish is needed and `dirty`
   *  stays where it was. Only the label in this library changes. */
  async function renameRecording(id: string, nextName: string) {
    const name = nextName.trim();
    if (!name) return;
    setSaving(true);
    try {
      await apiPatch(`/voice/ivr/prompts/${id}${qs}`, { displayName: name });
      setPrompts((ps) => ps.map((p) => (p.id === id ? { ...p, displayName: name } : p)));
      setRenaming(null);
      flash(`Renamed to “${name}”`);
    } catch (e: any) {
      setError(e?.body?.detail || e?.message || "Couldn't rename that recording");
    } finally { setSaving(false); }
  }

  function askDeleteRecording(row: PromptRow) {
    setConfirmDelete({ kind: "recording", id: row.id, name: row.displayName, blockers: recordingUses(row.promptRef) });
  }

  function askDeleteMenu(profile: RouteProfile) {
    setConfirmDelete({ kind: "menu", id: profile.id, name: profile.name, blockers: menuUses(profile.id) });
  }

  /** Which menu keys still route into this team. Client-side mirror of the
   *  server's own refusal, so the dialog can say WHERE before the request. */
  function teamUses(number: string): string[] {
    const markers = [`ext-group,${number},`, `ext-queues,${number},`];
    const uses: string[] = [];
    for (const p of profiles) {
      for (const o of optionsByProfile[p.id] ?? []) {
        if (markers.some((m) => (o.destinationRef || "").includes(m))) {
          uses.push(`key ${o.optionDigit} of “${p.name}” sends callers to it`);
        }
      }
    }
    return uses;
  }

  function askDeleteTeam(tm: { number: string; name?: string | null; kind: "ring_group" | "queue" }) {
    setConfirmDelete({
      kind: "team",
      id: `${tm.kind}/${tm.number}`,
      name: tm.name || `Team ${tm.number}`,
      blockers: teamUses(tm.number),
    });
  }

  async function doDelete() {
    const target = confirmDelete;
    if (!target || target.blockers.length > 0) return;
    setDeleting(true);
    try {
      if (target.kind === "recording") {
        const row = prompts.find((p) => p.id === target.id);
        if (row && playingRef === row.promptRef) stopPlaying();
        await apiDelete(`/voice/ivr/prompts/${target.id}${qs}`);
        setPrompts((ps) => ps.filter((p) => p.id !== target.id));
        flash(`“${target.name}” deleted`);
      } else if (target.kind === "team") {
        // id is "<kind>/<number>" — the server re-resolves the panel row id
        // from the number itself and refuses if any menu key still points at it.
        await apiDelete(`/voice/teams/${target.id}${qs}`);
        const num = target.id.split("/")[1];
        setTeams((ts) => ts.filter((t) => t.number !== num));
        flash(`“${target.name}” deleted`);
      } else {
        await apiDelete(`/voice/ivr/route-profiles/${target.id}${qs}`);
        const left = profiles.filter((p) => p.id !== target.id);
        setProfiles(left);
        setOptionsByProfile((m) => { const next = { ...m }; delete next[target.id]; return next; });
        // The deleted menu was almost certainly the open one — land somewhere
        // real rather than on an empty screen with a stale id selected.
        if (activeId === target.id) { setActiveId(left[0]?.id ?? null); setEditingDigit(null); }
        setDirty(true);
        flash(`“${target.name}” deleted`);
      }
      setConfirmDelete(null);
    } catch (e: any) {
      // Server body first — `.message` alone downgrades a full explanation to a
      // bare slug. See the portal ApiError note in CLAUDE.md.
      setError(e?.body?.detail || e?.message || "Couldn't delete that");
      setConfirmDelete(null);
    } finally { setDeleting(false); }
  }

  async function saveSchedule(next: ScheduleRow) {
    if (!tenantId) return;
    setSaving(true);
    try {
      await apiPut(`/voice/ivr/schedule`, { ...next, tenantId });
      setSchedule(next); setDirty(true); flash("Opening hours saved");
    } catch (e: any) {
      // `.body` is where the server's JSON lives — `.message` alone reduces a
      // full explanation to a bare slug, which is how "profile_not_found"
      // reached a customer's screen. See the ApiError note in CLAUDE.md.
      const code = String(e?.body?.error || "");
      setError(SCHEDULE_ERROR_TEXT[code] || e?.body?.detail || e?.message || "Couldn't save the hours");
    } finally { setSaving(false); }
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

    // Half-migrated numbers: a key that sends the caller back into the OLD
    // phone system's call flow means this number isn't really on Connect —
    // whatever the Studio shows. Say so before publishing, not after a caller
    // finds it.
    const handBacks = findPbxHandBacks({
      id: active.id,
      name: active.name,
      options: optionsByProfile[active.id] ?? [],
      timeoutDestination: active.timeoutDestinationType && active.timeoutDestinationRef
        ? { destinationType: active.timeoutDestinationType, destinationRef: active.timeoutDestinationRef } : null,
      invalidDestination: active.invalidDestinationType && active.invalidDestinationRef
        ? { destinationType: active.invalidDestinationType, destinationRef: active.invalidDestinationRef } : null,
    });
    for (const h of handBacks) {
      warnings.push(
        `${h.where} sends the caller to ${h.what}. From there the old system decides what happens — ` +
        "you can't see or change it here, so this number isn't fully moved over yet.",
      );
    }

    for (const f of pendingForwards) {
      warnings.push(
        `${formatPhone(f.phoneNumber)} is set up but won't ring yet. A new forwarding number only starts working ` +
        "once Apply Changes is pressed on the phone system — until then callers sent there get a busy signal.",
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
      // ⛔ NOT the 10s default. Publishing writes the whole menu to the phone
      // system and pushes any new audio with it; switching a number on top of
      // that runs a full per-tenant config regeneration measured at 35–40s
      // (the server's own helper timeout is 90s). At 10s the browser gave up
      // on work that was going to succeed — and giving up on the request does
      // NOT stop the server, so the publish landed anyway while the screen
      // said it had timed out. That is how the same menu got published twice
      // 16 seconds apart. The client must outlast the server.
      const res = await apiPost<{ keysWritten?: number }>(
        `/voice/ivr/publish${qs}`, { tenantId, profileId: active.id }, undefined, { timeoutMs: 120_000 });
      const keysWritten = Number(res?.keysWritten ?? 0);
      // The held "switch right now" plan executes here — Publish is the one
      // moment routing is allowed to change, so this is where the inbound
      // route flips to the menu's custom context.
      if (numberPlan && numberPlan.when === "now") {
        const e164 = numberPlan.e164;
        try {
          await apiPost(`/voice/did/${encodeURIComponent(numberPlan.mappingId)}/switch-to-connect${qs}`, {}, undefined, { timeoutMs: 120_000 });
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
      // A client-side timeout is NOT a failed publish. Aborting the request
      // doesn't stop the phone system, so the change may well have landed —
      // saying "timed out" invites a second Publish that isn't needed.
      if (e?.status === 408) {
        setError(
          "The phone system is taking longer than usual. Your change may already have gone through — " +
          "wait a moment and reload this page to check before publishing again.",
        );
      } else if (detail || missing.length > 0) setPublishBlocked({ detail: detail || "Couldn't publish.", missing });
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
            {active && (
              <button className="btn ghost sm danger" disabled={!canManage}
                title={t("Delete this menu")} onClick={() => askDeleteMenu(active)}>
                {t("Delete")}
              </button>
            )}
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
                        <button className="btn sm" onClick={() => play(active.pbxPromptRef)}>
                          {playingRef && playingRef === active.pbxPromptRef ? t("Stop") : t("Play")}
                        </button>
                        <button className="btn sm" disabled={!canManage} onClick={() => setRecPickerOpen(!recPickerOpen)}>{t("Change")}</button>
                        <button className="btn sm" disabled={!canManage} onClick={() => setMakeRecOpen(true)}>{t("Make one")}</button>
                        {voiceChangerAllowed && (
                          <button className="btn sm" disabled={!canManage}
                            onClick={() => { setMakeRecForKey(null); setConvertOpen(true); }}>{t("Change my voice")}</button>
                        )}
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
                        <div key={r.id} className={"recrow" + (active.pbxPromptRef === r.promptRef ? " on" : "")}>
                          <button type="button" className="p"
                            title={playingRef === r.promptRef ? t("Stop playing") : t("Play this recording")}
                            aria-label={playingRef === r.promptRef ? t("Stop playing") : t("Play this recording")}
                            onClick={() => play(r.promptRef)}>{playingRef === r.promptRef ? "⏸" : "▶"}</button>
                          <button type="button" className="nm"
                            onClick={() => { patchProfile({ pbxPromptRef: r.promptRef }); setRecPickerOpen(false); }}>
                            {r.displayName}
                          </button>
                          {active.pbxPromptRef === r.promptRef && <span className="cur">current</span>}
                          {canManagePrompts && (
                            <button type="button" className="del" title={t("Delete this recording")}
                              aria-label={t("Delete this recording")} onClick={() => askDeleteRecording(r)}>🗑</button>
                          )}
                        </div>
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
                          sub={pbxHandBack(o)
                            ? `Goes to ${pbxHandBack(o)} — not moved over to Connect yet`
                            : describeDestination(o, directory)}
                          kind={read.kind}
                          warn={Boolean(pbxHandBack(o)) || (!read.known && read.kind !== "hangup" && read.kind !== "other")}
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
                            teamsLoading={teamsLoading}
                            pendingTeamNumbers={pendingTeamNumbers}
                            disabled={saving}
                            onSave={(kind, target, after) => saveKey(digit, kind, target, after)}
                            onClear={() => clearKey(digit)}
                            onClose={() => setEditingDigit(null)}
                            onCreateMenu={() => setNamingFor({ mode: "create", forDigit: digit })}
                            onMakeRecording={() => { setMakeRecForKey(digit); setMakeRecOpen(true); }}
                            onConvertRecording={voiceChangerAllowed ? () => { setMakeRecForKey(digit); setConvertOpen(true); } : undefined}
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
                          teamsLoading={teamsLoading}
                          pendingTeamNumbers={pendingTeamNumbers}
                          disabled={saving}
                          onSave={(kind, target, after) => saveKey(editingDigit, kind, target, after)}
                          onClear={() => setEditingDigit(null)}
                          onClose={() => setEditingDigit(null)}
                          onCreateMenu={() => setNamingFor({ mode: "create", forDigit: editingDigit })}
                          onMakeRecording={() => { setMakeRecForKey(editingDigit); setMakeRecOpen(true); }}
                          onConvertRecording={voiceChangerAllowed ? () => { setMakeRecForKey(editingDigit); setConvertOpen(true); } : undefined}
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

                  {/* How long to wait, and how many tries, are both editable.
                      They were display-only before, which is why the wait read
                      as a fixed 7 seconds that "cannot be changed" — the API has
                      always accepted both (timeoutSeconds 1-60, maxRetries 1-10)
                      and publish already pushes them to the PBX. Only the
                      control was missing. */}
                  <Step glyph="⏱" muted
                    title={`They press nothing for ${active.timeoutSeconds || 7} seconds`}
                    sub={active.timeoutDestinationRef
                      ? `We send them to ${describeDestination({ destinationType: active.timeoutDestinationType || "", destinationRef: active.timeoutDestinationRef }, directory)}`
                      : "We replay the menu, then the call ends"}
                    actions={
                      <select className="sel" disabled={!canManage || saving}
                        aria-label={t("How long to wait")}
                        value={String(active.timeoutSeconds || 7)}
                        onChange={(e) => patchProfile({ timeoutSeconds: Number(e.target.value) })}>
                        {[3, 5, 7, 10, 15, 20, 30].map((s) => (
                          <option key={s} value={s}>{s} seconds</option>
                        ))}
                      </select>
                    } />

                  <Step glyph="⚠️" muted
                    title={t("They press a key you haven't set up")}
                    sub={active.invalidDestinationRef
                      ? `After ${active.maxRetries || 3} ${(active.maxRetries || 3) === 1 ? "try" : "tries"} we send them to ${describeDestination({ destinationType: active.invalidDestinationType || "", destinationRef: active.invalidDestinationRef }, directory)}`
                      : `We tell them it wasn't valid and replay the menu, up to ${active.maxRetries || 3} ${(active.maxRetries || 3) === 1 ? "time" : "times"}`}
                    actions={
                      <select className="sel" disabled={!canManage || saving}
                        aria-label={t("How many tries")}
                        value={String(active.maxRetries || 3)}
                        onChange={(e) => patchProfile({ maxRetries: Number(e.target.value) })}>
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>{n} {n === 1 ? "try" : "tries"}</option>
                        ))}
                      </select>
                    } />

                  {/* Dialling an extension straight from the menu. Its own step
                      because it changes what a caller can do, and because with
                      it OFF a caller who tries is told the option is invalid
                      rather than left guessing. */}
                  <Step glyph="#️⃣" muted last
                    title={active.directDialEnabled
                      ? t("They can dial someone's extension")
                      : t("They can't dial an extension")}
                    sub={active.directDialEnabled
                      ? t("A caller who knows an extension can type it instead of picking from the menu.")
                      : t("If a caller types an extension we tell them that option is invalid.")}
                    actions={
                      <button className="btn sm" disabled={!canManage || saving}
                        onClick={() => patchProfile({ directDialEnabled: !active.directDialEnabled })}>
                        {active.directDialEnabled ? t("Turn off") : t("Turn on")}
                      </button>
                    } />
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

            {/* The Jewish calendar sits directly under the weekly hours, because
                that is what it takes over: yom tov and Shabbos stop being rows
                the customer types and become dates the system already knows. */}
            <JewishCalendarCard
              tenantId={tenantId}
              disabled={!canManage || saving}
              onSaved={() => { void loadAll(); }}
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
                <div><h2>{t("Teams")}</h2><div className="sub">{teamsLoading ? t("Loading…") : `${directory.teams.length} set up`}</div></div>
                <button className="btn sm" disabled={!canManage} onClick={() => setMakeTeamOpen(true)}>{t("New team")}</button>
              </div>
              <div className="card-b">
                <div className="reclist flat">
                  {/* "Still arriving" must not read as "you have none" — teams
                      load after first paint, so an empty list mid-flight is not
                      an answer yet. */}
                  {teamsLoading && <div className="dimtxt">{t("Loading…")}</div>}
                  {!teamsLoading && directory.teams.length === 0 && (
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
                      <button className="btn ghost sm" disabled={!canManage}
                        title={t("Delete this team")}
                        onClick={() => askDeleteTeam(tm)}>✕</button>
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
              <div className="card-h">
                <div><h2>{t("Recordings")}</h2><div className="sub">{prompts.length} available</div></div>
                {/* Making a recording used to be reachable ONLY from the
                    greeting step or a key editor, so anything made was
                    immediately assigned somewhere. This one just adds to the
                    library and leaves the menu alone. */}
                <button className="btn sm" disabled={!canManagePrompts}
                  onClick={() => { setMakeRecForKey(null); setMakeRecForLibrary(true); setMakeRecOpen(true); }}>
                  {t("Make a recording")}
                </button>
                {voiceChangerAllowed && (
                  <button className="btn sm" disabled={!canManagePrompts}
                    onClick={() => { setMakeRecForKey(null); setMakeRecForLibrary(true); setConvertOpen(true); }}>
                    {t("Change my voice")}
                  </button>
                )}
              </div>
              <div className="card-b">
                <div className="reclist flat">
                  {prompts.length === 0 && <div className="dimtxt">{t("No recordings yet.")}</div>}
                  {prompts.map((r) => (
                    <div key={r.id} className="recrow">
                      <button type="button" className="p"
                        title={playingRef === r.promptRef ? t("Stop playing") : t("Play this recording")}
                        aria-label={playingRef === r.promptRef ? t("Stop playing") : t("Play this recording")}
                        onClick={() => play(r.promptRef)}>{playingRef === r.promptRef ? "⏸" : "▶"}</button>
                      <button type="button" className="nm" onClick={() => play(r.promptRef)}>{r.displayName}</button>
                      {r.hasAudio === false && <span className="cur">no audio</span>}
                      {canManagePrompts && (
                        <>
                          <button type="button" className="rn" title={t("Rename this recording")}
                            aria-label={t("Rename this recording")}
                            onClick={() => setRenaming({ id: r.id, name: r.displayName })}>✎</button>
                          <button type="button" className="del" title={t("Delete this recording")}
                            aria-label={t("Delete this recording")} onClick={() => askDeleteRecording(r)}>🗑</button>
                        </>
                      )}
                    </div>
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

      {renaming && (() => {
        const typed = renaming.name.trim().toLowerCase();
        const taken = prompts.some((p) => p.id !== renaming.id && p.displayName.trim().toLowerCase() === typed);
        const canSave = Boolean(typed) && !taken && !saving;
        return (
          <div className="backdrop" onClick={() => { if (!saving) setRenaming(null); }}>
            <div className="dialog" onClick={(e) => e.stopPropagation()}>
              <h3>{t("Rename recording")}</h3>
              <label className="rnlbl">{t("What should it be called?")}</label>
              <input className="inp" autoFocus value={renaming.name}
                onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter" && canSave) void renameRecording(renaming.id, renaming.name); }} />
              <p className="dimtxt" style={{ margin: "8px 0 0" }}>
                {taken
                  ? t("That name is already taken by another recording.")
                  : t("Callers never hear this name — it's only so you can find the recording later.")}
              </p>
              <div className="foot">
                <button className="btn ghost" disabled={saving} onClick={() => setRenaming(null)}>{t("Cancel")}</button>
                <button className="btn primary" disabled={!canSave} onClick={() => void renameRecording(renaming.id, renaming.name)}>
                  {t("Save name")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmDelete && (
        <div className="backdrop" onClick={() => { if (!deleting) setConfirmDelete(null); }}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            {confirmDelete.blockers.length > 0 ? (
              <>
                <h3>{t("You can't delete this yet")}</h3>
                <p className="dimtxt" style={{ margin: "8px 0 0" }}>
                  <b>{confirmDelete.name}</b> — {t("It's still being used here:")}
                </p>
                <ul className="misslist">
                  {confirmDelete.blockers.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
                <p className="dimtxt" style={{ margin: "10px 0 0" }}>
                  {t("Change these to something else first, then you can delete it.")}
                </p>
                <div className="foot">
                  <button className="btn primary" onClick={() => setConfirmDelete(null)}>{t("Close")}</button>
                </div>
              </>
            ) : (
              <>
                <h3>{t("Are you sure you want to delete this?")}</h3>
                <p className="dimtxt" style={{ margin: "8px 0 0" }}>
                  <b>{confirmDelete.name}</b> — {t("Callers can't reach it any more, and it can't be brought back.")}
                </p>
                <div className="foot">
                  <button className="btn ghost" disabled={deleting} onClick={() => setConfirmDelete(null)}>{t("Cancel")}</button>
                  <button className="btn danger" disabled={deleting} onClick={() => void doDelete()}>
                    {deleting ? t("Deleting…") : t("Delete")}
                  </button>
                </div>
              </>
            )}
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
          onCreated={onRecordingCreated}
          onClose={() => { setMakeRecOpen(false); setMakeRecForKey(null); setMakeRecForLibrary(false); }}
          existingNames={prompts.map((p) => p.displayName)}
        />
      )}

      {convertOpen && (
        <ConvertRecording
          tenantQs={qs}
          apiBase={getPortalApiBaseUrl()}
          authToken={(typeof window !== "undefined" && (localStorage.getItem("token") || localStorage.getItem("cc-token"))) || ""}
          onCreated={onRecordingCreated}
          onClose={() => { setConvertOpen(false); setMakeRecForKey(null); setMakeRecForLibrary(false); }}
          existingNames={prompts.map((p) => p.displayName)}
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
function KeyEditor({ digit, current, directory, peopleLoaded, teamsLoaded, teamsLoading, pendingTeamNumbers, disabled, onSave, onClear, onClose, onCreateMenu, onMakeRecording, onConvertRecording, onUploadRecording, adoptPromptRef, onAdopted, onCreateForward, onMakeTeam, adoptTeamNumber, onAdoptedTeam }: {
  digit: string;
  current: OptionRow | null;
  directory: TenantDirectory;
  peopleLoaded: boolean;
  teamsLoaded: boolean;
  teamsLoading: boolean;
  /** Teams that exist but don't take calls until PBX changes are applied. */
  pendingTeamNumbers?: string[];
  disabled?: boolean;
  onSave: (kind: MenuChoiceKind, targetId: string, after?: AfterRecordingChoice) => void;
  onClear: () => void;
  onClose: () => void;
  onCreateMenu: () => void;
  /** Open the ElevenLabs modal for THIS key; the result comes back via adoptPromptRef. */
  onMakeRecording?: () => void;
  /** Only supplied when this person holds can_use_voice_changer. Undefined
   *  means the button is never rendered — not rendered-and-refused. */
  onConvertRecording?: () => void;
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
      // Teams load after first paint, so the editor can open before they land.
      // Saying "couldn't load" then would be false — and would send someone off
      // to check a PBX link that is perfectly fine.
      if (teamsLoading) return { k, blocked: "Still loading this customer's teams — one moment." };
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
                {onConvertRecording && (
                  <button className="btn sm" disabled={disabled} onClick={onConvertRecording}>{t("Change my voice")}</button>
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

  // What the DRAFT schedule says about this very moment, with the reason.
  // "Even though store is OPEN, all I hear is After hours greetings" was a
  // schedule with hours on Monday only — the other six days were "Closed all
  // day", so the system was right and the owner had no way to see why. This
  // line makes the schedule's verdict, and its reason, visible on the card.
  const rightNow = (() => {
    try {
      const tz = draft.timezone || "America/New_York";
      const now = new Date();
      const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      if (draft.holidayDates.includes(localDate)) return { open: false, why: `${localDate} is marked as a holiday` };
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
      const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const dayName = parts.find((p) => p.type === "weekday")?.value ?? "";
      const dow = DOW[dayName] ?? now.getDay();
      const mm = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10) * 60 + parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
      const toMin = (s: string) => { const [h, m] = s.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
      const r = draft.businessHoursRules.find((x) => x.day === dow);
      if (!r) return { open: false, why: `no opening hours are set for ${dayName === "Sun" ? "Sunday" : dayName === "Mon" ? "Monday" : dayName === "Tue" ? "Tuesday" : dayName === "Wed" ? "Wednesday" : dayName === "Thu" ? "Thursday" : dayName === "Fri" ? "Friday" : "Saturday"}` };
      if (mm >= toMin(r.open) && mm < toMin(r.close)) return { open: true, why: `${r.open}–${r.close} today` };
      return { open: false, why: `outside today's ${r.open}–${r.close}` };
    } catch { return null; }
  })();
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

        {rightNow && (
          <div className="rowmini" style={{ marginBottom: 10, alignItems: "center", gap: 8 }}>
            <span className="pill" style={{ background: rightNow.open ? "var(--ok)" : "var(--vm)", color: "#fff" }}>
              {rightNow.open ? t("Open right now") : t("Closed right now")}
            </span>
            <span className="dimtxt">
              {rightNow.open
                ? `Callers hear the open-hours menu (${rightNow.why}).`
                : `Callers hear the closed-hours menu — ${rightNow.why}.`}
            </span>
          </div>
        )}
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
          {/* Which menu plays ON those days. This selector did not exist — the
              date picker did, holidayProfileId was saved and honoured all the
              way down to the dialplan pointer, but no screen ever offered it.
              So a customer could build a Holiday Menu with a holiday greeting,
              add the dates, and the system silently played the CLOSED menu on
              the holiday instead: "Holiday's not working, even though set up
              and greetings are ready." The fallback (holiday → closed menu)
              stays for tenants that never pick one. */}
          {draft.holidayDates.length > 0 && (
            <div className="rowmini" style={{ marginTop: 10, alignItems: "center", gap: 8 }}>
              <span className="dimtxt">{t("On those days play")}</span>
              <select className="sel" disabled={disabled} value={draft.holidayProfileId ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, holidayProfileId: e.target.value || null }))}>
                <option value="">Same as when you&apos;re closed</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
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
        background:var(--panel);color:var(--text);cursor:pointer;display:inline-flex;align-items:center;gap:7px;transition:border-color .14s,color .14s,background-color .14s,opacity .14s,filter .14s;white-space:nowrap}
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
        border-radius:13px;background:var(--panel-2);display:flex;gap:13px;align-items:center;flex-wrap:wrap;transition:border-color .14s,color .14s,background-color .14s,opacity .14s,filter .14s}
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
        background:var(--panel-2);cursor:pointer;font-family:inherit;color:var(--text);transition:border-color .14s,color .14s,background-color .14s,opacity .14s,filter .14s}
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
        background:var(--panel-2);cursor:pointer;font-family:inherit;color:var(--text);text-align:left;transition:border-color .14s,color .14s,background-color .14s,opacity .14s,filter .14s}
      .ivrs .target:hover{border-color:var(--accent-line)}
      .ivrs .target.on{border-color:var(--accent);background:var(--accent-soft)}
      .ivrs .av{width:31px;height:31px;border-radius:9px;flex:none;display:grid;place-items:center;font-size:12px;font-weight:730;color:#fff}
      .ivrs .target .nm{min-width:0}
      .ivrs .target .nm b{display:block;font-size:13.5px;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ivrs .target .nm span{display:block;font-size:11.5px;color:var(--faint)}
      .ivrs .digitgrid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}
      .ivrs .digitbtn{aspect-ratio:1;border-radius:11px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);
        font:inherit;font-size:18px;font-weight:740;cursor:pointer;transition:border-color .14s,color .14s,background-color .14s,opacity .14s,filter .14s}
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
        background:var(--panel-2);cursor:pointer;font-family:inherit;color:var(--text);text-align:left;width:100%;transition:border-color .14s,color .14s,background-color .14s,opacity .14s,filter .14s}
      .ivrs .recrow:hover{border-color:var(--accent-line)}
      .ivrs .recrow.on{border-color:var(--accent)}
      .ivrs .recrow .p{width:28px;height:28px;border-radius:8px;flex:none;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);font-size:11px}
      .ivrs .recrow .nm{flex:1;font-size:13.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ivrs .recrow .cur{font-size:11.5px;color:var(--faint)}
      /* A row is a div now, not one big button, because it carries its own
         play and delete buttons — nesting a button in a button is invalid and
         Firefox drops the inner one. These reset the inner buttons back to
         looking like the spans they replaced. */
      .ivrs .recrow>button{border:none;background:none;font:inherit;color:inherit;cursor:pointer;padding:0}
      .ivrs .recrow>button.nm{text-align:left}
      .ivrs .recrow>button.p:hover{filter:brightness(1.08)}
      .ivrs .recrow .del,.ivrs .recrow .rn{width:28px;height:28px;border-radius:8px;flex:none;display:grid;place-items:center;
        color:var(--faint);font-size:13px;opacity:.65;transition:opacity .14s,color .14s,background-color .14s}
      /* Rename is not destructive, so it must not turn red on hover — the
         colour is the only thing telling these two icons apart at a glance. */
      .ivrs .recrow .rn:hover{opacity:1;color:var(--accent);background:var(--accent-soft)}
      .ivrs .recrow .del:hover{opacity:1;color:var(--danger,#e5484d);background:rgba(229,72,77,.12)}
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
      /* ── Jewish calendar ────────────────────────────────────────────────
         Ported from the approved mockup rather than re-derived, and built on
         the Studio's own tokens so it belongs to this screen.

         ⛔ THE RULE: a Yiddish holiday name is an RTL island INSIDE an LTR
         layout. .jc-he is the only place direction is touched, and
         unicode-bidi: isolate is what keeps the punctuation and digits next
         to it in place. Never put dir or direction on a row or a card —
         that mirrors the page, which Izzy explicitly ruled out. */
      .ivrs .jc-he{font-family:"Frank Ruhl Libre","Times New Roman",serif;direction:rtl;unicode-bidi:isolate}

      .ivrs .jc-headright{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
      .ivrs .jc-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
      .ivrs .jc-segbtn{background:var(--bg-soft);border:none;color:var(--dim);font:inherit;font-size:12px;
        font-weight:600;padding:5px 12px;cursor:pointer}
      .ivrs .jc-segbtn + .jc-segbtn{border-left:1px solid var(--line)}
      .ivrs .jc-segbtn.on{background:var(--accent);color:#04121d}
      .ivrs .jc-segyi{font-family:"Frank Ruhl Libre","Times New Roman",serif;font-size:14px;direction:rtl;unicode-bidi:isolate}
      .ivrs .jc-toggle{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--dim);cursor:pointer}

      .ivrs .jc-strip{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--bg-soft);
        border:1px solid var(--line);border-radius:10px;padding:10px 13px;margin-bottom:16px;font-size:12.5px}
      .ivrs .jc-pill-music{background:var(--menu);color:#1b1030;border-color:var(--menu)}
      .ivrs .jc-err{background:rgba(226,96,106,.12);border:1px solid var(--stop);color:var(--text);
        border-radius:9px;padding:10px 13px;margin-bottom:14px;font-size:13px}
      .ivrs .jc-hint{margin-top:5px;font-size:12px;line-height:1.45}
      .ivrs .jc-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
      .ivrs .jc-row > .field{flex:1 1 210px;margin-bottom:0}

      .ivrs .jc-opts{display:flex;flex-direction:column;gap:8px}
      .ivrs .jc-opt{display:flex;gap:10px;align-items:flex-start;text-align:left;width:100%;
        padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg-soft);
        color:inherit;font:inherit;cursor:pointer}
      .ivrs .jc-opt.on{border-color:var(--accent-line);background:var(--accent-soft)}
      .ivrs .jc-opt:disabled{opacity:.55;cursor:default}
      .ivrs .jc-dot{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--faint);
        flex:0 0 auto;margin-top:3px;position:relative}
      .ivrs .jc-opt.on .jc-dot{border-color:var(--accent)}
      .ivrs .jc-opt.on .jc-dot::after{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--accent)}
      .ivrs .jc-opttext b{display:block;font-size:13px;font-weight:600}
      .ivrs .jc-opttext span{display:block;font-size:12px;color:var(--dim);margin-top:2px;line-height:1.45}

      .ivrs .jc-sub{border-top:1px solid var(--line-soft);margin-top:18px;padding-top:16px}
      .ivrs .jc-sub h3{margin:0 0 4px;font-size:13.5px;font-weight:600}
      .ivrs .jc-checks{display:flex;gap:18px;flex-wrap:wrap;margin-top:4px}
      .ivrs .jc-check{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer}

      /* the holiday list */
      .ivrs .jc-hlist{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:10px}
      .ivrs .jc-hrow{display:grid;grid-template-columns:1.3fr 1.5fr 1fr auto;gap:10px;align-items:center;
        padding:9px 12px;border-bottom:1px solid var(--line);border-left:3px solid var(--line);background:var(--panel)}
      .ivrs .jc-hrow:last-child{border-bottom:none}
      .ivrs .jc-stripe-yt{border-left-color:var(--menu)}
      .ivrs .jc-stripe-chm{border-left-color:var(--ok)}
      .ivrs .jc-stripe-no{border-left-color:var(--line)}
      .ivrs .jc-hname{font-size:13px;font-weight:600}
      .ivrs .jc-hname em{display:block;font-style:normal;font-size:11.5px;color:var(--faint);font-weight:400;margin-top:1px}
      .ivrs .jc-hwhen{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
      .ivrs .jc-auto{font-size:11.5px}
      @media(max-width:760px){
        .ivrs .jc-hrow{grid-template-columns:1fr 1fr}
        .ivrs .jc-hwhen{grid-column:1/-1}
      }

      /* the month view */
      .ivrs .jc-modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:18px}
      .ivrs .jc-backdrop{position:absolute;inset:0;background:rgba(4,10,16,.62)}
      .ivrs .jc-sheet{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);
        box-shadow:var(--shadow);max-width:1000px;width:100%;max-height:92vh;display:flex;flex-direction:column}
      .ivrs .jc-sheeth{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;
        padding:15px 18px 13px;border-bottom:1px solid var(--line)}
      .ivrs .jc-sheeth h3{margin:0 0 2px;font-size:15px;font-weight:600}
      .ivrs .jc-sheetb{padding:16px 18px 20px;overflow-y:auto;min-height:0}
      .ivrs .jc-preview{background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:9px;
        padding:9px 12px;margin-bottom:13px;font-size:12.5px}
      .ivrs .jc-calbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
      .ivrs .jc-mo{font-size:16px;font-weight:600}
      .ivrs .jc-spacer{flex:1}
      .ivrs .jc-scrollx{overflow-x:auto}
      .ivrs .jc-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;min-width:640px}
      .ivrs .jc-dow{font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
        color:var(--faint);text-align:center;padding-bottom:3px}
      .ivrs .jc-cell{background:var(--bg-soft);border:1px solid var(--line);border-left-width:3px;
        border-radius:9px;padding:6px 7px;min-height:84px;display:flex;flex-direction:column;gap:2px;
        cursor:pointer;text-align:left;font:inherit;color:inherit}
      .ivrs .jc-cell:hover{border-color:var(--accent-line)}
      .ivrs .jc-blank{background:transparent;border-color:transparent;cursor:default;min-height:0}
      .ivrs .jc-sel{outline:2px solid var(--accent);outline-offset:1px}
      .ivrs .jc-today{box-shadow:inset 0 0 0 1px var(--accent-line)}
      .ivrs .jc-gd{font-size:13.5px;font-weight:600;line-height:1.1}
      .ivrs .jc-lb{font-size:11px;font-weight:600;line-height:1.25}
      .ivrs .jc-music{font-size:11px;color:var(--menu)}
      .ivrs .jc-tm{font-size:10.5px;color:var(--faint);margin-top:auto;font-variant-numeric:tabular-nums}
      .ivrs .jc-yt{border-left-color:var(--menu);background:rgba(169,143,224,.09)}
      .ivrs .jc-yt .jc-lb{color:var(--menu)}
      .ivrs .jc-sh{border-left-color:var(--team);background:rgba(59,160,242,.07)}
      .ivrs .jc-sh .jc-lb{color:var(--team)}
      .ivrs .jc-er{border-left-color:var(--vm)}
      .ivrs .jc-er .jc-lb{color:var(--vm)}
      .ivrs .jc-chm{border-left-color:var(--ok)}
      .ivrs .jc-chm .jc-lb{color:var(--ok)}
      .ivrs .jc-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:12px;font-size:11.5px;color:var(--dim)}
      .ivrs .jc-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}
      .ivrs .jc-sw-yt{background:var(--menu)}
      .ivrs .jc-sw-sh{background:var(--team)}
      .ivrs .jc-sw-er{background:var(--vm)}
      .ivrs .jc-sw-chm{background:var(--ok)}
      .ivrs .jc-sw-no{background:var(--line)}
      .ivrs .jc-day{margin-top:14px;background:var(--bg-soft);border:1px solid var(--line);
        border-radius:10px;padding:13px 15px}
      .ivrs .jc-day h4{margin:0 0 2px;font-size:14px;font-weight:600}
      .ivrs .jc-verdict{font-size:13px;font-weight:600;margin:7px 0 5px}
      .ivrs .holidays{display:flex;flex-wrap:wrap;gap:7px;align-items:center;min-height:22px}
      .ivrs .hchip{display:inline-flex;align-items:center;gap:6px;font-size:12px;background:var(--bg-soft);border:1px solid var(--line);border-radius:999px;padding:4px 6px 4px 11px}
      .ivrs .hchip button{background:none;border:none;color:var(--dim);cursor:pointer;font-size:15px;line-height:1;padding:0 4px}
      /* dialog */
      .ivrs .backdrop{position:fixed;inset:0;background:rgba(4,10,17,.6);display:grid;place-items:center;padding:22px;z-index:70}
      .ivrs .dialog{background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);width:min(440px,100%);padding:20px}
      .ivrs .dialog h3{margin:0 0 6px;font-size:17px;font-weight:670}
      .ivrs .dialog .inp{margin-top:13px;font-size:15px;padding:11px 13px}
      .ivrs .rnlbl{display:block;font-size:11.5px;font-weight:640;color:var(--dim);margin:14px 0 0}
      .ivrs .check{display:flex;align-items:center;gap:9px;margin-top:13px;font-size:13.5px;cursor:pointer;color:var(--dim)}
      .ivrs .check input{width:16px;height:16px;accent-color:var(--accent);cursor:pointer}
      .ivrs .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--accent);
        color:var(--text);padding:12px 19px;border-radius:12px;box-shadow:var(--shadow);font-size:13.5px;font-weight:620;z-index:80;max-width:min(520px,92vw);text-align:center}
    `}</style>
  );
}

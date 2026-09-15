"use client";

/**
 * Set Up My Phones.
 *
 * ⛔⛔ THE SCREENS ARE THE APPROVED MOCKUP, PORTED. Same steps, same order, same
 * words, same classes. Izzy, 2026-08-21: "make everything exactly 100% on the dot
 * like the mock-ups." This repo has shipped a screen built from a mockup's
 * structure with its own styling before, and the report claiming it matched had
 * never put the two side by side.
 *
 * ⛔ The customer never sees a hardware address, an IP, a provisioning URL or a
 * status code. Everything on this screen comes from the API's customer view, which
 * strips all of that at the source rather than here.
 *
 * ⛔ Discovery needs the desktop app, because a web page cannot see an office
 * network. When it is missing the wizard says so in plain words instead of failing
 * with a blank list, which would read as "you have no phones".
 */

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  classifyDiscoveredHosts,
  shouldFingerprint,
  deviceKindFor,
  describeKind,
  needsIdentifying,
  type DeviceKind,
} from "@connect/shared";
import { orderPhonesByMake, toldUsPhrase } from "./makeHint";
import { IdentityPicker, SerialStickerDrawing, StickerDrawing } from "./PhoneIdentity";
import { ManagedPhonePanel } from "./ManagedPhonePanel";
import { apiGet, apiPost, apiUploadDeskPhoneLabelPhoto } from "../../services/apiClient";
import { ConnectSelect } from "../ConnectSelect";
import { createSetupDriver, type NeedsPerson } from "./setupDriver";
import { getRecordingToken } from "../../services/recordingPlayback";
import "./deskPhones.css";

type CustomerPhone = {
  id: string;
  /** Formatted hardware address (aa:bb:cc:dd:ee:ff) — shown on every phone row
   * since 2026-08-25 (Izzy, live at A plus center: "mac addresses should all be
   * displayed"). It is the sticker under the handset, i.e. how a person tells
   * two identical phones apart. */
  mac: string | null;
  model: string | null;
  vendor: string | null;
  displayName: string | null;
  extNumber: string | null;
  /** Whether this phone's extension is registered to the phone system RIGHT NOW
   * — the record says whose phone it is, only this says it is connected. A
   * factory-reset phone keeps its name and loses this (ext-103 test, 2026-08-25). */
  connectedNow?: boolean | null;
  /** False once the person left this phone unticked on the found screen. */
  selected?: boolean;
  /** Its address on the office network, shown beside the hardware address (2026-09-14). */
  ip?: string | null;
  /** Whether the maker's serial number is already on file — the extension screen asks when not. */
  serialOnFile?: boolean;
  /** What kind of thing it is, from everything it and its maker said about itself. */
  deviceType?: string | null;
  deviceTypeLabel?: string | null;
  identityConfidence?: string | null;
  provisioningStatus?: string | null;
  provisioningStatusLabel?: string | null;
  status: "Finding" | "Preparing" | "Restarting" | "Connecting" | "Ready" | "Needs attention";
  note: string | null;
  needsAttention: boolean;
};

type RunSummary = {
  total: number; ready: number; working: number; needsAttention: number;
  finished: boolean; headline: string;
};

type Step =
  | "welcome" | "knowPhone" | "connection" | "network"
  | "searching" | "found" | "match" | "resetAuth" | "ready" | "live" | "done";

const STEP_ORDER: Step[] = ["welcome", "knowPhone", "connection", "network", "found", "match", "ready", "live"];

function desktop(): any | null {
  if (typeof window === "undefined") return null;
  return (window as any).connectDesktop ?? null;
}


/** ⛔ The photo comes from the PBX's own product images, filed under the model name.
 * ⛔⛔ The token rides the QUERY STRING because an <img> sends no Authorization
 * header — without it every photo request was refused and the pictures never
 * showed (found live at A plus center, 2026-08-25). The api's global preHandler
 * copies ?token= into Authorization; this is the recordings player's exact
 * pattern (getRecordingToken + ?token=). */
function photoFor(model: string | null): string | null {
  const m = String(model ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!m) return null;
  const token = getRecordingToken();
  const base = `/api/desk-phones/photo/${encodeURIComponent(m)}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/**
 * The product photo, with a fallback that is HONEST ABOUT THE KIND OF THING.
 *
 * ⛔⛔ 94 of the PBX's 427 models ship no picture at all (measured 2026-09-10) — and it
 * is not a random 94: EVERY Grandstream HT and EVERY Dinstar DAG is missing, i.e. the
 * whole ATA family, plus all 39 newer Polycom and 33 Flying Voice models. Five of the
 * seven Grandstream devices actually provisioned on this platform today are HTs. So a
 * missing photo is the NORMAL case for a box, not an edge case, and no amount of waiting
 * for VitalPBX will fix it.
 *
 * ⛔ Which is why the fallback is drawn PER KIND rather than as one desk-phone glyph:
 * showing a picture of a telephone for an HT812 sends the customer looking for a phone
 * that does not exist on their shelf. The words already worked this way (`describe()`
 * routes through `describeKind`); the picture now agrees with them.
 */
function PhonePhoto({ model, alt }: { model: string | null; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const src = photoFor(model);
  if (!src || failed) return <KindGlyph kind={deviceKindFor(model)} />;
  return <img src={src} alt={alt ?? ""} onError={() => setFailed(true)} />;
}

/**
 * A sentence a person can match to the thing on the desk, the wall or the ceiling.
 * ⛔ Not just desk phones any more (Izzy, 2026-08-22): an HT box, a cordless base,
 * a ceiling speaker and a door intercom each get words for what they LOOK like,
 * never a category name.
 */
function describe(model: string | null): string {
  const m = String(model ?? "").toUpperCase();
  const kind = deviceKindFor(m);
  if (kind !== "desk_phone" && kind !== "unknown") return describeKind(kind);
  if (/T5[4-8]/.test(m)) return "Big colour screen, buttons down the side";
  if (/T4[6-8]/.test(m)) return "Colour screen, several buttons";
  if (/T4[0-4]/.test(m)) return "Small screen, plain black handset";
  if (/T29|T27/.test(m)) return "Large phone, lots of buttons";
  if (/T3[0-4]/.test(m)) return "Small desk phone";
  if (/CP/.test(m)) return "Conference room speakerphone";
  if (/GXP|GRP|^X\d/.test(m)) return "Desk phone";
  return describeKind(kind);
}

/** How long the live screen waits with no phone moving before it stops and says so. */
export const LIVE_NO_PROGRESS_TIMEOUT_MS = 10 * 60 * 1000;

export function DeskPhoneWizard({ onClose }: { onClose: () => void }) {
  const [managedMode, setManagedMode] = useState(false);
  const [managedModels, setManagedModels] = useState<{ model: string }[]>([]);
  /** Carries a found phone's identity into the zero-touch panel (MAC only — the serial never reaches the browser). */
  const [managedPrefill, setManagedPrefill] = useState<{ mac?: string | null; model?: string | null } | null>(null);
  useEffect(() => {
    let active = true;
    apiGet<{ enabled: boolean; models: { model: string }[] }>("/desk-phones/managed/capabilities")
      .then(result => { if (active && result.enabled) setManagedModels(result.models); })
      .catch(() => { /* Existing office setup remains available. */ });
    return () => { active = false; };
  }, []);
  const [step, setStep] = useState<Step>("welcome");
  const [runId, setRunId] = useState<string | null>(null);
  const [phones, setPhones] = useState<CustomerPhone[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [subnet, setSubnet] = useState<string | null>(null);
  const [extensions, setExtensions] = useState<Array<{ id: string; extNumber: string; displayName: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [knowsPhone, setKnowsPhone] = useState<"yes" | "no" | null>(null);
  const [phoneBrand, setPhoneBrand] = useState("");
  const [phoneNameHint, setPhoneNameHint] = useState("");
  const [connection, setConnection] = useState<"cable" | "wifi" | "unsure" | null>(null);
  const [othersCount, setOthersCount] = useState(0);
  // Phones the phone system already runs for this customer that THIS network scan
  // could not see (usually a separate phone network in the same building). Shown
  // as context on the found screen so a short list never reads as lost phones.
  const [knownElsewhere, setKnownElsewhere] = useState<Array<{ mac: string; model: string | null; vendor: string | null; name: string | null; connectedNow?: boolean | null }>>([]);
  const [needs, setNeeds] = useState<NeedsPerson[]>([]);
  /** Per-phone, plain-English: what this computer is doing for that phone right now. */
  const [hints, setHints] = useState<Record<string, string>>({});
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  /** Per-phone serial number being typed for the maker's cloud. */
  const [serialDrafts, setSerialDrafts] = useState<Record<string, string>>({});
  /** Phones already asked about in their maker's cloud this session (asked once each). */
  const cloudLookedUpRef = useRef<Set<string>>(new Set());
  /** Per-phone make/model the person is picking, before they save it. */
  const [identifyDraft, setIdentifyDraft] = useState<Record<string, { make: string; model: string }>>({});
  const [identifyError, setIdentifyError] = useState<Record<string, string>>({});
  const [identifyBusy, setIdentifyBusy] = useState<Record<string, boolean>>({});

  /** Which devices are ticked on the clearing screen. ⛔ The person picks; default all. */
  const [clearTicks, setClearTicks] = useState<Record<string, boolean>>({});
  /**
   * Which phones the person wants set up, from the found screen. ⛔ A partial
   * override map: a phone with no entry takes the default — TICKED when it is not
   * connected right now (a factory-reset or unplugged phone is exactly what this
   * wizard is for), UNTICKED when it is already connected (a working phone is left
   * alone unless the person asks). Izzy, 2026-09-02, testing on one reset phone:
   * "I want to be able to select which phone I want to provision … it should pick
   * up 'Not Connected' automatically."
   */
  const [picks, setPicks] = useState<Record<string, boolean>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const driverRef = useRef<ReturnType<typeof createSetupDriver> | null>(null);
  const tickingRef = useRef(false);

  const hasDesktop = Boolean(desktop()?.phoneSetup);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const loadRun = useCallback(async (id: string) => {
    const out = await apiGet<{ phones: CustomerPhone[]; summary: RunSummary; run: { subnet: string | null } }>(
      `/desk-phones/runs/${id}`,
    );
    setPhones(out.phones);
    setSummary(out.summary);
    setSubnet(out.run.subnet);
    return out;
  }, []);

  /*
    ⛔ A phone we know the MAKER of but not the MODEL is asked about in that maker's cloud, once,
    as soon as the list shows it (Izzy, 2026-09-14: the second GXP "didn't try to look up the other
    MAC addresses to find out what model phones they are"). Read-only at the maker; the server
    answers "not connected" honestly for a maker with no cloud, and a phone that is not in the
    cloud account stays unnamed — the label box below is still there for it.
  */
  useEffect(() => {
    if (!runId || (step !== "found" && step !== "match")) return;
    const unnamed = phones.filter((p) => !p.model && /grandstream|yealink|fanvil|poly/i.test(p.vendor ?? "") && !cloudLookedUpRef.current.has(p.id));
    if (!unnamed.length) return;
    for (const p of unnamed) cloudLookedUpRef.current.add(p.id);
    void (async () => {
      let learned = false;
      for (const p of unnamed) {
        const r = await apiPost<any>(`/desk-phones/runs/${runId}/phones/${p.id}/vendor-lookup`, {}).catch(() => null);
        if (r?.ok && r.phone?.model) learned = true;
      }
      if (learned) await loadRun(runId).catch(() => null);
    })();
  }, [runId, step, phones, loadRun]);

  const start = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const out = await apiPost<{ run: { id: string } }>("/desk-phones/runs", {
        deviceLabel: typeof navigator !== "undefined" ? navigator.platform : undefined,
      });
      setRunId(out.run.id);
      const ext = await apiGet<{ extensions: Array<{ id: string; extNumber: string; displayName: string }> }>(
        "/desk-phones/extensions",
      ).catch(() => ({ extensions: [] }));
      setExtensions(ext.extensions ?? []);
      setStep("knowPhone");
    } catch {
      setError("We could not start setup just now. Try again in a moment.");
    } finally { setBusy(false); }
  }, []);

  const search = useCallback(async () => {
    if (!runId) return;
    setStep("searching"); setError(null);
    const bridge = desktop()?.phoneSetup;
    if (!bridge) {
      // ⛔ Said plainly. An empty list here would read as "this office has no phones".
      setError("Phone setup needs the Loopcom app on a computer in the same office as your phones.");
      setStep("welcome");
      return;
    }
    try {
      const scan = await bridge.run({ op: "discover" });
      if (!scan?.ok) {
        setError("We could not search this network. Make sure this computer is on your office Wi-Fi or network cable.");
        setStep("welcome");
        return;
      }
      // ⛔⛔ A FAILED SCAN IS NEVER SHOWN AS AN EMPTY OFFICE. The very first live
      // run (2026-08-23) failed exactly here — the machine sat on a network shape
      // the scanner would not sweep — and this screen showed "we found 0 phones",
      // which reads as "you have no phones" when the truth was "we never looked".
      // The scanner writes its reason in plain words; show that, stay on this
      // step, and let the person try again or call us.
      if (scan.scan?.outcome === "failed") {
        setError(
          String(scan.scan?.note || "We could not look at this network from this computer.").slice(0, 300) +
          " If this keeps happening, Loopcom Support can take a look with you.",
        );
        setStep("network");
        return;
      }
      const hosts: Array<{ ip: string; mac: string; respondedOnHttp?: boolean; respondedOnSip?: boolean; fingerprint?: any }> = scan.scan?.hosts ?? [];
      // ⛔ Fingerprint only plausible candidates. A silent host on an unknown
      // hardware block is a laptop or a printer; spending four seconds and a rate
      // slot on each of them stalls the search for nothing.
      // ⛔ The scan itself may ALREADY carry the identity — the SIP probe reads
      // make + model off any SIP device, web page locked or not (2026-08-25).
      // A scan-provided fingerprint with a model is final; never overwrite it
      // with a per-host call, and never null it out for an implausible-looking
      // host — the device itself has spoken.
      const enriched: any[] = [];
      for (const h of hosts) {
        if (h.fingerprint?.model) { enriched.push(h); continue; }
        if (!shouldFingerprint(h)) { enriched.push({ ...h, fingerprint: h.fingerprint ?? null }); continue; }
        const fp = await bridge.run({ op: "fingerprint", ip: h.ip }).catch(() => null);
        enriched.push({ ...h, fingerprint: fp?.ok ? fp.fingerprint : (h.fingerprint ?? null) });
      }
      // ⛔⛔ ONLY DEVICES WITH EVIDENCE OF BEING A PHONE ARE SUBMITTED. Before this
      // filter, every ARP entry went to the server — an office with four phones and
      // nineteen other devices opened on "We found 23 desk phones", with the
      // printer fleet dressed up as broken phones.
      const verdict = classifyDiscoveredHosts(enriched);
      setOthersCount(verdict.othersCount);
      // ⛔ `identitySource` says HOW the device named itself, so the server files it as its
      // own identification source. A device that said nothing reports "none": the server
      // then relies on the hardware address and the maker's cloud, and never records a
      // blank reading as evidence. An older desktop build sends no source at all.
      const found = verdict.phones.map((h: any) => ({
        mac: h.mac, ip: h.ip,
        vendor: h.fingerprint?.vendor ?? undefined,
        model: h.fingerprint?.model ?? undefined,
        firmware: h.fingerprint?.firmware ?? undefined,
        identitySource: typeof h.fingerprint?.source === "string"
          ? h.fingerprint.source
          : (h.fingerprint?.model || (h.fingerprint?.vendor && h.fingerprint.vendor !== "unknown")) ? undefined : "none",
      }));
      const out = await apiPost<{ phones: CustomerPhone[]; subnet: string | null; knownElsewhere?: Array<{ mac: string; model: string | null; vendor: string | null; name: string | null; connectedNow?: boolean | null }> }>(
        `/desk-phones/runs/${runId}/discovered`,
        { subnet: scan.scan?.subnet ?? undefined, phones: found },
      );
      setPhones(out.phones);
      setSubnet(out.subnet);
      setKnownElsewhere(out.knownElsewhere ?? []);
      setStep("found");
    } catch {
      setError("Something went wrong while searching. Try again.");
      setStep("welcome");
    }
  }, [runId]);

  /**
   * WHAT THIS PHONE IS, when we could not read it ourselves.
   *
   * ⛔⛔ THIS IS THE ONE CONTROL THAT ANSWERS `model_unknown`. Until it existed the
   * wizard printed "Tell us the make and model on the back of this phone" at somebody and
   * gave them nowhere to say it — so a phone our fingerprint could not read could never
   * be finished, however many times they pressed anything.
   *
   * ⛔ The refusal is shown ON THAT PHONE'S ROW, not as the page-wide error: with several
   * phones on screen, a message at the top does not say which one it is about.
   */
  const identify = useCallback(async (phoneId: string, make: string, model: string) => {
    if (!runId || !model) return;
    setIdentifyBusy((b) => ({ ...b, [phoneId]: true }));
    setIdentifyError((e) => ({ ...e, [phoneId]: "" }));
    try {
      await apiPost(`/desk-phones/runs/${runId}/phones/${phoneId}/identify`, { make: make || null, model });
      setIdentifyDraft((d) => { const next = { ...d }; delete next[phoneId]; return next; });
      await loadRun(runId);
    } catch (err: any) {
      // ⛔ `.body`, never `.payload` — ApiError exposes the server's JSON as `body`, and
      // the field that carries the plain sentence is `message`. Reading `.payload` is the
      // documented way this codebase turns a full explanation into a bare slug on screen.
      const said = err?.body?.message;
      setIdentifyError((e) => ({ ...e, [phoneId]: said || "That could not be saved. Try again." }));
    } finally {
      setIdentifyBusy((b) => ({ ...b, [phoneId]: false }));
    }
  }, [runId, loadRun]);

  /**
   * WHAT THE LABEL SAYS, typed — or scanned, because a handheld barcode scanner types
   * into a text box exactly like a keyboard, so this one field is the barcode fallback
   * too (2026-09-14). The server reads the serial number, the hardware address and the
   * model off the text, and refuses a label that belongs to a different device.
   * ⛔ Refusals land on this phone's row, read off `.body` — the same rules as above.
   */
  const [labelDraft, setLabelDraft] = useState<Record<string, string>>({});
  const scanLabel = useCallback(async (phoneId: string, text: string) => {
    const said = text.trim();
    if (!runId || !said) return;
    setIdentifyBusy((b) => ({ ...b, [phoneId]: true }));
    setIdentifyError((e) => ({ ...e, [phoneId]: "" }));
    try {
      await apiPost(`/desk-phones/runs/${runId}/phones/${phoneId}/scan-label`, { text: said.slice(0, 600) });
      setLabelDraft((d) => { const next = { ...d }; delete next[phoneId]; return next; });
      await loadRun(runId);
    } catch (err: any) {
      const reason = err?.body?.message;
      setIdentifyError((e) => ({ ...e, [phoneId]: reason || "That label could not be read. Pick the make and model instead." }));
    } finally {
      setIdentifyBusy((b) => ({ ...b, [phoneId]: false }));
    }
  }, [runId, loadRun]);

  /** The line under a phone's name: what it looks like and what kind of thing it is — never the same words twice. */
  const hardwareLine = (p: CustomerPhone): string => {
    const named = [p.vendor, p.model].filter(Boolean).join(" ");
    const looks = p.displayName ? (named || describe(p.model)) : describe(p.model);
    const kind = p.deviceType && p.deviceType !== "unknown" ? (p.deviceTypeLabel ?? null) : null;
    return kind && !looks.toLowerCase().includes(kind.toLowerCase()) ? `${looks} · ${kind}` : looks;
  };

  const assign = useCallback(async (phoneId: string, extensionId: string | null) => {
    if (!runId) return;
    try {
      await apiPost(`/desk-phones/runs/${runId}/phones/${phoneId}/assign`, { extensionId });
      await loadRun(runId);
    } catch { setError("That could not be saved. Try again."); }
  }, [runId, loadRun]);

  /** "Try again" on a stuck phone's live row. The server never gives back a reset already spent. */
  const retryPhone = useCallback(async (phoneId: string) => {
    if (!runId) return;
    setError(null);
    try {
      await apiPost(`/desk-phones/runs/${runId}/phones/${phoneId}/retry`, {});
      await loadRun(runId);
    } catch (err: any) {
      setError(err?.body?.message || "That phone could not be tried again just now.");
    }
  }, [runId, loadRun]);

  /**
   * ⛔⛔ THE LIVE STEP DRIVES, IT DOES NOT MERELY WATCH. Each tick asks the server
   * what each phone needs, performs the instructions this machine can perform
   * (default-credential check, fetch-your-settings, re-find after a restart),
   * reports what it observed, and surfaces the two things only a person may do —
   * approving a wipe, and typing a password. Found on the 2026-08-22 review pass:
   * before this, nothing called advance and setup could never finish.
   */
  /**
   * ⛔ Izzy, 2026-09-14: "the thing is still spinning … saying Preparing. There's no cancel
   * button, and there should be a timeout." The live screen stops driving once no phone has
   * moved for this long, says so plainly, and offers Keep trying or Cancel setup — never an
   * endless spinner. (The standing PnP listener on this computer is unaffected.)
   */
  const [timedOut, setTimedOut] = useState(false);
  const progressRef = useRef<{ sig: string; at: number }>({ sig: "", at: 0 });

  const cancelSetup = useCallback(async () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    driverRef.current = null;
    // Ends the run on the server, so reopening the wizard starts a clean setup.
    if (runId) await apiPost(`/desk-phones/runs/${runId}/office-stop`, {}).catch(() => null);
    onClose();
  }, [runId, onClose]);

  const beginSetup = useCallback(async () => {
    if (!runId) return;
    setStep("live");
    setTimedOut(false);
    progressRef.current = { sig: "", at: Date.now() };
    if (pollRef.current) clearInterval(pollRef.current);
    const bridge = desktop()?.phoneSetup ?? null;
    // ⛔ onProgress paints a row the moment a step STARTS — a factory reset is seconds of
    // silence, and a row that only changes afterwards shows nothing while it matters most.
    driverRef.current = createSetupDriver(
      runId, { get: apiGet, post: apiPost }, bridge, undefined,
      (phoneId, text) => setHints((h) => ({ ...h, [phoneId]: text })),
    );
    const tickNow = async () => {
      // ⛔ Re-entry guard: a slow tick (each phone can cost a 4-second probe) must
      // not overlap the next interval firing, or two ticks advance the same phone.
      if (tickingRef.current || !driverRef.current) return;
      tickingRef.current = true;
      try {
        const out = await driverRef.current.tick();
        setPhones(out.phones);
        setSummary(out.summary);
        setNeeds(out.needs);
        setHints((h) => ({ ...h, ...(out.hints ?? {}) }));
        // Progress = any phone's status or note changing. Nothing moving for the whole
        // window stops the loop instead of spinning forever.
        const sig = JSON.stringify((out.phones ?? []).map((p: any) => [p.id, p.status, p.note ?? null]));
        const nowMs = Date.now();
        if (sig !== progressRef.current.sig) progressRef.current = { sig, at: nowMs };
        else if (nowMs - progressRef.current.at > LIVE_NO_PROGRESS_TIMEOUT_MS) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setTimedOut(true);
          return;
        }
        /*
          ⛔⛔ THE FINISHED SCREEN MEANS EVERY PHONE CAN MAKE CALLS (Izzy, 2026-09-14: "the
          confirmation screen should never come up unless the phone is up and registered,
          ready to make calls"). A run that stopped with a phone needing attention stays on
          this screen, which names what is wrong and offers "Try again" on that row.
        */
        if (out.finished && out.summary && out.summary.total > 0 && out.summary.ready === out.summary.total) {
          if (pollRef.current) clearInterval(pollRef.current);
          setStep("done");
        }
      } catch { /* the next tick looks again */ }
      finally { tickingRef.current = false; }
    };
    void tickNow();
    pollRef.current = setInterval(tickNow, 4000);
  }, [runId]);

  /**
   * The person pressed the big button on the clearing screen. ⛔ Only the TICKED
   * devices are approved; the unticked ones are recorded as a deliberate no, which
   * ends their setup kindly rather than re-asking forever.
   */
  const approveReset = useCallback(async (allIds: string[]) => {
    if (!runId) return;
    const ticked = allIds.filter((id) => clearTicks[id] !== false);
    const declined = allIds.filter((id) => clearTicks[id] === false);
    if (declined.length) driverRef.current?.declineReset(declined);
    if (!ticked.length) {
      setNeeds((n) => n.filter((x) => x.kind !== "reset_authorization"));
      return;
    }
    try {
      await apiPost(`/desk-phones/runs/${runId}/authorize-reset`, { phoneIds: ticked });
      setNeeds((n) => n.filter((x) => x.kind !== "reset_authorization"));
    } catch (e: any) {
      // The api's own refusal is already plain English ("You are not allowed to
      // clear a phone. Ask somebody who is.").
      setError(e?.body?.message || "That could not be approved from this account.");
    }
  }, [runId, clearTicks]);

  /** "Skip all of these for now" — a deliberate no for every device on the screen. */
  const declineAllResets = useCallback((allIds: string[]) => {
    driverRef.current?.declineReset(allIds);
    setNeeds((n) => n.filter((x) => x.kind !== "reset_authorization"));
  }, []);

  /**
   * The serial number off the phone's label, for the maker's cloud. ⛔ Sent through the same
   * label route the found screen uses, so the server refuses a label from a different phone and
   * stores only what the label really says.
   */
  const supplySerial = useCallback(async (phoneId: string, label: string) => {
    if (!runId) return;
    const typed = (serialDrafts[phoneId] ?? "").trim();
    if (!typed) return;
    const text = /\b(S\/?N|SN|SERIAL)\b/i.test(typed) ? typed : `S/N: ${typed}`;
    try {
      await apiPost(`/desk-phones/runs/${runId}/phones/${phoneId}/scan-label`, { text: text.slice(0, 600) });
      driverRef.current?.serialProvided(phoneId);
      setSerialDrafts((d) => { const { [phoneId]: _gone, ...rest } = d; return rest; });
      setNeeds((n) => n.filter((x) => !(x.kind === "serial" && x.phoneId === phoneId)));
      setError(null);
      // ⛔ Re-read the run, so the row's own `serialOnFile` flips and the box on the extension
      // screen takes itself away. Without this the person types the serial, it IS saved, and the
      // field just sits there — which reads as "it didn't work" and invites a second entry.
      await loadRun(runId);
    } catch (err: any) {
      setError(err?.body?.message || `The serial number for ${label} could not be read. Check it against the label and try again.`);
    }
  }, [runId, serialDrafts, loadRun]);

  /** "I don't have it" — the phone continues without the maker's cloud. Never a wall. */
  const noSerial = useCallback((phoneId: string) => {
    driverRef.current?.serialUnavailable(phoneId);
    setNeeds((n) => n.filter((x) => !(x.kind === "serial" && x.phoneId === phoneId)));
  }, []);

  /**
   * ⛔⛔ THE OTHER TWO WAYS TO GIVE US THE SERIAL (Izzy, 2026-09-14): "enter the actual number /
   * upload a photo of the back of the phone / text the photos through our business number."
   * Typing it is above; these are the same answer arriving differently, and all three land on the
   * SAME server gate, so a label from a different handset is refused whichever door it came through.
   *
   * ⛔ Every message shown here is the SERVER'S sentence, not one invented in the browser — the
   * server is the only side that knows whether the picture was sharp enough, whether photo reading
   * is switched on at all, and whether the label belongs to this phone.
   */
  const [photoBusy, setPhotoBusy] = useState<Record<string, boolean>>({});
  const [photoNote, setPhotoNote] = useState<Record<string, string>>({});
  const [textOpen, setTextOpen] = useState<Record<string, boolean>>({});
  const [textFrom, setTextFrom] = useState<Record<string, string>>({});
  const [textPrompt, setTextPrompt] = useState<Record<string, string>>({});

  const uploadLabelPhoto = useCallback(async (phoneId: string, file: File) => {
    if (!runId) return;
    setPhotoBusy((b) => ({ ...b, [phoneId]: true }));
    setPhotoNote((n) => ({ ...n, [phoneId]: "" }));
    try {
      await apiUploadDeskPhoneLabelPhoto(runId, phoneId, file);
      // The row is re-read, so `serialOnFile` flips and this whole block takes itself away.
      await loadRun(runId);
    } catch (err: any) {
      setPhotoNote((n) => ({
        ...n,
        [phoneId]: err?.message || "That photo couldn't be read. Take another one and try again.",
      }));
    } finally {
      setPhotoBusy((b) => ({ ...b, [phoneId]: false }));
    }
  }, [runId, loadRun]);

  /** Tell the server which phone the picture will come FROM, and hear back where to send it. */
  const startTextPhoto = useCallback(async (phoneId: string) => {
    if (!runId) return;
    const from = (textFrom[phoneId] ?? "").trim();
    if (!from) return;
    setPhotoNote((n) => ({ ...n, [phoneId]: "" }));
    try {
      const r = await apiPost<{ message?: string }>(
        `/desk-phones/runs/${runId}/phones/${phoneId}/label-photo/expect`,
        { fromNumber: from },
      );
      setTextPrompt((p) => ({ ...p, [phoneId]: r?.message || "Text the photo, then press “I've sent it”." }));
    } catch (err: any) {
      setPhotoNote((n) => ({ ...n, [phoneId]: err?.body?.message || "That number didn't work. Check it and try again." }));
    }
  }, [runId, textFrom]);

  /** "I've sent it" — one read of the chat, on demand. Nothing polls the inbox. */
  const checkTextPhoto = useCallback(async (phoneId: string) => {
    if (!runId) return;
    setPhotoBusy((b) => ({ ...b, [phoneId]: true }));
    setPhotoNote((n) => ({ ...n, [phoneId]: "" }));
    try {
      const r = await apiPost<{ waiting?: boolean; message?: string }>(
        `/desk-phones/runs/${runId}/phones/${phoneId}/label-photo/check`, {},
      );
      if (r?.waiting) setPhotoNote((n) => ({ ...n, [phoneId]: r.message || "It hasn't arrived yet." }));
      else await loadRun(runId);
    } catch (err: any) {
      setPhotoNote((n) => ({ ...n, [phoneId]: err?.body?.message || "We couldn't read that photo. Send a clearer one." }));
    } finally {
      setPhotoBusy((b) => ({ ...b, [phoneId]: false }));
    }
  }, [runId, loadRun]);

  /** "I don't know the password" — a complete answer, never a wall. */
  const dontKnowPassword = useCallback((phoneId: string) => {
    driverRef.current?.passwordUnknown(phoneId);
    setNeeds((n) => n.filter((x) => !(x.kind === "password" && x.phoneId === phoneId)));
  }, []);

  const supplyPassword = useCallback(async (phoneId: string, label: string) => {
    const pw = passwordDrafts[phoneId] ?? "";
    if (!pw.trim()) return;
    const bridge = desktop()?.phoneSetup;
    if (!bridge?.rememberCredential) return;
    // ⛔⛔ THE PASSWORD STAYS ON THIS COMPUTER. It goes into the app's own protected
    // store under a reference name; the server and the AI only ever see the
    // reference. That is the design, not a nicety — never post it to the api.
    const ref = `phone:${phoneId}`;
    const r = await bridge.rememberCredential(ref, "admin", pw).catch(() => null);
    if (r?.ok) {
      driverRef.current?.credentialStored(phoneId, ref);
      setPasswordDrafts((d) => { const { [phoneId]: _gone, ...rest } = d; return rest; });
      setNeeds((n) => n.filter((x) => !(x.kind === "password" && x.phoneId === phoneId)));
    } else {
      setError(`The password for ${label} could not be saved on this computer.`);
    }
  }, [passwordDrafts]);

  const isPicked = useCallback(
    (p: CustomerPhone) => picks[p.id] ?? (p.connectedNow !== true),
    [picks],
  );
  /** What the person told us on the make/model step, as one phrase to echo back. */
  const toldUs = useMemo(() => toldUsPhrase(phoneBrand, phoneNameHint), [phoneBrand, phoneNameHint]);

  /** The found list with the chosen make first. ⛔ Orders, never filters — see makeHint.ts. */
  const orderedPhones = useMemo(() => orderPhonesByMake(phones, phoneBrand), [phones, phoneBrand]);

  /** The phones going into the setup — every later screen is about these only. */
  const chosen = useMemo(() => phones.filter(isPicked), [phones, isPicked]);
  const leftAlone = phones.length - chosen.length;
  const assigned = useMemo(() => chosen.filter((p) => p.extNumber), [chosen]);
  const stepIndex = Math.max(0, STEP_ORDER.indexOf(step));

  /**
   * Found → match. ⛔ The pick is SAVED ON THE SERVER before the next screen, so
   * the run itself knows which phones are in — the driver, the progress numbers
   * and the reset gate all read the row, never this window's memory.
   */
  const commitSelection = useCallback(async () => {
    if (!runId || chosen.length === 0) return;
    setBusy(true); setError(null);
    try {
      const out = await apiPost<{ phones: CustomerPhone[] }>(`/desk-phones/runs/${runId}/selection`, {
        phoneIds: chosen.map((p) => p.id),
      });
      setPhones(out.phones);
      /*
        ⛔⛔ TICKING A STUCK PHONE MEANS "TRY THIS ONE AGAIN". Found live 2026-09-14: Izzy
        ticked his Yealink, which was NEEDS_ATTENTION from an attempt four days earlier; the
        driver skips finished phones, so nothing at all happened and nothing said why. The
        server's retry un-sticks it and re-attempts the phone's record; it refuses (409) a
        phone a retry would harm and never gives back a reset already spent — so a refusal
        here is left alone and the phone simply stays as it is.
      */
      const stuck = out.phones.filter((p) => chosen.some((c) => c.id === p.id) && p.needsAttention);
      if (stuck.length > 0) {
        for (const p of stuck) {
          await apiPost(`/desk-phones/runs/${runId}/phones/${p.id}/retry`, {}).catch(() => null);
        }
        await loadRun(runId);
      }
      setStep("match");
    } catch {
      setError("Your choice could not be saved. Try again.");
    } finally { setBusy(false); }
  }, [runId, chosen, loadRun]);

  /**
   * ⛔ A ticked phone we could not name blocks the match screen. Without a model the phone
   * system renders no settings file for it, so sending it on would only reach "needs
   * attention" again — the exact dead end this screen exists to stop.
   */
  const unnamed = useMemo(() => chosen.filter((p) => needsIdentifying(p)), [chosen]);

  return (
    <div className="dps-root">
      <div className="dps-wz">
        <div className="dps-wz-top">
          <span className="dps-t">Set up desk phones</span>
          <button
            type="button" onClick={onClose} aria-label="Close"
            style={{ marginLeft: "auto", background: "none", border: 0, color: "var(--dps-dim)", fontSize: 18, cursor: "pointer" }}
          >×</button>
        </div>
        <div className="dps-wz-steps" aria-hidden="true">
          {STEP_ORDER.map((s, i) => (
            <s key={s} className={i < stepIndex ? "dps-done" : i === stepIndex ? "dps-on" : ""} />
          ))}
        </div>

        {managedMode && <ManagedPhonePanel models={managedModels} initial={managedPrefill ?? undefined}
          onBack={() => { setManagedMode(false); setManagedPrefill(null); }} />}
        {step === "welcome" && !managedMode && (
          <>
            <div className="dps-wz-body">
              <h3>Let&rsquo;s set up your desk phones</h3>
              {managedModels.length > 0 && <button className="dps-btn" onClick={() => setManagedMode(true)}>Prepare a Yealink for delivery / manage phones</button>}
              <p className="dps-sub">
                Loopcom will look for the desk phones in your office and connect them to your account.
                It usually takes about five minutes, and we will tell you before anything on a phone changes.
              </p>
              <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 11 }}>
                <Check title="Your phones are plugged in and switched on" note="The screen is lit up, even if it says something like No service." />
                <Check title="They are in the same office as this computer" note="Same building, same internet." />
                <Check title="You can walk over to them if we ask" note="Usually we will not need to. Occasionally one phone needs a hand." />
              </div>
              {error && <p className="dps-hint" style={{ marginTop: 16, color: "var(--dps-warn)" }}>{error}</p>}
              {!hasDesktop && (
                <p className="dps-hint" style={{ marginTop: 16 }}>
                  Open this in the Loopcom app on a computer in the same office as your phones.
                </p>
              )}
            </div>
            <div className="dps-wz-foot">
              <span className="dps-hint">Nothing changes yet.</span>
              <span className="dps-sp" />
              <button className="dps-btn dps-btn-p" onClick={start} disabled={busy}>Find My Phones</button>
            </div>
          </>
        )}

        {step === "knowPhone" && (
          <>
            <div className="dps-wz-body">
              <h3>Do you know what kind of phone you have?</h3>
              <p className="dps-sub">
                If you know, tell us and we will go straight to it. If you are not sure, that is completely
                fine &mdash; most people are not, and we will work it out ourselves.
              </p>
              <div className="dps-tiles">
                <button className={`dps-tile${knowsPhone === "yes" ? " dps-sel" : ""}`} onClick={() => setKnowsPhone("yes")}>
                  <b>Yes &mdash; I can see a name on it</b>
                  <span>There is usually a brand name printed under the screen, like Yealink, Polycom or Grandstream.</span>
                </button>
                {knowsPhone === "yes" && (
                  <div className="dps-brandpick" style={{ gridColumn: "1 / -1" }}>
                    {/* ⛔⛔ BOTH LISTS COME FROM THE PBX'S OWN CATALOGUE (20 brands, 427
                        models), never a list typed here — a make or model we cannot
                        provision must not be offered, and one the PBX gains later must
                        appear without anyone editing this file.
                        ⛔ The model used to be a free-text box. What a person types is not
                        what the phone system calls it ("SIP-T54W" against a catalogue that
                        holds "T54W"), so a typed answer mostly resolved to nothing and the
                        phone stayed unnameable — which is the whole thing this step is for. */}
                    <IdentityPicker
                      idPrefix="dps-known"
                      make={phoneBrand}
                      model={phoneNameHint}
                      onMake={setPhoneBrand}
                      onModel={setPhoneNameHint}
                    />
                    <div className="dps-sticker">
                      <StickerDrawing />
                      <p className="dps-hint" style={{ marginTop: 4 }}>
                        Both are printed on a white label on the <b>underside</b> of the phone. Turn one
                        over &mdash; you do not need to unplug anything.
                      </p>
                    </div>
                  </div>
                )}
                <button className={`dps-tile${knowsPhone === "no" ? " dps-sel" : ""}`} onClick={() => setKnowsPhone("no")}>
                  <b>No &mdash; I have no idea</b>
                  <span>Perfectly normal. We will look for every kind of desk phone and show you a picture of each one we find.</span>
                </button>
              </div>
            </div>
            <div className="dps-wz-foot">
              <button className="dps-btn dps-btn-g" onClick={() => setStep("welcome")}>Back</button>
              <span className="dps-hint">Nothing changes yet.</span>
              <span className="dps-sp" />
              <button className="dps-btn dps-btn-p" onClick={() => setStep("connection")}>Continue</button>
            </div>
          </>
        )}

        {step === "connection" && (
          <>
            <div className="dps-wz-body">
              <h3>How are your phones connected?</h3>
              <p className="dps-sub">
                Look at the back of one phone. Which of these two does it look like? If you truly cannot tell,
                pick the last option and we will find out for you.
              </p>
              <div className="dps-tiles">
                <button className={`dps-tile${connection === "cable" ? " dps-sel" : ""}`} onClick={() => setConnection("cable")}>
                  <CableDrawing />
                  <b>There is a cable going into the back</b>
                  <span>A thin cable, a bit fatter than a phone cord, with a little clip on the end. This is how most office desk phones are connected.</span>
                </button>
                <button className={`dps-tile${connection === "wifi" ? " dps-sel" : ""}`} onClick={() => setConnection("wifi")}>
                  <WifiDrawing />
                  <b>No cable &mdash; it uses Wi&#8209;Fi</b>
                  <span>Only the power lead goes in. Less common on desk phones, but some newer models do this.</span>
                </button>
              </div>
              <button
                className={`dps-tile${connection === "unsure" ? " dps-sel" : ""}`}
                style={{ marginTop: 12, display: "block" }}
                onClick={() => setConnection("unsure")}
              >
                <b style={{ margin: 0 }}>I can&rsquo;t tell &mdash; just look for both</b>
                <span>We will search either way. This answer only helps us explain things better if a phone does not turn up.</span>
              </button>
            </div>
            <div className="dps-wz-foot">
              <button className="dps-btn dps-btn-g" onClick={() => setStep("knowPhone")}>Back</button>
              <span className="dps-hint">Nothing changes yet.</span>
              <span className="dps-sp" />
              <button className="dps-btn dps-btn-p" onClick={() => setStep("network")}>Continue</button>
            </div>
          </>
        )}

        {step === "network" && (
          <>
            <div className="dps-wz-body">
              <h3>One last thing before we look</h3>
              <p className="dps-sub">
                Your phones and this computer need to be on the same office internet. They almost always are
                &mdash; this is just so we know where to look.
              </p>
              {/* ⛔ A failed search lands back here WITH its reason. Without this
                  line the setError before setStep("network") was written to nobody. */}
              {error && (
                <div style={{ marginTop: 14, padding: "11px 13px", borderRadius: 10, border: "1.5px solid color-mix(in srgb, var(--warning, #f0b655) 45%, var(--dps-border))", background: "color-mix(in srgb, var(--warning, #f0b655) 9%, transparent)", font: "500 13.5px/1.5 Inter, sans-serif" }}>
                  {error}
                </div>
              )}
              <div style={{ margin: "20px 0 6px", padding: 18, borderRadius: 12, background: "var(--dps-panel-2)", border: "1px solid var(--dps-border)" }}>
                <SameNetworkDrawing />
              </div>
              <div style={{ display: "flex", gap: 9, alignItems: "center", marginTop: 14, padding: "11px 13px", borderRadius: 10, background: "color-mix(in srgb, var(--success, #34c27b) 11%, transparent)" }}>
                <span className="dps-tick" style={{ fontSize: 15 }}>&#10003;</span>
                <div style={{ font: "500 13.5px/1.5 Inter, sans-serif" }}>
                  This computer is on your office network. That is where we will look.
                </div>
              </div>
              <p className="dps-hint" style={{ marginTop: 12 }}>
                If any phones are in a different building, run this again on a computer in that building &mdash;
                we will only ever find the ones nearby.
              </p>
            </div>
            <div className="dps-wz-foot">
              <button className="dps-btn dps-btn-g" onClick={() => setStep("connection")}>Back</button>
              <span className="dps-hint">Nothing changes yet.</span>
              <span className="dps-sp" />
              <button className="dps-btn dps-btn-p" onClick={search}>Find My Phones</button>
            </div>
          </>
        )}

        {step === "searching" && (
          <div className="dps-wz-body">
            <div className="dps-radar">
              <span className="dps-ring" /><span className="dps-ring" /><span className="dps-ring" /><span className="dps-ring" />
              <span className="dps-core">
                <PhoneGlyph />
              </span>
            </div>
            <h3 style={{ textAlign: "center", fontSize: 22 }}>Looking for your phones&hellip;</h3>
            <p className="dps-sub" style={{ textAlign: "center", margin: "8px auto 0" }}>
              This takes about thirty seconds. You can leave this open and carry on working.
            </p>
            <div className="dps-scanline" style={{ marginTop: 20 }}><i /></div>
          </div>
        )}

        {(step === "found" || step === "match") && (
          <>
            <div className="dps-wz-body">
              {step === "found" ? (
                <>
                  <h3>{phones.length === 1 ? "We found 1 desk phone" : `We found ${phones.length} desk phones`}</h3>
                  <p className="dps-sub">
                    Tick the phones you want set up. Every phone you tick is factory reset first,
                    then given its Loopcom settings and restarted. Phones you do not tick are left
                    exactly as they are.
                  </p>
                  {phones.length > 0 && (
                    <div className="dps-picks">
                      <b>{chosen.length === 1 ? "1 phone selected" : `${chosen.length} phones selected`}</b>
                      <button type="button" className="dps-linkbtn"
                        onClick={() => setPicks(Object.fromEntries(phones.map((p) => [p.id, p.connectedNow !== true])))}>
                        Only the ones not connected
                      </button>
                      <button type="button" className="dps-linkbtn"
                        onClick={() => setPicks(Object.fromEntries(phones.map((p) => [p.id, true])))}>
                        Select all
                      </button>
                      <button type="button" className="dps-linkbtn"
                        onClick={() => setPicks(Object.fromEntries(phones.map((p) => [p.id, false])))}>
                        Select none
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <h3>Who uses each phone?</h3>
                  <p className="dps-sub">
                    Pick the person who sits at each desk. Leave a phone blank to skip it for now.
                    {leftAlone > 0 && ` ${leftAlone === 1 ? "1 phone you did not tick is" : `${leftAlone} phones you did not tick are`} left exactly as they are.`}
                  </p>
                </>
              )}
              {step === "found" && othersCount > 0 && (
                <p className="dps-hint" style={{ marginTop: 10 }}>
                  We also saw {othersCount} other {othersCount === 1 ? "device" : "devices"} on your network
                  &mdash; computers, printers and the like. We left those alone.
                </p>
              )}
              {step === "found" && toldUs && phones.length > 0 && (
                <p className="dps-hint" style={{ marginTop: 6 }}>
                  You told us &ldquo;{toldUs}&rdquo; &mdash; check the pictures below match what is on your desk.
                </p>
              )}
              {subnet && (
                <p className="dps-hint" style={{ marginTop: 10 }}>
                  We looked on this office&rsquo;s network. Phones in another building need this run again over there.
                </p>
              )}
              {error && <p className="dps-hint" style={{ color: "var(--dps-warn)", marginTop: 10 }}>{error}</p>}
              <div className="dps-plist">
                {(step === "found" ? orderedPhones : chosen).map((p) => (
                  <div key={p.id}>
                  {/* ⛔ On the found screen the whole row is one big tick target, the
                     same shape as the clearing screen — a person picks phones here. */}
                  <RowShell pick={step === "found"} picked={isPicked(p)}
                    onPick={(v) => setPicks((t) => ({ ...t, [p.id]: v }))}
                    label={`Set up ${p.displayName || p.model || "this phone"}`}>
                    <div className="dps-pimg">
                      <PhonePhoto model={p.model} alt={p.model ? `${p.vendor ?? ""} ${p.model}`.trim() : "Desk phone"} />
                    </div>
                    <div className="dps-pmeta">
                      {/* The person's name leads when the phone system already knows
                          whose phone this is; the hardware line always shows the MAC. */}
                      <b>{p.displayName
                        ? `${p.displayName}${p.extNumber ? ` — ext ${p.extNumber}` : ""}`
                        : ([p.vendor, p.model].filter(Boolean).join(" ") || "Desk phone")}</b>
                      <span>{hardwareLine(p)}</span>
                      {(p.mac || p.ip) && <span className="dps-mac">{[p.mac, p.ip].filter(Boolean).join(" · ")}</span>}
                    </div>
                    {step === "match" ? (
                      <ConnectSelect
                        style={{ minWidth: 172 }}
                        value={extensions.find((e) => e.extNumber === p.extNumber)?.id ?? ""}
                        onChange={(v) => assign(p.id, v || null)}
                        ariaLabel="Who uses this phone"
                        options={[
                          { value: "", label: "Choose a person…" },
                          ...extensions.map((e) => ({ value: e.id, label: `${e.displayName} — ${e.extNumber}` })),
                        ]}
                      />
                    ) : (
                      /* ⛔ The pill tells the LIVE truth, never a blanket "Ready":
                         a factory-reset phone keeps its name from the records and
                         loses its connection — the difference is the whole point
                         of running this wizard on it. */
                      <span className={`dps-pill ${p.needsAttention ? "dps-pill-hm" : p.connectedNow === false ? "dps-pill-hm" : "dps-pill-ok"}`}>
                        {p.needsAttention ? "Needs attention"
                          : p.connectedNow === true ? "Connected"
                          : p.connectedNow === false ? "Not connected"
                          : "Found"}
                      </span>
                    )}
                  </RowShell>
                  {/*
                    ⛔⛔ THE PHONE WE COULD NOT NAME ASKS, RIGHT ON ITS OWN ROW.
                    Without a model the phone system has no catalogue row for it, so no
                    settings file is ever rendered and a factory-reset handset asks into
                    silence — which is exactly what happened to Izzy's Yealink. The person
                    holding it can read the label in five seconds; nothing else can.
                    ⛔ Only when we genuinely do not know: a phone that told us its own
                    model is never asked, because being asked to confirm something the
                    system plainly already knows reads as the wizard not paying attention.
                  */}
                  {/*
                    ⛔⛔ THE SERIAL IS ASKED HERE, NOT MID-SETUP (Izzy, 2026-09-14: "where they
                    select the extension, they should also be prompted to enter the serial number"
                    — and "I don't want it to ask for the password"). The maker's cloud clears a
                    phone from its serial, so asking once, on the row the person is already looking
                    at, replaces a password prompt that interrupted the setup for something most
                    people do not have.
                  */}
                  {step === "match" && isPicked(p) && p.serialOnFile === false && (
                    <div className="dps-idrow">
                      <label className="dps-flabel" htmlFor={`dps-serial-${p.id}`}>
                        The serial number on the label underneath
                      </label>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <input
                          id={`dps-serial-${p.id}`}
                          className="dps-input"
                          maxLength={60}
                          placeholder="Type it, or scan the barcode"
                          value={serialDrafts[p.id] ?? ""}
                          onChange={(e) => { const v = e.target.value; setSerialDrafts((d) => ({ ...d, [p.id]: v })); }}
                          onKeyDown={(e) => { if (e.key === "Enter") void supplySerial(p.id, p.displayName || hardwareLine(p)); }}
                        />
                        <button
                          className="dps-btn dps-btn-g"
                          disabled={!(serialDrafts[p.id] ?? "").trim()}
                          onClick={() => void supplySerial(p.id, p.displayName || hardwareLine(p))}
                        >
                          Save it
                        </button>
                      </div>
                      <p className="dps-hint" style={{ marginTop: 8 }}>
                        It is on the sticker underneath the phone, next to the barcode. No password is needed.
                      </p>

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                        {/* A label styled as a button: the file input itself stays hidden, and
                            `capture` opens the camera straight away on a phone. */}
                        <label className="dps-btn dps-btn-g" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
                          {photoBusy[p.id] ? "Reading the photo…" : "Upload a photo of the label"}
                          <input
                            type="file"
                            accept="image/*"
                            capture="environment"
                            hidden
                            disabled={!!photoBusy[p.id]}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              // Cleared so choosing the SAME file again still fires a change.
                              e.target.value = "";
                              if (f) void uploadLabelPhoto(p.id, f);
                            }}
                          />
                        </label>
                        <button
                          className="dps-btn dps-btn-g"
                          onClick={() => setTextOpen((t) => ({ ...t, [p.id]: !t[p.id] }))}
                        >
                          {textOpen[p.id] ? "Never mind texting it" : "Text the photo instead"}
                        </button>
                      </div>

                      {textOpen[p.id] && (
                        <div style={{ marginTop: 10 }}>
                          {textPrompt[p.id] ? (
                            <>
                              <p className="dps-hint" style={{ margin: "0 0 8px" }}>{textPrompt[p.id]}</p>
                              <button
                                className="dps-btn dps-btn-g"
                                disabled={!!photoBusy[p.id]}
                                onClick={() => void checkTextPhoto(p.id)}
                              >
                                {photoBusy[p.id] ? "Looking…" : "I've sent it"}
                              </button>
                            </>
                          ) : (
                            <>
                              <label className="dps-flabel" htmlFor={`dps-textfrom-${p.id}`}>
                                Which phone will you text it from?
                              </label>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                <input
                                  id={`dps-textfrom-${p.id}`}
                                  className="dps-input"
                                  maxLength={30}
                                  placeholder="(845) 555-0112"
                                  value={textFrom[p.id] ?? ""}
                                  onChange={(e) => { const v = e.target.value; setTextFrom((t) => ({ ...t, [p.id]: v })); }}
                                  onKeyDown={(e) => { if (e.key === "Enter") void startTextPhoto(p.id); }}
                                />
                                <button
                                  className="dps-btn dps-btn-g"
                                  disabled={!(textFrom[p.id] ?? "").trim()}
                                  onClick={() => void startTextPhoto(p.id)}
                                >
                                  Use this number
                                </button>
                              </div>
                              <p className="dps-hint" style={{ marginTop: 6 }}>
                                We only look for a picture from this number, so tell us the one you'll send from.
                              </p>
                            </>
                          )}
                        </div>
                      )}

                      {photoNote[p.id] && (
                        <p className="dps-hint" style={{ color: "var(--dps-warn)", marginTop: 8 }}>{photoNote[p.id]}</p>
                      )}

                      <SerialStickerDrawing />
                    </div>
                  )}

                  {step === "match" && needsIdentifying(p) && (
                    <div className="dps-idrow">
                      <p className="dps-hint" style={{ margin: "0 0 8px" }}>
                        We could not tell what this one is. Turn it over and read the label underneath.
                      </p>
                      <IdentityPicker
                        idPrefix={`dps-id-${p.id}`}
                        size="sm"
                        disabled={!!identifyBusy[p.id]}
                        make={identifyDraft[p.id]?.make ?? ""}
                        model={identifyDraft[p.id]?.model ?? ""}
                        error={identifyError[p.id] || null}
                        onMake={(v) => setIdentifyDraft((d) => ({ ...d, [p.id]: { make: v, model: d[p.id]?.model ?? "" } }))}
                        onModel={(v) => setIdentifyDraft((d) => ({ ...d, [p.id]: { make: d[p.id]?.make ?? "", model: v } }))}
                      />
                      {/* ⛔ The same question answered from the label itself: type what it says,
                          or point a barcode scanner at it — a scanner types like a keyboard. */}
                      <div style={{ marginTop: 10 }}>
                        <label className="dps-flabel" htmlFor={`dps-label-${p.id}`}>Or type or scan what the label says</label>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <input
                            id={`dps-label-${p.id}`}
                            className="dps-input"
                            maxLength={600}
                            placeholder="Serial number, MAC or model from the label"
                            value={labelDraft[p.id] ?? ""}
                            disabled={!!identifyBusy[p.id]}
                            onChange={(e) => { const v = e.target.value; setLabelDraft((d) => ({ ...d, [p.id]: v })); }}
                            onKeyDown={(e) => { if (e.key === "Enter") void scanLabel(p.id, labelDraft[p.id] ?? ""); }}
                          />
                          <button
                            className="dps-btn dps-btn-g"
                            disabled={!(labelDraft[p.id] ?? "").trim() || !!identifyBusy[p.id]}
                            onClick={() => void scanLabel(p.id, labelDraft[p.id] ?? "")}
                          >
                            Read the label
                          </button>
                        </div>
                      </div>
                      <div className="dps-idfoot">
                        <StickerDrawing />
                        <button
                          className="dps-btn dps-btn-p"
                          disabled={!identifyDraft[p.id]?.model || !!identifyBusy[p.id]}
                          onClick={() => identify(p.id, identifyDraft[p.id]?.make ?? "", identifyDraft[p.id]?.model ?? "")}
                        >
                          {identifyBusy[p.id] ? "Saving…" : "That’s the one"}
                        </button>
                      </div>
                    </div>
                  )}
                  </div>
                ))}
                {knownElsewhere.length > 0 && (
                  <div className="dps-known">
                    <p className="dps-hint" style={{ marginTop: 14 }}>
                      Your phone system also has <b>{knownElsewhere.length}</b> {knownElsewhere.length === 1 ? "phone" : "phones"} already
                      set up that we did not see on this network &mdash; they may be plugged into a different
                      network in the building. They keep working as they are.
                    </p>
                    <div className="dps-plist" style={{ marginTop: 8 }}>
                      {knownElsewhere.map((k) => (
                        <div key={k.mac} className="dps-prow dps-known-row">
                          <div className="dps-pimg"><PhonePhoto model={k.model} /></div>
                          <div className="dps-pmeta">
                            <b>{k.name || [k.vendor, k.model].filter(Boolean).join(" ") || "Phone"}</b>
                            <span>{[k.vendor, k.model].filter(Boolean).join(" ") || "Already set up"}</span>
                            <span className="dps-mac">{k.mac}</span>
                          </div>
                          <span className={`dps-pill ${k.connectedNow === false ? "dps-pill-hm" : "dps-pill-ok"}`}>
                            {k.connectedNow === false ? "Not connected right now" : "Already set up"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {phones.length === 0 && (
                  <p className="dps-hint">
                    We did not find any desk phones on this office&rsquo;s network. Check they are switched on and
                    plugged in, then search again.
                    {/* ⛔ The connection answer earns its keep here — the copy on that
                        step promises "this answer only helps us explain things better
                        if a phone does not turn up", and this is that explanation. */}
                    {connection === "wifi" &&
                      " Wi-Fi phones sometimes join a guest network — check the phone is on the same Wi-Fi name as this computer."}
                    {connection === "cable" &&
                      " Follow the cable from one phone and make sure it goes to the same internet box this computer uses."}
                  </p>
                )}
              </div>
            </div>
            <div className="dps-wz-foot">
              <button className="dps-btn dps-btn-g" onClick={step === "found" ? search : () => setStep("found")}>
                {step === "found" ? "Search again" : "Back"}
              </button>
              <span className="dps-hint">
                {step === "match" && unnamed.length > 0
                  ? "Tell us what the phone above is first — read the label underneath it."
                  : "Nothing changes yet."}
              </span>
              <span className="dps-sp" />
              <button
                className="dps-btn dps-btn-p"
                onClick={() => (step === "found" ? void commitSelection() : setStep("ready"))}
                disabled={busy || (step === "found" ? chosen.length === 0 : phones.length === 0 || unnamed.length > 0)}
              >{step === "found"
                ? (busy ? "Saving…" : chosen.length === 1 ? "Set up this phone" : `Set up these ${chosen.length} phones`)
                : "Continue"}</button>
            </div>
          </>
        )}

        {step === "ready" && (
          <>
            <div className="dps-wz-body">
              <h3>Ready to set up your office</h3>
              <p className="dps-sub">
                {assigned.length} {assigned.length === 1 ? "phone is" : "phones are"} matched to a person.
                Some may restart along the way &mdash; the rest keep working the whole time.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 11, marginTop: 20 }}>
                <Stat n={String(assigned.length)} label="phones to set up" />
                <Stat n="~4" label="minutes, roughly" />
              </div>
              <p className="dps-hint" style={{ marginTop: 16 }}>
                If somebody is on a call right now, that phone waits its turn.
                {leftAlone > 0 && ` The ${leftAlone === 1 ? "phone" : `${leftAlone} phones`} you did not tick will not be touched.`}
              </p>
            </div>
            <div className="dps-wz-foot">
              <button className="dps-btn dps-btn-g" onClick={() => setStep("match")}>Back</button>
              <span className="dps-sp" />
              <button className="dps-btn dps-btn-p" onClick={beginSetup} disabled={assigned.length === 0}>
                Set Up {assigned.length} {assigned.length === 1 ? "Phone" : "Phones"}
              </button>
            </div>
          </>
        )}

        {/*
          ⛔⛔ THE TWO PERSON-ONLY MOMENTS ARE FULL SCREENS, ONE QUESTION AT A TIME.
          Izzy saw the compact card version and said even he took a second to find
          it — "dumb people will just get stuck here". So when a decision is needed,
          the wizard STOPS: no progress list, no competing information, one big
          question, big buttons, and a way out that is not a wall.
        */}
        {step === "live" && !managedMode && needs.some((n) => n.kind === "reset_authorization") && (() => {
          const n: any = needs.find((x) => x.kind === "reset_authorization");
          const items = phones.filter((p) => n.phoneIds.includes(p.id));
          const tickedCount = n.phoneIds.filter((id: string) => clearTicks[id] !== false).length;
          return (
            <>
              <div className="dps-wz-body">
                <h3>{items.length === 1 ? "One phone needs a fresh start" : `${items.length} phones need a fresh start`}</h3>
                <p className="dps-sub">
                  These still have your <b>old phone company&rsquo;s</b> settings inside. To join Loopcom,
                  we wipe the old settings off. That is all &mdash; your numbers, voicemails and
                  everything in Loopcom are not touched.
                </p>
                <div className="dps-plist" style={{ marginTop: 16 }}>
                  {(items.length ? items : n.phoneIds.map((id: string) => ({ id, model: null, vendor: null, displayName: null, extNumber: null }))).map((p: any) => (
                    <label key={p.id} className="dps-prow dps-clear-row">
                      <input
                        type="checkbox"
                        className="dps-check"
                        checked={clearTicks[p.id] !== false}
                        onChange={(e) => setClearTicks((t) => ({ ...t, [p.id]: e.target.checked }))}
                        aria-label={`Clear ${p.displayName || p.model || "this device"}`}
                      />
                      <div className="dps-pimg">
                        <PhonePhoto model={p.model} />
                      </div>
                      <div className="dps-pmeta">
                        <b>{p.displayName ? `${p.displayName}${p.extNumber ? ` — ${p.extNumber}` : ""}` : (p.model ?? "Device")}</b>
                        <span>{describe(p.model)}</span>
                        {p.mac && <span className="dps-mac">{p.mac}</span>}
                      </div>
                      <span className="dps-hint">{clearTicks[p.id] !== false ? "Will be cleaned" : "Left alone"}</span>
                    </label>
                  ))}
                </div>
                <p className="dps-hint" style={{ marginTop: 12 }}>
                  Untick any you want left exactly as it is. Each one restarts once and takes about two minutes.
                </p>
                {error && <p className="dps-hint" style={{ color: "var(--dps-warn)", marginTop: 10 }}>{error}</p>}
              </div>
              <div className="dps-wz-foot">
                <button className="dps-btn dps-btn-g" onClick={() => declineAllResets(n.phoneIds)}>
                  Skip all of these for now
                </button>
                <span className="dps-sp" />
                <button className="dps-btn dps-btn-p dps-btn-big" onClick={() => approveReset(n.phoneIds)}>
                  {tickedCount === 0 ? "Continue without cleaning" :
                    tickedCount === 1 ? "Clean 1 phone — go ahead" : `Clean ${tickedCount} phones — go ahead`}
                </button>
              </div>
            </>
          );
        })()}

        {step === "live" && !managedMode && !needs.some((n) => n.kind === "reset_authorization") && needs.some((n) => n.kind === "password") && (() => {
          const n: any = needs.find((x) => x.kind === "password");
          return (
            <>
              <div className="dps-wz-body">
                <h3>{n.label} is locked with a password</h3>
                <p className="dps-sub">
                  Your old phone company put a password on this one. If you have it, type it in
                  and we do the rest. <b>If you don&rsquo;t have it, that is completely fine</b> &mdash;
                  press the other button and Loopcom will sort it out for you.
                </p>
                <div className="dps-ask" style={{ marginTop: 18 }}>
                  <b>Where would the password be?</b>
                  <p>Sometimes it is on a sticker under the phone. Sometimes it is in an old email
                  from your previous phone company. If you are not sure, don&rsquo;t dig &mdash; just press
                  &ldquo;I don&rsquo;t know it&rdquo;.</p>
                  <div className="dps-ask-row">
                    <input
                      type="password"
                      className="dps-input"
                      placeholder="Type the password here"
                      value={passwordDrafts[n.phoneId] ?? ""}
                      onChange={(e) => setPasswordDrafts((d) => ({ ...d, [n.phoneId]: e.target.value }))}
                      aria-label={`Password for ${n.label}`}
                    />
                    <button className="dps-btn dps-btn-p" onClick={() => supplyPassword(n.phoneId, n.label)}>Use it</button>
                  </div>
                  <span className="dps-hint">The password stays on this computer. It is never sent to Loopcom.</span>
                </div>
                {error && <p className="dps-hint" style={{ color: "var(--dps-warn)", marginTop: 10 }}>{error}</p>}
              </div>
              <div className="dps-wz-foot">
                <button className="dps-btn dps-btn-g dps-btn-big" onClick={() => dontKnowPassword(n.phoneId)}>
                  I don&rsquo;t know it — Loopcom can sort this one out
                </button>
                <span className="dps-sp" />
              </div>
            </>
          );
        })()}

        {step === "live" && !managedMode && !needs.some((n) => n.kind === "reset_authorization" || n.kind === "password") && needs.some((n) => n.kind === "serial") && (() => {
          const n: any = needs.find((x) => x.kind === "serial");
          return (
            <>
              <div className="dps-wz-body">
                <h3>{n.label} needs its serial number</h3>
                <p className="dps-sub">
                  To clear this phone and connect it, its maker needs the <b>serial number</b> printed on the
                  label underneath it. Type it in, or point a barcode scanner at the label.
                </p>
                <div className="dps-ask" style={{ marginTop: 18 }}>
                  <b>Where is it?</b>
                  <p>Turn the phone over. The white label has the model, the MAC address and a line
                  starting with <b>S/N</b> &mdash; that last one is the serial number. There is a
                  barcode beside it, so a barcode scanner works instead of typing.</p>
                  {/* ⛔ The drawing is the half people actually need: almost nobody knows where a
                      serial number lives, and almost everybody can read a label once told to turn
                      the phone over. Same reasoning as the make/model step's sticker drawing. */}
                  <SerialStickerDrawing />
                  <div className="dps-ask-row">
                    <input
                      id={`dps-serial-${n.phoneId}`}
                      className="dps-input"
                      maxLength={60}
                      placeholder="Serial number from the label"
                      value={serialDrafts[n.phoneId] ?? ""}
                      onChange={(e) => { const v = e.target.value; setSerialDrafts((d) => ({ ...d, [n.phoneId]: v })); }}
                      onKeyDown={(e) => { if (e.key === "Enter") void supplySerial(n.phoneId, n.label); }}
                      aria-label={`Serial number for ${n.label}`}
                    />
                    <button className="dps-btn dps-btn-p" onClick={() => void supplySerial(n.phoneId, n.label)}>Use it</button>
                  </div>
                </div>
                {error && <p className="dps-hint" style={{ color: "var(--dps-warn)", marginTop: 10 }}>{error}</p>}
              </div>
              <div className="dps-wz-foot">
                <button className="dps-btn dps-btn-g dps-btn-big" onClick={() => noSerial(n.phoneId)}>
                  I can&rsquo;t find it &mdash; continue without it
                </button>
                <span className="dps-sp" />
              </div>
            </>
          );
        })()}

        {step === "live" && !managedMode && !needs.length && (
          <>
          <div className="dps-wz-body">
            <div style={{ display: "flex", alignItems: "baseline", gap: 11, marginBottom: 11 }}>
              <div style={{ font: "700 22px/1 Inter, sans-serif", letterSpacing: "-0.025em" }}>
                {summary?.headline ?? "Setting up your office"}
              </div>
            </div>
            {error && <p className="dps-hint" style={{ color: "var(--dps-warn)", marginBottom: 10 }}>{error}</p>}
            <div className="dps-bar">
              <i style={{ width: `${summary && summary.total ? Math.round((summary.ready / summary.total) * 100) : 0}%` }} />
            </div>
            <div className="dps-plist">
              {chosen.map((p) => (
                <div key={p.id} className="dps-prow">
                  <div className="dps-pimg">
                    <PhonePhoto model={p.model} />
                  </div>
                  <div className="dps-pmeta">
                    <b>{p.displayName ? `${p.displayName} — ${p.extNumber}` : (p.model ?? "Desk phone")}</b>
                    {p.note && <span>{p.note}</span>}
                    {/* What this computer is doing for the phone right now — the
                        power-cycle ask lives here, where the person is looking. */}
                    {!p.note && hints[p.id] && <span className="dps-hintline">{hints[p.id]}</span>}
                    {p.mac && <span className="dps-mac">{p.mac}</span>}
                  </div>
                  {p.needsAttention && (
                    <button className="dps-btn dps-btn-g" onClick={() => void retryPhone(p.id)}>Try again</button>
                  )}
                  {/* The password dead-end must never be a dead end: a found Yealink can always
                      switch to the zero-touch path (RPS), which needs no password at all. */}
                  {p.needsAttention && p.mac && managedModels.length > 0 && /yealink/i.test(p.vendor ?? "") && (
                    <button className="dps-btn" onClick={() => { setManagedPrefill({ mac: p.mac, model: p.model }); setManagedMode(true); }}>
                      Set up from the cloud &mdash; no password
                    </button>
                  )}
                  <span className={`dps-pill ${p.status === "Ready" ? "dps-pill-ok" : p.needsAttention ? "dps-pill-hm" : "dps-pill-br"}`}>
                    {p.status !== "Ready" && !p.needsAttention && <span className="dps-spin" style={{ marginRight: 5 }} />}
                    {p.status}
                  </span>
                </div>
              ))}
            </div>
            {timedOut ? (
              <p className="dps-hint" style={{ marginTop: 14, color: "var(--dps-warn)" }}>
                We stopped waiting &mdash; nothing changed for 10 minutes. Check the phone is plugged in and
                switched on, then press Keep trying, or cancel this setup.
              </p>
            ) : (
              <p className="dps-hint" style={{ marginTop: 14 }}>
                {/* ⛔ Honest: the office machine is doing the work, so the window has to
                    stay open. Saying "you can close this" here would quietly stop the
                    setup the moment somebody believed it. */}
                Keep this window open while we work &mdash; you can carry on using your computer.
              </p>
            )}
          </div>
          <div className="dps-wz-foot">
            <button className="dps-btn dps-btn-g" onClick={() => void cancelSetup()}>Cancel setup</button>
            <span className="dps-sp" />
            {timedOut && <button className="dps-btn dps-btn-p" onClick={() => void beginSetup()}>Keep trying</button>}
          </div>
          </>
        )}

        {step === "done" && !managedMode && summary && (
          <>
            {/* ⛔⛔ THE MARK REFLECTS THE OUTCOME. This screen used to draw a green
                tick UNCONDITIONALLY and say "Your office is working" whenever
                anything needed attention — so a run where NOTHING registered showed
                a customer a tick above "0 of your 1 phones are ready". Izzy hit
                exactly that on 2026-09-10. Three outcomes, three marks, and the
                word "working" is only ever used when at least one phone really is. */}
            <div className="dps-wz-body" style={{ textAlign: "center", paddingTop: 34 }}>
              <div
                className="dps-found"
                style={{
                  width: 62, height: 62, borderRadius: "50%", display: "grid", placeItems: "center",
                  margin: "0 auto 18px",
                  background: summary.ready === 0
                    ? "color-mix(in srgb, var(--warning, #f0b655) 17%, transparent)"
                    : "color-mix(in srgb, var(--success, #34c27b) 17%, transparent)",
                }}
              >
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
                     strokeLinecap="round" strokeLinejoin="round"
                     style={{ color: summary.ready === 0 ? "var(--dps-warn)" : "var(--dps-ok)" }} aria-hidden="true">
                  {summary.ready === 0
                    ? <><path d="M12 8v5" /><path d="M12 16.5v.01" /><circle cx="12" cy="12" r="9" /></>
                    : <path d="M4.5 12.5l5 5 10-11" />}
                </svg>
              </div>
              <h3 style={{ fontSize: 26 }}>{summary.headline}</h3>
              <p className="dps-sub" style={{ margin: "9px auto 0" }}>
                {summary.needsAttention === 0
                  ? "Try picking one up — you should hear a dial tone."
                  : summary.ready === 0
                    // Nothing registered. Saying the office is working would be false,
                    // and it is the sentence a customer quotes back when they ring up.
                    ? "None of them are connected yet. Loopcom Support can finish this with you."
                    : "The ones that are ready are working now. The rest can wait until you have a minute."}
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(158px,1fr))", gap: 8, marginTop: 22, textAlign: "left" }}>
                {chosen.map((p) => (
                  <div key={p.id} className="dps-st">
                    <span className={p.status === "Ready" ? "dps-tick" : ""}>{p.status === "Ready" ? "✓" : "⚠"}</span>{" "}
                    {p.displayName ?? p.model ?? "Desk phone"}
                  </div>
                ))}
              </div>
            </div>
            <div className="dps-wz-foot">
              <span className="dps-hint">Everything is saved.</span>
              <span className="dps-sp" />
              <button className="dps-btn dps-btn-p" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One phone row. On the found screen it is a LABEL wrapping a tick, so the whole
 * card is the click target (the clearing screen's proven shape); everywhere else
 * it is the plain row it always was.
 */
function RowShell({ pick, picked, onPick, label, children }: {
  pick: boolean; picked: boolean; onPick: (v: boolean) => void; label: string; children: ReactNode;
}) {
  if (!pick) return <div className="dps-prow dps-found">{children}</div>;
  return (
    <label className={`dps-prow dps-found dps-clear-row${picked ? " dps-picked" : " dps-unpicked"}`}>
      <input type="checkbox" className="dps-check" checked={picked}
        onChange={(e) => onPick(e.target.checked)} aria-label={label} />
      {children}
    </label>
  );
}

function Check({ title, note }: { title: string; note: string }) {
  return (
    <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
      <span className="dps-tick">&#10003;</span>
      <div>
        <b style={{ font: "600 13.5px Inter, sans-serif" }}>{title}</b>
        <div className="dps-hint">{note}</div>
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div style={{ padding: "15px 16px", borderRadius: 11, background: "var(--dps-panel-2)", border: "1px solid var(--dps-border)" }}>
      <div style={{ font: "700 27px/1 Inter, sans-serif", letterSpacing: "-0.03em" }}>{n}</div>
      <div className="dps-hint" style={{ marginTop: 4 }}>{label}</div>
    </div>
  );
}

function PhoneGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         style={{ color: "var(--dps-accent)" }} aria-hidden="true">
      <rect x="4" y="2" width="16" height="20" rx="2.5" />
      <rect x="7.5" y="5" width="9" height="4.5" rx="1" />
      <circle cx="9" cy="14" r="1" /><circle cx="12" cy="14" r="1" /><circle cx="15" cy="14" r="1" />
    </svg>
  );
}

/**
 * What this thing LOOKS like, for the 94 catalogue models the PBX has no photo of.
 *
 * ⛔ Each drawing has to be recognisable at 28px against the object on the customer's
 * desk or wall — so they are silhouettes with one distinguishing feature each (the ATA
 * its row of sockets, the base its aerial, the speaker its sound arcs, the intercom its
 * call button), not detailed illustrations that turn to mush at this size.
 *
 * ⛔ `unknown` deliberately gets a PLAIN BOX rather than the phone. We do not know what
 * it is; drawing a telephone would be a claim, and the row's own words already say
 * "we could not tell what this is".
 */
function KindGlyph({ kind }: { kind: DeviceKind }) {
  // aria-hidden is written out on EVERY drawing below rather than carried in here, because
  // the wizard's accessibility guard reads the literal opening-tag text — a spread would
  // hide the attribute from it, and a guard that cannot see what it checks is not a guard.
  // (⛔ And this comment deliberately does not spell that tag out: the guard scans the raw
  // file, so prose quoting the tag is itself picked up as an unlabelled drawing.)
  const shell = {
    width: 28, height: 28, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.8,
    style: { color: "var(--dps-accent)" },
  };

  if (kind === "desk_phone") return <PhoneGlyph />;

  if (kind === "ata") {
    // A small flat box with phone sockets along the front — what an HT actually is.
    return (
      <svg {...shell} aria-hidden="true">
        <rect x="2.5" y="7" width="19" height="10" rx="2" />
        <rect x="5" y="13.5" width="3" height="2.2" rx="0.5" />
        <rect x="9.5" y="13.5" width="3" height="2.2" rx="0.5" />
        <rect x="14" y="13.5" width="3" height="2.2" rx="0.5" />
        <circle cx="19" cy="10" r="0.9" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (kind === "cordless_base") {
    // A cradle with a handset sitting in it, and the aerial that gives it away.
    return (
      <svg {...shell} aria-hidden="true">
        <path d="M4 20 h16 a1.5 1.5 0 0 0 1.5-1.5 v-2 h-19 v2 A1.5 1.5 0 0 0 4 20 Z" />
        <rect x="8" y="6" width="8" height="10.5" rx="2" />
        <path d="M18.5 9.5 V4" strokeLinecap="round" />
      </svg>
    );
  }

  if (kind === "pager") {
    // A ceiling speaker: the cone, and sound coming out of it.
    return (
      <svg {...shell} aria-hidden="true">
        <circle cx="9" cy="12" r="6.5" />
        <circle cx="9" cy="12" r="2.2" />
        <path d="M17 8.5 a5 5 0 0 1 0 7" strokeLinecap="round" />
        <path d="M20 6 a9 9 0 0 1 0 12" strokeLinecap="round" />
      </svg>
    );
  }

  if (kind === "doorbell") {
    // A narrow panel on a wall: grille at the top, the button you press below it.
    return (
      <svg {...shell} aria-hidden="true">
        <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
        <path d="M9.5 7 h5 M9.5 9.5 h5" strokeLinecap="round" />
        <circle cx="12" cy="16" r="2.2" />
      </svg>
    );
  }

  // unknown — a plain box. We do not know, so we do not draw a claim.
  return (
    <svg {...shell} aria-hidden="true">
      <rect x="3.5" y="6" width="17" height="12" rx="2.5" />
      <circle cx="7.5" cy="15" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* ⛔ Drawn, not described. "Ethernet" means nothing to most people; a picture of a
   cable going into a box does. Ported from the approved mockup. */
function CableDrawing() {
  return (
    <svg width="100%" height="128" viewBox="0 0 280 128" fill="none" role="img"
         aria-label="A desk phone with a network cable running into the office internet box">
      <DrawnPhone x={14} y={22} stroke="var(--dps-accent)" />
      <text x="42" y="106" fontSize="11" fill="var(--dps-dim)" textAnchor="middle">your phone</text>
      <path d="M70 62 H190" stroke="var(--dps-accent)" strokeWidth="3.6" strokeLinecap="round" />
      <circle cx="70" cy="62" r="4" fill="var(--dps-accent)" />
      <circle cx="190" cy="62" r="4" fill="var(--dps-accent)" />
      <text x="130" y="52" fontSize="11.5" fontWeight="600" fill="var(--dps-accent)" textAnchor="middle">a cable</text>
      <DrawnRouter x={190} y={46} stroke="var(--dps-accent)" />
      <text x="228" y="106" fontSize="11" fill="var(--dps-dim)" textAnchor="middle">internet box</text>
    </svg>
  );
}

function WifiDrawing() {
  return (
    <svg width="100%" height="128" viewBox="0 0 280 128" fill="none" role="img"
         aria-label="A desk phone connecting to the office internet box over Wi-Fi, with no cable">
      <DrawnPhone x={14} y={22} stroke="var(--dps-dim)" />
      <text x="42" y="106" fontSize="11" fill="var(--dps-dim)" textAnchor="middle">your phone</text>
      <g stroke="var(--dps-dim)" strokeWidth="2.6" strokeLinecap="round" fill="none">
        <path d="M84 72 a 15 15 0 0 1 0 -20" /><path d="M96 79 a 27 27 0 0 0 0 -34" />
        <path d="M186 72 a 15 15 0 0 0 0 -20" /><path d="M174 79 a 27 27 0 0 1 0 -34" />
      </g>
      <text x="135" y="46" fontSize="11.5" fontWeight="600" fill="var(--dps-dim)" textAnchor="middle">no cable</text>
      <DrawnRouter x={190} y={46} stroke="var(--dps-dim)" />
      <text x="228" y="106" fontSize="11" fill="var(--dps-dim)" textAnchor="middle">internet box</text>
    </svg>
  );
}

function SameNetworkDrawing() {
  const A = "var(--dps-accent)";
  return (
    <svg width="100%" height="200" viewBox="0 0 440 200" fill="none" role="img"
         aria-label="This computer and the desk phones all connect to the same office internet box">
      <DrawnRouter x={168} y={18} stroke={A} wide />
      <text x="220" y="74" fontSize="12" fontWeight="600" fill={A} textAnchor="middle">Your office internet</text>
      <g stroke={A} strokeWidth="2.4" strokeLinecap="round" fill="none">
        <path d="M220 56 v30" /><path d="M70 86 H352" />
        <path d="M70 86 v18" /><path d="M294 86 v18" /><path d="M352 86 v18" />
      </g>
      <g stroke={A} strokeWidth="1.8" fill="none">
        <rect x="34" y="104" width="72" height="46" rx="4" fill="var(--dps-panel)" />
        <rect x="40" y="110" width="60" height="30" rx="2" fill={A} opacity=".2" stroke="none" />
        <path d="M64 150 v9 M76 150 v9" strokeLinecap="round" /><path d="M48 160 h44" strokeLinecap="round" />
      </g>
      <text x="70" y="188" fontSize="11.5" fill="var(--dps-dim)" textAnchor="middle">This computer</text>
      <DrawnPhone x={266} y={104} stroke={A} />
      <DrawnPhone x={324} y={104} stroke={A} />
      <text x="323" y="188" fontSize="11.5" fill="var(--dps-dim)" textAnchor="middle">Your desk phones</text>
    </svg>
  );
}

function DrawnPhone({ x, y, stroke }: { x: number; y: number; stroke: string }) {
  return (
    <g stroke={stroke} strokeWidth="1.8" fill="none">
      <rect x={x} y={y + 10} width="56" height="56" rx="5" fill="var(--dps-panel)" />
      <rect x={x - 4} y={y} width="64" height="13" rx="6" fill="var(--dps-panel)" />
      <rect x={x + 9} y={y + 18} width="38" height="16" rx="2" fill={stroke} opacity=".22" stroke="none" />
      <g fill={stroke} opacity=".5" stroke="none">
        <circle cx={x + 15} cy={y + 43} r="2.4" /><circle cx={x + 28} cy={y + 43} r="2.4" /><circle cx={x + 41} cy={y + 43} r="2.4" />
        <circle cx={x + 15} cy={y + 54} r="2.4" /><circle cx={x + 28} cy={y + 54} r="2.4" /><circle cx={x + 41} cy={y + 54} r="2.4" />
      </g>
    </g>
  );
}

function DrawnRouter({ x, y, stroke, wide }: { x: number; y: number; stroke: string; wide?: boolean }) {
  const w = wide ? 104 : 76;
  const h = wide ? 38 : 32;
  return (
    <g stroke={stroke} strokeWidth="1.8" fill="none">
      <rect x={x} y={y} width={w} height={h} rx="6" fill="var(--dps-panel)" />
      <path d={`M${x + 18} ${y} v-12`} strokeLinecap="round" />
      <path d={`M${x + w - 18} ${y} v-16`} strokeLinecap="round" />
      <g stroke="none">
        <circle cx={x + 14} cy={y + h / 2} r="2.5" fill="var(--success, #34c27b)" />
        <circle cx={x + 24} cy={y + h / 2} r="2.5" fill="var(--success, #34c27b)" />
      </g>
    </g>
  );
}

"use client";

/**
 * THE GUIDED SETUP — one phone at a time, Laybel beside the person.
 *
 * Izzy, 2026-09-18: "The wizard is going to have browsers, the backend, and literally
 * open the UIs and put the link in… All we have to do is get the customer to factory
 * reset the phones, and that's it. The system takes it from there… Laybel live with
 * the customer… connect one phone at a time… check the last 4 of the MAC."
 *
 * What this file is NOT: a new setup engine. The server's ladder still decides what
 * happens to a phone and `setupDriver.ts` still performs it — this is a different
 * SCREEN on the same run: extension → phone (sticker check) → the person's one job
 * (factory reset, per-model picture) → the robot's timeline → connected → next.
 *
 * ⛔ "Connected" comes ONLY from the server's per-device `connectedNow` (2026-09-17).
 * ⛔ Laybel's words come from the server (`/laybel`), never invented here, so she can
 *    never know something the run does not.
 * ⛔ The classic wizard (`DeskPhoneWizard.tsx`) is untouched and still reachable —
 *    this is additive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "../../services/apiClient";
import { classifyDiscoveredHosts, shouldFingerprint } from "@connect/shared";
import { resetRecipeFor, type ResetRecipe } from "@connect/shared";
import { createSetupDriver, type NeedsPerson } from "./setupDriver";
import {
  candidateStateLine, classifyStuck, connectedAsMapped, extensionsWithPhones, orderCandidates,
  screenForFocused, stickerEndsIn, stickerMatches, type GuidedPhone, type GuidedScreen,
} from "./guidedFlow";
import { ResetIllustration } from "./ResetIllustration";
import { LaybelVideoCall } from "../LaybelVideoCall";
import type { LaybelStatus } from "../LaybelSetup";
import { wavBase64 } from "../../lib/laybelMic";
import { useAppContext } from "../../hooks/useAppContext";
import type { VoiceInput } from "../../lib/laybelSpeech";
import "./deskPhones.css";
import "./guidedSetup.css";

type Extension = { id: string; extNumber: string; displayName: string };
type Situation =
  | "choose_extension" | "choose_phone" | "confirm_phone" | "reset" | "reset_waiting" | "connecting"
  | "connected" | "stuck_old_provider" | "stuck_password" | "stuck_not_checking_in" | "stuck_unsupported"
  | "needs_serial" | "done_all";
type Caption = { role: "laybel" | "customer"; text: string; textYi?: string | null };
type Chip = { en: string; yi: string | null };
type Lang = "en" | "yi";
const LANG_KEY = "gps-laybel-lang";
function storedLang(): Lang { try { return localStorage.getItem(LANG_KEY) === "yi" ? "yi" : "en"; } catch { return "en"; } }
const isRtl = (t: string) => /[\u0590-\u05FF]/.test(t);
type Phase = "extension" | "phone" | "working";

function desktop(): any | null {
  if (typeof window === "undefined") return null;
  return (window as any).connectDesktop ?? null;
}
function token(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}

/** Poll cadence while the driver runs — the classic wizard's, unchanged. */
const TICK_MS = 4000;
/** How often the reset screen looks for the phone coming back fresh (a login is a read). */
const FRESH_WATCH_MS = 8000;

export function GuidedPhoneSetup({ onClose, onClassic }: { onClose: () => void; onClassic?: () => void }) {
  /*
    ⛔ WHOSE PHONES (Izzy, 2026-09-18: "from the super admin account, I can run the wizard for
    any customer just by selecting the tenant dropdown"). Every api call already carries the
    switcher's tenant (x-tenant-context) and the desk-phone doors honour it for a super-admin,
    so this screen is genuinely that customer's setup — and it SAYS so, in the header, the whole
    time, so nobody provisions the wrong company's phones without seeing it.
  */
  const { backendJwtRole, adminScope, tenant } = useAppContext();
  const actingFor = String(backendJwtRole ?? "").toUpperCase() === "SUPER_ADMIN" && adminScope === "TENANT" && tenant?.id && tenant.id !== "local" ? tenant : null;
  const [runId, setRunId] = useState<string | null>(null);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [phones, setPhones] = useState<GuidedPhone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [discoveryNote, setDiscoveryNote] = useState<string | null>(null);
  /** What the robot learned by LOOKING at each phone: fresh (factory password works) or not. */
  const [fresh, setFresh] = useState<Record<string, boolean | null>>({});

  const [phase, setPhase] = useState<Phase>("extension");
  const [focusExt, setFocusExt] = useState<Extension | null>(null);
  const [focusPhoneId, setFocusPhoneId] = useState<string | null>(null);
  const [stickerTyped, setStickerTyped] = useState("");
  const [confirming, setConfirming] = useState<GuidedPhone | null>(null);
  const [doneIds, setDoneIds] = useState<string[]>([]);

  const [needs, setNeeds] = useState<NeedsPerson[]>([]);
  const [hints, setHints] = useState<Record<string, string>>({});
  const [timeline, setTimeline] = useState<Array<{ at: number; text: string }>>([]);
  const [ticking, setTicking] = useState(false);
  const [saidRestarted, setSaidRestarted] = useState(false);
  const [serialDraft, setSerialDraft] = useState("");

  const driverRef = useRef<ReturnType<typeof createSetupDriver> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickingRef = useRef(false);
  const authorizedRef = useRef<Set<string>>(new Set());
  const lastSituationRef = useRef<string>("");

  /* ── Laybel ──────────────────────────────────────────────────────────── */
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [chips, setChips] = useState<Chip[]>([]);
  /*
    ⛔ YIDDISH (Izzy, 2026-09-18: "I should be able to select Yiddish also, and the agent
    should communicate through Yiddish Labs"). The choice is the customer's, remembered on
    this computer. The server carries the words through Yiddish Labs both ways; the brain
    and the truth fence stay in English; the avatar SPEAKS the English (the owner's
    language contract). When YL cannot translate, the English caption shows — never nothing.
  */
  const [language, setLanguage] = useState<Lang>(storedLang);
  const pickLanguage = useCallback((l: Lang) => { setLanguage(l); try { localStorage.setItem(LANG_KEY, l); } catch { /* per-viewer convenience only */ } }, []);
  const [listening, setListening] = useState(false);
  const [hearing, setHearing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [askDraft, setAskDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [laybelStatus, setLaybelStatus] = useState<LaybelStatus | null>(null);
  const [video, setVideo] = useState(false);
  const speakerRef = useRef<((text: string) => void) | null>(null);
  const captionsEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    apiGet<LaybelStatus>("/support/laybel/status").then((s) => { if (live) setLaybelStatus(s); }).catch(() => { /* captions-only is the baseline */ });
    return () => { live = false; };
  }, []);
  useEffect(() => { captionsEnd.current?.scrollIntoView({ block: "end" }); }, [captions]);

  const focused = useMemo(() => phones.find((p) => p.id === focusPhoneId) ?? null, [phones, focusPhoneId]);
  const recipe: ResetRecipe | null = useMemo(() => (focused ? resetRecipeFor(focused.vendor, focused.model) : null), [focused]);

  /** Laybel says something about the current situation — the server's words, spoken if video is on. */
  const laybelSay = useCallback(async (situation: Situation, message?: string, shown?: string) => {
    if (!runId) return;
    try {
      const out = await apiPost<{ say: string; chips: string[]; sayYiddish?: string | null; chipsYiddish?: string[] | null }>(`/desk-phones/runs/${runId}/laybel`, {
        situation,
        phoneId: focusPhoneId ?? undefined,
        message: message || undefined,
        language,
        transcript: captions.slice(-8).map((c) => ({ role: c.role, text: c.text })),
        observed: {
          freshOutOfBox: focusPhoneId ? fresh[focusPhoneId] === true : undefined,
          statusLine: focusPhoneId ? hints[focusPhoneId] : undefined,
        },
      });
      setCaptions((c) => [
        ...c,
        ...(message ? [{ role: "customer" as const, text: message, textYi: shown && shown !== message ? shown : null }] : []),
        { role: "laybel" as const, text: out.say, textYi: out.sayYiddish ?? null },
      ]);
      setChips((out.chips ?? []).map((en, i) => ({ en, yi: out.chipsYiddish?.[i] ?? null })));
      speakerRef.current?.(out.say);
      return out.say;
    } catch {
      /* the screen already says what is happening; a silent Laybel is not a broken setup */
      return undefined;
    }
  }, [runId, focusPhoneId, captions, fresh, hints, language]);
  const sayRef = useRef(laybelSay);
  sayRef.current = laybelSay;

  const situationSaid = useCallback((key: string, situation: Situation) => {
    if (lastSituationRef.current === key) return;
    lastSituationRef.current = key;
    void sayRef.current(situation);
  }, []);

  const ask = useCallback(async (text: string, shown?: string) => {
    const t = text.trim();
    if (!t || asking) return;
    setAsking(true); setAskDraft("");
    const screen = currentScreenRef.current;
    const situation: Situation =
      screen === "extension" ? "choose_extension" : screen === "phone" ? "choose_phone" : screen === "reset" ? (saidRestarted ? "reset_waiting" : "reset")
      : screen === "connecting" ? "connecting" : screen === "connected" ? "connected" : screen === "all_done" ? "done_all"
      : focused ? (`stuck_${classifyStuck(focused.note)}` as Situation) : "connecting";
    try { await sayRef.current(situation, t, shown); } finally { setAsking(false); }
  }, [asking, saidRestarted, focused]);

  /*
    THE MIC (Izzy, 2026-09-18: "Add a mic so they can talk for transcription"). Press to
    talk, press again to stop; the clip goes to the run's /laybel/hear door, Yiddish Labs
    transcribes it (Yiddish or English, auto), and the words come back as the customer's
    own caption before Laybel answers. ⛔ Nothing is sent until the person stops the
    recording; a failed transcription is said on screen, never guessed.
  */
  const stopListening = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state !== "inactive") r.stop();
    setListening(false);
  }, []);
  const startListening = useCallback(async () => {
    if (!runId || listening || hearing) return;
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { setError("The microphone isn't available on this computer — type instead."); return; }
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime });
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunksRef.current, { type: mime });
      chunksRef.current = [];
      if (blob.size < 200) return;
      setHearing(true);
      try {
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        const heard = await apiPost<{ ok: boolean; transcript: string; english: string; yiddish: boolean }>(`/desk-phones/runs/${runId}/laybel/hear`, { audioBase64: btoa(bin), filename: "mic.webm" });
        if (heard.transcript) await ask(heard.english || heard.transcript, heard.transcript);
      } catch (err: any) {
        setError(err?.body?.message || "I couldn't hear that — try again, or type instead.");
      } finally { setHearing(false); }
    };
    recorderRef.current = rec;
    rec.start();
    setListening(true);
    // A clip is at most 30 s — the mic is for a sentence, not a speech.
    setTimeout(() => { if (recorderRef.current === rec && rec.state === "recording") { rec.stop(); setListening(false); } }, 30_000);
  }, [runId, listening, hearing, ask]);
  useEffect(() => () => { const r = recorderRef.current; if (r && r.state !== "inactive") r.stop(); }, []);

  /* ── the run ─────────────────────────────────────────────────────────── */
  const loadRun = useCallback(async (id: string) => {
    const out = await apiGet<{ phones: GuidedPhone[] }>(`/desk-phones/runs/${id}`);
    setPhones(out.phones);
    return out;
  }, []);

  const probeFresh = useCallback(async (list: GuidedPhone[]) => {
    const bridge = desktop()?.phoneSetup;
    if (!bridge) return;
    // ⛔ Only a maker the robot has a family for (Yealink page, Grandstream cgi); a login is a READ.
    const targets = list.filter((p) => p.ip && /yealink|grandstream/i.test(p.vendor ?? "") && p.connectedNow !== true);
    const queue = [...targets];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const r = await bridge.run({ op: "web_probe", ip: p.ip, vendor: p.vendor ?? null }).catch(() => null);
        const isFresh = r?.ok === true && r.loginWorked === true && r.usedDefault === true ? true : r?.ok === true && r.loginWorked === false ? false : null;
        setFresh((f) => ({ ...f, [p.id]: isFresh }));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }, []);

  const discover = useCallback(async (id: string) => {
    const bridge = desktop()?.phoneSetup;
    if (!bridge) {
      setDiscovery("failed");
      setDiscoveryNote("Phone setup needs the Loopcom app on a computer in the same office as your phones.");
      return;
    }
    setDiscovery("running"); setDiscoveryNote(null);
    try {
      const scan = await bridge.run({ op: "discover" });
      if (!scan?.ok || scan.scan?.outcome === "failed") {
        setDiscovery("failed");
        setDiscoveryNote(String(scan?.scan?.note || "We could not look at this network from this computer.").slice(0, 300));
        return;
      }
      const hosts: any[] = scan.scan?.hosts ?? [];
      const enriched: any[] = [];
      for (const h of hosts) {
        if (h.fingerprint?.model) { enriched.push(h); continue; }
        if (!shouldFingerprint(h)) { enriched.push({ ...h, fingerprint: h.fingerprint ?? null }); continue; }
        const fp = await bridge.run({ op: "fingerprint", ip: h.ip }).catch(() => null);
        enriched.push({ ...h, fingerprint: fp?.ok ? fp.fingerprint : (h.fingerprint ?? null) });
      }
      const verdict = classifyDiscoveredHosts(enriched);
      const found = verdict.phones.map((h: any) => ({
        mac: h.mac, ip: h.ip,
        vendor: h.fingerprint?.vendor ?? undefined, model: h.fingerprint?.model ?? undefined, firmware: h.fingerprint?.firmware ?? undefined,
        identitySource: typeof h.fingerprint?.source === "string" ? h.fingerprint.source
          : (h.fingerprint?.model || (h.fingerprint?.vendor && h.fingerprint.vendor !== "unknown")) ? undefined : "none",
      }));
      const out = await apiPost<{ phones: GuidedPhone[] }>(`/desk-phones/runs/${id}/discovered`, { subnet: scan.scan?.subnet ?? undefined, phones: found });
      setPhones(out.phones);
      setDiscovery("done");
      void probeFresh(out.phones);
    } catch {
      setDiscovery("failed");
      setDiscoveryNote("Something went wrong while searching. Try again.");
    }
  }, [probeFresh]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const out = await apiPost<{ run: { id: string } }>("/desk-phones/runs", { deviceLabel: typeof navigator !== "undefined" ? navigator.platform : undefined });
        if (!live) return;
        setRunId(out.run.id);
        const ext = await apiGet<{ extensions: Extension[] }>("/desk-phones/extensions").catch(() => ({ extensions: [] }));
        if (!live) return;
        setExtensions(ext.extensions ?? []);
        void discover(out.run.id);
      } catch {
        if (live) setError("We could not start setup just now. Try again in a moment.");
      }
    })();
    return () => { live = false; if (pollRef.current) clearInterval(pollRef.current); };
  }, [discover]);

  useEffect(() => { if (runId && phase === "extension") situationSaid(`ext:${runId}`, "choose_extension"); }, [runId, phase, situationSaid]);

  /* ── the driver loop (the classic wizard's, per focused phone) ─────────── */
  const stopTicking = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setTicking(false);
  }, []);

  const startTicking = useCallback(() => {
    if (!runId) return;
    if (!driverRef.current) {
      driverRef.current = createSetupDriver(
        runId, { get: apiGet, post: apiPost }, desktop()?.phoneSetup ?? null, undefined,
        (phoneId, text) => {
          setHints((h) => ({ ...h, [phoneId]: text }));
          if (phoneId === focusRef.current) setTimeline((t) => (t.length && t[t.length - 1].text === text ? t : [...t, { at: Date.now(), text }]));
        },
      );
    }
    if (pollRef.current) clearInterval(pollRef.current);
    setTicking(true);
    const tickNow = async () => {
      if (tickingRef.current || !driverRef.current) return;
      tickingRef.current = true;
      try {
        const out = await driverRef.current.tick();
        setPhones(out.phones);
        setNeeds(out.needs);
        setHints((h) => ({ ...h, ...(out.hints ?? {}) }));
        const fid = focusRef.current;
        if (fid && out.hints?.[fid]) {
          const text = out.hints[fid];
          setTimeline((t) => (t.length && t[t.length - 1].text === text ? t : [...t, { at: Date.now(), text }]));
        }
        // ⛔ The person already said "set this one up, wipe it" on the confirm screen —
        // that is the authorization the ladder asks for. Given ONCE per phone, only for
        // the phone in front of them; every other phone keeps the classic gate.
        const auth = out.needs.find((n) => n.kind === "reset_authorization" && fid && n.phoneIds.includes(fid));
        if (auth && fid && !authorizedRef.current.has(fid)) {
          authorizedRef.current.add(fid);
          await apiPost(`/desk-phones/runs/${runId}/authorize-reset`, { phoneIds: [fid] }).catch(() => null);
        }
      } catch { /* the next tick looks again */ }
      finally { tickingRef.current = false; }
    };
    void tickNow();
    pollRef.current = setInterval(tickNow, TICK_MS);
  }, [runId]);

  const focusRef = useRef<string | null>(null);
  focusRef.current = focusPhoneId;

  /* ── choices ─────────────────────────────────────────────────────────── */
  const chooseExtension = useCallback((e: Extension) => {
    setFocusExt(e); setConfirming(null); setStickerTyped(""); setPhase("phone");
    situationSaid(`phone:${e.id}`, "choose_phone");
  }, [situationSaid]);

  const beginPhone = useCallback(async (p: GuidedPhone) => {
    if (!runId || !focusExt) return;
    setError(null);
    try {
      if (String(p.extNumber ?? "") !== String(focusExt.extNumber)) {
        await apiPost(`/desk-phones/runs/${runId}/phones/${p.id}/assign`, { extensionId: focusExt.id });
      }
      const selected = Array.from(new Set([...doneIds, p.id]));
      await apiPost(`/desk-phones/runs/${runId}/selection`, { phoneIds: selected });
      if (p.needsAttention) {
        await apiPost(`/desk-phones/runs/${runId}/phones/${p.id}/retry`, {}).catch(() => null);
        driverRef.current?.retried(p.id);
      }
      await loadRun(runId);
      setFocusPhoneId(p.id);
      setTimeline([]); setSaidRestarted(false); setConfirming(null);
      setPhase("working");
      lastSituationRef.current = "";
      startTicking();
    } catch (err: any) {
      setError(err?.body?.message || "That could not be saved. Try again.");
    }
  }, [runId, focusExt, doneIds, loadRun, startTicking]);

  const restarted = useCallback(async () => {
    if (!runId || !focusPhoneId) return;
    setSaidRestarted(true);
    await apiPost(`/desk-phones/runs/${runId}/phones/${focusPhoneId}/retry`, {}).catch(() => null);
    driverRef.current?.retried(focusPhoneId);
    situationSaid(`waiting:${focusPhoneId}`, "reset_waiting");
  }, [runId, focusPhoneId, situationSaid]);

  const supplySerial = useCallback(async () => {
    if (!runId || !focusPhoneId) return;
    const typed = serialDraft.trim();
    if (!typed) return;
    const text = /\b(S\/?N|SN|SERIAL)\b/i.test(typed) ? typed : `S/N: ${typed}`;
    try {
      await apiPost(`/desk-phones/runs/${runId}/phones/${focusPhoneId}/scan-label`, { text: text.slice(0, 600) });
      driverRef.current?.serialProvided(focusPhoneId);
      setSerialDraft("");
      setNeeds((n) => n.filter((x) => !(x.kind === "serial" && x.phoneId === focusPhoneId)));
      await loadRun(runId);
    } catch (err: any) {
      setError(err?.body?.message || "That serial number could not be read. Check it against the sticker and try again.");
    }
  }, [runId, focusPhoneId, serialDraft, loadRun]);

  const nextPhone = useCallback(() => {
    stopTicking();
    if (focusPhoneId) setDoneIds((d) => Array.from(new Set([...d, focusPhoneId])));
    setFocusPhoneId(null); setFocusExt(null); setTimeline([]); setNeeds([]);
    setPhase("extension");
    lastSituationRef.current = "";
    if (runId) void loadRun(runId);
  }, [stopTicking, focusPhoneId, runId, loadRun]);

  const ringIt = useCallback(() => {
    if (!focusExt) return;
    window.dispatchEvent(new CustomEvent("crm:dial", { detail: { target: String(focusExt.extNumber) } }));
  }, [focusExt]);

  const finish = useCallback(async () => {
    stopTicking();
    if (runId) await apiPost(`/desk-phones/runs/${runId}/office-stop`, {}).catch(() => null);
    onClose();
  }, [stopTicking, runId, onClose]);

  /* ── which screen ────────────────────────────────────────────────────── */
  const extRows = useMemo(() => extensionsWithPhones(extensions, phones), [extensions, phones]);
  const allDone = extRows.length > 0 && extRows.every((r) => r.phone);
  const workingScreen = screenForFocused(focused, needs, { ticking });
  const screen: GuidedScreen = phase === "extension" ? (allDone ? "all_done" : "extension") : phase === "phone" ? "phone" : workingScreen;
  const currentScreenRef = useRef<GuidedScreen>(screen);
  currentScreenRef.current = screen;
  const serialNeed = needs.find((n) => n.kind === "serial" && n.phoneId === focusPhoneId) ?? null;
  const stuckKind = focused ? classifyStuck(focused.note) : "not_checking_in";

  // Laybel narrates every screen change, once per (phone, screen).
  useEffect(() => {
    if (!focusPhoneId || phase !== "working") return;
    const key = `${focusPhoneId}:${screen}:${serialNeed ? "serial" : ""}`;
    if (serialNeed) return situationSaid(key, "needs_serial");
    if (screen === "reset") return situationSaid(key, saidRestarted ? "reset_waiting" : "reset");
    if (screen === "connecting") return situationSaid(key, "connecting");
    if (screen === "connected") return situationSaid(key, "connected");
    if (screen === "stuck") return situationSaid(key, `stuck_${stuckKind}` as Situation);
  }, [focusPhoneId, phase, screen, serialNeed, saidRestarted, stuckKind, situationSaid]);
  useEffect(() => { if (screen === "all_done") situationSaid("all_done", "done_all"); }, [screen, situationSaid]);
  useEffect(() => { if (screen === "connected") stopTicking(); }, [screen, stopTicking]);

  // ⛔ The reset screen advances ITSELF: the moment the factory password opens the
  // phone's page again, the reset is proven and the driver is told to look afresh.
  useEffect(() => {
    if (screen !== "reset" || !focused?.ip || !/yealink|grandstream/i.test(focused.vendor ?? "") || saidRestarted) return;
    const bridge = desktop()?.phoneSetup;
    if (!bridge) return;
    let live = true;
    const look = async () => {
      const r = await bridge.run({ op: "web_probe", ip: focused.ip, vendor: focused.vendor ?? null }).catch(() => null);
      if (!live) return;
      if (r?.ok === true && r.loginWorked === true && r.usedDefault === true) {
        setFresh((f) => ({ ...f, [focused.id]: true }));
        void restarted();
      }
    };
    const t = setInterval(look, FRESH_WATCH_MS);
    return () => { live = false; clearInterval(t); };
  }, [screen, focused, saidRestarted, restarted]);

  /* ── render ──────────────────────────────────────────────────────────── */
  const connectedCount = extRows.filter((r) => r.phone).length;
  const candidates = useMemo(() => orderCandidates(phones), [phones]);
  const laybelVideoAllowed = Boolean(laybelStatus?.available && laybelStatus?.enabled !== false);

  return (
    <div className="dps-root gps-root">
      <aside className="gps-rail">
        <div className="gps-rail-head">
          <span className="gps-dot" />
          <span className="gps-rail-title">LAYBEL · LIVE</span>
          <div className="gps-lang" role="group" aria-label="Language">
            <button type="button" className={`gps-lang-btn ${language === "en" ? "gps-lang-on" : ""}`} onClick={() => pickLanguage("en")} aria-pressed={language === "en"}>English</button>
            <button type="button" className={`gps-lang-btn ${language === "yi" ? "gps-lang-on" : ""}`} onClick={() => pickLanguage("yi")} aria-pressed={language === "yi"} lang="yi">ייִדיש</button>
          </div>
          {onClassic && <button type="button" className="gps-link" onClick={onClassic}>Classic setup</button>}
        </div>
        {laybelVideoAllowed && video ? (
          <div className="gps-video">
            <LaybelVideoCall
              onTurn={async (text) => { const say = await sayRef.current(situationFor(currentScreenRef.current, saidRestarted, focused), text); return say ? { reply: say } : undefined; }}
              onTranscribe={async (pcm, signal) => {
                const response = await fetch("/agent-api/chat/voice-transcribe", {
                  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
                  body: JSON.stringify({ audioBase64: wavBase64(pcm) }), signal: AbortSignal.any([signal, AbortSignal.timeout(50_000)]),
                });
                if (!response.ok) throw new Error("yiddishlabs_transcription_unavailable");
                const result = await response.json();
                if (!result.ok || typeof result.text !== "string") throw new Error("yiddishlabs_transcription_unavailable");
                return result as VoiceInput & { ms: number };
              }}
              onEnd={() => { speakerRef.current = null; setVideo(false); }}
              onVoiceOnly={() => { speakerRef.current = null; setVideo(false); }}
              onSpeaker={(s) => { speakerRef.current = s; }}
            />
          </div>
        ) : (
          <div className="gps-portrait">
            <svg width="96" height="96" viewBox="0 0 120 120" fill="none" aria-hidden="true">
              <circle cx="60" cy="46" r="24" stroke="var(--dps-accent)" strokeWidth="3" />
              <path d="M18 108c6-24 22-34 42-34s36 10 42 34" stroke="var(--dps-accent)" strokeWidth="3" strokeLinecap="round" />
            </svg>
            {laybelVideoAllowed && <button type="button" className="dps-btn dps-btn-g dps-btn-s" onClick={() => setVideo(true)}>Turn on video</button>}
          </div>
        )}
        <div className="gps-captions" aria-live="polite">
          {captions.length === 0 && <div className="gps-cap gps-cap-laybel">Hi, I'm Laybel. One moment while I look around your network…</div>}
          {captions.slice(-6).map((c, i) => {
            const shown = language === "yi" && c.textYi ? c.textYi : (c.role === "customer" && c.textYi ? c.textYi : c.text);
            return <div key={i} className={`gps-cap gps-cap-${c.role}`} dir={isRtl(shown) ? "rtl" : "ltr"} lang={isRtl(shown) ? "yi" : "en"}>{shown}</div>;
          })}
          <div ref={captionsEnd} />
        </div>
        {chips.length > 0 && (
          <div className="gps-chips">
            {chips.map((c) => {
              const label = language === "yi" && c.yi ? c.yi : c.en;
              return <button key={c.en} type="button" className="gps-chip" dir={isRtl(label) ? "rtl" : "ltr"} onClick={() => void ask(c.en, label)} disabled={asking}>{label}</button>;
            })}
          </div>
        )}
        <form className="gps-ask" onSubmit={(e) => { e.preventDefault(); void ask(askDraft); }}>
          <label htmlFor="gps-ask" className="gps-sr">Ask Laybel</label>
          <input id="gps-ask" className="dps-managed-input" placeholder={language === "yi" ? "פרעגט מיך עפּעס…" : "Ask me anything…"} dir={language === "yi" ? "rtl" : "ltr"} value={askDraft} onChange={(e) => setAskDraft(e.target.value)} disabled={asking || hearing} />
          <button
            type="button"
            className={`gps-mic ${listening ? "gps-mic-on" : ""}`}
            aria-label={listening ? "Stop and send" : "Talk to Laybel"}
            aria-pressed={listening}
            title={listening ? "Stop and send" : "Talk — Yiddish or English"}
            disabled={hearing || asking}
            onClick={() => (listening ? stopListening() : void startListening())}
          >
            {hearing ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
            )}
          </button>
          <button type="submit" className="dps-btn dps-btn-p dps-btn-s" disabled={asking || hearing || !askDraft.trim()}>{language === "yi" ? "שיק" : "Send"}</button>
        </form>
        <div className="gps-rail-note">
          {listening ? "Listening… press the mic again to send." : hearing ? "Turning your words into text…" : language === "yi" ? "Captions in Yiddish via Yiddish Labs. If video pauses, I keep talking here." : "Captions always on. If video pauses, I keep talking here."}
        </div>
      </aside>

      <main className="gps-main">
        {actingFor && (
          <div className="gps-acting" role="status">
            Setting up phones for <b>{actingFor.name}</b> — pick a different company from the tenant menu to change this.
          </div>
        )}
        <header className="gps-head">
          <div>
            <div className="gps-kicker">{focusExt ? `SETTING UP EXT ${focusExt.extNumber} · ${focusExt.displayName}` : "DESK PHONE SETUP"}{focused ? ` · ${focused.model ?? focused.vendor ?? "phone"} · …${stickerEndsIn(focused.mac) ?? ""}` : ""}</div>
            <h1 className="gps-h1">
              {screen === "extension" && "Which extension first?"}
              {screen === "phone" && "Which phone is this one?"}
              {screen === "reset" && (saidRestarted ? "Waiting for it to come back" : "Reset this phone")}
              {screen === "connecting" && `Connecting ${focusExt?.displayName ?? "this"} phone`}
              {screen === "connected" && `${focusExt?.displayName ?? "This"} phone is connected`}
              {screen === "stuck" && (stuckKind === "old_provider" ? "This one needs a day — I've handled it" : stuckKind === "unsupported" ? "This one needs a person" : "This one needs another go")}
              {screen === "all_done" && "Every phone is connected"}
            </h1>
          </div>
          <div className="gps-progress">{connectedCount} of {extRows.length || "?"} phones connected</div>
          <button type="button" onClick={() => void finish()} aria-label="Close" className="gps-close">×</button>
        </header>

        {error && <div className="dps-err" role="alert">{error}</div>}

        {screen === "extension" && (
          <>
            <div className="gps-grid2">
              {extRows.map((e) => (
                <button key={e.id} type="button" className={`gps-card ${e.phone ? "gps-card-done" : ""}`} onClick={() => chooseExtension(e)}>
                  <span className="gps-extnum">{e.extNumber}</span>
                  <span className="gps-card-body">
                    <span className="gps-card-title">{e.displayName}</span>
                    <span className={`gps-card-sub ${e.phone ? "gps-ok" : ""}`}>
                      {e.phone ? `Connected · ${e.phone.model ?? e.phone.vendor ?? "phone"} · …${stickerEndsIn(e.phone.mac) ?? ""}` : "No phone connected yet"}
                    </span>
                  </span>
                  <span className="gps-card-cta">{e.phone ? "Replace →" : "Set up →"}</span>
                </button>
              ))}
              {extensions.length === 0 && <div className="dps-hint">Loading your extensions…</div>}
            </div>
            <div className="gps-note">
              {discovery === "running" && "I'm looking around your network for phones in the background — by the time you pick, I'll know which ones I found."}
              {discovery === "done" && `I found ${phones.length} ${phones.length === 1 ? "phone" : "phones"} on your network.`}
              {discovery === "failed" && <>{discoveryNote} <button type="button" className="gps-link" onClick={() => runId && void discover(runId)}>Look again</button></>}
            </div>
          </>
        )}

        {screen === "phone" && (
          <>
            <div className="gps-grid3">
              {candidates.map((p) => {
                const state = candidateStateLine(p, fresh[p.id] ?? null);
                const chosen = confirming?.id === p.id;
                return (
                  <div key={p.id} className={`gps-phone ${chosen ? "gps-phone-on" : ""}`}>
                    <div className="gps-phone-pic"><PhoneGlyph /></div>
                    <div className="gps-phone-model">{p.model ?? (p.vendor ? `${p.vendor} phone` : "Unknown phone")}</div>
                    <div className="gps-sticker-label">STICKER ENDS IN</div>
                    <div className="gps-sticker">{stickerEndsIn(p.mac) ?? "—"}</div>
                    <div className={`gps-phone-state gps-${state.tone}`}>{state.text}</div>
                    {!chosen ? (
                      <button type="button" className="dps-btn dps-btn-g" onClick={() => { setConfirming(p); setStickerTyped(""); }}>
                        {connectedAsMapped(p) && String(p.extNumber) !== String(focusExt?.extNumber) ? `Move it to ${focusExt?.extNumber}` : `This is ${focusExt?.displayName ?? "the one"}'s`}
                      </button>
                    ) : (
                      <div className="gps-confirm">
                        <label htmlFor="gps-sticker">Type the last 4 from the sticker to be sure</label>
                        <input id="gps-sticker" className="dps-managed-input" value={stickerTyped} onChange={(e) => setStickerTyped(e.target.value)} placeholder={stickerEndsIn(p.mac)?.replace(/[0-9A-F]/g, "•") ?? "••••"} autoFocus />
                        <button type="button" className="dps-btn dps-btn-p" disabled={!stickerMatches(p.mac, stickerTyped)} onClick={() => void beginPhone(p)}>
                          {fresh[p.id] === true || p.connectedNow === true ? "Set it up" : "Set it up (this wipes it)"}
                        </button>
                        {stickerTyped.replace(/[^0-9a-f]/gi, "").length >= 4 && !stickerMatches(p.mac, stickerTyped) && <div className="gps-warn">That's a different phone — check the sticker again.</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="gps-note">
              {discovery === "running" ? "Still looking — more phones may appear." : "Not in the list? Plug it in and wait a moment, then tell me the last four characters on its sticker."}
            </div>
            <footer className="gps-foot">
              <button type="button" className="gps-link" onClick={() => { setPhase("extension"); setFocusExt(null); }}>← Different extension</button>
              <span className="dps-hint">Step 2 of 5 · Match</span>
            </footer>
          </>
        )}

        {screen === "reset" && recipe && (
          <>
            <div className="gps-reset">
              <div className="gps-illus">
                <ResetIllustration kind={recipe.illustration} holdSeconds={recipe.holdSeconds} label={`${focused?.model ?? "Phone"} — ${recipe.headline}`} />
                <span className="gps-illus-tag">{(focused?.vendor ?? "").toUpperCase()} {focused?.model ?? ""} · RESET</span>
              </div>
              <div className="gps-steps">
                <div className="gps-recipe-head">{recipe.headline}</div>
                {recipe.steps.map((s, i) => (
                  <div key={i} className={`gps-step ${i === 0 && !saidRestarted ? "gps-step-on" : ""}`}><span className="gps-step-n">{i + 1}</span><span>{s}</span></div>
                ))}
                {recipe.confidence === "inferred" && <div className="gps-note">Menus differ a little on this maker — if yours doesn't match, tell Laybel what the screen says.</div>}
                <div className="gps-note">
                  {saidRestarted
                    ? "The phone is restarting. I'm watching your network — this screen moves on by itself the moment it comes back fresh."
                    : "I'm watching the network. The moment it comes back fresh, this screen moves on by itself — you don't have to click anything."}
                </div>
                <div className="gps-actions">
                  {!saidRestarted && <button type="button" className="dps-btn dps-btn-p dps-btn-big" onClick={() => void restarted()}>It restarted</button>}
                  <button type="button" className="dps-btn dps-btn-g" onClick={() => void ask(recipe.ifItLooksDifferent ? "It looks different from these steps" : "Show me a different way")}>Show me a different way</button>
                </div>
              </div>
            </div>
            {serialNeed && <SerialAsk draft={serialDraft} setDraft={setSerialDraft} onSupply={supplySerial} onSkip={() => { if (focusPhoneId) driverRef.current?.serialUnavailable(focusPhoneId); setNeeds((n) => n.filter((x) => !(x.kind === "serial" && x.phoneId === focusPhoneId))); }} />}
            <footer className="gps-foot">
              <button type="button" className="gps-link" onClick={() => { stopTicking(); setPhase("phone"); setFocusPhoneId(null); }}>← Wrong phone</button>
              <span className="dps-hint">Step 3 of 5 · Reset</span>
            </footer>
          </>
        )}

        {screen === "connecting" && (
          <>
            <div className="gps-timeline">
              {(timeline.length ? timeline : [{ at: Date.now(), text: hints[focusPhoneId ?? ""] ?? "Checking this phone…" }]).map((t, i, arr) => (
                <div key={i} className="gps-tl-row">
                  <div className="gps-tl-rail"><span className={`gps-tl-dot ${i === arr.length - 1 ? "gps-tl-now" : "gps-tl-done"}`} />{i < arr.length - 1 && <span className="gps-tl-line" />}</div>
                  <div className="gps-tl-body"><span className="gps-tl-text">{t.text}</span><span className="gps-tl-time">{new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></div>
                </div>
              ))}
              <div className="gps-tl-row">
                <div className="gps-tl-rail"><span className="gps-tl-dot gps-tl-todo" /></div>
                <div className="gps-tl-body"><span className="gps-tl-text gps-dim">Waiting for it to check in as ext {focusExt?.extNumber}</span><span className="gps-tl-time">turns green only when your phone system sees <b>this exact phone</b></span></div>
              </div>
            </div>
            {serialNeed && <SerialAsk draft={serialDraft} setDraft={setSerialDraft} onSupply={supplySerial} onSkip={() => { if (focusPhoneId) driverRef.current?.serialUnavailable(focusPhoneId); setNeeds((n) => n.filter((x) => !(x.kind === "serial" && x.phoneId === focusPhoneId))); }} />}
            <footer className="gps-foot"><span className="dps-hint">Step 4 of 5 · Connect</span><button type="button" className="gps-link" onClick={() => void ask("What are you doing right now?")}>What are you doing?</button></footer>
          </>
        )}

        {screen === "connected" && focused && (
          <>
            <div className="gps-live">
              <span className="gps-live-check">✓</span>
              <div className="gps-live-body">
                <div className="gps-live-title">Your phone system sees this phone as ext {focused.registeredAsExt ?? focusExt?.extNumber}</div>
                <div className="gps-live-sub">Checked in from the phone itself — this is the phone system's own word, not a guess. The screen should show <b>{focusExt?.extNumber}</b> at the top.</div>
              </div>
              <button type="button" className="dps-btn dps-btn-p dps-btn-big" onClick={ringIt}>Ring it now</button>
            </div>
            <SummaryList rows={extRows} focus={focusExt?.id ?? null} />
            <footer className="gps-foot">
              <span className="dps-hint">Step 5 of 5 · Done with this phone</span>
              <div className="gps-actions">
                <button type="button" className="dps-btn dps-btn-g" onClick={() => void finish()}>I'm done for today</button>
                <button type="button" className="dps-btn dps-btn-p" onClick={nextPhone}>{allDone ? "All done →" : "Next phone →"}</button>
              </div>
            </footer>
          </>
        )}

        {screen === "stuck" && focused && (
          <>
            <div className="gps-stuck">
              <div className="gps-stuck-title">
                {stuckKind === "old_provider" && "Your old provider's cloud still owns this phone"}
                {stuckKind === "password" && "This phone still has the old provider's password"}
                {stuckKind === "unsupported" && "I can't set this model up on my own yet"}
                {stuckKind === "not_checking_in" && "This phone took its settings but hasn't checked in"}
              </div>
              <div className="gps-stuck-sub">{focused.note ?? ""}</div>
            </div>
            <div className="gps-steps">
              {stuckKind === "old_provider" && (<>
                <div className="gps-step gps-step-done"><span className="gps-step-n">✓</span><span>Reset confirmed, set up, restarted — it came back on the old provider's address, not ours.</span></div>
                <div className="gps-step gps-step-done"><span className="gps-step-n">✓</span><span>Release request filed with the maker, automatically, with this phone's details.</span></div>
                <div className="gps-step gps-step-on"><span className="gps-step-n">→</span><span>The moment they let go, I finish this phone by myself — nothing for you to do.</span></div>
              </>)}
              {stuckKind === "password" && (<>
                <div className="gps-step gps-step-on"><span className="gps-step-n">1</span><span>Do the reset once more — hold longer this time, a full fifteen seconds.</span></div>
                <div className="gps-step"><span className="gps-step-n">2</span><span>If it still asks for a password, unplug it, wait five seconds, plug it back in and try again.</span></div>
              </>)}
              {stuckKind === "not_checking_in" && (<>
                <div className="gps-step gps-step-on"><span className="gps-step-n">1</span><span>Check the network cable at that desk is clicked in at both ends.</span></div>
                <div className="gps-step"><span className="gps-step-n">2</span><span>Then press Try again — I'll restart it and watch for it once more.</span></div>
              </>)}
              {stuckKind === "unsupported" && (<div className="gps-step gps-step-on"><span className="gps-step-n">→</span><span>A Loopcom person will finish it with you — everything about it is already written down, so you won't have to explain.</span></div>)}
            </div>
            <footer className="gps-foot">
              <div className="gps-actions">
                {stuckKind !== "old_provider" && stuckKind !== "unsupported" && (
                  <button type="button" className="dps-btn dps-btn-g" onClick={async () => { if (!runId || !focusPhoneId) return; await apiPost(`/desk-phones/runs/${runId}/phones/${focusPhoneId}/retry`, {}).catch(() => null); driverRef.current?.retried(focusPhoneId); setSaidRestarted(false); lastSituationRef.current = ""; await loadRun(runId); startTicking(); }}>Try again</button>
                )}
                <button type="button" className="dps-btn dps-btn-g" onClick={() => void ask("I'd like to talk to a person")}>Talk to a person</button>
              </div>
              <button type="button" className="dps-btn dps-btn-p" onClick={nextPhone}>Next phone →</button>
            </footer>
          </>
        )}

        {screen === "all_done" && (
          <>
            <div className="gps-live">
              <span className="gps-live-check">✓</span>
              <div className="gps-live-body">
                <div className="gps-live-title">All {extRows.length} phones are connected and can make calls</div>
                <div className="gps-live-sub">Each one was seen checking in by your phone system itself.</div>
              </div>
            </div>
            <SummaryList rows={extRows} focus={null} />
            <footer className="gps-foot"><span /><button type="button" className="dps-btn dps-btn-p dps-btn-big" onClick={() => void finish()}>Done</button></footer>
          </>
        )}
      </main>
    </div>
  );
}

function situationFor(screen: GuidedScreen, saidRestarted: boolean, focused: GuidedPhone | null): Situation {
  switch (screen) {
    case "extension": return "choose_extension";
    case "phone": return "choose_phone";
    case "reset": return saidRestarted ? "reset_waiting" : "reset";
    case "connecting": return "connecting";
    case "connected": return "connected";
    case "all_done": return "done_all";
    case "stuck": return `stuck_${classifyStuck(focused?.note)}` as Situation;
  }
}

function SerialAsk({ draft, setDraft, onSupply, onSkip }: { draft: string; setDraft: (v: string) => void; onSupply: () => void; onSkip: () => void }) {
  return (
    <div className="gps-serial">
      <label htmlFor="gps-serial">The maker's cloud needs this phone's serial number — it's on the sticker after S/N</label>
      <div className="gps-actions">
        <input id="gps-serial" className="dps-managed-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="S/N" />
        <button type="button" className="dps-btn dps-btn-p" onClick={onSupply} disabled={!draft.trim()}>Save</button>
        <button type="button" className="dps-btn dps-btn-g" onClick={onSkip}>I don't have it</button>
      </div>
    </div>
  );
}

function SummaryList({ rows, focus }: { rows: ReturnType<typeof extensionsWithPhones>; focus: string | null }) {
  return (
    <div className="gps-summary">
      <div className="gps-kicker">ALL PHONES</div>
      {rows.map((e) => (
        <div key={e.id} className={`gps-sum-row ${e.id === focus ? "gps-sum-focus" : ""}`}>
          <span className={`gps-extnum-sm ${e.phone ? "gps-ok" : ""}`}>{e.extNumber}</span>
          <span className="gps-sum-name">{e.displayName}</span>
          <span className="gps-sum-sub">{e.phone ? `${e.phone.model ?? e.phone.vendor ?? "phone"} · …${stickerEndsIn(e.phone.mac) ?? ""}` : "Not set up yet"}</span>
          <span className={`gps-sum-state ${e.phone ? "gps-ok" : "gps-dim"}`}>{e.phone ? "✓ Connected" : ""}</span>
        </div>
      ))}
    </div>
  );
}

function PhoneGlyph() {
  return (
    <svg width="150" height="90" viewBox="0 0 150 90" fill="none" aria-hidden="true">
      <rect x="30" y="6" width="112" height="78" rx="8" fill="var(--dps-panel)" stroke="var(--dps-border)" strokeWidth="2" />
      <rect x="42" y="14" width="88" height="30" rx="3" fill="var(--dps-panel-2)" />
      <rect x="8" y="10" width="16" height="70" rx="6" fill="var(--dps-panel)" stroke="var(--dps-border)" strokeWidth="2" />
      <circle cx="116" cy="62" r="10" fill="var(--dps-panel-2)" stroke="var(--dps-border)" strokeWidth="2" />
    </svg>
  );
}

"use client";

// ── Make a recording ─────────────────────────────────────────────────────────
//
// The alternative to this is a customer recording their greeting on a mobile in
// a noisy office — which is why so many businesses never get past the stock
// prompt. Here they type the words, pick a voice, hear it, and it's installed.
//
// Two deliberate choices:
//
//   • Preview costs nothing but characters and saves nothing. Audition as many
//     voices as you like; only "Use this recording" writes a file, creates a
//     catalog row, and pushes to the PBX.
//   • There is no download button, and there never will be for audio generated
//     here. Playback is `controlsList="nodownload"` and the server marks these
//     rows `source: "generated"`. (Honest limit: a determined person can always
//     capture audio that plays in a browser. What this removes is the ordinary
//     one-click way a file leaves the product.)
//
// The tuning controls are advanced-only and closed by default. Someone setting
// up their first phone menu should not have to form an opinion about
// "similarity boost" — the IVR preset is already the right answer.
//
// Two voice sources
// ─────────────────
// ElevenLabs is the default. Amazon Polly appears ONLY for people whose role
// carries `can_use_amazon_polly` and only when its credentials are working —
// the server answers `allowed: false` for everyone else, so the switch simply
// isn't drawn and the screen is byte-for-byte what it always was. Which source
// made a recording never matters after this modal closes: both arrive as 8 kHz
// WAV through the same save path and become the same kind of catalog row.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUiLanguage } from "../../../../hooks/useUiLanguage";

/** Registered up front so the whole screen arrives translated at once, rather
 *  than switching to Yiddish a phrase at a time as the customer clicks. */
const PHRASES = [
  "Make a recording", "Type what callers should hear and choose a voice. No microphone needed.",
  "Loading voices...",
  "Voice generation isn't set up yet. An administrator needs to add an ElevenLabs key on the ElevenLabs settings page. You can still upload your own recording instead.",
  "The ElevenLabs key isn't working. An administrator needs to check it.",
  "What should it be called?", "What should callers hear?",
  "Main greeting", "With a menu", "After hours", "Nobody answered",
  "characters", "left this month",
  "Which voice?", "No voices on this account yet.",
  "Advanced settings", "These are already set for phone menus. Change them only if something sounds wrong.",
  "Speaking speed", "Lower is slower and clearer on a bad line.",
  "Consistency", "Higher reads it the same way every time. Too high sounds flat.",
  "Expression", "Emotion in the delivery. A menu rarely needs any.",
  "Quality",
  "Recordings made here can be played in Connect but not downloaded.",
  "Generating...", "Hear it", "Saving...", "Use this recording",
  "Saved and live - the next caller will hear it.",
  "Saved. It'll be live on your phone system within a few minutes.",
  "Couldn't load the voices.", "Couldn't play that.", "Couldn't save that recording.",
  "Ready - press the play button to hear it.",
  "If nothing plays, close your browser completely and open it again.",
  "The preview took too long. Try again.",
  "Voice source", "Amazon Polly", "Language", "All languages", "of",
  "No voices offer that language and quality together. Try another.",
  "This voice quality always reads at its own natural pace — speed can't be changed.",
  "Give this recording a name so you can find it later.",
  "You already have a recording called that. Pick a different name.",
  "So you can tell it apart from your other recordings later.",
  "Name it before you can save it.",
];

interface Voice {
  voiceId: string;
  name: string;
  labels: Record<string, string>;
  previewUrl: string | null;
  category: string | null;
}

interface Status {
  configured: boolean;
  keyWorks?: boolean;
  /** The account can synthesise RIGHT NOW. A valid key on an account with an
   *  unpaid invoice is keyWorks:true, usable:false — and pressing Generate on
   *  that combination fails with a 401 that looks like a bad key. */
  usable?: boolean;
  message?: string | null;
  charactersUsed?: number | null;
  characterLimit?: number | null;
  models?: { id: string; label: string; detail: string }[];
  defaultTuning?: Tuning;
}

/** An Amazon Polly voice. Far more of these exist than ElevenLabs voices — a
 *  hundred-odd across every language — which is why the Polly picker gets a
 *  language filter that the ElevenLabs one doesn't need. */
interface PollyVoice {
  voiceId: string;
  name: string;
  gender: string | null;
  languageCode: string | null;
  languageName: string | null;
  engines: string[];
}

interface PollyStatus {
  /** False for everyone whose role doesn't carry can_use_amazon_polly. This is
   *  a 200, not a 403: the Studio asks on every open, and a console full of
   *  403s for the ordinary case makes real failures impossible to spot. */
  allowed: boolean;
  configured: boolean;
  keyWorks?: boolean;
  usable?: boolean;
  message?: string | null;
  region?: string | null;
  /** `supportsSpeed` is false for engines Amazon silently ignores prosody on —
   *  the speed control is hidden for those rather than left doing nothing. */
  engines?: { id: string; label: string; detail: string; supportsSpeed?: boolean }[];
  defaultEngine?: string;
  defaultSpeed?: number;
  voices?: PollyVoice[] | null;
}

type Provider = "elevenlabs" | "polly";

const POLLY_FALLBACK_SPEED = 0.95;
/** Overridden by the server's `defaultEngine`; only used if it doesn't say. */
const POLLY_FALLBACK_ENGINE = "generative";

export interface Tuning {
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
  speed: number;
}

const FALLBACK_TUNING: Tuning = { stability: 0.75, similarityBoost: 0.75, style: 0, useSpeakerBoost: true, speed: 0.95 };

/** Give up on a preview request after this long. The server's own provider
 *  timeout is 60s; a button that can spin for a minute with no way out is a
 *  bug of its own. */
const PREVIEW_FETCH_TIMEOUT_MS = 45_000;

/**
 * Start playback, but never TRUST it to start.
 *
 * Real incident (2026-08-04): a wedged browser media pipeline left
 * `audio.play()`'s promise pending forever — not resolved, not rejected — so
 * `await play()` hung the button with no error and the customer heard nothing.
 * The only reliable signal that sound is actually coming out is the `playing`
 * event, so this races that event against a short clock and reports honestly.
 * The visible player stays either way; a person can always press ▶ themselves.
 */
function startPlayback(el: HTMLAudioElement | null, src: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!el) return resolve(false);
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener("playing", onPlaying);
      resolve(ok);
    };
    const onPlaying = () => settle(true);
    const timer = setTimeout(() => settle(false), 4_000);
    el.addEventListener("playing", onPlaying);
    el.src = src;
    // Autoplay refusal rejects; a wedged pipeline just never answers. Both
    // end the same way: the watchdog reports "didn't start".
    el.play().then(() => settle(true)).catch(() => settle(false));
  });
}

/** Starting points, so the box is never blank. Wording matters more than people
 *  expect: these are the sentences callers judge a business by. */
const TEMPLATES = [
  { label: "Main greeting", text: "Thanks for calling. Please hold and someone will be with you shortly." },
  { label: "With a menu", text: "Thanks for calling. For sales, press one. For support, press two. To speak to someone, stay on the line." },
  { label: "After hours", text: "Thanks for calling. We're closed right now. Please leave a message and we'll get back to you." },
  { label: "Nobody answered", text: "Sorry, nobody's available to take your call. Please leave a message after the tone." },
];

export function MakeRecording({
  tenantQs,
  apiBase,
  authToken,
  onCreated,
  onClose,
  existingNames = [],
}: {
  /** "?tenantId=…" or "" — the Studio's existing tenant scoping, passed through. */
  tenantQs: string;
  apiBase: string;
  authToken: string;
  /** What this customer's recordings are already called. Used to refuse a
   *  duplicate and to suggest a name that isn't taken — four recordings called
   *  "Main greeting" is a library nobody can use. */
  existingNames?: string[];
  /** Called with the new catalog row once it's installed — the whole row, so
   *  the Studio can splice it into its list instead of refetching everything. */
  onCreated: (prompt: { id: string; promptRef: string; displayName: string; category: string }) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [loading, setLoading] = useState(true);

  // ⛔ Starts EMPTY on purpose. It used to default to "Main greeting", and the
  // template chips overwrote it with their own label, so whoever clicked the
  // first chip and pressed save got "Main greeting" — one tenant ended up with
  // four recordings by that name and no way to tell them apart.
  const [name, setName] = useState("");
  const [text, setText] = useState(TEMPLATES[0].text);
  const [voiceId, setVoiceId] = useState("");
  const [model, setModel] = useState("eleven_flash_v2_5");
  const [tuning, setTuning] = useState<Tuning>(FALLBACK_TUNING);
  const [advanced, setAdvanced] = useState(false);

  // ── Amazon Polly, when this person is allowed it ──────────────────────────
  // Kept in its own state rather than folded into the ElevenLabs fields: the
  // two providers take different inputs, and switching between them must not
  // lose the voice already chosen in the other.
  const [provider, setProvider] = useState<Provider>("elevenlabs");
  const [polly, setPolly] = useState<PollyStatus | null>(null);
  const [pollyVoices, setPollyVoices] = useState<PollyVoice[]>([]);
  const [pollyVoiceId, setPollyVoiceId] = useState("");
  const [pollyEngine, setPollyEngine] = useState(POLLY_FALLBACK_ENGINE);
  const [pollySpeed, setPollySpeed] = useState(POLLY_FALLBACK_SPEED);
  const [pollyLanguage, setPollyLanguage] = useState("en");

  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const { t } = useUiLanguage(PHRASES);

  // One VISIBLE audio element, reused. Two previews playing over each other is
  // a confusing way to compare voices — and a visible player means playback
  // never depends on autoplay being allowed or the media pipeline being alive.
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const inlineAudioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [previewReady, setPreviewReady] = useState(false);

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const r = await fetch(`${apiBase}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json", ...(init?.headers || {}) },
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.message || body?.error || `Request failed (${r.status})`);
      }
      return r;
    },
    [apiBase, authToken],
  );

  useEffect(() => {
    let cancelled = false;
    // A modal stuck on "Loading voices..." with no way out is the same bug as
    // a play button that never answers. If the server hasn't replied in 20s,
    // stop waiting and say so.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    (async () => {
      // Started as promises BEFORE either is awaited, so both requests are
      // genuinely in flight at once. (Awaiting inside a Promise.all array is
      // the trap: the array's elements are evaluated left to right, so the
      // second request wouldn't even be created until the first replied.) Each
      // /status carries its own provider's voice list, so this is one
      // round-trip per provider rather than two sequential ones each.
      //
      // Both are best-effort, and neither may take the other down. Most people
      // aren't allowed Polly, plenty of servers have no Polly credentials, and
      // an API that predates this feature answers 404 — none of which may stop
      // ElevenLabs from opening. Equally, an ElevenLabs outage must not hide a
      // working Polly. Only a failure of BOTH is an error worth showing.
      let loadError: any = null;
      const elevenPromise = api("/voice/elevenlabs/status", { signal: ctrl.signal })
        .then((r) => r.json() as Promise<Status & { voices?: Voice[] | null }>)
        .catch((e: any) => { loadError = e; return null; });
      const pollyPromise = api("/voice/polly/status", { signal: ctrl.signal })
        .then((r) => r.json() as Promise<PollyStatus>)
        .catch(() => null);

      try {
        const [s, p] = await Promise.all([elevenPromise, pollyPromise]);
        if (cancelled) return;
        if (s) setStatus(s);
        if (s?.defaultTuning) setTuning(s.defaultTuning);
        if (s?.configured && s.keyWorks && s.usable) {
          let voiceList: Voice[] | null = Array.isArray(s.voices) ? s.voices : null;
          if (!voiceList) {
            // The list didn't ride along (older API, or a voices hiccup the
            // status answer survived) — fall back to the dedicated route.
            const v: { voices: Voice[] } = await (await api("/voice/elevenlabs/voices", { signal: ctrl.signal })).json();
            if (cancelled) return;
            voiceList = v.voices || [];
          }
          setVoices(voiceList);
          if (voiceList.length) setVoiceId(voiceList[0].voiceId);
        }

        if (p?.allowed && p.configured && p.usable) {
          setPolly(p);
          if (typeof p.defaultSpeed === "number") setPollySpeed(p.defaultSpeed);
          const engine = p.defaultEngine || POLLY_FALLBACK_ENGINE;
          setPollyEngine(engine);
          const list = Array.isArray(p.voices) ? p.voices : [];
          setPollyVoices(list);
          // Start on the language most of the catalogue is in for this list,
          // rather than assuming English exists in it.
          const preferred = list.some((v) => (v.languageCode || "").startsWith("en")) ? "en" : (list[0]?.languageCode || "en").split("-")[0];
          setPollyLanguage(preferred);
          const first = list.find((v) => (v.languageCode || "").startsWith(preferred) && v.engines.includes(engine)) ?? list[0];
          if (first) {
            setPollyVoiceId(first.voiceId);
            // Not every voice offers the default quality. Follow the voice we
            // actually landed on rather than leaving a selected quality it
            // cannot do — that combination fails only at Generate time.
            if (!first.engines.includes(engine)) setPollyEngine(first.engines[0] || "standard");
          }
          // Polly is the only working source — start there rather than opening
          // on an ElevenLabs error the person can do nothing about.
          if (!(s?.configured && s.keyWorks && s.usable)) setProvider("polly");
        } else if (loadError) {
          // Nothing usable came back from either side. Surface the ElevenLabs
          // failure, which is the one that carries a reason.
          throw loadError;
        }
      } catch (e: any) {
        // A timeout must not masquerade as "this account has no voices".
        if (!cancelled) setErr(e?.name === "AbortError" ? t("The voice service is taking too long — close this and try again.") : e?.message || t("Couldn't load the voices."));
      } finally {
        clearTimeout(timer);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; ctrl.abort(); clearTimeout(timer); };
  }, [api]);

  // Release the blob when this closes — a preview is not something to keep.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  async function preview() {
    setErr(null); setNote(null); setPreviewing(true);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PREVIEW_FETCH_TIMEOUT_MS);
      let r: Response;
      try {
        r = isPolly
          ? await api("/voice/polly/preview", {
              method: "POST",
              body: JSON.stringify({ voiceId: pollyVoiceId, text, engine: pollyEngine, speed: pollySpeed }),
              signal: ctrl.signal,
            })
          : await api("/voice/elevenlabs/preview", {
              method: "POST",
              body: JSON.stringify({ voiceId, text, model, tuning }),
              signal: ctrl.signal,
            });
      } finally {
        clearTimeout(timer);
      }
      const blob = await r.blob();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = URL.createObjectURL(blob);
      setPreviewReady(true);
      const started = await startPlayback(inlineAudioRef.current, objectUrlRef.current);
      if (!started) {
        // The recording exists and the player is on screen — say so, and say
        // what to do if the browser itself is the problem.
        setNote(`${t("Ready - press the play button to hear it.")} ${t("If nothing plays, close your browser completely and open it again.")}`);
      }
    } catch (e: any) {
      if (e?.name === "AbortError") setErr(t("The preview took too long. Try again."));
      else setErr(e?.message || t("Couldn't play that."));
    } finally {
      setPreviewing(false);
    }
  }

  async function save() {
    // ⛔ No "|| Greeting" fallback here any more. A silent default is how the
    // library filled up with identical names, and an unnamed recording is
    // un-findable the moment there are two of them.
    //
    // But refusing has to SAY SO, at the control that was pressed and at the
    // box that needs filling — the name sits at the top of a modal that scrolls
    // a long way past the voice list, so someone at the bottom cannot see it.
    // The take itself is never at risk: the name is not part of what generates
    // the audio, so filling it in and pressing again returns the identical
    // preview from the server-side cache.
    const displayName = name.trim();
    if (!displayName) {
      setErr(t("Give this recording a name so you can find it later."));
      nameInputRef.current?.focus();
      nameInputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (nameTaken) {
      setErr(t("You already have a recording called that. Pick a different name."));
      nameInputRef.current?.focus();
      nameInputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    setErr(null); setNote(null); setSaving(true);
    try {
      const r = isPolly
        ? await api(`/voice/ivr/prompts/generate-polly${tenantQs}`, {
            method: "POST",
            body: JSON.stringify({
              displayName,
              text,
              voiceId: pollyVoiceId,
              engine: pollyEngine,
              speed: pollySpeed,
              category: "greeting",
            }),
          })
        : await api(`/voice/ivr/prompts/generate${tenantQs}`, {
            method: "POST",
            body: JSON.stringify({ displayName, text, voiceId, model, tuning, category: "greeting" }),
          });
      const j = await r.json();
      // The PBX push can lag; the greeting is real either way, so say which.
      if (j?.pbxPush?.status === "pushed") setNote(t("Saved and live - the next caller will hear it."));
      else setNote(t("Saved. It'll be live on your phone system within a few minutes."));
      onCreated(j.prompt);
    } catch (e: any) {
      setErr(e?.message || t("Couldn't save that recording."));
    } finally {
      setSaving(false);
    }
  }

  /** Case- and space-insensitive, because "Main Greeting" and "main greeting"
   *  are the same thing to the person reading the list. */
  const takenKeys = useMemo(
    () => new Set(existingNames.map((n) => n.trim().toLowerCase()).filter(Boolean)),
    [existingNames],
  );
  const nameTaken = takenKeys.has(name.trim().toLowerCase());

  /** A template's label, made unique — "Main greeting 2" when the first one is
   *  already in the library. Only ever fills an empty box. */
  const suggestName = useCallback((base: string): string => {
    if (!takenKeys.has(base.trim().toLowerCase())) return base;
    for (let n = 2; n < 100; n++) {
      const candidate = `${base} ${n}`;
      if (!takenKeys.has(candidate.toLowerCase())) return candidate;
    }
    return base;
  }, [takenKeys]);

  const chars = text.trim().length;
  const left = status?.characterLimit && status?.charactersUsed != null
    ? Math.max(0, status.characterLimit - status.charactersUsed)
    : null;

  // Which sources are actually usable right now. `pollyReady` already folds in
  // the permission — the server sends allowed:false to everyone else, so no
  // permission check happens on this side and none can drift out of step.
  const elevenReady = Boolean(status?.configured && status.keyWorks && status.usable);
  const pollyReady = Boolean(polly?.allowed && polly.configured && polly.usable && pollyVoices.length > 0);
  const isPolly = provider === "polly" && pollyReady;

  /** Languages present in the Polly catalogue, deduped to the base language
   *  ("en" covers en-US, en-GB, en-AU …) so the picker is short. */
  const pollyLanguages = useMemo(() => {
    const seen = new Map<string, string>();
    for (const v of pollyVoices) {
      const code = (v.languageCode || "").split("-")[0];
      if (code && !seen.has(code)) seen.set(code, (v.languageName || code).replace(/\s*\(.*\)$/, ""));
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [pollyVoices]);

  /** Only voices that can actually do what's selected. Offering a voice with no
   *  neural version while "Natural" is chosen produces a provider error at the
   *  moment someone presses Generate — filtering is the honest version. */
  const shownPollyVoices = useMemo(
    () =>
      pollyVoices.filter(
        (v) =>
          (pollyLanguage === "all" || (v.languageCode || "").startsWith(pollyLanguage)) &&
          v.engines.includes(pollyEngine),
      ),
    [pollyVoices, pollyLanguage, pollyEngine],
  );

  // Changing language or quality can strip the selected voice out of the list.
  // Land on the first one that survives rather than leaving an invisible
  // selection that fails only when Generate is pressed.
  useEffect(() => {
    if (!isPolly) return;
    if (shownPollyVoices.some((v) => v.voiceId === pollyVoiceId)) return;
    setPollyVoiceId(shownPollyVoices[0]?.voiceId ?? "");
  }, [isPolly, shownPollyVoices, pollyVoiceId]);

  /** False on engines Amazon accepts a speed for and then ignores. Server-told,
   *  so this screen never hard-codes which ones those are. */
  const pollyEngineSupportsSpeed = (polly?.engines ?? []).find((e) => e.id === pollyEngine)?.supportsSpeed !== false;

  const selectedVoice = isPolly ? pollyVoiceId : voiceId;
  const canGenerate = Boolean(selectedVoice && chars > 0 && !previewing && !saving);

  return (
    <div className="mr-backdrop" onClick={onClose}>
      <div className="mr-card" onClick={(e) => e.stopPropagation()}>
        <div className="mr-head">
          <div>
            <h3>{t("Make a recording")}</h3>
            <p>{t("Type what callers should hear and choose a voice. No microphone needed.")}</p>
          </div>
          <button className="mr-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* A working Polly is enough on its own. The ElevenLabs failure states
            below only apply when there is no other way to make a recording —
            otherwise someone with Polly access would be shown an ElevenLabs
            billing problem and stopped, with a working source right there. */}
        {loading ? (
          <div className="mr-body"><p className="mr-dim">{t("Loading voices...")}</p></div>
        ) : !elevenReady && !pollyReady && !status?.configured ? (
          <div className="mr-body">
            <div className="mr-note bad">
              {t("Voice generation isn't set up yet. An administrator needs to add an ElevenLabs key on the ElevenLabs settings page. You can still upload your own recording instead.")}
            </div>
          </div>
        ) : !elevenReady && !pollyReady ? (
          <div className="mr-body">
            {/* status.message is written by the server and already says what to
                do about it — show it in preference to our generic fallback. */}
            <div className="mr-note bad">{status?.message || t("The ElevenLabs key isn't working. An administrator needs to check it.")}</div>
          </div>
        ) : (
          <>
            <div className="mr-body">
              {/* Only drawn when there is genuinely a choice. One source is not
                  a decision to put in front of someone. */}
              {elevenReady && pollyReady && (
                <>
                  <label className="mr-lbl">{t("Voice source")}</label>
                  <div className="mr-chips">
                    <button
                      className={"mr-chip" + (provider === "elevenlabs" ? " on" : "")}
                      onClick={() => setProvider("elevenlabs")}
                    >
                      ElevenLabs
                    </button>
                    <button
                      className={"mr-chip" + (provider === "polly" ? " on" : "")}
                      onClick={() => setProvider("polly")}
                    >
                      {t("Amazon Polly")}
                    </button>
                  </div>
                </>
              )}

              <label className="mr-lbl">{t("What should it be called?")}</label>
              <input ref={nameInputRef} className={"mr-in" + (nameTaken || (previewReady && !name.trim()) ? " bad" : "")}
                value={name} onChange={(e) => setName(e.target.value)} placeholder="Main greeting" />
              {/* Once there's a preview there is a take worth keeping, so the
                  missing name stops being a hint and becomes the one thing
                  standing between them and saving it. Say so THEN, not after
                  they press the button and wonder why nothing happened. */}
              <div className={"mr-hint" + (nameTaken || (previewReady && !name.trim()) ? " bad" : "")}>
                {nameTaken
                  ? t("You already have a recording called that. Pick a different name.")
                  : previewReady && !name.trim()
                    ? t("Name it before you can save it.")
                    : t("So you can tell it apart from your other recordings later.")}
              </div>

              <label className="mr-lbl">{t("What should callers hear?")}</label>
              <div className="mr-chips">
                {TEMPLATES.map((tpl) => (
                  // The chip fills the name only when the box is still empty,
                  // and never with a name that's already taken. It used to
                  // overwrite whatever was typed with its own label, which is
                  // how a library ends up with four "Main greeting"s.
                  <button key={tpl.label} className="mr-chip"
                    onClick={() => { setText(tpl.text); if (!name.trim()) setName(suggestName(tpl.label)); }}>
                    {t(tpl.label)}
                  </button>
                ))}
              </div>
              <textarea className="mr-ta" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="mr-meta">
                <span>{chars} {t("characters")}</span>
                {/* Only ElevenLabs publishes a monthly allowance. Amazon bills
                    per character with no cap, so there is no number to show
                    and inventing one would be a lie. */}
                {!isPolly && left != null && <span>{left.toLocaleString()} {t("left this month")}</span>}
              </div>

              {/* Language and quality sit HERE, directly above the voice list,
                  not in Advanced settings. Both of them filter that list, and
                  a filter whose control is hidden just makes the list look
                  wrong — which is exactly what happened when Quality lived in
                  the collapsed panel and silently hid two thirds of the
                  voices. */}
              {isPolly && (
                <div className="mr-polly-filters">
                  {pollyLanguages.length > 1 && (
                    <div>
                      <label className="mr-lbl">{t("Language")}</label>
                      <select className="mr-in" value={pollyLanguage} onChange={(e) => setPollyLanguage(e.target.value)}>
                        <option value="all">{t("All languages")}</option>
                        {pollyLanguages.map(([code, label]) => (
                          <option key={code} value={code}>{label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="mr-lbl">{t("Quality")}</label>
                    <select className="mr-in" value={pollyEngine} onChange={(e) => setPollyEngine(e.target.value)}>
                      {(polly?.engines ?? []).map((e) => (
                        <option key={e.id} value={e.id}>{e.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <label className="mr-lbl">
                {t("Which voice?")}
                {/* Say how many of the total are being shown. Without this, a
                    filtered list is indistinguishable from a short one. */}
                {isPolly && pollyVoices.length > 0 && (
                  <span className="mr-count">
                    {shownPollyVoices.length === pollyVoices.length
                      ? shownPollyVoices.length
                      : `${shownPollyVoices.length} ${t("of")} ${pollyVoices.length}`}
                  </span>
                )}
              </label>
              <div className="mr-voices">
                {isPolly
                  ? shownPollyVoices.map((v) => (
                      <button
                        key={v.voiceId}
                        className={"mr-voice" + (v.voiceId === pollyVoiceId ? " on" : "")}
                        onClick={() => setPollyVoiceId(v.voiceId)}
                      >
                        <b>{v.name}</b>
                        <span>{[v.gender, v.languageName].filter(Boolean).join(", ")}</span>
                      </button>
                    ))
                  : voices.map((v) => (
                      <button
                        key={v.voiceId}
                        className={"mr-voice" + (v.voiceId === voiceId ? " on" : "")}
                        onClick={() => setVoiceId(v.voiceId)}
                      >
                        <b>{v.name}</b>
                        <span>{describeVoice(v)}</span>
                      </button>
                    ))}
                {isPolly && shownPollyVoices.length === 0 && (
                  <p className="mr-dim">{t("No voices offer that language and quality together. Try another.")}</p>
                )}
                {!isPolly && voices.length === 0 && <p className="mr-dim">{t("No voices on this account yet.")}</p>}
              </div>

              <button className="mr-adv" onClick={() => setAdvanced(!advanced)}>
                {advanced ? "▾" : "▸"} {t("Advanced settings")}
              </button>
              {advanced && (
                <div className="mr-advbox">
                  <p className="mr-dim">
                    {t("These are already set for phone menus. Change them only if something sounds wrong.")}
                  </p>

                  {isPolly ? (
                    <>
                      {/* Amazon has no stability or expression knobs — its
                          equivalent of those is the quality choice, which now
                          lives above next to the voice list. Speed is all
                          that's left, and only on engines that honour it:
                          the most lifelike one accepts the setting and then
                          ignores it, so showing the slider there would be a
                          control that does nothing. */}
                      {pollyEngineSupportsSpeed ? (
                        <Slider label={t("Speaking speed")} hint={t("Lower is slower and clearer on a bad line.")}
                          min={0.7} max={1.2} step={0.05} value={pollySpeed}
                          onChange={setPollySpeed} />
                      ) : (
                        <p className="mr-dim">{t("This voice quality always reads at its own natural pace — speed can't be changed.")}</p>
                      )}
                      <p className="mr-dim" style={{ marginBottom: 0 }}>
                        {(polly?.engines ?? []).find((e) => e.id === pollyEngine)?.detail ?? ""}
                      </p>
                    </>
                  ) : (
                    <>
                      <Slider label={t("Speaking speed")} hint={t("Lower is slower and clearer on a bad line.")}
                        min={0.7} max={1.2} step={0.05} value={tuning.speed}
                        onChange={(v) => setTuning({ ...tuning, speed: v })} />

                      <Slider label={t("Consistency")} hint={t("Higher reads it the same way every time. Too high sounds flat.")}
                        min={0} max={1} step={0.05} value={tuning.stability}
                        onChange={(v) => setTuning({ ...tuning, stability: v })} />

                      <Slider label={t("Expression")} hint={t("Emotion in the delivery. A menu rarely needs any.")}
                        min={0} max={1} step={0.05} value={tuning.style}
                        onChange={(v) => setTuning({ ...tuning, style: v })} />

                      <label className="mr-lbl">{t("Quality")}</label>
                      <select className="mr-in" value={model} onChange={(e) => setModel(e.target.value)}>
                        {(status?.models ?? []).map((m) => (
                          <option key={m.id} value={m.id}>{m.label} — {m.detail}</option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
              )}

              {/* Mounted from the start (hidden until a preview exists) so the
                  ref is live the moment the first preview needs it. Download is
                  off — generated audio never gets a one-click way out. */}
              <audio
                ref={inlineAudioRef}
                className="mr-player"
                controls
                preload="auto"
                controlsList="nodownload noplaybackrate"
                style={{ display: previewReady ? "block" : "none" }}
              />

              {err && <div className="mr-note bad">{err}</div>}
              {note && <div className="mr-note ok">{note}</div>}
              <p className="mr-fine">
                {t("Recordings made here can be played in Connect but not downloaded.")}
              </p>
            </div>

            <div className="mr-foot">
              <button className="mr-btn" onClick={preview} disabled={!canGenerate}>
                {previewing ? t("Generating...") : `\u25b6 ${t("Hear it")}`}
              </button>
              {/* ⛔ NEVER disabled for a missing name. It was, and someone who
                  had spent an hour getting a take right found a dead button and
                  no reason given — the name box is at the top of a long scrolled
                  modal, far out of sight of the button that refuses. Clicking
                  now says what's wrong and puts the cursor in the box. */}
              <button className="mr-btn primary" onClick={save} disabled={!canGenerate}>
                {t(saving ? "Saving..." : "Use this recording")}
              </button>
            </div>
          </>
        )}
      </div>
      <MakeRecordingStyles />
    </div>
  );
}

/** ElevenLabs' labels are things like {accent: "american", age: "middle aged"}.
 *  Read the useful ones back as a phrase instead of showing raw key/value tags. */
function describeVoice(v: Voice): string {
  const bits = [v.labels?.accent, v.labels?.age, v.labels?.gender].filter(Boolean) as string[];
  const phrase = bits.join(", ");
  const use = v.labels?.use_case || v.labels?.["use case"];
  return use ? `${phrase}${phrase ? " · " : ""}${use}` : phrase || (v.category ?? "");
}

function Slider({ label, hint, min, max, step, value, onChange }: {
  label: string; hint: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void;
}) {
  return (
    <div className="mr-slider">
      <div className="mr-slider-head"><b>{label}</b><span>{value.toFixed(2)}</span></div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
      <p>{hint}</p>
    </div>
  );
}

function MakeRecordingStyles() {
  return (
    <style jsx global>{`
      .mr-backdrop{position:fixed;inset:0;background:rgba(6,12,20,.55);display:grid;place-items:center;padding:20px;z-index:95}
      .mr-card{background:var(--panel,#fff);border:1px solid var(--line,rgba(19,32,48,.13));border-radius:18px;
        width:min(600px,100%);max-height:92vh;display:flex;flex-direction:column;overflow:hidden;
        box-shadow:0 30px 70px -30px rgba(0,0,0,.45);color:inherit}
      .mr-head{display:flex;justify-content:space-between;gap:12px;padding:22px 24px 0}
      .mr-head h3{font-size:19px;font-weight:700;margin:0;letter-spacing:-.015em}
      .mr-head p{margin:6px 0 0;font-size:13.5px;color:var(--dim,#5d6f84);line-height:1.55}
      .mr-x{background:none;border:none;font-size:26px;line-height:1;color:var(--faint,#94a3b8);cursor:pointer;padding:0 4px}
      .mr-body{padding:18px 24px 4px;overflow:auto}
      .mr-lbl{display:block;font-size:12px;font-weight:660;color:var(--dim,#5d6f84);margin:16px 0 7px}
      .mr-lbl:first-child{margin-top:0}
      .mr-in,.mr-ta{width:100%;font:inherit;font-size:14px;padding:11px 12px;border-radius:11px;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc);color:inherit}
      .mr-ta{resize:vertical;line-height:1.6}
      .mr-in:focus,.mr-ta:focus{outline:none;border-color:var(--accent,#2f6bff)}
      .mr-hint{margin:6px 0 0;font-size:12px;line-height:1.5;color:var(--faint,#94a3b8)}
      .mr-hint.bad{color:#c2410c;font-weight:600}
      :root[data-theme="dark"] .mr-hint.bad{color:#fca77a}
      .mr-in.bad{border-color:#c2410c}
      :root[data-theme="dark"] .mr-in.bad{border-color:#fca77a}
      .mr-chips{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:9px}
      .mr-chip{font:inherit;font-size:12px;font-weight:600;padding:6px 11px;border-radius:99px;cursor:pointer;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc);color:var(--dim,#5d6f84)}
      .mr-chip:hover{border-color:var(--accent,#2f6bff);color:var(--accent,#2f6bff)}
      .mr-chip.on{border-color:var(--accent,#2f6bff);color:var(--accent,#2f6bff);
        background:var(--accent-soft,rgba(47,107,255,.08));font-weight:680}
      .mr-polly-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
      .mr-polly-filters .mr-lbl{margin-top:16px}
      .mr-count{font-size:11px;font-weight:650;color:var(--accent,#2f6bff);
        background:var(--accent-soft,rgba(47,107,255,.08));border-radius:999px;padding:2px 8px;margin-left:7px}
      .mr-meta{display:flex;justify-content:space-between;font-size:11.5px;color:var(--faint,#94a3b8);margin-top:6px}
      .mr-voices{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:8px}
      .mr-voice{text-align:left;font:inherit;padding:11px 12px;border-radius:11px;cursor:pointer;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc);color:inherit;transition:.14s}
      .mr-voice:hover{border-color:var(--accent,#2f6bff)}
      .mr-voice.on{border-color:var(--accent,#2f6bff);background:var(--accent-soft,rgba(47,107,255,.08))}
      .mr-voice b{display:block;font-size:14px;font-weight:650}
      .mr-voice span{display:block;font-size:11.5px;color:var(--dim,#5d6f84);margin-top:2px;text-transform:capitalize}
      .mr-adv{margin-top:18px;background:none;border:none;font:inherit;font-size:13px;font-weight:620;
        color:var(--dim,#5d6f84);cursor:pointer;padding:0}
      .mr-advbox{margin-top:10px;padding:14px;border-radius:12px;border:1px solid var(--line,rgba(19,32,48,.13));
        background:var(--panel-2,#f6f9fc)}
      .mr-advbox .mr-dim{margin-top:0}
      .mr-slider{margin-bottom:14px}
      .mr-slider-head{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px}
      .mr-slider-head b{font-weight:640}
      .mr-slider-head span{color:var(--faint,#94a3b8);font-variant-numeric:tabular-nums}
      .mr-slider input[type=range]{width:100%}
      .mr-slider p{margin:4px 0 0;font-size:11.5px;color:var(--faint,#94a3b8);line-height:1.5}
      .mr-player{width:100%;margin-top:14px;height:36px}
      .mr-dim{font-size:13px;color:var(--dim,#5d6f84);line-height:1.6;margin:0 0 12px}
      .mr-note{margin-top:14px;padding:11px 13px;border-radius:11px;font-size:13px;line-height:1.55}
      .mr-note.bad{color:#c9414c;background:rgba(201,65,76,.08);border:1px solid rgba(201,65,76,.28)}
      .mr-note.ok{color:#1a9d5c;background:rgba(26,157,92,.08);border:1px solid rgba(26,157,92,.28)}
      .mr-fine{margin:14px 0 0;font-size:11.5px;color:var(--faint,#94a3b8)}
      .mr-foot{display:flex;gap:10px;justify-content:flex-end;padding:16px 24px 20px;
        border-top:1px solid var(--line-soft,rgba(19,32,48,.07))}
      .mr-btn{font:inherit;font-size:14px;font-weight:650;padding:11px 20px;border-radius:11px;cursor:pointer;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel,#fff);color:inherit}
      .mr-btn.primary{background:var(--accent,#2f6bff);border-color:var(--accent,#2f6bff);color:#fff}
      .mr-btn:disabled{opacity:.5;cursor:not-allowed}
    `}</style>
  );
}

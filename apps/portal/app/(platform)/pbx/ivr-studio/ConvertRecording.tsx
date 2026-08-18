"use client";

/**
 * The voice changer — record or upload a real person speaking, get it back in
 * one of the platform's voices.
 *
 * ⛔⛔ Nothing here transcribes or translates anything. The audio never becomes
 * text at any point, which is the ONLY reason this works on Yiddish: no
 * provider on the market can transcribe or speak it, but the voice changer does
 * not need to know what was said. What the customer keeps is their words,
 * timing, pauses, rhythm and delivery; what changes is who it sounds like.
 *
 * Why a separate dialog rather than a third mode inside MakeRecording:
 * that one is built around TYPING the words — templates, a character counter,
 * a monthly allowance, a preview you can re-roll for free. This one takes a
 * FILE. Folding the two together would mean branching almost every field in an
 * 850-line component and putting the working greeting flow at risk for a
 * feature that shares none of its inputs.
 *
 * ⛔ There is no free preview here, deliberately. Converting is what costs
 * money — by the MINUTE, not by the character — so a "preview then save" pair
 * would bill twice for one recording. One action converts AND saves, and the
 * result is played back from the saved row.
 *
 * ⛔ This dialog is only ever mounted when the server said `allowed: true`. The
 * permission decides whether the option EXISTS, not whether pressing it works.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUiLanguage } from "../../../../hooks/useUiLanguage";
// ⛔ Shared, not copied. These rules live in a `<style jsx global>` that only
// exists while a dialog is mounted, so this one must render them too — but a
// second copy would drift the moment either dialog is restyled.
import { MakeRecordingStyles } from "./MakeRecording";

const PHRASES = [
  "Change a recording's voice", "Use my own recording", "Record now", "Stop recording",
  "Choose a file", "Recording...", "Clear", "What should it be called?",
  "So you can tell it apart from your other recordings later.",
  "Which voice should it become?", "Convert", "Converting...", "Close", "Done",
  "Loading voices...", "seconds", "Up to", "Advanced settings", "Language handling",
  "Any language", "English only", "Remove background noise",
  "You already have a recording called that. Pick a different name.",
  "Give this recording a name so you can find it later.",
  "Pick the voice it should become.", "Record or choose a file first.",
  "Listen", "Stop", "Couldn't play that voice.", "Press play to hear it.",
  "The words, timing and delivery stay exactly as you recorded them. Only the voice changes.",
  "Your microphone isn't available. Choose a file instead.",
  "Nothing was recorded. Check the microphone and try again.",
  "The recording stopped unexpectedly. Try again, or choose a file.",
  "That file was empty.", "Ready to convert", "Recorded",
  "Saved and live - the next caller will hear it.",
  "Saved. It'll be live on your phone system within a few minutes.",
  "Couldn't convert that recording.",
];

interface Voice {
  voiceId: string;
  name: string;
  labels?: Record<string, string>;
  category?: string | null;
}

interface VoiceChangerStatus {
  allowed: boolean;
  configured: boolean;
  keyWorks?: boolean;
  usable?: boolean;
  message?: string | null;
  models?: { id: string; label: string; detail: string }[];
  maxSeconds?: number;
  voices?: Voice[] | null;
}

/** Matches the server's MAX_CONVERT_SECONDS; overridden by what /status says. */
const FALLBACK_MAX_SECONDS = 180;

export function ConvertRecording({
  tenantQs,
  apiBase,
  authToken,
  existingNames = [],
  onCreated,
  onClose,
}: {
  tenantQs: string;
  apiBase: string;
  authToken: string;
  existingNames?: string[];
  onCreated: (prompt: { id: string; promptRef: string; displayName: string; category: string }) => void;
  onClose: () => void;
}) {
  const { t } = useUiLanguage(PHRASES);

  const [status, setStatus] = useState<VoiceChangerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [model, setModel] = useState("eleven_multilingual_sts_v2");
  const [removeNoise, setRemoveNoise] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const [clip, setClip] = useState<{ blob: Blob; filename: string; seconds: number | null } | null>(null);
  const [recording, setRecording] = useState(false);
  const [converting, setConverting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  /** Which voice is being auditioned. Sampling is FREE — it plays
   *  ElevenLabs' own hosted clip through our API, not a synthesis — so
   *  someone can work down all 38 without spending anything. */
  const [samplingId, setSamplingId] = useState<string | null>(null);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);
  const sampleUrlRef = useRef<string | null>(null);
  /** State, not the ref: a ref change does not re-render, so keying the
   *  player's visibility off sampleUrlRef would never show it. */
  const [sampleReady, setSampleReady] = useState(false);
  const sourceUrlRef = useRef<string | null>(null);
  const resultUrlRef = useRef<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  const maxSeconds = status?.maxSeconds ?? FALLBACK_MAX_SECONDS;

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const r = await fetch(`${apiBase}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${authToken}`, ...(init?.headers || {}) },
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
    const ctrl = new AbortController();
    // Same reasoning as MakeRecording: a modal stuck on "Loading voices..."
    // with no way out is its own bug.
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    (async () => {
      try {
        const s: VoiceChangerStatus = await (
          await api("/voice/elevenlabs/voice-changer/status", { signal: ctrl.signal })
        ).json();
        if (cancelled) return;
        setStatus(s);
        const list = Array.isArray(s.voices) ? s.voices : [];
        if (list.length && !voiceId) setVoiceId(list[0].voiceId);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || t("Couldn't convert that recording."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Object URLs are revoked on unmount and whenever they're replaced — a modal
  // someone opens and closes repeatedly would otherwise leak a blob per clip.
  useEffect(() => {
    return () => {
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
      if (sampleUrlRef.current) URL.revokeObjectURL(sampleUrlRef.current);
      recorderRef.current?.stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  function setSource(blob: Blob | null, filename: string) {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = null;
    setSourceUrl(null);
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    resultUrlRef.current = null;
    setResultUrl(null);
    setNote(null);
    if (!blob) {
      setClip(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    sourceUrlRef.current = url;
    setSourceUrl(url);
    setClip({ blob, filename, seconds: null });
  }

  /**
   * Play a voice's sample.
   *
   * ⛔ Fetched with the auth header and turned into a blob rather than pointed
   * at directly: the portal's CSP is `default-src 'self'`, so an <audio> src on
   * ElevenLabs' CDN is blocked by the browser — silently, as a console
   * violation that reads as "the play button does nothing". Our API proxies it
   * for the same reason.
   */
  async function playSample(id: string) {
    const el = sampleAudioRef.current;
    if (!el) return;
    // Pressing the one that's already playing stops it.
    if (samplingId === id && !el.paused) {
      el.pause();
      setSamplingId(null);
      return;
    }
    el.pause();
    setSamplingId(id);
    setErr(null);
    try {
      const r = await api(`/voice/elevenlabs/voices/${encodeURIComponent(id)}/sample`);
      // ⛔ Build the blob with an explicit audio type rather than inheriting
      // whatever the response says. Belt and braces with the server-side
      // forcing: a blob typed text/plain will not play, and the failure is
      // silent — no error, no network fault, just a button that does nothing.
      const blob = new Blob([await r.arrayBuffer()], { type: "audio/mpeg" });
      if (sampleUrlRef.current) URL.revokeObjectURL(sampleUrlRef.current);
      const url = URL.createObjectURL(blob);
      sampleUrlRef.current = url;
      setSampleReady(true);
      el.src = url;
      try {
        await el.play();
      } catch {
        // Autoplay can be refused because the click was consumed by the fetch
        // that preceded it. Never swallow that silently — the visible player
        // below means they can still press play themselves.
        setSamplingId(null);
        setErr(t("Press play to hear it."));
      }
    } catch {
      setSamplingId(null);
      setErr(t("Couldn't play that voice."));
    }
  }

  async function startRecording() {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Same constraints the chat voice-note recorder uses. Mono matters
        // twice over here: the phone system is mono anyway, and a clean single
        // channel is what the voice changer works best from.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });

      // ⛔⛔ THE mimeType IS NOT OPTIONAL, and leaving it out is what broke this
      // the first time. MediaRecorder's default WebM carries NO duration in its
      // header, so the browser reports the clip as infinitely long and draws a
      // dead grey player you cannot press — it looks exactly like "nothing was
      // recorded". audio/mp4 (m4a) writes a real duration, and it is also on
      // ElevenLabs' accepted list. Same order as ChatComposer, deliberately.
      const mimeType = MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : undefined;

      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onerror = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        recorderRef.current = null;
        setRecording(false);
        setErr(t("The recording stopped unexpectedly. Try again, or choose a file."));
      };
      rec.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        recorderRef.current = null;
        const parts = chunksRef.current.filter((c) => c.size > 0);
        chunksRef.current = [];
        setRecording(false);
        // ⛔ Say so rather than handing back an empty clip. An empty blob still
        // sets a preview and still enables Convert, so the failure would only
        // surface as a provider error thirty seconds and a charge later.
        if (!parts.length) {
          setErr(t("Nothing was recorded. Check the microphone and try again."));
          return;
        }
        const blob = new Blob(parts, { type: rec.mimeType || mimeType || "audio/webm" });
        if (blob.size === 0) {
          setErr(t("Nothing was recorded. Check the microphone and try again."));
          return;
        }
        const ext = (rec.mimeType || mimeType || "").includes("mp4") ? "m4a" : "webm";
        setSource(blob, `recording.${ext}`);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setErr(t("Your microphone isn't available. Choose a file instead."));
      setRecording(false);
    }
  }

  function stopRecording() {
    const rec = recorderRef.current;
    // "inactive" means it already stopped (or never started) — calling stop()
    // again throws, and the throw would leave the button stuck on "Stop".
    if (rec && rec.state !== "inactive") rec.stop();
    else setRecording(false);
  }

  const takenKeys = useMemo(
    () => new Set(existingNames.map((n) => n.trim().toLowerCase()).filter(Boolean)),
    [existingNames],
  );
  const nameTaken = takenKeys.has(name.trim().toLowerCase());

  async function convert() {
    const displayName = name.trim();
    // Refusals happen at the control that needs filling, and scroll to it —
    // this modal is taller than most screens.
    if (!clip) {
      setErr(t("Record or choose a file first."));
      return;
    }
    if (!displayName) {
      setErr(t("Give this recording a name so you can find it later."));
      nameInputRef.current?.focus();
      nameInputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (nameTaken) {
      setErr(t("You already have a recording called that. Pick a different name."));
      nameInputRef.current?.focus();
      return;
    }
    if (!voiceId) {
      setErr(t("Pick the voice it should become."));
      return;
    }

    setErr(null);
    setNote(null);
    setConverting(true);
    try {
      const form = new FormData();
      form.append("audio", clip.blob, clip.filename);
      form.append("displayName", displayName);
      form.append("voiceId", voiceId);
      form.append("model", model);
      form.append("category", "greeting");
      if (removeNoise) form.append("removeBackgroundNoise", "true");

      // ⛔ No Content-Type header — the browser sets the multipart boundary,
      // exactly as the server does when it forwards this on.
      const r = await api(`/voice/ivr/prompts/convert${tenantQs}`, { method: "POST", body: form });
      const j = await r.json();

      if (j?.pbxPush?.status === "pushed") setNote(t("Saved and live - the next caller will hear it."));
      else setNote(t("Saved. It'll be live on your phone system within a few minutes."));

      // Play the converted result straight from the saved row, so what they
      // hear is exactly what the phone system now has — not a separate take.
      try {
        const audio = await api(`/voice/ivr/prompts/${j.prompt.id}/stream`);
        const blob = await audio.blob();
        if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
        const url = URL.createObjectURL(blob);
        resultUrlRef.current = url;
        setResultUrl(url);
      } catch {
        // The recording is saved and live either way — not being able to play
        // it back inside the dialog is a cosmetic failure, not a real one.
      }

      onCreated(j.prompt);
    } catch (e: any) {
      setErr(e?.message || t("Couldn't convert that recording."));
    } finally {
      setConverting(false);
    }
  }

  const ready = Boolean(status?.configured && status?.keyWorks && status?.usable);

  return (
    <>
    <div className="mr-backdrop" onClick={onClose}>
      <div className="mr-card" onClick={(e) => e.stopPropagation()}>
        <div className="mr-head">
          <div>
            <h3>{t("Change a recording's voice")}</h3>
            <p>{t("The words, timing and delivery stay exactly as you recorded them. Only the voice changes.")}</p>
          </div>
          <button className="mr-x" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </div>

        {loading ? (
          <div className="mr-body">
            <p className="mr-dim">{t("Loading voices...")}</p>
          </div>
        ) : !ready ? (
          <div className="mr-body">
            <div className="mr-note bad">
              {status?.message || t("Couldn't convert that recording.")}
            </div>
          </div>
        ) : (
          <div className="mr-body">
            <label className="mr-lbl">{t("Use my own recording")}</label>
            <div className="mr-chips">
              {recording ? (
                <button className="mr-chip on" onClick={stopRecording}>
                  {t("Stop recording")}
                </button>
              ) : (
                <button className="mr-chip" onClick={startRecording}>
                  {t("Record now")}
                </button>
              )}
              <label className="mr-chip" style={{ cursor: "pointer" }}>
                {t("Choose a file")}
                <input
                  type="file"
                  accept="audio/*,.m4a,.mp3,.wav,.ogg,.oga,.flac,.webm"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    // Same reasoning as an empty recording: a 0-byte file would
                    // set a preview, enable Convert, and only fail at the
                    // provider — after the round trip.
                    if (f && f.size === 0) setErr(t("That file was empty."));
                    else if (f) { setErr(null); setSource(f, f.name); }
                    e.currentTarget.value = "";
                  }}
                />
              </label>
              {clip && !recording && (
                <button className="mr-chip" onClick={() => setSource(null, "")}>
                  {t("Clear")}
                </button>
              )}
            </div>
            {recording && <div className="mr-hint">{t("Recording...")}</div>}
            {/* ⛔ Stated as text, not left to the player. If the browser cannot
                draw usable controls for a container it still reports the size
                here, so "did that work?" always has an answer on screen. */}
            {clip && !recording && (
              <div className="mr-hint">
                {t("Ready to convert")} — {clip.filename} ({Math.max(1, Math.round(clip.blob.size / 1024))} KB)
              </div>
            )}
            {sourceUrl && (
              <audio className="mr-player" src={sourceUrl} controls preload="metadata" />
            )}
            <div className="mr-hint">
              {t("Up to")} {maxSeconds} {t("seconds")}.
            </div>

            <label className="mr-lbl">{t("What should it be called?")}</label>
            <input
              ref={nameInputRef}
              className={"mr-in" + (nameTaken ? " bad" : "")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Main greeting"
            />
            <div className={"mr-hint" + (nameTaken ? " bad" : "")}>
              {nameTaken
                ? t("You already have a recording called that. Pick a different name.")
                : t("So you can tell it apart from your other recordings later.")}
            </div>

            <label className="mr-lbl">{t("Which voice should it become?")}</label>
            <div className="mr-voices">
              {(status?.voices || []).map((v) => (
                <div key={v.voiceId} className="mr-voice-wrap">
                  <button
                    className={"mr-voice" + (voiceId === v.voiceId ? " on" : "")}
                    onClick={() => setVoiceId(v.voiceId)}
                  >
                    <b>{v.name}</b>
                    {v.labels?.gender && <span>{v.labels.gender}</span>}
                  </button>
                  {/* Sibling, not nested — a <button> inside a <button> is
                      invalid and browsers drop the inner one. */}
                  <button
                    className="mr-voice-play"
                    onClick={() => playSample(v.voiceId)}
                    aria-label={`${t("Listen")} — ${v.name}`}
                    title={t("Listen")}
                  >
                    {samplingId === v.voiceId ? "■" : "▶"}
                  </button>
                </div>
              ))}
            </div>
            {/* One shared element for auditioning, kept out of the way. */}
            <audio
              ref={sampleAudioRef}
              className="mr-player"
              controls
              onEnded={() => setSamplingId(null)}
              style={{ display: sampleReady ? "block" : "none" }}
            />

            <button className="mr-adv" onClick={() => setAdvanced((a) => !a)}>
              {t("Advanced settings")}
            </button>
            {advanced && (
              <div className="mr-advbox">
                <label className="mr-lbl">{t("Language handling")}</label>
                <div className="mr-chips">
                  {(status?.models || []).map((m) => (
                    <button
                      key={m.id}
                      className={"mr-chip" + (model === m.id ? " on" : "")}
                      onClick={() => setModel(m.id)}
                      title={m.detail}
                    >
                      {t(m.label)}
                    </button>
                  ))}
                </div>
                <label className="mr-check">
                  <input type="checkbox" checked={removeNoise} onChange={(e) => setRemoveNoise(e.target.checked)} />
                  {t("Remove background noise")}
                </label>
              </div>
            )}

            {resultUrl && (
              <>
                <label className="mr-lbl">{t("Done")}</label>
                <audio className="mr-player" src={resultUrl} controls autoPlay />
              </>
            )}

            {err && <div className="mr-note bad">{err}</div>}
            {note && <div className="mr-note ok">{note}</div>}
          </div>
        )}

        <div className="mr-foot">
          <button className="mr-btn" onClick={onClose}>
            {t("Close")}
          </button>
          {ready && !loading && (
            <button className="mr-btn primary" onClick={convert} disabled={converting || recording || !clip}>
              {converting ? t("Converting...") : t("Convert")}
            </button>
          )}
        </div>
      </div>
    </div>
    <MakeRecordingStyles />
    </>
  );
}

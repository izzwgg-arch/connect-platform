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
  "The words, timing and delivery stay exactly as you recorded them. Only the voice changes.",
  "Your microphone isn't available. Choose a file instead.",
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

  async function startRecording() {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        // The extension has to match what was actually captured — the server
        // forwards the file as-is and the provider reads the container.
        const ext = (rec.mimeType || "audio/webm").includes("ogg") ? "ogg" : "webm";
        setSource(blob, `recording.${ext}`);
        setRecording(false);
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
    recorderRef.current?.stop();
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
                    if (f) setSource(f, f.name);
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
                <button
                  key={v.voiceId}
                  className={"mr-voice" + (voiceId === v.voiceId ? " on" : "")}
                  onClick={() => setVoiceId(v.voiceId)}
                >
                  <b>{v.name}</b>
                  {v.labels?.gender && <span>{v.labels.gender}</span>}
                </button>
              ))}
            </div>

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

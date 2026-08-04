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

import { useCallback, useEffect, useRef, useState } from "react";
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
  message?: string | null;
  charactersUsed?: number | null;
  characterLimit?: number | null;
  models?: { id: string; label: string; detail: string }[];
  defaultTuning?: Tuning;
}

export interface Tuning {
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
  speed: number;
}

const FALLBACK_TUNING: Tuning = { stability: 0.75, similarityBoost: 0.75, style: 0, useSpeakerBoost: true, speed: 0.95 };

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
}: {
  /** "?tenantId=…" or "" — the Studio's existing tenant scoping, passed through. */
  tenantQs: string;
  apiBase: string;
  authToken: string;
  /** Called with the new prompt's dialplan ref once it's installed. */
  onCreated: (promptRef: string, displayName: string) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("Main greeting");
  const [text, setText] = useState(TEMPLATES[0].text);
  const [voiceId, setVoiceId] = useState("");
  const [model, setModel] = useState("eleven_flash_v2_5");
  const [tuning, setTuning] = useState<Tuning>(FALLBACK_TUNING);
  const [advanced, setAdvanced] = useState(false);

  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const { t } = useUiLanguage(PHRASES);

  // One audio element, reused. Two previews playing over each other is a
  // confusing way to compare voices.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

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
    (async () => {
      try {
        const s: Status = await (await api("/voice/elevenlabs/status")).json();
        if (cancelled) return;
        setStatus(s);
        if (s.defaultTuning) setTuning(s.defaultTuning);
        if (s.configured && s.keyWorks) {
          const v: { voices: Voice[] } = await (await api("/voice/elevenlabs/voices")).json();
          if (cancelled) return;
          setVoices(v.voices || []);
          if (v.voices?.length) setVoiceId(v.voices[0].voiceId);
        }
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || t("Couldn't load the voices."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
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
      const r = await api("/voice/elevenlabs/preview", {
        method: "POST",
        body: JSON.stringify({ voiceId, text, model, tuning }),
      });
      const blob = await r.blob();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = URL.createObjectURL(blob);
      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.src = objectUrlRef.current;
      await audioRef.current.play();
    } catch (e: any) {
      setErr(e?.message || t("Couldn't play that."));
    } finally {
      setPreviewing(false);
    }
  }

  async function save() {
    setErr(null); setNote(null); setSaving(true);
    try {
      const r = await api(`/voice/ivr/prompts/generate${tenantQs}`, {
        method: "POST",
        body: JSON.stringify({ displayName: name.trim() || "Greeting", text, voiceId, model, tuning, category: "greeting" }),
      });
      const j = await r.json();
      // The PBX push can lag; the greeting is real either way, so say which.
      if (j?.pbxPush?.status === "pushed") setNote(t("Saved and live - the next caller will hear it."));
      else setNote(t("Saved. It'll be live on your phone system within a few minutes."));
      onCreated(j.prompt.promptRef, j.prompt.displayName);
    } catch (e: any) {
      setErr(e?.message || t("Couldn't save that recording."));
    } finally {
      setSaving(false);
    }
  }

  const chars = text.trim().length;
  const canGenerate = Boolean(voiceId && chars > 0 && !previewing && !saving);
  const left = status?.characterLimit && status?.charactersUsed != null
    ? Math.max(0, status.characterLimit - status.charactersUsed)
    : null;

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

        {loading ? (
          <div className="mr-body"><p className="mr-dim">{t("Loading voices...")}</p></div>
        ) : !status?.configured ? (
          <div className="mr-body">
            <div className="mr-note bad">
              {t("Voice generation isn't set up yet. An administrator needs to add an ElevenLabs key on the ElevenLabs settings page. You can still upload your own recording instead.")}
            </div>
          </div>
        ) : !status.keyWorks ? (
          <div className="mr-body">
            <div className="mr-note bad">{status.message || t("The ElevenLabs key isn't working. An administrator needs to check it.")}</div>
          </div>
        ) : (
          <>
            <div className="mr-body">
              <label className="mr-lbl">{t("What should it be called?")}</label>
              <input className="mr-in" value={name} onChange={(e) => setName(e.target.value)} placeholder="Main greeting" />

              <label className="mr-lbl">{t("What should callers hear?")}</label>
              <div className="mr-chips">
                {TEMPLATES.map((tpl) => (
                  <button key={tpl.label} className="mr-chip" onClick={() => { setText(tpl.text); setName(tpl.label); }}>
                    {t(tpl.label)}
                  </button>
                ))}
              </div>
              <textarea className="mr-ta" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="mr-meta">
                <span>{chars} {t("characters")}</span>
                {left != null && <span>{left.toLocaleString()} {t("left this month")}</span>}
              </div>

              <label className="mr-lbl">{t("Which voice?")}</label>
              <div className="mr-voices">
                {voices.map((v) => (
                  <button
                    key={v.voiceId}
                    className={"mr-voice" + (v.voiceId === voiceId ? " on" : "")}
                    onClick={() => setVoiceId(v.voiceId)}
                  >
                    <b>{v.name}</b>
                    <span>{describeVoice(v)}</span>
                  </button>
                ))}
                {voices.length === 0 && <p className="mr-dim">{t("No voices on this account yet.")}</p>}
              </div>

              <button className="mr-adv" onClick={() => setAdvanced(!advanced)}>
                {advanced ? "▾" : "▸"} {t("Advanced settings")}
              </button>
              {advanced && (
                <div className="mr-advbox">
                  <p className="mr-dim">
                    {t("These are already set for phone menus. Change them only if something sounds wrong.")}
                  </p>

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
                    {(status.models ?? []).map((m) => (
                      <option key={m.id} value={m.id}>{m.label} — {m.detail}</option>
                    ))}
                  </select>
                </div>
              )}

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
      .mr-chips{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:9px}
      .mr-chip{font:inherit;font-size:12px;font-weight:600;padding:6px 11px;border-radius:99px;cursor:pointer;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc);color:var(--dim,#5d6f84)}
      .mr-chip:hover{border-color:var(--accent,#2f6bff);color:var(--accent,#2f6bff)}
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

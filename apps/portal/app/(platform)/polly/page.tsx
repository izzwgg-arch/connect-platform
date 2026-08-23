"use client";
/**
 * Amazon Polly — owner page. Holds the AWS credentials and shows what they can
 * actually reach: the region, whether Amazon accepts them, and every voice
 * available to spend characters on.
 *
 * The secret access key is WRITE-ONLY. It is stored encrypted in the same
 * AgentSecret store as the ElevenLabs key, and no endpoint anywhere returns its
 * value — this page can only show the last four characters. Saving a blank
 * access key ID clears the whole credential.
 *
 * The access key ID itself IS shown in full, deliberately. It is an identifier
 * rather than a secret (it travels in the clear in every signed request and is
 * on display in AWS's own console), and showing it is what makes "did my paste
 * actually land, or did the browser refill the old one" an answerable question.
 *
 * Access to Polly for everyone else is a per-role toggle — `can_use_amazon_polly`
 * on Admin → Custom Roles — not something this page grants.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPut, ApiError, getPortalApiBaseUrl } from "../../../services/apiClient";
import { ConnectSelect } from "../../../components/ConnectSelect";
import { PageHeader } from "../../../components/PageHeader";

/** Reading localStorage throws outright in Safari's "Block All Cookies" mode
 *  and in storage-disabled webviews — the shared client guards every read for
 *  exactly that reason, and the one read done here must too. */
function safeToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return (
      window.localStorage.getItem("token") ||
      window.localStorage.getItem("cc-token") ||
      window.localStorage.getItem("authToken") ||
      ""
    );
  } catch {
    return "";
  }
}

interface Voice {
  voiceId: string;
  name: string;
  gender: string | null;
  languageCode: string | null;
  languageName: string | null;
  engines: string[];
}

interface Engine {
  id: string;
  label: string;
  detail: string;
  /** False where Amazon accepts a speaking-speed change and then ignores it. */
  supportsSpeed?: boolean;
}

interface Credentials {
  configured: boolean;
  source: "store" | "env" | "none";
  /** Shown in full — an identifier, not a secret. */
  accessKeyId: string | null;
  /** Last four of the secret, and nothing more. */
  secretHint: string | null;
  region: string | null;
  regions: { id: string; label: string }[];
  engines?: Engine[];
  keyWorks: boolean;
  usable: boolean;
  /** Written by the server for a person to read; shown verbatim when present. */
  message: string | null;
  voiceCount?: number | null;
  voices: Voice[];
}

/** Short enough to cost almost nothing, long enough to judge a voice by. */
const SAMPLE_TEXT = "Thanks for calling. Please hold and someone will be with you shortly.";

export default function PollyPage() {
  const [state, setState] = useState<Credentials | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [region, setRegion] = useState("us-east-1");

  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Nothing is hidden by default. This page's job is to show you the whole
  // inventory you're paying for; a helpful-looking default filter here just
  // makes voices look missing. Narrowing is the customer's move, not ours.
  const [search, setSearch] = useState("");
  const [language, setLanguage] = useState("all");
  const [engine, setEngine] = useState("all");
  const [playing, setPlaying] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<Credentials>("/voice/polly/credentials");
      setState(data);
      if (data.region) setRegion(data.region);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(
        e instanceof ApiError && e.status === 403
          ? "This page is for platform owners only."
          : e?.message || "Couldn't load the Amazon Polly settings.",
      );
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // A preview is not something to keep — release the blob when leaving.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  async function save() {
    setSaving(true); setMsg(null); setErr(null);
    try {
      const res = await apiPut<{ keyWorks?: boolean; usable?: boolean; message?: string | null; voiceCount?: number | null }>(
        "/voice/polly/credentials",
        { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(), region: region.trim() },
      );
      // Never keep the secret in the page after saving.
      setSecretAccessKey("");
      setAccessKeyId("");
      if (res.usable) {
        setMsg(`Saved and working${res.voiceCount ? ` — ${res.voiceCount} voices available` : ""}.`);
      } else {
        setErr(res.message || "Saved, but Amazon didn't accept these credentials.");
      }
      await load();
    } catch (e: any) {
      setErr(e?.message || "Couldn't save the credentials.");
    } finally { setSaving(false); }
  }

  async function clearCredentials() {
    setSaving(true); setMsg(null); setErr(null);
    try {
      await apiPut("/voice/polly/credentials", { accessKeyId: "" });
      setAccessKeyId(""); setSecretAccessKey("");
      setMsg("Credentials removed. Amazon Polly is switched off.");
      await load();
    } catch (e: any) {
      setErr(e?.message || "Couldn't remove the credentials.");
    } finally { setSaving(false); }
  }

  /**
   * Hear one voice, on demand only.
   *
   * Not auto-played for the whole list: unlike ElevenLabs, Amazon has no free
   * hosted samples, so every one of these is a real synthesis that is really
   * billed. One voice at a time, when someone asks for it.
   */
  async function playSample(v: Voice) {
    setErr(null); setPlaying(v.voiceId);
    try {
      // With "Any quality" selected there is no chosen engine to honour, so
      // audition each voice at the best it offers — the order in POLLY_ENGINES
      // is best-first, so the first match is that.
      const preferred = (state?.engines ?? []).map((e) => e.id);
      const usableEngine = v.engines.includes(engine)
        ? engine
        : preferred.find((id) => v.engines.includes(id)) || v.engines[0] || "standard";
      // A bespoke fetch rather than the shared helpers: apiFetchBlob is GET-only
      // and this is a POST that answers with audio. The API ORIGIN still comes
      // from the shared resolver — hard-coding `/api` would work in production
      // and break every local dev setup, where the API is on its own port.
      const token = safeToken();
      const r = await fetch(`${getPortalApiBaseUrl()}/voice/polly/preview`, {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ voiceId: v.voiceId, text: SAMPLE_TEXT, engine: usableEngine }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.message || `Couldn't play that voice (${r.status}).`);
      }
      const blob = await r.blob();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.src = objectUrlRef.current;
        // A refused autoplay is not an error — the player is on screen and can
        // be pressed by hand.
        await audioRef.current.play().catch(() => {});
      }
    } catch (e: any) {
      setErr(e?.message || "Couldn't play that voice.");
    } finally {
      setPlaying(null);
    }
  }

  const voices = state?.voices ?? [];

  const languages = useMemo(() => {
    const seen = new Map<string, string>();
    for (const v of voices) {
      const code = (v.languageCode || "").split("-")[0];
      if (code && !seen.has(code)) seen.set(code, (v.languageName || code).replace(/\s*\(.*\)$/, ""));
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [voices]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return voices.filter((v) => {
      if (language !== "all" && !(v.languageCode || "").toLowerCase().startsWith(language)) return false;
      // The quality dropdown FILTERS, rather than only tinting a badge. Picking
      // "Most lifelike" and still being shown all 109 voices makes answering
      // "which ones can do this?" a manual scan of every badge on the page.
      if (engine !== "all" && !v.engines.includes(engine)) return false;
      if (!q) return true;
      return `${v.name} ${v.voiceId} ${v.languageName ?? ""}`.toLowerCase().includes(q);
    });
  }, [voices, search, language, engine]);

  const canSave = accessKeyId.trim().length > 0 && secretAccessKey.trim().length > 0 && !saving;

  return (
    <div className="pl-wrap">
      <PollyStyles />
      <PageHeader
        title="Amazon Polly"
        subtitle="A second voice for the recordings callers hear. Set the Amazon credentials here, then switch it on for the people who should have it."
      />

      <div className="pl-head">
        {state && (
          <span className={`pl-pill ${state.usable ? "ok" : state.configured ? "bad" : ""}`}>
            {state.usable
              ? "connected"
              : state.configured
                ? state.keyWorks ? "can't make recordings" : "credentials not working"
                : "not set up yet"}
          </span>
        )}
      </div>

      {loadError && <div className="pl-note bad">{loadError}</div>}
      {err && <div className="pl-note bad">{err}</div>}
      {msg && <div className="pl-note ok">{msg}</div>}

      {!loadError && (
        <>
          <div className="pl-card">
            <h2>Amazon credentials</h2>
            <p className="pl-sub">
              From the AWS console under IAM → Users → Security credentials. The user needs only two permissions:{" "}
              <code>polly:SynthesizeSpeech</code> and <code>polly:DescribeVoices</code>. The secret key is stored
              encrypted and can never be read back — you can only replace it or remove it.
            </p>

            <label className="pl-lbl">Access key ID</label>
            <input
              className="pl-input"
              autoComplete="off"
              name="polly-access-key-id"
              placeholder={state?.configured ? "A key is saved — type a new one to replace it" : "AKIA…"}
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
            />

            <label className="pl-lbl">Secret access key</label>
            <input
              className="pl-input"
              type="password"
              // "new-password" rather than "off": browsers and password managers
              // ignore "off" on a password field and will happily refill an old
              // value over a freshly pasted one — which looks exactly like a
              // successful save and is impossible to tell apart from one.
              autoComplete="new-password"
              name="polly-secret-access-key"
              placeholder={state?.configured ? "Saved — type a new one to replace it" : "Paste the secret access key"}
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
            />

            <label className="pl-lbl">Region</label>
            <div className="pl-row">
              <ConnectSelect
                style={{ flex: 1, minWidth: 240 }}
                value={region}
                onChange={setRegion}
                options={[
                  ...(state?.regions ?? []).map((r) => ({ value: r.id, label: `${r.label} — ${r.id}` })),
                  // A saved region outside the shortlist must still be selectable,
                  // or opening this page would silently move it on the next save.
                  ...(state?.region && !(state.regions ?? []).some((r) => r.id === state.region)
                    ? [{ value: state.region, label: state.region }]
                    : []),
                ]}
              />
            </div>
            <p className="pl-sub" style={{ marginTop: 8 }}>
              Any region works. Pick the one nearest your phone system for the quickest generation.
            </p>

            <div className="pl-row" style={{ marginTop: 14 }}>
              <button className="pl-btn primary" disabled={!canSave} onClick={save}>
                {saving ? "Saving…" : "Save credentials"}
              </button>
              {state?.configured && (
                <button className="pl-btn" disabled={saving} onClick={clearCredentials}>
                  Remove
                </button>
              )}
            </div>

            {/* What is actually stored, so credentials that never made it in —
                mistyped, half-pasted, refilled by the browser — are visible
                rather than inferred from a failure that looks the same. */}
            {state?.configured && (
              <p className="pl-sub" style={{ marginTop: 14, marginBottom: 0 }}>
                Saved key <b>{state.accessKeyId}</b>, secret ending <b>{state.secretHint}</b>, region{" "}
                <b>{state.region}</b>
                {state.source === "env" && " (from this server's environment, not typed here)"}.
              </p>
            )}
            {state?.configured && !state.usable && state.message && (
              <div className="pl-note bad" style={{ marginTop: 12 }}>{state.message}</div>
            )}
          </div>

          <div className="pl-card">
            <h2>Who can use it</h2>
            <p className="pl-sub" style={{ marginBottom: 0 }}>
              Setting the credentials here does <b>not</b> hand Amazon Polly to everyone. It stays off until you
              switch on <code>can_use_amazon_polly</code> for a role under <b>Admin → Custom Roles</b>. People
              without it carry on using ElevenLabs exactly as before and never see the Polly option at all.
              Platform admins already have it.
            </p>
          </div>

          {state?.usable && (
            <div className="pl-card">
              <h2>
                Voices
                <span className="pl-count">{shown.length}{shown.length !== voices.length ? ` of ${voices.length}` : ""}</span>
              </h2>
              <p className="pl-sub">
                These are what people with Polly access will choose from in the IVR Studio. Press <b>Hear it</b> to
                listen — each one is generated fresh and is billed, so it plays only when you ask.
              </p>

              <div className="pl-filters">
                <ConnectSelect
                  style={{ flex: "0 0 auto", minWidth: 170 }}
                  value={language}
                  onChange={setLanguage}
                  options={[
                    { value: "all", label: "All languages" },
                    ...languages.map(([code, label]) => ({ value: code, label })),
                  ]}
                />
                <ConnectSelect
                  style={{ flex: "0 0 auto", minWidth: 170 }}
                  value={engine}
                  onChange={setEngine}
                  options={[
                    { value: "all", label: "Any quality" },
                    ...(state.engines ?? []).map((e) => ({ value: e.id, label: e.label })),
                  ]}
                />
                <input
                  className="pl-input"
                  placeholder="Search by name"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>

              <audio ref={audioRef} className="pl-audio" controls preload="none" controlsList="nodownload" />

              <div className="pl-voices">
                {shown.map((v) => (
                  <div key={v.voiceId} className="pl-voice">
                    <div className="pl-voice-name">
                      <b>{v.name}</b>
                      {v.gender && <span className="pl-tag">{v.gender}</span>}
                    </div>
                    <div className="pl-voice-sub">{v.languageName || v.languageCode}</div>
                    <div className="pl-voice-engines">
                      {v.engines.map((e) => (
                        <span key={e} className={"pl-label" + (e === engine ? " on" : "")}>{e}</span>
                      ))}
                    </div>
                    <button className="pl-btn small" disabled={playing === v.voiceId} onClick={() => playSample(v)}>
                      {playing === v.voiceId ? "Generating…" : "▶ Hear it"}
                    </button>
                  </div>
                ))}
                {shown.length === 0 && <p className="pl-sub">No voices match that.</p>}
              </div>
            </div>
          )}

          <div className="pl-card">
            <h2>How recordings will be made</h2>
            <ul className="pl-list">
              <li><b>Generated at telephone quality.</b> Amazon produces the audio in exactly the format your
                phone system plays, so nothing is converted afterwards and nothing is lost.</li>
              <li><b>Tuned for menus, not audiobooks.</b> A touch slower than natural — people are listening for
                their option, not being entertained.</li>
              <li><b>Play-only for customers.</b> Recordings made this way can be listened to in Connect, never
                downloaded.</li>
              <li><b>Billed per character, when generated.</b> A greeting costs its length once, however many
                callers hear it.</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function PollyStyles() {
  return (
    <style jsx global>{`
      .pl-wrap{--pnl:#fff;--pnl2:#f6f9fc;--ln:rgba(19,32,48,.13);--tx:#132030;--dim:#5d6f84;--faint:#8496a8;
        --ac:#1f74d0;--ac-soft:rgba(31,116,208,.09);--ok:#1a9d5c;--bad:#c9414c;
        max-width:960px;margin:0 auto;padding:8px 4px 60px;color:var(--tx);
        font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      :root[data-theme="dark"] .pl-wrap{--pnl:#16212e;--pnl2:#1c2937;--ln:#2a3a4c;--tx:#e4ecf4;--dim:#8ba0b6;--faint:#64798f;
        --ac:#3ba0f2;--ac-soft:rgba(59,160,242,.14);--ok:#3ec37e;--bad:#e2606a}
      .pl-wrap *{box-sizing:border-box}
      .pl-head{display:flex;justify-content:flex-end;margin:0 0 14px}
      .pl-pill{font-size:11.5px;font-weight:680;padding:5px 12px;border-radius:999px;border:1px solid var(--ln);color:var(--dim);white-space:nowrap}
      .pl-pill.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent);background:color-mix(in srgb,var(--ok) 12%,transparent)}
      .pl-pill.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent);background:color-mix(in srgb,var(--bad) 12%,transparent)}
      .pl-card{background:var(--pnl);border:1px solid var(--ln);border-radius:16px;padding:20px;margin-bottom:16px}
      .pl-card h2{font-size:16px;font-weight:680;margin:0 0 4px;display:flex;align-items:center;gap:9px}
      .pl-count{font-size:12px;font-weight:650;color:var(--ac);background:var(--ac-soft);border-radius:999px;padding:3px 9px}
      .pl-sub{color:var(--dim);font-size:13.5px;margin:0 0 14px;line-height:1.6;max-width:70ch}
      .pl-sub code{font-size:12.5px;background:var(--pnl2);border:1px solid var(--ln);border-radius:5px;padding:1px 5px}
      .pl-lbl{display:block;font-size:12px;font-weight:660;color:var(--dim);margin:16px 0 7px}
      .pl-row{display:flex;gap:10px;flex-wrap:wrap}
      .pl-input{flex:1;min-width:240px;width:100%;font:inherit;font-size:14px;padding:11px 13px;border-radius:10px;
        border:1px solid var(--ln);background:var(--pnl2);color:var(--tx)}
      .pl-input:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px var(--ac-soft)}
      .pl-narrow{flex:0 0 auto;min-width:170px;width:auto}
      .pl-filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
      .pl-btn{font:inherit;font-size:13.5px;font-weight:640;padding:11px 18px;border-radius:10px;cursor:pointer;
        border:1px solid var(--ln);background:var(--pnl2);color:var(--tx)}
      .pl-btn.primary{background:var(--ac);border-color:var(--ac);color:#fff}
      .pl-btn.small{font-size:12px;padding:6px 12px;margin-top:10px}
      .pl-btn:disabled{opacity:.5;cursor:not-allowed}
      .pl-note{padding:11px 14px;border-radius:11px;font-size:13.5px;margin-bottom:14px;border:1px solid var(--ln);color:var(--dim)}
      .pl-note.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 34%,transparent);background:color-mix(in srgb,var(--ok) 10%,transparent)}
      .pl-note.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 34%,transparent);background:color-mix(in srgb,var(--bad) 10%,transparent)}
      .pl-audio{width:100%;height:36px;margin-bottom:14px}
      .pl-voices{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
      .pl-voice{border:1px solid var(--ln);border-radius:12px;padding:13px;background:var(--pnl2)}
      .pl-voice-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .pl-voice-name b{font-size:14.5px;font-weight:660}
      .pl-voice-sub{font-size:12px;color:var(--dim);margin-top:3px}
      .pl-tag{font-size:10.5px;font-weight:680;text-transform:uppercase;letter-spacing:.05em;color:var(--ac);
        background:var(--ac-soft);border-radius:999px;padding:2px 8px}
      .pl-voice-engines{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
      .pl-label{font-size:11px;color:var(--dim);border:1px solid var(--ln);border-radius:6px;padding:2px 7px}
      .pl-label.on{color:var(--ac);border-color:color-mix(in srgb,var(--ac) 45%,transparent);background:var(--ac-soft)}
      .pl-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:9px;font-size:13.5px;color:var(--dim);line-height:1.6}
      .pl-list b{color:var(--tx)}
    `}</style>
  );
}

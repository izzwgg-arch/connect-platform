"use client";
/**
 * ElevenLabs — owner page. Holds the API key and shows what it can actually
 * reach: plan, character allowance, whether cloning is available, and the
 * voices on the account.
 *
 * The key is WRITE-ONLY. It is stored encrypted in the same AgentSecret store
 * as the Anthropic / OpenAI / Yiddish Labs keys, and no endpoint anywhere
 * returns its value — the page can only ever show a masked hint. Saving a
 * blank value clears it.
 *
 * Voices are for IVR greetings, so the settings below are deliberately tuned
 * for a phone menu rather than for audiobook narration — see VOICE_PRESET.
 */
import { useCallback, useEffect, useState } from "react";
import { VOICE_PRESET } from "../../../lib/voicePreset";

void VOICE_PRESET; // referenced by the generate flow; kept imported so the preset has one home

function token() {
  return typeof window === "undefined"
    ? ""
    : localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}
async function agentApi<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/agent-api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

interface Voice { voiceId: string; name: string; category: string | null; labels: Record<string, string>; previewUrl: string | null }
interface Status {
  configured: boolean; reachable: boolean; reason?: string;
  tier?: string | null; characterCount?: number | null; characterLimit?: number | null;
  canClone?: boolean; voices?: Voice[];
}


export default function ElevenLabsPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await agentApi<Status>("/voice/elevenlabs/status"));
      setErr(null);
    } catch {
      setErr("Owners only, or the assistant service is unreachable.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function saveKey() {
    setSaving(true); setMsg(null); setErr(null);
    try {
      await agentApi("/admin/secrets", {
        method: "POST",
        body: JSON.stringify({ key: "elevenlabs_api_key", value: keyInput.trim() }),
      });
      setKeyInput(""); // never keep the key in the page after saving
      setMsg(keyInput.trim() ? "Key saved — checking it now…" : "Key removed.");
      await load();
    } catch {
      setErr("Couldn't save the key.");
    } finally { setSaving(false); }
  }

  const used = status?.characterCount ?? 0;
  const limit = status?.characterLimit ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  return (
    <div className="el-wrap">
      <ElStyles />
      <div className="el-head">
        <div>
          <div className="el-eyebrow">Voices</div>
          <h1>ElevenLabs</h1>
          <p>Generate the recordings callers hear — greetings, menus and hold messages — in a voice you choose.</p>
        </div>
        {status && (
          <span className={`el-pill ${status.reachable ? "ok" : status.configured ? "bad" : ""}`}>
            {status.reachable ? "connected" : status.configured ? "key not working" : "no key yet"}
          </span>
        )}
      </div>

      {err && <div className="el-note bad">{err}</div>}
      {msg && <div className="el-note ok">{msg}</div>}

      <div className="el-card">
        <h2>API key</h2>
        <p className="el-sub">
          From your ElevenLabs account under Profile → API Keys. It&apos;s stored encrypted and can never be
          read back — you can only replace it or remove it.
        </p>
        <div className="el-row">
          <input
            className="el-input"
            type="password"
            autoComplete="off"
            placeholder={status?.configured ? "A key is saved — type a new one to replace it" : "Paste your ElevenLabs API key"}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button className="el-btn primary" disabled={saving || !keyInput.trim()} onClick={saveKey}>
            {saving ? "Saving…" : "Save key"}
          </button>
          {status?.configured && (
            <button className="el-btn" disabled={saving} onClick={() => { setKeyInput(""); void saveKey(); }}>
              Remove
            </button>
          )}
        </div>
        {status?.configured && !status.reachable && (
          <div className="el-note bad" style={{ marginTop: 12 }}>
            {status.reason === "invalid_key"
              ? "ElevenLabs rejected this key. Check you copied all of it, and that it hasn't been revoked."
              : "Saved, but ElevenLabs couldn't be reached just now."}
          </div>
        )}
      </div>

      {status?.reachable && (
        <>
          <div className="el-card">
            <h2>Your account</h2>
            <div className="el-stats">
              <div className="el-stat"><b>{status.tier ?? "—"}</b><span>Plan</span></div>
              <div className="el-stat"><b>{limit ? `${used.toLocaleString()} / ${limit.toLocaleString()}` : "—"}</b><span>Characters used</span></div>
              <div className="el-stat"><b>{status.canClone ? "Yes" : "No"}</b><span>Voice cloning</span></div>
            </div>
            {limit > 0 && (
              <div className="el-bar"><i style={{ width: `${pct}%` }} /></div>
            )}
            <p className="el-sub" style={{ marginTop: 12 }}>
              Characters are spent when a recording is generated, not when it&apos;s played. A greeting costs
              its length once, however many callers hear it.
            </p>
          </div>

          <div className="el-card">
            <h2>Voices on this account <span className="el-count">{status.voices?.length ?? 0}</span></h2>
            <p className="el-sub">
              These are what you&apos;ll be able to choose from in the IVR Studio.
            </p>
            <div className="el-voices">
              {(status.voices ?? []).map((v) => (
                <div key={v.voiceId} className="el-voice">
                  <div className="el-voice-name">
                    <b>{v.name}</b>
                    {v.category && <span className="el-tag">{v.category}</span>}
                  </div>
                  <div className="el-voice-labels">
                    {Object.entries(v.labels || {}).slice(0, 4).map(([k, val]) => (
                      <span key={k} className="el-label">{val}</span>
                    ))}
                  </div>
                  {v.previewUrl && (
                    <audio className="el-audio" controls preload="none" src={v.previewUrl} controlsList="nodownload" />
                  )}
                </div>
              ))}
              {(status.voices ?? []).length === 0 && <p className="el-sub">No voices on this account yet.</p>}
            </div>
          </div>

          <div className="el-card">
            <h2>How recordings will be made</h2>
            <ul className="el-list">
              <li><b>Generated at telephone quality.</b> ElevenLabs can produce audio in exactly the format your
                phone system plays, so nothing is converted afterwards and nothing is lost.</li>
              <li><b>Tuned for menus, not audiobooks.</b> Steady and consistent rather than expressive, and a
                touch slower — people are listening for their option, not being entertained.</li>
              <li><b>Play-only for customers.</b> Recordings made here can be listened to in Connect, never
                downloaded.</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function ElStyles() {
  return (
    <style jsx global>{`
      .el-wrap{--pnl:#fff;--pnl2:#f6f9fc;--ln:rgba(19,32,48,.13);--tx:#132030;--dim:#5d6f84;--faint:#8496a8;
        --ac:#1f74d0;--ac-soft:rgba(31,116,208,.09);--ok:#1a9d5c;--bad:#c9414c;
        max-width:960px;margin:0 auto;padding:8px 4px 60px;color:var(--tx);
        font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      :root[data-theme="dark"] .el-wrap{--pnl:#16212e;--pnl2:#1c2937;--ln:#2a3a4c;--tx:#e4ecf4;--dim:#8ba0b6;--faint:#64798f;
        --ac:#3ba0f2;--ac-soft:rgba(59,160,242,.14);--ok:#3ec37e;--bad:#e2606a}
      .el-wrap *{box-sizing:border-box}
      .el-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:14px 0 20px}
      .el-eyebrow{font-size:11px;font-weight:750;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
      .el-head h1{font-size:26px;font-weight:720;margin:8px 0 0;letter-spacing:-.02em}
      .el-head p{margin:8px 0 0;color:var(--dim);font-size:14.5px;max-width:60ch}
      .el-pill{font-size:11.5px;font-weight:680;padding:5px 12px;border-radius:999px;border:1px solid var(--ln);color:var(--dim);white-space:nowrap}
      .el-pill.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent);background:color-mix(in srgb,var(--ok) 12%,transparent)}
      .el-pill.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent);background:color-mix(in srgb,var(--bad) 12%,transparent)}
      .el-card{background:var(--pnl);border:1px solid var(--ln);border-radius:16px;padding:20px;margin-bottom:16px}
      .el-card h2{font-size:16px;font-weight:680;margin:0 0 4px;display:flex;align-items:center;gap:9px}
      .el-count{font-size:12px;font-weight:650;color:var(--ac);background:var(--ac-soft);border-radius:999px;padding:3px 9px}
      .el-sub{color:var(--dim);font-size:13.5px;margin:0 0 14px;line-height:1.6;max-width:70ch}
      .el-row{display:flex;gap:10px;flex-wrap:wrap}
      .el-input{flex:1;min-width:260px;font:inherit;font-size:14px;padding:11px 13px;border-radius:10px;
        border:1px solid var(--ln);background:var(--pnl2);color:var(--tx)}
      .el-input:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px var(--ac-soft)}
      .el-btn{font:inherit;font-size:13.5px;font-weight:640;padding:11px 18px;border-radius:10px;cursor:pointer;
        border:1px solid var(--ln);background:var(--pnl2);color:var(--tx)}
      .el-btn.primary{background:var(--ac);border-color:var(--ac);color:#fff}
      .el-btn:disabled{opacity:.5;cursor:not-allowed}
      .el-note{padding:11px 14px;border-radius:11px;font-size:13.5px;margin-bottom:14px;border:1px solid var(--ln);color:var(--dim)}
      .el-note.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 34%,transparent);background:color-mix(in srgb,var(--ok) 10%,transparent)}
      .el-note.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 34%,transparent);background:color-mix(in srgb,var(--bad) 10%,transparent)}
      .el-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
      .el-stat{border:1px solid var(--ln);border-radius:12px;padding:14px;background:var(--pnl2)}
      .el-stat b{display:block;font-size:19px;font-weight:720}
      .el-stat span{display:block;font-size:12px;color:var(--dim);margin-top:3px}
      .el-bar{height:7px;border-radius:99px;background:var(--pnl2);border:1px solid var(--ln);margin-top:14px;overflow:hidden}
      .el-bar i{display:block;height:100%;background:var(--ac)}
      .el-voices{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
      .el-voice{border:1px solid var(--ln);border-radius:12px;padding:13px;background:var(--pnl2)}
      .el-voice-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .el-voice-name b{font-size:14.5px;font-weight:660}
      .el-tag{font-size:10.5px;font-weight:680;text-transform:uppercase;letter-spacing:.05em;color:var(--ac);
        background:var(--ac-soft);border-radius:999px;padding:2px 8px}
      .el-voice-labels{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
      .el-label{font-size:11px;color:var(--dim);border:1px solid var(--ln);border-radius:6px;padding:2px 7px}
      .el-audio{width:100%;margin-top:10px;height:34px}
      .el-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:9px;font-size:13.5px;color:var(--dim);line-height:1.6}
      .el-list b{color:var(--tx)}
    `}</style>
  );
}

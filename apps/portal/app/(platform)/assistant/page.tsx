"use client";
/**
 * AI Assistant — owner console. Test every agent, see everything, control it.
 * Consumes /agent-api/* (owner JWT). One place to: check status/providers, run
 * provider self-tests, chat-test the live agent, view certified capabilities,
 * and see corpus / Yiddish Labs / activity at a glance.
 */
import { useCallback, useEffect, useRef, useState } from "react";

function token() { return typeof window === "undefined" ? "" : (localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || ""); }
async function get<T>(p: string): Promise<T> { const r = await fetch(`/agent-api${p}`, { headers: { Authorization: `Bearer ${token()}` } }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
async function post<T>(p: string, body: object): Promise<T> { const r = await fetch(`/agent-api${p}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

type SecretStatus = Record<string, { configured: boolean; source: string; hint?: string }>;
const SECRET_FIELDS: { key: string; label: string }[] = [
  { key: "anthropic_api_key", label: "Anthropic API key" },
  { key: "openai_api_key", label: "OpenAI API key" },
  { key: "yiddishlabs_api_key", label: "Yiddish Labs API key" },
];

type Status = { enabled: boolean; killSwitchEngaged: boolean; providersConfigured: string[]; smtpConfigured: boolean; dbConnected: boolean; chatEnabled: boolean; manifest: { total: number; executable: number } };
type Cap = { id: string; title: string; kind: string; status: string; roles: string[]; pbxWrite: boolean; liveEnabled: boolean };

const statusChip = (ok: boolean, on = "on", off = "off") => (
  <span style={{ ...pill, background: ok ? "#12331f" : "#3b1417", color: ok ? "#22c55e" : "#ef4444" }}>{ok ? on : off}</span>
);
const pill: React.CSSProperties = { padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600 };
const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,.3)", borderRadius: 12, padding: 16, marginBottom: 14 };
const btn: React.CSSProperties = { padding: "7px 14px", borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13 };
const btnBlue: React.CSSProperties = { ...btn, background: "#2563eb", color: "#fff", border: "none" };

export default function AssistantPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [caps, setCaps] = useState<Cap[]>([]);
  const [corpus, setCorpus] = useState<any>(null);
  const [yl, setYl] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<Record<string, string>>({});
  const [chat, setChat] = useState<{ role: string; text: string }[]>([]);
  const [input, setInput] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const [secStatus, setSecStatus] = useState<SecretStatus | null>(null);
  const [masterKey, setMasterKey] = useState(true);
  const [keyInput, setKeyInput] = useState<Record<string, string>>({});
  const [keyMsg, setKeyMsg] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState(false);
  const [micMsg, setMicMsg] = useState("");
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const load = useCallback(async () => {
    try {
      setStatus(await get<Status>("/status"));
      setCaps((await get<{ capabilities: Cap[] }>("/admin/capabilities")).capabilities);
      setCorpus(await get("/corpus/stats").catch(() => null));
      setYl(await get("/yiddishlabs/status").catch(() => null));
      const s = await get<{ masterKey: boolean; secrets: SecretStatus }>("/admin/secrets/status").catch(() => null);
      if (s) { setSecStatus(s.secrets); setMasterKey(s.masterKey); }
      setErr(null);
    } catch { setErr("Owners only, or the agent is unreachable."); }
  }, []);

  const saveKey = async (key: string) => {
    const value = keyInput[key] ?? "";
    setKeyMsg((m) => ({ ...m, [key]: "saving…" }));
    try {
      const r = await post<{ status: SecretStatus }>("/admin/secrets", { key, value });
      setSecStatus(r.status);
      setKeyInput((k) => ({ ...k, [key]: "" }));
      setKeyMsg((m) => ({ ...m, [key]: value.trim() ? "saved ✓ (takes effect now)" : "cleared" }));
      load();
    } catch { setKeyMsg((m) => ({ ...m, [key]: "save failed" })); }
  };

  const startMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setMicMsg("transcribing…");
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const b64 = await new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(blob); });
        try {
          const r = await post<any>("/transcribe/mic", { audioBase64: b64, filename: "mic.webm" });
          if (r.ok && r.text) { setInput((v) => (v ? v + " " : "") + r.text); setMicMsg(`✓ ${r.language ?? ""}`); }
          else setMicMsg("✗ " + (r.error ?? "no text"));
        } catch { setMicMsg("✗ transcription failed"); }
      };
      mediaRef.current = mr; mr.start(); setRecording(true); setMicMsg("listening…");
    } catch { setMicMsg("✗ mic permission denied"); }
  };
  const stopMic = () => { mediaRef.current?.stop(); setRecording(false); };
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [chat]);

  const runTest = async (provider: "openai" | "anthropic") => {
    setTest((t) => ({ ...t, [provider]: "…" }));
    try {
      const r = await post<any>("/admin/selftest", { provider });
      setTest((t) => ({ ...t, [provider]: r.ok ? `✓ ${r.model}: ${r.text}` : `✗ ${r.error?.slice(0, 80)}` }));
    } catch (e) { setTest((t) => ({ ...t, [provider]: "✗ " + String(e) })); }
  };

  const send = async () => {
    const text = input.trim(); if (!text) return; setInput("");
    setChat((c) => [...c, { role: "user", text }]);
    try {
      const r = await post<{ reply: string }>("/chat/message", { text, channel: "chat" });
      setChat((c) => [...c, { role: "assistant", text: r.reply }]);
    } catch { setChat((c) => [...c, { role: "assistant", text: "(error reaching agent)" }]); }
  };

  const certified = caps.filter((c) => c.status === "certified" || c.status === "live");
  const pbxWrite = caps.filter((c) => c.pbxWrite);

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>AI Assistant — control center</h1>
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>Test every agent, see everything, control it. Owner-only.</div>
      {err && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {status && (
        <div style={card}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
            <div><b>Agent</b> {statusChip(status.enabled, "ENABLED", "disabled")}</div>
            <div>Kill switch {statusChip(!status.killSwitchEngaged, "clear", "ENGAGED")}</div>
            <div>DB {statusChip(status.dbConnected)}</div>
            <div>Chat {statusChip(status.chatEnabled)}</div>
            <div>Email {statusChip(status.smtpConfigured)}</div>
            <div>Providers: {status.providersConfigured.length ? status.providersConfigured.map((p) => <span key={p} style={{ ...pill, background: "#12233f", color: "#60a5fa", marginRight: 4 }}>{p}</span>) : <span style={{ ...pill, background: "#3a2c0d", color: "#f59e0b" }}>none — add API keys</span>}</div>
            <div>Capabilities: <b>{status.manifest.executable}</b>/{status.manifest.total} live</div>
          </div>
        </div>
      )}

      <div style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 4 }}>API keys</h3>
        <div style={{ fontSize: 11.5, opacity: 0.65, marginBottom: 10 }}>Stored encrypted on the server, write-only (never shown back). Saving takes effect immediately — no restart.</div>
        {!masterKey && <div style={{ color: "#f59e0b", fontSize: 12, marginBottom: 8 }}>Encryption master key not set on the server — keys can only be set via the env file until CREDENTIALS_MASTER_KEY is configured.</div>}
        {SECRET_FIELDS.map((f) => {
          const st = secStatus?.[f.key];
          return (
            <div key={f.key} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", flexWrap: "wrap" }}>
              <span style={{ width: 150, fontSize: 13 }}>{f.label}</span>
              {st?.configured ? statusChip(true, `set ${st.hint ?? ""}`) : statusChip(false, "not set")}
              <input type="password" value={keyInput[f.key] ?? ""} onChange={(e) => setKeyInput((k) => ({ ...k, [f.key]: e.target.value }))} placeholder={st?.configured ? "replace…" : "paste key…"} style={{ flex: 1, minWidth: 160, padding: "6px 10px", borderRadius: 7, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", fontSize: 13 }} autoComplete="off" />
              <button style={btn} disabled={!masterKey} onClick={() => saveKey(f.key)}>Save</button>
              {keyMsg[f.key] && <span style={{ fontSize: 11.5, color: keyMsg[f.key].includes("✓") ? "#22c55e" : "#8b98a9" }}>{keyMsg[f.key]}</span>}
            </div>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={card}>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Provider self-test</h3>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button style={btn} onClick={() => runTest("anthropic")}>Test Claude (Sonnet/Opus)</button>
            <button style={btn} onClick={() => runTest("openai")}>Test OpenAI</button>
          </div>
          {["anthropic", "openai"].map((p) => test[p] && <div key={p} style={{ fontSize: 12.5, fontFamily: "Consolas,monospace", padding: "4px 0", color: test[p].startsWith("✓") ? "#22c55e" : "#ef4444" }}>{p}: {test[p]}</div>)}
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>Pings each model with a live call. Needs the agent enabled + API keys set.</div>
        </div>

        <div style={card}>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Live test chat</h3>
          <div style={{ minHeight: 120, maxHeight: 200, overflowY: "auto", marginBottom: 8 }}>
            {chat.length === 0 && <div style={{ opacity: 0.5, fontSize: 13 }}>Talk to the agent as a client would — English or Yiddish.</div>}
            {chat.map((m, i) => <div key={i} style={{ margin: "4px 0", padding: "6px 10px", borderRadius: 10, fontSize: 13, background: m.role === "user" ? "#2563eb" : "rgba(128,128,128,.15)", color: m.role === "user" ? "#fff" : undefined, alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", marginLeft: m.role === "user" ? "auto" : 0, whiteSpace: "pre-wrap" }}>{m.text}</div>)}
            <div ref={bottom} />
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button title="Hold to speak (Yiddish or English)" onClick={recording ? stopMic : startMic} style={{ ...btn, background: recording ? "#ef4444" : "transparent", color: recording ? "#fff" : "inherit", border: recording ? "none" : "1px solid rgba(128,128,128,.4)", width: 40, padding: 0, height: 34 }}>{recording ? "■" : "🎤"}</button>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Type, or tap 🎤 to speak…" style={{ flex: 1, padding: "7px 12px", borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", fontSize: 13 }} />
            <button style={btnBlue} onClick={send}>Send</button>
          </div>
          {micMsg && <div style={{ fontSize: 11.5, opacity: 0.7, marginTop: 4 }}>{micMsg}</div>}
        </div>
      </div>

      <div style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Capabilities ({certified.length} live · {pbxWrite.length} PBX-write, all sim-gated)</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 6, fontSize: 12.5 }}>
          {caps.map((c) => (
            <div key={c.id} style={{ display: "flex", justifyContent: "space-between", gap: 6, padding: "4px 8px", border: "1px solid rgba(128,128,128,.15)", borderRadius: 6 }}>
              <span title={c.id}>{c.title.slice(0, 34)}</span>
              <span style={{ ...pill, fontSize: 10, background: c.status === "certified" || c.status === "live" ? "#12331f" : "#1c2330", color: c.status === "certified" || c.status === "live" ? "#22c55e" : "#8b98a9" }}>{c.pbxWrite && !c.liveEnabled ? "sim" : c.status}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {corpus && <div style={{ ...card, flex: 1, minWidth: 200 }}><h3 style={{ fontSize: 14, marginBottom: 8 }}>Tuning corpus</h3><div style={{ fontSize: 13 }}>Total: <b>{corpus.total}</b> · corrected: {corpus.corrected} · training-eligible: {corpus.trainingEligible}<br />from calls: {corpus.from_calls} · hotline: {corpus.from_hotline}</div></div>}
        {yl && <div style={{ ...card, flex: 1, minWidth: 200 }}><h3 style={{ fontSize: 14, marginBottom: 8 }}>Yiddish Labs {statusChip(yl.configured, "connected", "no key")}</h3><div style={{ fontSize: 13 }}>ייִדיש {yl.counts?.yi ?? 0} · English {yl.counts?.en ?? 0} · yi-en {yl.counts?.["yi-en"] ?? 0}</div></div>}
      </div>

      <div style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>Manage</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a href="/agent-approvals" style={btn}>Approvals</a>
          <a href="/agent-permissions" style={btn}>Permissions</a>
          <a href="/agent-activity" style={btn}>Activity &amp; Watchman</a>
          <a href="/yiddish-labs" style={btn}>Yiddish Labs</a>
          <a href="/support-chat" style={btn}>Client Chat</a>
        </div>
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>Enable/disable the whole agent via AGENT_ENABLED on the server. PBX-write capabilities stay simulation-gated until the PW-2 window.</div>
      </div>
    </div>
  );
}

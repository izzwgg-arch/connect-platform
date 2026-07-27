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

// Instant acknowledgment. Yiddish Labs' English→Yiddish leg is a fixed ~9s, so
// while the real answer translates we show this fixed, pre-approved Yiddish ack
// INSTANTLY (0ms, no network) — the exact YL translation of
// "One moment — I'm looking into that for you." Feels instant.
const ACK_YI = "ביטע ווארט איין רגע בשעת איך טשעק דאס איבער פאר אייך.";
const ACK_EN = "One moment — I'm looking into that for you.";
const isYiddish = (s: string) => /[֐-׿]/.test(s);

type SecretStatus = Record<string, { configured: boolean; source: string; hint?: string }>;
const SECRET_FIELDS: { key: string; label: string }[] = [
  { key: "anthropic_api_key", label: "Anthropic API key" },
  { key: "openai_api_key", label: "OpenAI API key" },
  { key: "yiddishlabs_api_key", label: "Yiddish Labs API key" },
  { key: "ivrit_api_key", label: "ivrit.ai (RunPod) API key" },
];

// Mic transcription engines the owner can A/B from the Assistant page.
const MIC_ENGINES: { id: string; label: string }[] = [
  { id: "openai", label: "OpenAI (fast)" },
  { id: "ivrit", label: "ivrit.ai" },
  { id: "yiddishlabs", label: "Yiddish Labs" },
];

type Status = { enabled: boolean; killSwitchEngaged: boolean; providersConfigured: string[]; activeChatModel?: { provider: string; model: string }; smtpConfigured: boolean; dbConnected: boolean; chatEnabled: boolean; manifest: { total: number; executable: number } };
type ModelCatalog = { active: { provider: string; model: string }; providers: Record<string, string[]> };
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
  const [chat, setChat] = useState<{ role: string; text: string; pending?: boolean }[]>([]);
  const [input, setInput] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const [secStatus, setSecStatus] = useState<SecretStatus | null>(null);
  const [masterKey, setMasterKey] = useState(true);
  const [keyInput, setKeyInput] = useState<Record<string, string>>({});
  const [keyMsg, setKeyMsg] = useState<Record<string, string>>({});
  const [models, setModels] = useState<ModelCatalog | null>(null);
  const [modelSel, setModelSel] = useState("");
  const [modelMsg, setModelMsg] = useState("");
  const [recording, setRecording] = useState(false);
  const [micMsg, setMicMsg] = useState("");
  const [micEngine, setMicEngine] = useState("openai");
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

  // Model catalog is fetched once (it hits both providers' list APIs) and after
  // every apply — the ACTIVE model rides the regular 15s /status poll instead.
  const loadModels = useCallback(async () => {
    try {
      const m = await get<ModelCatalog>("/admin/models");
      setModels(m);
      setModelSel((s) => s || `${m.active.provider}:${m.active.model}`);
    } catch { /* owner-only or agent down; card just hides */ }
  }, []);
  useEffect(() => { loadModels(); }, [loadModels]);

  const applyModel = async (value: string) => {
    setModelMsg("applying…");
    try {
      const r = await post<{ ok: boolean; activeChatModel?: { provider: string; model: string } }>("/admin/secrets", { key: "chat_model", value });
      const a = r.activeChatModel;
      setModelMsg(a ? `✓ chat now runs on ${a.provider}:${a.model}` : "✓ applied");
      load(); loadModels();
    } catch { setModelMsg("✗ apply failed"); }
  };

  const testModel = async () => {
    const [provider, ...rest] = modelSel.split(":");
    if (!provider || rest.length === 0) return;
    setModelMsg("testing…");
    try {
      const r = await post<any>("/admin/selftest", { provider, model: rest.join(":") });
      setModelMsg(r.ok ? `✓ ${r.model} replied: ${r.text}` : `✗ ${String(r.error).slice(0, 120)}`);
    } catch (e) { setModelMsg("✗ " + String(e)); }
  };

  const startMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setMicMsg(`transcribing via ${micEngine}…`);
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const b64 = await new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(blob); });
        try {
          const r = await post<any>("/transcribe/mic", { audioBase64: b64, filename: "mic.webm", engine: micEngine });
          if (r.ok && r.text) { setInput((v) => (v ? v + " " : "") + r.text); setMicMsg(`✓ ${r.engine ?? micEngine} · ${r.ms ? (r.ms / 1000).toFixed(1) + "s" : ""} · ${r.language ?? ""}`); }
          else setMicMsg(`✗ ${r.engine ?? micEngine}: ${r.error ?? "no text"}`);
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

  // Reveal the final reply with a typewriter effect, replacing the pending ack.
  const typeOut = (full: string) => {
    const stepChars = Math.max(2, Math.round(full.length / 60));
    let i = 0;
    const tick = () => {
      i = Math.min(full.length, i + stepChars);
      const shown = full.slice(0, i);
      const done = i >= full.length;
      setChat((c) => {
        const n = [...c];
        for (let j = n.length - 1; j >= 0; j--) {
          if (n[j].role === "assistant") { n[j] = { role: "assistant", text: shown, pending: !done }; break; }
        }
        return n;
      });
      if (!done) setTimeout(tick, 16);
    };
    tick();
  };

  const send = async () => {
    const text = input.trim(); if (!text) return; setInput("");
    // Show the user message + an INSTANT acknowledgment (Yiddish if they wrote
    // Yiddish) so there's zero perceived wait while the real answer translates.
    const ack = isYiddish(text) ? ACK_YI : ACK_EN;
    setChat((c) => [...c, { role: "user", text }, { role: "assistant", text: ack, pending: true }]);
    try {
      const r = await post<{ reply: string }>("/chat/message", { text, channel: "chat" });
      typeOut(r.reply); // replaces the pending ack, revealed as a typewriter
    } catch {
      setChat((c) => { const n = [...c]; for (let j = n.length - 1; j >= 0; j--) { if (n[j].role === "assistant") { n[j] = { role: "assistant", text: "(error reaching agent)" }; break; } } return n; });
    }
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

      <div style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 4 }}>Chat model</h3>
        <div style={{ fontSize: 11.5, opacity: 0.65, marginBottom: 10 }}>
          Which LLM answers the agent chat (support conversations + task extraction). Applies instantly to new messages — no restart. Heavy-reasoning jobs (diagnostics, security, reports) keep their own model.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>Active:</span>
          <span style={{ ...pill, background: "#12233f", color: "#60a5fa" }}>
            {status?.activeChatModel ? `${status.activeChatModel.provider}:${status.activeChatModel.model}` : "…"}
          </span>
          <select value={modelSel} onChange={(e) => setModelSel(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", fontSize: 13, minWidth: 260 }}>
            {!models && <option value="">loading models…</option>}
            {models && Object.entries(models.providers).map(([prov, ids]) => ids.length > 0 && (
              <optgroup key={prov} label={prov === "openai" ? "OpenAI" : "Anthropic (Claude)"}>
                {ids.map((id) => <option key={`${prov}:${id}`} value={`${prov}:${id}`} style={{ color: "#000" }}>{id}</option>)}
              </optgroup>
            ))}
          </select>
          <button style={btn} onClick={testModel} disabled={!modelSel}>Test selected</button>
          <button style={btnBlue} onClick={() => applyModel(modelSel)} disabled={!modelSel || !masterKey}>Use this model</button>
          <button style={btn} onClick={() => { setModelSel(""); applyModel(""); }}>Reset to default</button>
        </div>
        {modelMsg && <div style={{ fontSize: 12.5, fontFamily: "Consolas,monospace", marginTop: 8, color: modelMsg.startsWith("✓") ? "#22c55e" : modelMsg.startsWith("✗") ? "#ef4444" : "#8b98a9" }}>{modelMsg}</div>}
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
          The list is live from each provider&apos;s models API (chat-capable only). &quot;Test selected&quot; makes a real call to exactly that model. Your pick is saved on the server and survives restarts.
        </div>
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
            {chat.map((m, i) => <div key={i} style={{ margin: "4px 0", padding: "6px 10px", borderRadius: 10, fontSize: 13, background: m.role === "user" ? "#2563eb" : "rgba(128,128,128,.15)", color: m.role === "user" ? "#fff" : undefined, alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", marginLeft: m.role === "user" ? "auto" : 0, whiteSpace: "pre-wrap", opacity: m.pending ? 0.75 : 1, fontStyle: m.pending ? "italic" : "normal" }}>{m.text}{m.pending && <span style={{ animation: "blink 1s steps(2) infinite" }}>▍</span>}</div>)}
            <style>{"@keyframes blink{50%{opacity:0}}"}</style>
            <div ref={bottom} />
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button title="Hold to speak (Yiddish or English)" onClick={recording ? stopMic : startMic} style={{ ...btn, background: recording ? "#ef4444" : "transparent", color: recording ? "#fff" : "inherit", border: recording ? "none" : "1px solid rgba(128,128,128,.4)", width: 40, padding: 0, height: 34 }}>{recording ? "■" : "🎤"}</button>
            <select value={micEngine} onChange={(e) => setMicEngine(e.target.value)} title="Transcription engine for the 🎤 — swap to compare" style={{ padding: "7px 8px", borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", fontSize: 12 }}>
              {MIC_ENGINES.map((e) => <option key={e.id} value={e.id} style={{ color: "#000" }}>🎤 {e.label}</option>)}
            </select>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Type, or tap 🎤 to speak…" style={{ flex: 1, padding: "7px 12px", borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", fontSize: 13 }} />
            <button style={btnBlue} onClick={send}>Send</button>
          </div>
          {micMsg && <div style={{ fontSize: 11.5, opacity: 0.7, marginTop: 4 }}>{micMsg}</div>}
          <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>Swap the 🎤 engine to compare OpenAI vs ivrit.ai vs Yiddish Labs (speed + accuracy shown after each). First ivrit.ai call may take ~15–60s while its RunPod worker wakes up.</div>
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

"use client";
/**
 * FloatingAssistant — the always-visible chat bubble in the bottom-right corner
 * of every portal page. This is how regular (non-admin) users reach the agent;
 * admins also have the full control center at /assistant.
 *
 * Talks to the agent service through the nginx /agent-api/ proxy with the same
 * Bearer token as the rest of the portal (identity/tenant come from the JWT
 * server-side). Instant Yiddish/English acknowledgment + typewriter reveal, so
 * there's zero perceived wait while Yiddish Labs translates the real answer.
 *
 * Theming: uses the Connect CSS variables (--bg/--panel/--accent/…) so it looks
 * native in BOTH light and dark mode. No model or vendor names appear anywhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Bot, Send, Mic, X, Plus } from "lucide-react";

type Msg = { id: string; role: "user" | "assistant"; content: string; pending?: boolean };

const ACK_YI = "ביטע ווארט איין רגע בשעת איך טשעק דאס איבער פאר אייך.";
const ACK_EN = "One moment — I'm looking into that for you.";
const isYiddish = (s: string) => /[֐-׿]/.test(s);

// Pages that already have their own full chat — don't overlay the bubble there.
const HIDE_ON = ["/assistant", "/support-chat"];

function token(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}

async function agentPost<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`/agent-api/chat/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`agent ${path} failed: ${res.status}`);
  return res.json();
}

/** Human-friendly name for the current page, for the "sees your page" chip. */
function pageLabel(pathname: string): string {
  const seg = pathname.split("/").filter(Boolean)[0] || "dashboard";
  const map: Record<string, string> = {
    dashboard: "Dashboard",
    voicemail: "Voicemail",
    calls: "Call History",
    chat: "Messages",
    contacts: "Contacts",
    crm: "CRM",
    recordings: "Recordings",
    reports: "Reports",
    billing: "Billing",
    team: "Team",
    sms: "SMS",
    pbx: "Phone System",
    settings: "Settings",
    "yiddish-labs": "Transcripts",
  };
  return map[seg] || seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " ");
}

export function FloatingAssistant() {
  const pathname = usePathname() || "/";
  const [open, setOpen] = useState(false);
  const [showHint, setShowHint] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<any>(null);

  const label = useMemo(() => pageLabel(pathname), [pathname]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  // Auto-dismiss the "Need help?" nudge after a few seconds.
  useEffect(() => {
    const t = setTimeout(() => setShowHint(false), 6000);
    return () => clearTimeout(t);
  }, []);

  const typeOut = useCallback((id: string, full: string) => {
    const step = Math.max(2, Math.round(full.length / 60));
    let i = 0;
    const tick = () => {
      i = Math.min(full.length, i + step);
      const done = i >= full.length;
      const shown = full.slice(0, i);
      setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, content: shown, pending: !done } : msg)));
      if (!done) setTimeout(tick, 16);
    };
    tick();
  }, []);

  const send = useCallback(
    async (raw?: string) => {
      const text = (raw ?? input).trim();
      if (!text || sending) return;
      setSending(true);
      setInput("");
      const ackId = `ack-${Date.now()}`;
      const ack = isYiddish(text) ? ACK_YI : ACK_EN;
      setMessages((m) => [...m, { id: `u-${Date.now()}`, role: "user", content: text }, { id: ackId, role: "assistant", content: ack, pending: true }]);
      try {
        const res = await agentPost<{ conversationId: string; reply: string }>("message", {
          text,
          channel: "chat",
          context: { page: label, path: pathname },
        });
        setConversationId(res.conversationId);
        typeOut(ackId, res.reply);
      } catch {
        setMessages((m) => m.map((msg) => (msg.id === ackId ? { ...msg, content: "Sorry — I couldn't reach the assistant just now. Please try again.", pending: false } : msg)));
      } finally {
        setSending(false);
      }
    },
    [input, sending, typeOut, label, pathname],
  );

  const newChat = useCallback(async () => {
    if (conversationId) {
      try { await agentPost("close", { conversationId }); } catch { /* non-fatal */ }
    }
    setConversationId(null);
    setMessages([]);
  }, [conversationId]);

  // Voice input via the browser's Speech Recognition (client-side, no upload).
  const toggleMic = useCallback(() => {
    const SR = (typeof window !== "undefined" && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;
    if (!SR) return;
    if (listening && recRef.current) { recRef.current.stop(); return; }
    const rec = new SR();
    rec.lang = "he-IL"; // covers Yiddish/Hebrew script; falls back gracefully for English
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e: any) => {
      const t = Array.from(e.results).map((r: any) => r[0].transcript).join("");
      setInput(t);
    };
    rec.onend = () => { setListening(false); recRef.current = null; inputRef.current?.focus(); };
    rec.onerror = () => { setListening(false); recRef.current = null; };
    recRef.current = rec;
    setListening(true);
    rec.start();
  }, [listening]);

  if (HIDE_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  const micAvailable = typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  return (
    <>
      <style>{faCss}</style>

      {open && (
        <div className="fa-panel" role="dialog" aria-label="Assistant">
          <div className="fa-head">
            <div className="fa-avatar"><Bot size={18} /></div>
            <div className="fa-title">
              <b>Assistant</b>
              <small><span className="fa-live" /> Online — here to help</small>
            </div>
            <div className="fa-head-actions">
              <button title="New chat" onClick={newChat}><Plus size={16} /></button>
              <button title="Minimize" onClick={() => setOpen(false)}><X size={16} /></button>
            </div>
          </div>

          <div className="fa-ctx">
            <span className="fa-eye" aria-hidden>👁</span>
            <span>Viewing with you: <b>{label}</b> — ask me anything on this page</span>
          </div>

          <div className="fa-msgs custom-scrollbar">
            {messages.length === 0 && (
              <div className="fa-empty">
                Hi! How can I help? You can type in <b>English</b> or <b>ייִדיש</b>.
              </div>
            )}
            {messages.map((m) => {
              const yi = isYiddish(m.content);
              return (
                <div
                  key={m.id}
                  className={`fa-m ${m.role === "user" ? "fa-user" : "fa-bot"}${yi ? " fa-yi" : ""}${m.pending ? " fa-pending" : ""}`}
                  dir={yi ? "rtl" : "ltr"}
                >
                  {m.content}
                  {m.pending && <span className="fa-caret">▍</span>}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {messages.length === 0 && (
            <div className="fa-quick">
              <button onClick={() => send(`What can I do on the ${label} page?`)}>Help with this page</button>
              <button onClick={() => send("Summarize my new voicemails")}>Summarize voicemails</button>
              <button onClick={() => send("רעד צו מיר אידיש")}>רעד צו מיר אידיש</button>
            </div>
          )}

          <div className="fa-input">
            {micAvailable && (
              <button className={`fa-icon${listening ? " fa-icon-on" : ""}`} title="Speak" onClick={toggleMic}>
                <Mic size={17} />
              </button>
            )}
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
              placeholder={listening ? "Listening…" : "Type or talk…"}
              aria-label="Message"
            />
            <button className="fa-send" title="Send" onClick={() => send()} disabled={sending || !input.trim()}>
              <Send size={16} />
            </button>
          </div>
          <div className="fa-foot">A human is always behind it</div>
        </div>
      )}

      <div className="fa-fab-wrap">
        {!open && showHint && <div className="fa-hint">Need help? I'm right here 👋</div>}
        <button className="fa-fab" title={open ? "Close assistant" : "Open assistant"} onClick={() => { setOpen((v) => !v); setShowHint(false); }}>
          {open ? <X size={24} /> : <Bot size={26} />}
          {!open && <span className="fa-dot" />}
        </button>
      </div>
    </>
  );
}

const faCss = `
.fa-fab-wrap { position: fixed; right: 22px; bottom: 22px; z-index: 1200; display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
.fa-fab {
  width: 58px; height: 58px; border-radius: 50%; border: none; cursor: pointer; position: relative;
  background: var(--accent, #2f6df6); color: #fff;
  box-shadow: 0 8px 26px rgba(0,0,0,.28), 0 2px 8px rgba(0,0,0,.22);
  display: flex; align-items: center; justify-content: center; transition: transform .12s ease;
}
.fa-fab:hover { transform: translateY(-2px); }
.fa-dot { position: absolute; top: 3px; right: 3px; width: 12px; height: 12px; background: #22c55e; border: 2px solid var(--bg, #0d1420); border-radius: 50%; }
.fa-hint {
  background: var(--panel, #16233a); color: var(--text, #cfe0ff); border: 1px solid var(--border, #29406b);
  font-size: 12px; padding: 7px 12px; border-radius: 10px 10px 2px 10px; box-shadow: 0 4px 14px rgba(0,0,0,.25); max-width: 210px;
}

.fa-panel {
  position: fixed; right: 22px; bottom: 92px; z-index: 1199;
  width: 372px; max-width: calc(100vw - 44px); height: 560px; max-height: calc(100vh - 130px);
  background: var(--panel, #0f1928); border: 1px solid var(--border, #23344f); border-radius: 16px;
  box-shadow: 0 24px 60px rgba(0,0,0,.35); display: flex; flex-direction: column; overflow: hidden;
  color: var(--text, #e8ecf3);
}
.fa-head { background: var(--panel-2, #16233a); padding: 12px 14px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border, #23344f); }
.fa-avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--accent, #2f6df6); color: #fff; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
.fa-title { flex: 1; min-width: 0; }
.fa-title b { font-size: 14px; display: block; }
.fa-title small { color: var(--text-dim, #7fd4a2); font-size: 11px; display: flex; align-items: center; gap: 5px; }
.fa-live { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; display: inline-block; }
.fa-head-actions { display: flex; gap: 4px; }
.fa-head-actions button { background: none; border: none; color: var(--text-dim, #8b9ab2); cursor: pointer; padding: 4px; border-radius: 6px; display: flex; }
.fa-head-actions button:hover { background: var(--border, #23344f); color: var(--text, #fff); }

.fa-ctx { padding: 8px 14px; border-bottom: 1px solid var(--border, #1d2a40); display: flex; align-items: center; gap: 8px; background: var(--bg, #0c1626); }
.fa-ctx span { font-size: 11.5px; color: var(--text-dim, #7d95c0); }
.fa-ctx b { color: var(--text, #b9d0f5); font-weight: 600; }

.fa-msgs { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.fa-empty { margin: auto; text-align: center; color: var(--text-dim, #8b9ab2); font-size: 13.5px; line-height: 1.6; padding: 0 18px; }
.fa-m { max-width: 84%; padding: 9px 12px; border-radius: 13px; font-size: 13.5px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
.fa-bot { background: var(--panel-2, #182742); border: 1px solid var(--border, #23344f); align-self: flex-start; border-bottom-left-radius: 4px; }
.fa-user { background: var(--accent, #2f6df6); color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
.fa-yi { font-size: 15px; }
.fa-pending { opacity: .8; font-style: italic; }
.fa-caret { animation: fa-blink 1s steps(2) infinite; }
@keyframes fa-blink { 50% { opacity: 0; } }

.fa-quick { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 12px 10px; }
.fa-quick button { background: var(--panel-2, #14213a); border: 1px solid var(--border, #2a3c5f); color: var(--accent, #a9c2ec); font-size: 11.5px; padding: 6px 10px; border-radius: 999px; cursor: pointer; }
.fa-quick button:hover { filter: brightness(1.08); }

.fa-input { border-top: 1px solid var(--border, #23344f); padding: 10px 12px; display: flex; align-items: center; gap: 8px; background: var(--bg, #0e1826); }
.fa-icon { background: none; border: none; cursor: pointer; color: var(--text-dim, #8b9ab2); padding: 5px; border-radius: 8px; display: flex; }
.fa-icon:hover { background: var(--border, #23344f); }
.fa-icon-on { color: #fff; background: #ef4444; }
.fa-input input { flex: 1; background: var(--panel-2, #16233a); border: 1px solid var(--border, #2a3c5f); color: var(--text, #e8ecf3); border-radius: 999px; padding: 9px 14px; font-size: 13px; outline: none; }
.fa-input input:focus { border-color: var(--accent, #2f6df6); }
.fa-send { background: var(--accent, #2f6df6); border: none; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; color: #fff; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
.fa-send:disabled { opacity: .5; cursor: default; }
.fa-foot { text-align: center; font-size: 10.5px; color: var(--text-dim, #5c6b84); padding: 5px 0 8px; background: var(--bg, #0e1826); }

@media (max-width: 560px) {
  .fa-panel { right: 12px; bottom: 84px; width: calc(100vw - 24px); height: calc(100vh - 110px); }
  .fa-fab-wrap { right: 14px; bottom: 14px; }
}
`;

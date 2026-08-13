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
import { Bot, Send, Mic, X, Plus, Paperclip, Music, FileText } from "lucide-react";
import { AgentGrantConfirmDialog, usePendingGrant } from "./AgentGrantConfirmDialog";

type Msg = { id: string; role: "user" | "assistant"; content: string; pending?: boolean };

type PendingFile = {
  localId: string;
  name: string;
  sizeBytes: number;
  kind: "audio" | "document";
  progress: number; // 0..100
  status: "uploading" | "ready" | "error";
  attachmentId?: string;
  error?: string;
};

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

/**
 * Fire-and-forget button-press beacon → agent audit log. Powers the AI Trainer
 * activity trail ("every press on the button"). Never blocks or breaks the UI.
 */
function uiEvent(name: string): void {
  try {
    void fetch("/agent-api/chat/ui-event", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ name }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* logging must never affect the user */
  }
}

const isAudioFile = (f: File) => /^audio\//i.test(f.type) || /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|wma|aiff?)$/i.test(f.name);
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
// 3 MB raw chunks: base64 (~4 MB) + JSON stays well under nginx's 10 MB
// /agent-api/ body cap on every network in between.
const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** init → chunk×N → finish against the agent's chunked upload endpoints. */
async function uploadFileChunked(file: File, onProgress: (pct: number) => void): Promise<{ id: string; filename: string }> {
  const totalChunks = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_BYTES));
  const init = await agentPost<{ ok: boolean; uploadId?: string }>("upload/init", {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    totalChunks,
  });
  if (!init.ok || !init.uploadId) throw new Error("upload init failed");
  for (let i = 0; i < totalChunks; i++) {
    const slice = file.slice(i * UPLOAD_CHUNK_BYTES, Math.min(file.size, (i + 1) * UPLOAD_CHUNK_BYTES));
    const dataBase64 = await blobToBase64(slice);
    await agentPost<{ ok: boolean }>("upload/chunk", { uploadId: init.uploadId, index: i, dataBase64 });
    onProgress(Math.round(((i + 1) / (totalChunks + 1)) * 100));
  }
  const fin = await agentPost<{ ok: boolean; attachment?: { id: string; filename: string } }>("upload/finish", { uploadId: init.uploadId });
  if (!fin.ok || !fin.attachment) throw new Error("upload finish failed");
  onProgress(100);
  return fin.attachment;
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
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Each mic take gets a serial number; cancelling marks the CURRENT take as
  // discarded so its onstop/late transcription result is thrown away — the
  // only abort path used to be stop-and-upload (owner request 2026-07-27).
  const takeRef = useRef(0);
  const cancelledTakeRef = useRef(-1);
  // A permission the assistant has PREPARED but not applied. It only ever
  // becomes real after the password dialog below, which talks to the API
  // directly — the assistant never sees the password.
  const { grant, refresh: refreshGrant, clear: clearGrant } = usePendingGrant();

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
      const ready = pendingFiles.filter((f) => f.status === "ready" && f.attachmentId);
      const stillUploading = pendingFiles.some((f) => f.status === "uploading");
      let text = (raw ?? input).trim();
      if ((!text && ready.length === 0) || sending || stillUploading) return;
      if (!text) text = `I uploaded: ${ready.map((f) => f.name).join(", ")}`;
      setSending(true);
      uiEvent(ready.length ? `send (${ready.length} attachment(s))` : "send");
      setInput("");
      setPendingFiles([]);
      const ackId = `ack-${Date.now()}`;
      const ack = isYiddish(text) ? ACK_YI : ACK_EN;
      const shownText = ready.length ? `${text}\n📎 ${ready.map((f) => f.name).join(", ")}` : text;
      setMessages((m) => [...m, { id: `u-${Date.now()}`, role: "user", content: shownText }, { id: ackId, role: "assistant", content: ack, pending: true }]);
      try {
        const res = await agentPost<{ conversationId: string; reply: string }>("message", {
          text,
          channel: "chat",
          context: { page: label, path: pathname },
          ...(ready.length ? { attachments: ready.map((f) => f.attachmentId) } : {}),
        });
        setConversationId(res.conversationId);
        typeOut(ackId, res.reply);
        // If that turn prepared a permission change, the confirmation is now
        // waiting on the API. Ask — the assistant is not trusted to say so.
        void refreshGrant();
      } catch {
        setMessages((m) => m.map((msg) => (msg.id === ackId ? { ...msg, content: "Sorry — I couldn't reach the assistant just now. Please try again.", pending: false } : msg)));
      } finally {
        setSending(false);
      }
    },
    [input, sending, typeOut, label, pathname, pendingFiles, refreshGrant],
  );

  /** Drop a line into the transcript from outside the model — e.g. the result
   *  of a permission change, which the assistant never learns about. */
  const sayInChat = useCallback((text: string) => {
    setMessages((m) => [...m, { id: `sys-${Date.now()}`, role: "assistant", content: text }]);
  }, []);

  // A confirmation prepared before a reload is still waiting; pick it up when
  // the panel is opened rather than stranding it.
  useEffect(() => {
    if (open) void refreshGrant();
  }, [open, refreshGrant]);

  // File uploads: pick any documents (MP3s become hold-music candidates), chunk-
  // upload each in the background, then send them with the next message.
  const pickFiles = useCallback(() => fileInputRef.current?.click(), []);
  const onFilesChosen = useCallback((list: FileList | null) => {
    if (!list?.length) return;
    const files = Array.from(list).slice(0, 10);
    for (const file of files) {
      const localId = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const entry: PendingFile = {
        localId,
        name: file.name,
        sizeBytes: file.size,
        kind: isAudioFile(file) ? "audio" : "document",
        progress: 0,
        status: "uploading",
      };
      if (file.size > MAX_UPLOAD_BYTES) {
        setPendingFiles((p) => [...p, { ...entry, status: "error", error: "Too large (max 60 MB)" }]);
        continue;
      }
      setPendingFiles((p) => [...p, entry]);
      uploadFileChunked(file, (pct) => {
        setPendingFiles((p) => p.map((f) => (f.localId === localId ? { ...f, progress: pct } : f)));
      })
        .then((att) => {
          setPendingFiles((p) => p.map((f) => (f.localId === localId ? { ...f, status: "ready", progress: 100, attachmentId: att.id } : f)));
        })
        .catch(() => {
          setPendingFiles((p) => p.map((f) => (f.localId === localId ? { ...f, status: "error", error: "Upload failed" } : f)));
        });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);
  const removePendingFile = useCallback((localId: string) => {
    setPendingFiles((p) => p.filter((f) => f.localId !== localId));
  }, []);

  const newChat = useCallback(async () => {
    if (conversationId) {
      try { await agentPost("close", { conversationId }); } catch { /* non-fatal */ }
    }
    setConversationId(null);
    setMessages([]);
  }, [conversationId]);

  // Voice input: record a short clip in the browser (MediaRecorder), then send
  // it to the server to be transcribed by Yiddish Labs (accurate for American
  // Yiddish, auto-detects English). Click once to start, once again to stop.
  const stopMic = useCallback(() => {
    try { mediaRef.current?.stop(); } catch { /* noop */ }
  }, []);

  /** Abort the current take: nothing is uploaded, nothing lands in the input. */
  const cancelMic = useCallback(() => {
    cancelledTakeRef.current = takeRef.current;
    try { mediaRef.current?.stop(); } catch { /* noop */ }
    setTranscribing(false);
  }, []);

  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      takeRef.current += 1;
      const take = takeRef.current;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        if (cancelledTakeRef.current === take) return; // discarded — never upload
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (blob.size < 400) return; // too short / no audio captured
        setTranscribing(true);
        try {
          const b64 = await new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(blob); });
          const r = await agentPost<{ ok: boolean; text?: string }>("transcribe", { audioBase64: b64, filename: "mic.webm" });
          if (cancelledTakeRef.current !== take && r.ok && r.text) { setInput((v) => (v ? v + " " : "") + r.text); inputRef.current?.focus(); }
        } catch { /* silent — user can type instead */ } finally { setTranscribing(false); }
      };
      mediaRef.current = mr;
      mr.start();
      setRecording(true);
    } catch {
      setRecording(false); // mic permission denied / unavailable
    }
  }, []);

  const toggleMic = useCallback(() => {
    if (recording || transcribing) { stopMic(); return; }
    // Always record the whole clip and let Yiddish Labs auto-detect the language
    // (Yiddish vs English) across the full utterance — never the browser's
    // English-only recogniser, which turns Yiddish speech into gibberish. The
    // community code-switches heavily, so detection must judge the whole clip.
    startMic();
  }, [recording, transcribing, startMic, stopMic]);

  if (HIDE_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  const micAvailable = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof window !== "undefined" && "MediaRecorder" in window;

  return (
    <>
      <style>{faCss}</style>

      {grant && (
        <AgentGrantConfirmDialog
          grant={grant}
          onClose={clearGrant}
          onResult={(msg) => { setOpen(true); sayInChat(msg); }}
        />
      )}

      {open && (
        <div className="fa-panel" role="dialog" aria-label="Assistant">
          <div className="fa-head">
            <div className="fa-avatar"><Bot size={18} /></div>
            <div className="fa-title">
              <b>Assistant</b>
              <small><span className="fa-live" /> Online — here to help</small>
            </div>
            <div className="fa-head-actions">
              <button title="New chat" onClick={() => { uiEvent("new chat"); newChat(); }}><Plus size={16} /></button>
              <button title="Minimize" onClick={() => { uiEvent("minimize"); setOpen(false); }}><X size={16} /></button>
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

          {pendingFiles.length > 0 && (
            <div className="fa-files">
              {pendingFiles.map((f) => (
                <div key={f.localId} className={`fa-file${f.status === "error" ? " fa-file-err" : ""}`}>
                  {f.kind === "audio" ? <Music size={13} /> : <FileText size={13} />}
                  <span className="fa-file-name" title={f.name}>{f.name}</span>
                  {f.status === "uploading" && <span className="fa-file-pct">{f.progress}%</span>}
                  {f.status === "error" && <span className="fa-file-pct">{f.error}</span>}
                  <button title="Remove" onClick={() => removePendingFile(f.localId)}><X size={12} /></button>
                  {f.status === "uploading" && <i className="fa-file-bar" style={{ width: `${f.progress}%` }} />}
                </div>
              ))}
            </div>
          )}

          <div className="fa-input">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => onFilesChosen(e.target.files)}
              aria-label="Attach files"
            />
            <button className="fa-icon" title="Attach files — MP3s can become your hold music" onClick={() => { uiEvent("attach files"); pickFiles(); }} disabled={sending}>
              <Paperclip size={17} />
            </button>
            {micAvailable && (recording || transcribing) && (
              <button className="fa-icon fa-cancel" title="Cancel — discard the recording" onClick={() => { uiEvent("cancel recording"); cancelMic(); }}>
                <X size={17} />
              </button>
            )}
            {micAvailable && (
              <button
                className={`fa-icon${recording ? " fa-icon-on" : ""}`}
                title={recording ? "Stop and transcribe" : "Speak — auto-detects Yiddish or English"}
                onClick={() => { uiEvent(recording ? "stop recording" : "start recording"); toggleMic(); }}
                disabled={transcribing}
              >
                <Mic size={17} />
              </button>
            )}
            {/* A textarea, not an <input>: the keydown always allowed
                Shift+Enter through, but a single-line input physically cannot
                hold a newline, so the trainer's "no Shift+Enter to add one
                line" was right — the handler was ready and the element wasn't.
                Enter still sends; Shift+Enter now actually makes a line. */}
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                  if (inputRef.current) inputRef.current.style.height = "auto";
                }
              }}
              placeholder={recording ? "Recording… mic = use it, ✕ = cancel" : transcribing ? "Transcribing… ✕ to cancel" : "Type or talk…"}
              aria-label="Message"
            />
            <button
              className="fa-send"
              title="Send"
              onClick={() => send()}
              disabled={sending || pendingFiles.some((f) => f.status === "uploading") || (!input.trim() && !pendingFiles.some((f) => f.status === "ready"))}
            >
              <Send size={16} />
            </button>
          </div>
          <div className="fa-foot">A human is always behind it</div>
        </div>
      )}

      <div className="fa-fab-wrap">
        {!open && showHint && <div className="fa-hint">Need help? I'm right here 👋</div>}
        <button className="fa-fab" title={open ? "Close assistant" : "Open assistant"} onClick={() => { uiEvent(open ? "close assistant" : "open assistant"); setOpen((v) => !v); setShowHint(false); }}>
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

.fa-files { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 0; background: var(--bg, #0e1826); border-top: 1px solid var(--border, #23344f); }
.fa-file { position: relative; overflow: hidden; display: flex; align-items: center; gap: 6px; max-width: 100%; background: var(--panel-2, #16233a); border: 1px solid var(--border, #2a3c5f); color: var(--text, #cfe0ff); border-radius: 8px; padding: 5px 8px; font-size: 11.5px; }
.fa-file-err { border-color: rgba(239,68,68,.55); color: #f2b8b8; }
.fa-file-name { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fa-file-pct { color: var(--text-dim, #8b9ab2); font-size: 10.5px; }
.fa-file button { background: none; border: none; color: var(--text-dim, #8b9ab2); cursor: pointer; padding: 1px; display: flex; border-radius: 4px; }
.fa-file button:hover { color: #ef4444; }
.fa-file-bar { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--accent, #2f6df6); transition: width .2s ease; }
.fa-input { border-top: 1px solid var(--border, #23344f); padding: 10px 12px; display: flex; align-items: center; gap: 8px; background: var(--bg, #0e1826); }
.fa-icon { background: none; border: none; cursor: pointer; color: var(--text-dim, #8b9ab2); padding: 5px; border-radius: 8px; display: flex; }
.fa-icon:hover { background: var(--border, #23344f); }
.fa-icon-on { color: #fff; background: #ef4444; animation: fa-pulse 1s ease-in-out infinite; }
@keyframes fa-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,.5); } 50% { box-shadow: 0 0 0 5px rgba(239,68,68,0); } }
.fa-icon:disabled { opacity: .5; cursor: default; }
.fa-cancel { color: #ef4444; border: 1px solid rgba(239,68,68,.45); }
.fa-cancel:hover { background: rgba(239,68,68,.15); }
.fa-input input, .fa-input textarea { flex: 1; background: var(--panel-2, #16233a); border: 1px solid var(--border, #2a3c5f); color: var(--text, #e8ecf3); border-radius: 999px; padding: 9px 14px; font-size: 13px; outline: none; }
.fa-input input:focus, .fa-input textarea:focus { border-color: var(--accent, #2f6df6); }
.fa-input textarea { resize: none; font-family: inherit; line-height: 1.4; max-height: 96px; border-radius: 18px; }
.fa-send { background: var(--accent, #2f6df6); border: none; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; color: #fff; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
.fa-send:disabled { opacity: .5; cursor: default; }
.fa-foot { text-align: center; font-size: 10.5px; color: var(--text-dim, #5c6b84); padding: 5px 0 8px; background: var(--bg, #0e1826); }

@media (max-width: 560px) {
  .fa-panel { right: 12px; bottom: 84px; width: calc(100vw - 24px); height: calc(100vh - 110px); }
  .fa-fab-wrap { right: 14px; bottom: 14px; }
}
`;

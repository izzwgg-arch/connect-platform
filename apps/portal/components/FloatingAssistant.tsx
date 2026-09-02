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
import {
  Bot,
  Send,
  Mic,
  X,
  Plus,
  Paperclip,
  Music,
  FileText,
  Sparkles,
  ChevronRight,
  LifeBuoy,
  ArrowLeft,
  Check,
  Eye,
  Voicemail as VoicemailIcon,
  ListOrdered,
  LayoutPanelTop,
  Languages,
  AlertTriangle,
  Lightbulb,
} from "lucide-react";
import { SUPPORT_REPORT_AREAS, SUPPORT_REPORT_PROBLEM_MIN, FEATURE_SUGGESTION_MIN, assistantGreetingLine } from "@connect/shared";
import { apiGet, apiPost, ApiError, hasBrowserAuthToken } from "../services/apiClient";
import { useAppContext } from "../hooks/useAppContext";
import { AgentGrantConfirmDialog, usePendingGrant } from "./AgentGrantConfirmDialog";

type Msg = { id: string; role: "user" | "assistant" | "staff"; content: string; pending?: boolean };

/** Which screen the panel is showing. The report is a place, not a dialog: it
 *  replaces the panel's body so the customer is never typing into a form that
 *  is floating over the conversation they were just having. The feature
 *  suggestion gets the same treatment for the same reason. */
type PanelView = "chat" | "report" | "sent" | "suggest" | "suggestSent";

/** An update on something the customer reported. `message` is the OpenAI rewrite
 *  that passed the safety gate — the technical report never reaches the browser. */
type SupportUpdate = { id: string; reference: string; message: string; at: string };
type SupportMsg = {
  id: string;
  ticketRef: string | null;
  direction: "to_customer" | "from_customer" | string;
  body: string;
  createdAt: string;
  readAt: string | null;
};

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

/**
 * `docked` = the desktop app's Coworker popover (/desktop/coworker). There the
 * panel IS the window: it starts open, fills the window, has no corner bubble,
 * and Minimize hides the window through the desktop bridge instead of collapsing
 * to a bubble that does not exist in that window.
 */
export function FloatingAssistant({ docked = false }: { docked?: boolean } = {}) {
  const pathname = usePathname() || "/";
  const { user } = useAppContext();
  const [open, setOpen] = useState(docked);
  const [view, setView] = useState<PanelView>("chat");
  const minimize = () => {
    uiEvent("minimize");
    if (docked) {
      const w = window as unknown as { coworkerWidget?: { closeChat?: () => void } };
      try { w.coworkerWidget?.closeChat?.(); } catch { /* not inside the desktop app */ }
      return;
    }
    setOpen(false);
  };

  /**
   * Updates on something they reported: we looked at it, and here is what
   * changed, in plain English. The badge is the whole point — Izzy: "down by the
   * widget, there is a message. Open it, they will test it, and let the agent
   * know if it's good or not."
   *
   * ⛔ Two minutes, not seconds. The lesson from the voicemail flood is that a
   * widget poll runs on every page for every customer forever; this is a note
   * that arrives once a week at most, and nothing about it is urgent.
   */
  const [updates, setUpdates] = useState<SupportUpdate[]>([]);
  const [answering, setAnswering] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Record<string, "fixed" | "not_fixed">>({});

  /**
   * Direct messages from a PERSON at Loopcom support, and the customer's own
   * replies. ⛔ This is the channel the desk's "message the customer" lands in —
   * the old conversation reply reached nobody (nothing polled it, 2026-09-01).
   * Unread ones pop up beside the bubble; reading happens when the panel opens.
   */
  const [supportMsgs, setSupportMsgs] = useState<SupportMsg[]>([]);
  const [readLocally, setReadLocally] = useState<Record<string, true>>({});
  const [msgReply, setMsgReply] = useState("");
  const [msgReplying, setMsgReplying] = useState(false);
  const [msgReplyDone, setMsgReplyDone] = useState(false);

  useEffect(() => {
    // ⛔ Gated on the token: a signed-out tab polling an authenticated route is
    // how an office gets itself auto-banned at nginx (2026-08-17).
    if (!hasBrowserAuthToken()) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await apiGet<{ updates: SupportUpdate[] }>("/support/updates");
        if (!stop) setUpdates(Array.isArray(r?.updates) ? r.updates : []);
      } catch {
        /* transient — the next tick retries, and a badge is not worth an error */
      }
      try {
        const m = await apiGet<{ messages: SupportMsg[] }>("/support/messages");
        if (!stop) setSupportMsgs(Array.isArray(m?.messages) ? m.messages : []);
      } catch {
        /* same rule — a missed poll is a slightly later badge, never an error */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 120000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const unanswered = useMemo(() => updates.filter((u) => !answered[u.id]), [updates, answered]);
  const unreadSupportMsgs = useMemo(
    () => supportMsgs.filter((m) => m.direction === "to_customer" && !m.readAt && !readLocally[m.id]),
    [supportMsgs, readLocally],
  );

  // Opening the panel IS reading them — stamp each once, so the pop-up beside
  // the bubble stands down and the desk can see the message landed.
  useEffect(() => {
    if (!open || view !== "chat" || unreadSupportMsgs.length === 0) return;
    for (const m of unreadSupportMsgs) {
      setReadLocally((r) => ({ ...r, [m.id]: true }));
      void apiPost(`/support/messages/${encodeURIComponent(m.id)}/read`, {}).catch(() => {});
    }
  }, [open, view, unreadSupportMsgs]);

  const sendSupportReply = useCallback(async () => {
    const text = msgReply.trim();
    if (!text || msgReplying) return;
    setMsgReplying(true);
    try {
      const latest = supportMsgs.find((m) => m.direction === "to_customer");
      await apiPost<{ ok: boolean }>("/support/messages/reply", {
        message: text,
        ...(latest ? { replyToId: latest.id } : {}),
      });
      setMsgReply("");
      setMsgReplyDone(true);
      // Show it immediately rather than waiting out the 2-minute poll.
      setSupportMsgs((list) => [
        { id: `local-${Date.now()}`, ticketRef: latest?.ticketRef ?? null, direction: "from_customer", body: text, createdAt: new Date().toISOString(), readAt: null },
        ...list,
      ]);
    } catch {
      /* left in the box so they can try again — a swallowed reply must not LOOK sent */
    } finally {
      setMsgReplying(false);
    }
  }, [msgReply, msgReplying, supportMsgs]);

  const answerUpdate = useCallback(async (id: string, verdict: "fixed" | "not_fixed") => {
    setAnswering(id);
    try {
      await apiPost<{ ok: boolean }>(`/support/updates/${encodeURIComponent(id)}/verdict`, { verdict });
      setAnswered((m) => ({ ...m, [id]: verdict }));
    } catch {
      // Left unanswered on purpose: it stays on screen so they can try again,
      // rather than silently looking like it was recorded when it was not.
    } finally {
      setAnswering(null);
    }
  }, []);
  const [showHint, setShowHint] = useState(true);
  /** Unheard voicemail, so the first suggestion carries a fact rather than a
   *  guess. Null until it answers — the row simply reads without a count. */
  const [unheard, setUnheard] = useState<number | null>(null);
  // ── Report a problem ─────────────────────────────────────────────────────
  const [problem, setProblem] = useState("");
  const [area, setArea] = useState<string>("calls");
  const [urgent, setUrgent] = useState(false);
  const [callback, setCallback] = useState("");
  const [filing, setFiling] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ reference: string; callbackPhone: string; confirmationTexted: boolean } | null>(null);
  // ── Suggest a feature ────────────────────────────────────────────────────
  const [suggestion, setSuggestion] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Support-desk take-over: while true, a PERSON is answering — the widget
  // polls for their replies instead of expecting one from the send response.
  const [takenOver, setTakenOver] = useState(false);
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
  // Re-read on every open so a panel left open overnight is not still saying
  // "Good evening" in the morning.
  const greeting = useMemo(() => assistantGreetingLine(user?.name), [user?.name, open]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  // The unheard count for the opening screen. ⛔ `pageSize: 1` on purpose — we
  // want the COUNT, not the rows. Asking for a full page here would be the
  // voicemail flood again (100 rows fetched every time anyone opens the panel).
  useEffect(() => {
    if (!open || unheard !== null) return;
    let cancelled = false;
    void apiGet<{ unreadTotal?: number }>("/voice/voicemail?folder=inbox&pageSize=1")
      .then((r) => {
        if (!cancelled) setUnheard(Number.isFinite(r?.unreadTotal) ? Number(r.unreadTotal) : null);
      })
      // A missing count is not an error worth showing: the row still works.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, unheard]);

  // Their own number, so the report form starts filled in. Only fetched when
  // the report screen is actually opened.
  useEffect(() => {
    if (view !== "report" || callback) return;
    void apiGet<{ callbackPhone: string | null }>("/support/context")
      .then((r) => {
        if (r?.callbackPhone) setCallback(r.callbackPhone);
      })
      .catch(() => undefined);
  }, [view, callback]);

  // Auto-dismiss the "Need help?" nudge after a few seconds.
  useEffect(() => {
    const t = setTimeout(() => setShowHint(false), 6000);
    return () => clearTimeout(t);
  }, []);

  // Support-desk take-over: while a person holds the conversation, poll for
  // their replies. The messages endpoint reports the flag, so the loop also
  // notices the hand-back and stops itself. Only while the panel is open —
  // a closed widget polls nothing.
  useEffect(() => {
    if (!takenOver || !conversationId || !open) return;
    let stop = false;
    const tick = async () => {
      try {
        const out = await agentPost<{ messages: Array<{ id: string; role: string; content: string }>; humanTakeover?: boolean }>(
          "messages",
          { conversationId },
        );
        if (stop) return;
        setMessages(
          out.messages
            .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "staff")
            .map((m) => ({ id: m.id, role: m.role as Msg["role"], content: m.content })),
        );
        if (out.humanTakeover === false) setTakenOver(false);
      } catch {
        /* transient — next tick retries */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [takenOver, conversationId, open]);

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
        const res = await agentPost<{ conversationId: string; reply: string; humanTakeover?: boolean }>("message", {
          text,
          channel: "chat",
          context: { page: label, path: pathname },
          ...(ready.length ? { attachments: ready.map((f) => f.attachmentId) } : {}),
        });
        setConversationId(res.conversationId);
        if (res.humanTakeover) {
          // A person is handling this — no assistant reply is coming. Drop the
          // waiting bubble; the person's answer arrives via the polling loop.
          setMessages((m) => m.filter((msg) => msg.id !== ackId));
          setTakenOver(true);
        } else {
          typeOut(ackId, res.reply);
        }
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

  const openReport = useCallback(() => {
    uiEvent("open report a problem");
    setReportError(null);
    setView("report");
  }, []);

  const openSuggest = useCallback(() => {
    uiEvent("open suggest a feature");
    setSuggestError(null);
    setView("suggest");
  }, []);

  const backToChat = useCallback(() => {
    setView("chat");
    setReportError(null);
    setSuggestError(null);
  }, []);

  /**
   * File the report. ⛔ This does NOT go through the assistant — it posts
   * straight to the API, which writes the escalation itself. The whole point of
   * the button is that reaching a person must not depend on a model choosing to
   * pass something along.
   */
  const fileReport = useCallback(async () => {
    if (filing) return;
    const text = problem.trim();
    if (text.length < SUPPORT_REPORT_PROBLEM_MIN) {
      setReportError("Please tell us a little more about what's happening.");
      return;
    }
    if (!callback.trim()) {
      setReportError("We need a number to reach you on.");
      return;
    }
    setFiling(true);
    setReportError(null);
    uiEvent(urgent ? "send report (phones down)" : "send report");
    try {
      const res = await apiPost<{ ok: boolean; reference: string; callbackPhone: string; confirmationTexted: boolean }>(
        "/support/report",
        { problem: text, area, urgent, callbackPhone: callback.trim(), page: label },
      );
      setSent({ reference: res.reference, callbackPhone: res.callbackPhone, confirmationTexted: !!res.confirmationTexted });
      setProblem("");
      setUrgent(false);
      setView("sent");
    } catch (e: unknown) {
      // ⛔ `.body`, never `.payload` — `.payload` has never existed on ApiError
      // and silently falls through to the bare error code. This is the one
      // screen a customer reaches when something is already broken; a slug
      // here is the worst possible thing to show them.
      const body = e instanceof ApiError ? (e.body as { message?: string } | undefined) : undefined;
      setReportError(
        body?.message ||
          "We couldn't send that just now. Please call us on (845) 723-1213 and we'll pick it up straight away.",
      );
    } finally {
      setFiling(false);
    }
  }, [filing, problem, callback, area, urgent, label]);

  /**
   * Send the suggestion. ⛔ Straight to the API, never through the assistant —
   * an idea must not depend on a model choosing to pass it along. The API
   * emails it to the Loopcom product inbox; nobody's phone rings for this.
   */
  const sendSuggestion = useCallback(async () => {
    if (suggesting) return;
    const text = suggestion.trim();
    if (text.length < FEATURE_SUGGESTION_MIN) {
      setSuggestError("Please tell us a little more about the feature you'd like.");
      return;
    }
    setSuggesting(true);
    setSuggestError(null);
    uiEvent("send feature suggestion");
    try {
      await apiPost<{ ok: boolean }>("/support/feature-suggestion", { suggestion: text, page: label });
      setSuggestion("");
      setView("suggestSent");
    } catch (e: unknown) {
      // ⛔ `.body`, never `.payload` — same trap as the report form: `.payload`
      // has never existed on ApiError and silently drops the server's sentence.
      const body = e instanceof ApiError ? (e.body as { message?: string } | undefined) : undefined;
      setSuggestError(body?.message || "We couldn't send that just now. Please try again in a minute.");
    } finally {
      setSuggesting(false);
    }
  }, [suggesting, suggestion, label]);

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
    <div className={docked ? "fa-docked" : undefined}>
      <style>{faCss}</style>

      {grant && (
        <AgentGrantConfirmDialog
          grant={grant}
          onClose={clearGrant}
          onResult={(msg) => { setOpen(true); sayInChat(msg); }}
        />
      )}

      {open && view === "report" && (
        <div className="fa-panel" role="dialog" aria-label="Report a problem">
          <div className="fa-head">
            <button className="fa-back" title="Back to the assistant" onClick={backToChat}><ArrowLeft size={18} /></button>
            <div className="fa-title"><b>Report a problem</b></div>
            <div className="fa-head-actions">
              <button title="Minimize" onClick={minimize}><X size={16} /></button>
            </div>
          </div>

          <div className="fa-body custom-scrollbar">
            <p className="fa-lead">This goes straight to a person at Loopcom — not to the assistant.</p>

            <div className="fa-form">
              <div>
                <label className="fa-lbl" htmlFor="fa-problem">What&apos;s happening?</label>
                <textarea
                  id="fa-problem"
                  className="fa-box fa-box-tall"
                  value={problem}
                  onChange={(e) => setProblem(e.target.value)}
                  placeholder="The phone in the front office stopped ringing this morning…"
                  maxLength={2000}
                />
              </div>

              <div>
                <span className="fa-lbl">Where?</span>
                <div className="fa-pills" role="group" aria-label="Where is the problem">
                  {SUPPORT_REPORT_AREAS.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className={`fa-pill${area === a.id ? " fa-pill-on" : ""}`}
                      aria-pressed={area === a.id}
                      onClick={() => setArea(a.id)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className={`fa-toggle${urgent ? " fa-toggle-on" : ""}`}
                aria-pressed={urgent}
                onClick={() => setUrgent((v) => !v)}
              >
                <span className="fa-sw" aria-hidden />
                <span className="fa-row-txt">
                  <b>Our phones are down right now</b>
                  <small>We&apos;ll treat it as urgent</small>
                </span>
                <AlertTriangle size={15} className="fa-warn" />
              </button>

              <div>
                <label className="fa-lbl" htmlFor="fa-callback">Best number to reach you</label>
                <input
                  id="fa-callback"
                  className="fa-box"
                  value={callback}
                  onChange={(e) => setCallback(e.target.value)}
                  placeholder="(845) 555-0134"
                  inputMode="tel"
                  autoComplete="tel"
                />
              </div>

              {reportError && <div className="fa-err" role="alert">{reportError}</div>}
            </div>

            <div className="fa-cta">
              <button className="fa-btn" onClick={() => void fileReport()} disabled={filing}>
                {filing ? "Sending…" : "Send to Loopcom"}
              </button>
              <small>We&apos;ll text you back on this number.</small>
            </div>
          </div>
          <div className="fa-foot">A person from Loopcom is always behind this</div>
        </div>
      )}

      {open && view === "sent" && (
        <div className="fa-panel" role="dialog" aria-label="Report sent">
          <div className="fa-head">
            <button className="fa-back" title="Back to the assistant" onClick={backToChat}><ArrowLeft size={18} /></button>
            <div className="fa-title"><b>Report a problem</b></div>
            <div className="fa-head-actions">
              <button title="Minimize" onClick={minimize}><X size={16} /></button>
            </div>
          </div>
          <div className="fa-done">
            <span className="fa-ring"><Check size={26} /></span>
            <h3>We&apos;ve got it.</h3>
            {/* ⛔ Only promise the text when the text actually went. Saying
                "we'll text you" after the send failed is the kind of small lie
                that turns into "nobody ever got back to me". */}
            <p>
              {sent?.confirmationTexted ? (
                <>Your message reached a person at Loopcom. We&apos;ll text you back on <b>{sent?.callbackPhone}</b>.</>
              ) : (
                <>Your message reached a person at Loopcom. We&apos;ll be in touch on <b>{sent?.callbackPhone}</b>.</>
              )}
            </p>
            <p className="fa-ref">Reference <b>{sent?.reference}</b></p>
            <button className="fa-ghost" onClick={backToChat}>Back to the assistant</button>
          </div>
          <div className="fa-foot">A person from Loopcom is always behind this</div>
        </div>
      )}

      {open && view === "suggest" && (
        <div className="fa-panel" role="dialog" aria-label="Suggest a feature">
          <div className="fa-head">
            <button className="fa-back" title="Back to the assistant" onClick={backToChat}><ArrowLeft size={18} /></button>
            <div className="fa-title"><b>Suggest a feature</b></div>
            <div className="fa-head-actions">
              <button title="Minimize" onClick={minimize}><X size={16} /></button>
            </div>
          </div>

          <div className="fa-body custom-scrollbar">
            <p className="fa-lead">Tell us what you wish Loopcom could do — this goes straight to our team, not to the assistant.</p>

            <div className="fa-form">
              <div>
                <label className="fa-lbl" htmlFor="fa-suggestion">What should we build?</label>
                <textarea
                  id="fa-suggestion"
                  className="fa-box fa-box-tall"
                  value={suggestion}
                  onChange={(e) => setSuggestion(e.target.value)}
                  placeholder="It would be great if I could…"
                  maxLength={2000}
                />
              </div>

              {suggestError && <div className="fa-err" role="alert">{suggestError}</div>}
            </div>

            <div className="fa-cta">
              <button className="fa-btn" onClick={() => void sendSuggestion()} disabled={suggesting}>
                {suggesting ? "Sending…" : "Send to Loopcom"}
              </button>
              <small>Every suggestion is read by a person.</small>
            </div>
          </div>
          <div className="fa-foot">A person from Loopcom is always behind this</div>
        </div>
      )}

      {open && view === "suggestSent" && (
        <div className="fa-panel" role="dialog" aria-label="Suggestion sent">
          <div className="fa-head">
            <button className="fa-back" title="Back to the assistant" onClick={backToChat}><ArrowLeft size={18} /></button>
            <div className="fa-title"><b>Suggest a feature</b></div>
            <div className="fa-head-actions">
              <button title="Minimize" onClick={minimize}><X size={16} /></button>
            </div>
          </div>
          <div className="fa-done">
            <span className="fa-ring"><Check size={26} /></span>
            <h3>Thank you.</h3>
            <p>Your suggestion is on its way to the Loopcom team. The best ideas come from the people using this every day.</p>
            <button className="fa-ghost" onClick={backToChat}>Back to the assistant</button>
          </div>
          <div className="fa-foot">A person from Loopcom is always behind this</div>
        </div>
      )}

      {open && view === "chat" && (
        <div className="fa-panel" role="dialog" aria-label="Assistant">
          <div className="fa-head">
            <div className="fa-avatar"><Sparkles size={17} /></div>
            <div className="fa-title">
              <b>Assistant</b>
              {docked ? <small>Loopcom Coworker · here to help</small> : <small><Eye size={12} /> Looking at {label} with you</small>}
            </div>
            <div className="fa-head-actions">
              <button title="New chat" onClick={() => { uiEvent("new chat"); newChat(); }}><Plus size={16} /></button>
              <button title="Minimize" onClick={minimize}><X size={16} /></button>
            </div>
          </div>

          <div className="fa-msgs custom-scrollbar">
            {messages.length === 0 && (
              <div className="fa-open">
                {supportMsgs.length > 0 && (
                  <div className="fa-sm-card">
                    <div className="fa-upd-top">
                      <span className="fa-upd-ico"><Sparkles size={14} /></span>
                      <b>Messages from Loopcom support</b>
                    </div>
                    <div className="fa-sm-thread">
                      {supportMsgs.slice(0, 6).reverse().map((m) => (
                        <div key={m.id} className={"fa-sm" + (m.direction === "from_customer" ? " fa-sm-mine" : "")}>
                          <span className="fa-sm-who">
                            {m.direction === "from_customer" ? "You" : "Loopcom support"}
                            {m.ticketRef ? ` · ${m.ticketRef}` : ""}
                          </span>
                          {m.body}
                        </div>
                      ))}
                    </div>
                    {msgReplyDone && <div className="fa-sm-sent">Sent — a person at Loopcom will see it.</div>}
                    <div className="fa-sm-replyrow">
                      <input
                        className="fa-sm-input"
                        value={msgReply}
                        placeholder="Reply to support…"
                        disabled={msgReplying}
                        onChange={(e) => { setMsgReply(e.target.value); setMsgReplyDone(false); }}
                        onKeyDown={(e) => (e.key === "Enter" ? void sendSupportReply() : null)}
                      />
                      <button
                        className="fa-sm-send"
                        disabled={msgReplying || !msgReply.trim()}
                        onClick={() => void sendSupportReply()}
                      >
                        Reply
                      </button>
                    </div>
                  </div>
                )}
                {unanswered.map((u) => (
                  <div className="fa-upd" key={u.id}>
                    <div className="fa-upd-top">
                      <span className="fa-upd-ico"><Check size={14} /></span>
                      <b>We looked into what you reported</b>
                    </div>
                    <p className="fa-upd-msg">{u.message}</p>
                    <div className="fa-upd-btns">
                      <button
                        className="fa-upd-yes"
                        disabled={answering === u.id}
                        onClick={() => void answerUpdate(u.id, "fixed")}
                      >
                        Yes, it&apos;s working
                      </button>
                      <button
                        className="fa-upd-no"
                        disabled={answering === u.id}
                        onClick={() => void answerUpdate(u.id, "not_fixed")}
                      >
                        No, still not right
                      </button>
                    </div>
                  </div>
                ))}
                {updates.filter((u) => answered[u.id]).map((u) => (
                  <div className="fa-upd fa-upd-done" key={u.id}>
                    <div className="fa-upd-top">
                      <span className="fa-upd-ico"><Check size={14} /></span>
                      <b>{answered[u.id] === "fixed" ? "Thanks for checking" : "Thanks — we've reopened it"}</b>
                    </div>
                    <p className="fa-upd-msg">
                      {answered[u.id] === "fixed"
                        ? "Glad that's sorted."
                        : "Someone will pick it up from here."}
                    </p>
                  </div>
                ))}
                <div className="fa-greet">
                  <h3>{greeting}</h3>
                  <p>What can I help with?</p>
                </div>
                <div className="fa-rows">
                  <button className="fa-row fa-row-lead" onClick={() => send("Summarize my new voicemails")}>
                    <span className="fa-ico"><VoicemailIcon size={15} /></span>
                    <span className="fa-row-txt">
                      <b>Catch me up on voicemail</b>
                      {/* A real number when we have one; never a made-up one. */}
                      <small>{unheard === null ? "Read out what's waiting" : unheard === 0 ? "Nothing unheard right now" : `${unheard} unheard`}</small>
                    </span>
                    <ChevronRight size={15} className="fa-chev" />
                  </button>
                  <button className="fa-row" onClick={() => send("I want to change my phone menu")}>
                    <span className="fa-ico"><ListOrdered size={15} /></span>
                    <span className="fa-row-txt">
                      <b>Change my phone menu</b>
                      <small>Greeting, options, opening hours</small>
                    </span>
                    <ChevronRight size={15} className="fa-chev" />
                  </button>
                  <button className="fa-row" onClick={() => send(`What can I do on the ${label} page?`)}>
                    <span className="fa-ico"><LayoutPanelTop size={15} /></span>
                    <span className="fa-row-txt">
                      <b>Explain this page</b>
                      <small>What everything on {label} does</small>
                    </span>
                    <ChevronRight size={15} className="fa-chev" />
                  </button>
                  <button className="fa-row" onClick={() => send("רעד צו מיר אידיש")}>
                    <span className="fa-ico"><Languages size={15} /></span>
                    <span className="fa-row-txt fa-row-rtl" dir="rtl">
                      <b>רעד צו מיר אידיש</b>
                      <small>Switch to Yiddish</small>
                    </span>
                    <ChevronRight size={15} className="fa-chev" />
                  </button>
                </div>
              </div>
            )}
            {messages.map((m) => {
              const yi = isYiddish(m.content);
              const staff = m.role === "staff";
              return (
                <div
                  key={m.id}
                  className={`fa-m ${m.role === "user" ? "fa-user" : "fa-bot"}${yi ? " fa-yi" : ""}${m.pending ? " fa-pending" : ""}`}
                  dir={yi ? "rtl" : "ltr"}
                  style={staff ? { borderColor: "var(--success)", boxShadow: "inset 3px 0 0 var(--success)" } : undefined}
                >
                  {staff ? (
                    <span style={{ display: "block", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--success)", marginBottom: 3 }}>
                      Loopcom support · a real person
                    </span>
                  ) : null}
                  {m.content}
                  {m.pending && <span className="fa-caret">▍</span>}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* ⛔ Always available, not only on the opening screen: someone who
              has been going back and forth with the assistant for five minutes
              without getting anywhere is exactly who needs a person. Kept
              visually apart from the assistant's own suggestions so nobody
              mistakes them for more things to ask the AI. Two doors, two
              destinations: a problem pages a person, a suggestion emails the
              product inbox — neither travels through the model. */}
          <div className="fa-help-row">
            <button className="fa-help" onClick={openReport}>
              <span className="fa-ico fa-ico-quiet"><LifeBuoy size={15} /></span>
              <span className="fa-row-txt">
                <b>Report a problem</b>
              </span>
            </button>
            <button className="fa-help" onClick={openSuggest}>
              <span className="fa-ico fa-ico-quiet"><Lightbulb size={15} /></span>
              <span className="fa-row-txt">
                <b>Suggest a feature</b>
              </span>
            </button>
          </div>

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
          <div className="fa-foot">A person from Loopcom is always behind this</div>
        </div>
      )}

      {!docked && (
      <div className="fa-fab-wrap">
        {/* ⛔ A message from a PERSON at support outranks the greeting hint —
            it pops up beside the bubble until the panel is opened. This is the
            notification the old conversation-reply path never had. */}
        {!open && unreadSupportMsgs.length > 0 ? (
          <button
            className="fa-nudge"
            onClick={() => { uiEvent("open support message"); setView("chat"); setOpen(true); setShowHint(false); }}
          >
            <b>Loopcom support sent you a message</b>
            <span>Tap to read and reply</span>
          </button>
        ) : (
          !open && showHint && <div className="fa-hint">Need help? I&apos;m right here 👋</div>
        )}
        <button className="fa-fab" title={open ? "Close assistant" : "Open assistant"} onClick={() => { uiEvent(open ? "close assistant" : "open assistant"); setOpen((v) => !v); setShowHint(false); }}>
          {open ? <X size={24} /> : <Bot size={26} />}
          {!open && unanswered.length + unreadSupportMsgs.length > 0 && (
            <span className="fa-badge">{unanswered.length + unreadSupportMsgs.length}</span>
          )}
          {!open && unanswered.length + unreadSupportMsgs.length === 0 && <span className="fa-dot" />}
        </button>
      </div>
      )}
    </div>
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
.fa-nudge {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; cursor: pointer; text-align: left;
  background: var(--panel, #16233a); color: var(--text, #cfe0ff);
  border: 1px solid var(--accent, #2f6df6); border-radius: 12px 12px 2px 12px;
  padding: 10px 14px; max-width: 240px; box-shadow: 0 8px 24px rgba(0,0,0,.3);
  animation: fa-nudge-in .25s ease;
}
.fa-nudge b { font-size: 12.5px; }
.fa-nudge span { font-size: 11px; color: var(--text-dim, #8fa3c8); }
@keyframes fa-nudge-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .fa-nudge { animation: none; } }
.fa-sm-card {
  background: var(--panel-2, #131f33); border: 1px solid var(--border, #23344f);
  border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px;
}
.fa-sm-thread { display: flex; flex-direction: column; gap: 6px; }
.fa-sm {
  background: var(--panel, #0f1928); border: 1px solid var(--border, #23344f);
  border-radius: 10px; padding: 7px 10px; font-size: 12.5px; line-height: 1.45; white-space: pre-wrap;
  align-self: flex-start; max-width: 95%;
}
.fa-sm-mine { align-self: flex-end; border-color: var(--accent, #2f6df6); }
.fa-sm-who { display: block; font-size: 10.5px; color: var(--text-dim, #8fa3c8); margin-bottom: 2px; }
.fa-sm-sent { font-size: 11.5px; color: var(--success, #22c55e); }
.fa-sm-replyrow { display: flex; gap: 6px; }
.fa-sm-input {
  flex: 1; min-width: 0; background: var(--panel, #0f1928); color: var(--text, #cfe0ff);
  border: 1px solid var(--border, #23344f); border-radius: 8px; padding: 7px 10px; font-size: 12.5px;
}
.fa-sm-send {
  border: none; border-radius: 8px; padding: 7px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
  background: var(--accent, #2f6df6); color: #fff;
}
.fa-sm-send:disabled { opacity: .55; cursor: default; }

.fa-panel {
  position: fixed; right: 22px; bottom: 92px; z-index: 1199;
  width: 372px; max-width: calc(100vw - 44px); height: 560px; max-height: calc(100vh - 130px);
  background: var(--panel, #0f1928); border: 1px solid var(--border, #23344f); border-radius: 16px;
  box-shadow: 0 24px 60px rgba(0,0,0,.35); display: flex; flex-direction: column; overflow: hidden;
  color: var(--text, #e8ecf3);
}
.fa-head { background: var(--panel, #16233a); padding: 12px 14px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border, #23344f); }
.fa-avatar { width: 32px; height: 32px; border-radius: 10px; background: linear-gradient(140deg, var(--accent, #2f6df6), var(--accent-2, #4f7bff)); color: #fff; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
.fa-back { background: none; border: none; color: var(--text-dim, #8b9ab2); cursor: pointer; padding: 4px; border-radius: 7px; display: flex; flex: 0 0 auto; }
.fa-back:hover { background: var(--border, #23344f); color: var(--text, #fff); }
.fa-title { flex: 1; min-width: 0; }
.fa-title b { font-size: 14px; display: block; font-weight: 620; letter-spacing: -.01em; }
.fa-title small { color: var(--text-dim, #8b9ab2); font-size: 11.5px; display: flex; align-items: center; gap: 5px; }
.fa-head-actions { display: flex; gap: 4px; }
.fa-head-actions button { background: none; border: none; color: var(--text-dim, #8b9ab2); cursor: pointer; padding: 4px; border-radius: 6px; display: flex; }
.fa-head-actions button:hover { background: var(--border, #23344f); color: var(--text, #fff); }

.fa-msgs { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }

/* ── opening screen ─────────────────────────────────────────────────────── */
.fa-open { display: flex; flex-direction: column; }
.fa-greet h3 { margin: 4px 0 0; font-size: 18px; font-weight: 650; letter-spacing: -.015em; color: var(--text, #e8ecf3); }
.fa-greet p { margin: 5px 0 0; font-size: 13px; color: var(--text-dim, #8b9ab2); }
.fa-rows { display: flex; flex-direction: column; gap: 7px; margin-top: 18px; }
.fa-row {
  display: flex; align-items: center; gap: 11px; width: 100%; text-align: left;
  padding: 10px 11px; border-radius: 11px; cursor: pointer;
  border: 1px solid var(--border, #23344f); background: var(--panel-2, #182742);
  color: var(--text, #e8ecf3); font: inherit; transition: border-color .12s ease, background .12s ease;
}
.fa-row:hover { border-color: var(--accent, #2f6df6); }
.fa-row-lead { border-color: color-mix(in srgb, var(--accent, #2f6df6) 45%, transparent); }
.fa-ico {
  width: 28px; height: 28px; border-radius: 8px; flex: 0 0 auto;
  background: color-mix(in srgb, var(--accent, #2f6df6) 12%, transparent);
  color: var(--accent, #2f6df6); display: flex; align-items: center; justify-content: center;
}
.fa-ico-quiet { background: color-mix(in srgb, var(--text-dim, #8b9ab2) 14%, transparent); color: var(--text-dim, #8b9ab2); }
.fa-row-txt { flex: 1; min-width: 0; }
.fa-row-txt b { display: block; font-size: 13px; font-weight: 570; }
.fa-row-txt small { display: block; font-size: 11.5px; color: var(--text-dim, #8b9ab2); margin-top: 1px; }
.fa-row-rtl { text-align: right; }
.fa-row-rtl b { font-size: 15px; }
.fa-chev { color: var(--text-dim, #8b9ab2); flex: 0 0 auto; }

/* ── report a problem / suggest a feature ───────────────────────────────── */
.fa-upd {
  margin: 0 12px 10px; padding: 11px 12px; border-radius: 12px;
  border: 1px solid var(--accent); background: color-mix(in srgb, var(--accent) 9%, var(--panel));
}
.fa-upd-done { border-color: var(--border); background: var(--panel-2); }
.fa-upd-top { display: flex; align-items: center; gap: 7px; font-size: 12.5px; margin-bottom: 5px; }
.fa-upd-ico {
  display: inline-flex; align-items: center; justify-content: center;
  width: 19px; height: 19px; border-radius: 50%; background: var(--accent); color: #04121d; flex: 0 0 auto;
}
.fa-upd-msg { margin: 0 0 9px; font-size: 12.5px; line-height: 1.5; color: var(--text); }
.fa-upd-btns { display: flex; gap: 7px; }
.fa-upd-btns button {
  flex: 1; padding: 7px 9px; border-radius: 9px; font-size: 12px; cursor: pointer;
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
}
.fa-upd-btns button:disabled { opacity: .55; cursor: default; }
.fa-upd-yes { border-color: var(--accent) !important; background: var(--accent) !important; color: #04121d !important; font-weight: 600; }
.fa-badge {
  position: absolute; top: -3px; right: -3px; min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: 10px; background: var(--danger); color: #fff; font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center; border: 2px solid var(--bg);
}
.fa-help-row { display: flex; gap: 7px; margin: 0 12px 10px; }
.fa-help {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
  padding: 9px 10px; border-radius: 11px; cursor: pointer;
  border: 1px dashed color-mix(in srgb, var(--text-dim, #8b9ab2) 45%, transparent);
  background: transparent; color: var(--text, #e8ecf3); font: inherit; text-align: left;
}
.fa-help:hover { border-color: var(--text-dim, #8b9ab2); background: color-mix(in srgb, var(--text-dim, #8b9ab2) 8%, transparent); }
.fa-help .fa-row-txt b { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fa-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 14px 12px; display: flex; flex-direction: column; }
.fa-lead { margin: 0 0 14px; font-size: 12.5px; color: var(--text-dim, #8b9ab2); line-height: 1.5; }
.fa-form { display: flex; flex-direction: column; gap: 12px; }
.fa-lbl { display: block; font-size: 11.5px; font-weight: 600; color: var(--text-dim, #8b9ab2); margin-bottom: 6px; }
.fa-box {
  width: 100%; border: 1px solid var(--border, #2a3c5f); background: var(--panel-2, #16233a);
  color: var(--text, #e8ecf3); border-radius: 10px; padding: 10px 11px; font-size: 12.5px;
  font-family: inherit; line-height: 1.45; outline: none;
}
.fa-box:focus { border-color: var(--accent, #2f6df6); }
.fa-box-tall { min-height: 62px; resize: vertical; }
.fa-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.fa-pill {
  font-size: 11.5px; padding: 5px 10px; border-radius: 999px; cursor: pointer; font: inherit;
  font-size: 11.5px; border: 1px solid var(--border, #2a3c5f); background: var(--panel-2, #16233a);
  color: var(--text-dim, #8b9ab2);
}
.fa-pill-on { border-color: var(--accent, #2f6df6); background: color-mix(in srgb, var(--accent, #2f6df6) 12%, transparent); color: var(--accent, #2f6df6); font-weight: 600; }
.fa-toggle {
  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; cursor: pointer;
  padding: 9px 11px; border-radius: 10px; font: inherit; color: var(--text, #e8ecf3);
  border: 1px solid var(--border, #2a3c5f); background: var(--panel-2, #16233a);
}
.fa-toggle-on { border-color: color-mix(in srgb, var(--warning, #f0b655) 55%, transparent); background: color-mix(in srgb, var(--warning, #f0b655) 12%, transparent); }
.fa-sw { width: 30px; height: 18px; border-radius: 999px; flex: 0 0 auto; position: relative; background: color-mix(in srgb, var(--text-dim, #8b9ab2) 35%, transparent); transition: background .14s ease; }
.fa-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--panel, #0f1928); transition: transform .14s ease; }
.fa-toggle-on .fa-sw { background: var(--warning, #f0b655); }
.fa-toggle-on .fa-sw::after { transform: translateX(12px); }
.fa-warn { color: var(--warning, #f0b655); flex: 0 0 auto; opacity: .55; }
.fa-toggle-on .fa-warn { opacity: 1; }
.fa-err { font-size: 12px; color: var(--danger, #ea6068); line-height: 1.45; }
.fa-cta { margin-top: auto; display: flex; flex-direction: column; gap: 7px; padding-top: 14px; }
.fa-btn {
  background: var(--accent, #2f6df6); color: #fff; border: none; border-radius: 10px;
  padding: 11px; font-size: 13.5px; font-weight: 600; cursor: pointer; font-family: inherit;
}
.fa-btn:disabled { opacity: .6; cursor: default; }
.fa-cta small { text-align: center; font-size: 11px; color: var(--text-dim, #8b9ab2); }
.fa-done { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 13px; padding: 0 26px; }
.fa-ring { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--success, #34c27b) 16%, transparent); color: var(--success, #34c27b); }
.fa-done h3 { margin: 0; font-size: 17px; font-weight: 640; letter-spacing: -.012em; }
.fa-done p { margin: 0; font-size: 12.5px; color: var(--text-dim, #8b9ab2); line-height: 1.5; }
.fa-done p b { color: var(--text, #e8ecf3); font-weight: 600; }
.fa-ref { font-size: 11px !important; }
.fa-ghost { border: 1px solid var(--border, #2a3c5f); background: none; border-radius: 999px; padding: 7px 14px; font-size: 12px; color: var(--text-dim, #8b9ab2); cursor: pointer; font-family: inherit; margin-top: 4px; }
.fa-ghost:hover { color: var(--text, #e8ecf3); border-color: var(--text-dim, #8b9ab2); }
.fa-m { max-width: 84%; padding: 9px 12px; border-radius: 13px; font-size: 13.5px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
.fa-bot { background: var(--panel-2, #182742); border: 1px solid var(--border, #23344f); align-self: flex-start; border-bottom-left-radius: 4px; }
.fa-user { background: var(--accent, #2f6df6); color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
.fa-yi { font-size: 15px; }
.fa-pending { opacity: .8; font-style: italic; }
.fa-caret { animation: fa-blink 1s steps(2) infinite; }
@keyframes fa-blink { 50% { opacity: 0; } }


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

/* Docked = the desktop Coworker popover: the panel is the whole window. The head
   doubles as the frameless window's drag handle (its buttons stay clickable). */
.fa-docked .fa-panel { top: 0; left: 0; right: 0; bottom: 0; width: auto; height: auto; max-width: none; max-height: none; border-radius: 0; border: none; box-shadow: none; }
.fa-docked .fa-head { -webkit-app-region: drag; }
.fa-docked .fa-head button { -webkit-app-region: no-drag; }

@media (max-width: 560px) {
  .fa-panel { right: 12px; bottom: 84px; width: calc(100vw - 24px); height: calc(100vh - 110px); }
  .fa-fab-wrap { right: 14px; bottom: 14px; }
}
`;

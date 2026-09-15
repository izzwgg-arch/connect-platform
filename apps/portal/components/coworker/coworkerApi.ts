/**
 * The Coworker workspace talks to the AGENT (/agent-api/…, the portal JWT), exactly
 * like the corner assistant does — chat messages, the chunked file upload, and the
 * workspace's own routes (activity, answer, stop, tasks, log, prefs, voice).
 *
 * ⛔ No path, command or host is ever sent from here to be acted on: files go up as
 * bytes, folders are attached on the computer by the desktop app, and everything the
 * Coworker does on the computer is decided by the desktop app itself.
 */
import type { ActivityEvent } from "./coworkerModel";

export function portalToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  } catch {
    return "";
  }
}

export class AgentError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message || code);
  }
}

async function agent<T>(path: string, body: unknown, init: { method?: "GET" | "POST"; signal?: AbortSignal; keepalive?: boolean } = {}): Promise<T> {
  const method = init.method ?? "POST";
  const res = await fetch(`/agent-api/${path}`, {
    method,
    headers: { ...(method === "POST" ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${portalToken()}` },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: init.signal,
    keepalive: init.keepalive,
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message: string | undefined;
    try { const j = await res.json(); code = j?.error || code; message = j?.message; } catch { /* not json */ }
    throw new AgentError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export type ChatReply = { conversationId: string; reply: string; language: "en" | "yi"; degraded: boolean; humanTakeover?: boolean };

export function sendMessage(input: {
  text: string;
  turnId: string;
  conversationId: string | null;
  newTask: boolean;
  attachments: string[];
  folders: { path: string; name: string; repo: boolean }[];
  path: string;
  channel?: "chat" | "voice";
}): Promise<ChatReply> {
  return agent<ChatReply>("chat/message", {
    text: input.text,
    channel: input.channel ?? "chat",
    turnId: input.turnId,
    ...(input.conversationId && !input.newTask ? { conversationId: input.conversationId } : {}),
    ...(input.newTask ? { newTask: true } : {}),
    ...(input.attachments.length ? { attachments: input.attachments } : {}),
    context: { page: "Coworker", path: input.path, ...(input.folders.length ? { folders: input.folders } : {}) },
  });
}

export function readActivity(turnId: string, after: number, signal?: AbortSignal) {
  return agent<{ events: ActivityEvent[]; done: boolean; lastSeq: number }>("coworker/activity", { turnId, after }, { signal });
}

export function attachToTask(conversationId: string) {
  return agent<{ turnId: string | null }>("coworker/attach", { conversationId });
}

export function answerQuestion(turnId: string, questionId: string, answer: string | null) {
  return agent<{ ok: true }>("coworker/answer", { turnId, questionId, answer });
}

export function stopTurn(turnId: string) {
  return agent<{ ok: true; alreadyDone: boolean }>("coworker/stop", { turnId }, { keepalive: true });
}

export type TaskRow = { id: string; title: string; startedAt: string; status: "OPEN" | "CLOSED"; running: boolean };
export function listTasks() {
  return agent<{ visible: boolean; tasks: TaskRow[] }>("coworker/tasks", {});
}

export type StoredMessage = { id: string; role: string; content: string; createdAt: string };
export function loadMessages(conversationId: string) {
  return agent<{ messages: StoredMessage[]; humanTakeover: boolean }>("chat/messages", { conversationId });
}

export function closeTask(conversationId: string) {
  return agent<{ closed: boolean }>("chat/close", { conversationId }).catch(() => null);
}

export type LogEntry = { at: string; conversationId: string | null; kind: string; label: string; state: string; changed: string | null; tookMs: number | null };
export function readLog(limit = 150) {
  return agent<{ entries: LogEntry[] }>("coworker/log", { limit });
}

export type CoworkerPrefs = {
  memory: string;
  detail: "short" | "detailed";
  phone: boolean;
  email: boolean;
  showSteps: boolean;
  notify: boolean;
  keepHistory: boolean;
  autoSendVoice: boolean;
};
export const DEFAULT_PREFS: CoworkerPrefs = { memory: "", detail: "short", phone: true, email: false, showSteps: true, notify: true, keepHistory: true, autoSendVoice: false };

export function readPrefs() {
  return agent<{ prefs: CoworkerPrefs }>("coworker/prefs", {}).then((r) => ({ ...DEFAULT_PREFS, ...r.prefs }));
}
export function savePrefs(patch: Partial<CoworkerPrefs>) {
  return agent<{ prefs: CoworkerPrefs }>("coworker/prefs", { prefs: patch }).then((r) => ({ ...DEFAULT_PREFS, ...r.prefs }));
}

export function linkStatus() {
  return agent<{ connected: boolean; hostname?: string; profile?: string }>("coworker/status", undefined, { method: "GET" });
}

export async function transcribeVoice(blob: Blob): Promise<{ text: string; language: "en" | "yi"; engine: string }> {
  const b64 = await blobToBase64(blob);
  const r = await agent<{ ok: boolean; text?: string; language?: "en" | "yi"; engine?: string; error?: string }>("coworker/transcribe", {
    audioBase64: b64,
    filename: blob.type.includes("mp4") ? "voice.m4a" : "voice.webm",
  });
  if (!r.ok || !r.text) throw new AgentError(502, r.error || "transcription_unavailable");
  return { text: r.text, language: r.language ?? "en", engine: r.engine ?? "" };
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
// 3 MB raw chunks: base64 (~4 MB) + JSON stays well under nginx's 10 MB /agent-api/ cap.
const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;

/** init → chunk×N → finish against the agent's chunked upload. */
export async function uploadFile(file: File, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<{ id: string; filename: string; kind: string }> {
  if (file.size > MAX_UPLOAD_BYTES) throw new AgentError(413, "file_too_large", `${file.name} is larger than 60 MB.`);
  if (file.size === 0) throw new AgentError(400, "empty_file", `${file.name} is empty.`);
  const totalChunks = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_BYTES));
  const init = await agent<{ ok: boolean; uploadId?: string }>("chat/upload/init", {
    filename: file.name.slice(0, 200) || "file",
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    totalChunks,
  }, { signal });
  if (!init.ok || !init.uploadId) throw new AgentError(400, "upload_init_failed");
  for (let i = 0; i < totalChunks; i++) {
    if (signal?.aborted) throw new AgentError(499, "cancelled");
    const slice = file.slice(i * UPLOAD_CHUNK_BYTES, Math.min(file.size, (i + 1) * UPLOAD_CHUNK_BYTES));
    const dataBase64 = await blobToBase64(slice);
    let tries = 0;
    for (;;) {
      try { await agent("chat/upload/chunk", { uploadId: init.uploadId, index: i, dataBase64 }, { signal }); break; }
      catch (e) { if (++tries >= 3 || signal?.aborted) throw e; await new Promise((r) => setTimeout(r, 400 * tries)); }
    }
    onProgress(Math.round(((i + 1) / (totalChunks + 1)) * 100));
  }
  const fin = await agent<{ ok: boolean; attachment?: { id: string; filename: string; kind: string } }>("chat/upload/finish", { uploadId: init.uploadId }, { signal });
  if (!fin.ok || !fin.attachment) throw new AgentError(400, "upload_finish_failed");
  onProgress(100);
  return fin.attachment;
}

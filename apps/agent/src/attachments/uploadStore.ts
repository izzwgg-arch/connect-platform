/**
 * Chat-widget file uploads — chunked, disk-backed (owner request 2026-07-27).
 *
 * The browser cannot post big files in one request: nginx caps /agent-api/*
 * bodies at 10 MB (and base64 inflates by a third). So the widget slices each
 * file into ~3 MB raw chunks and drives init → chunk×N → finish. Assembled
 * files land under DATA_DIR/chat-uploads/<tenantId>/ and are referenced by id
 * in the very next chat message.
 *
 * Sessions are held in memory + chunk files on disk; they expire after 30
 * minutes and finished attachments are kept for 24 h (the message that uses
 * them is sent seconds after finish). This is deliberately not a document
 * store — audio is forwarded to the API's MOH pipeline, documents are logged
 * for the team.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export const MAX_FILE_BYTES = 60 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNKS = 64;
export const SESSION_TTL_MS = 30 * 60_000;
export const ATTACHMENT_TTL_MS = 24 * 3600_000;

export type AttachmentKind = "audio" | "image" | "document";

export interface ChatAttachment {
  id: string;
  tenantId: string;
  clientUserId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: AttachmentKind;
  path: string;
  createdAt: number;
}

interface UploadSession {
  id: string;
  tenantId: string;
  clientUserId: string | null;
  filename: string;
  mimeType: string;
  declaredBytes: number;
  totalChunks: number;
  received: Set<number>;
  bytes: number;
  dir: string;
  createdAt: number;
}

const AUDIO_MIME_RE = /^audio\//i;
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|wma|aiff?)$/i;
// Only the formats both LLM providers accept as image input. Anything else
// image-ish (tiff, bmp, svg…) stays a plain document — better an honest "I
// can't open that" than a provider 400 mid-conversation.
const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

export function classifyAttachment(filename: string, mimeType: string): AttachmentKind {
  if (AUDIO_MIME_RE.test(mimeType) || AUDIO_EXT_RE.test(filename)) return "audio";
  if (IMAGE_MIME_RE.test(mimeType) || IMAGE_EXT_RE.test(filename)) return "image";
  return "document";
}

export function safeFilename(raw: string): string {
  const base = path.basename(String(raw || "file")).replace(/[^\w.\- ()\[\]]+/g, "_").slice(0, 120);
  return base || "file";
}

export class ChatUploadStore {
  private sessions = new Map<string, UploadSession>();
  private attachments = new Map<string, ChatAttachment>();

  constructor(private rootDir: string) {}

  async init(input: {
    tenantId: string;
    clientUserId: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    totalChunks: number;
  }): Promise<{ uploadId: string } | { error: string }> {
    this.sweep();
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_FILE_BYTES) {
      return { error: "file_too_large" };
    }
    if (!Number.isInteger(input.totalChunks) || input.totalChunks < 1 || input.totalChunks > MAX_CHUNKS) {
      return { error: "bad_chunk_count" };
    }
    const id = crypto.randomUUID();
    const dir = path.join(this.rootDir, "tmp", id);
    await fs.promises.mkdir(dir, { recursive: true });
    this.sessions.set(id, {
      id,
      tenantId: input.tenantId,
      clientUserId: input.clientUserId,
      filename: safeFilename(input.filename),
      mimeType: String(input.mimeType || "application/octet-stream").slice(0, 100),
      declaredBytes: input.sizeBytes,
      totalChunks: input.totalChunks,
      received: new Set(),
      bytes: 0,
      dir,
      createdAt: Date.now(),
    });
    return { uploadId: id };
  }

  async addChunk(input: {
    tenantId: string;
    uploadId: string;
    index: number;
    dataBase64: string;
  }): Promise<{ ok: true; received: number } | { error: string }> {
    const s = this.sessions.get(input.uploadId);
    if (!s || s.tenantId !== input.tenantId) return { error: "upload_not_found" };
    if (!Number.isInteger(input.index) || input.index < 0 || input.index >= s.totalChunks) return { error: "bad_chunk_index" };
    let buf: Buffer;
    try {
      buf = Buffer.from(input.dataBase64.replace(/^data:[^,]+,/, ""), "base64");
    } catch {
      return { error: "bad_chunk_data" };
    }
    if (buf.length === 0 || buf.length > MAX_CHUNK_BYTES) return { error: "bad_chunk_size" };
    if (!s.received.has(input.index)) {
      s.bytes += buf.length;
      if (s.bytes > MAX_FILE_BYTES) return { error: "file_too_large" };
      s.received.add(input.index);
    }
    await fs.promises.writeFile(path.join(s.dir, `${input.index}.part`), buf);
    return { ok: true, received: s.received.size };
  }

  async finish(input: {
    tenantId: string;
    uploadId: string;
  }): Promise<{ ok: true; attachment: ChatAttachment } | { error: string }> {
    const s = this.sessions.get(input.uploadId);
    if (!s || s.tenantId !== input.tenantId) return { error: "upload_not_found" };
    if (s.received.size !== s.totalChunks) return { error: "chunks_missing" };

    const finalDir = path.join(this.rootDir, s.tenantId.replace(/[^\w\-]+/g, "_"));
    await fs.promises.mkdir(finalDir, { recursive: true });
    const finalPath = path.join(finalDir, `${s.id}-${s.filename}`);
    const out = await fs.promises.open(finalPath, "w");
    try {
      for (let i = 0; i < s.totalChunks; i++) {
        const part = await fs.promises.readFile(path.join(s.dir, `${i}.part`));
        await out.write(part);
      }
    } finally {
      await out.close();
    }
    await fs.promises.rm(s.dir, { recursive: true, force: true }).catch(() => void 0);
    this.sessions.delete(s.id);

    const st = await fs.promises.stat(finalPath);
    const attachment: ChatAttachment = {
      id: s.id,
      tenantId: s.tenantId,
      clientUserId: s.clientUserId,
      filename: s.filename,
      mimeType: s.mimeType,
      sizeBytes: st.size,
      kind: classifyAttachment(s.filename, s.mimeType),
      path: finalPath,
      createdAt: Date.now(),
    };
    this.attachments.set(attachment.id, attachment);
    return { ok: true, attachment };
  }

  /** Tenant-scoped attachment lookup for the chat-message leg. */
  get(id: string, tenantId: string): ChatAttachment | null {
    const a = this.attachments.get(id);
    return a && a.tenantId === tenantId ? a : null;
  }

  /** Drop expired sessions (and their chunk dirs) + stale attachment records. */
  sweep(now = Date.now()): void {
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(id);
        void fs.promises.rm(s.dir, { recursive: true, force: true }).catch(() => void 0);
      }
    }
    for (const [id, a] of this.attachments) {
      if (now - a.createdAt > ATTACHMENT_TTL_MS) {
        this.attachments.delete(id);
        void fs.promises.rm(a.path, { force: true }).catch(() => void 0);
      }
    }
  }
}

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  convertToPbxWav,
  contentTypeForFilename,
  sanitizeBaseName,
  sanitizeTenantScope,
} from "./promptStorage";

const execFileAsync = promisify(execFile);

const DEFAULT_ROOT = path.resolve(process.cwd(), "data/crm-voicemail-drops");
const PBX_FORMAT = "wav_pcm_s16le_8k_mono";

export function getCrmVoicemailDropStorageRoot(): string {
  return (process.env.CRM_VOICEMAIL_DROP_STORAGE_DIR || DEFAULT_ROOT).replace(/\/+$/, "");
}

export function resolveCrmVoicemailDropStoragePath(storageKey: string): string {
  const clean = String(storageKey || "").replace(/\\/g, "/");
  if (!clean || clean.includes("..")) throw new Error("invalid_storage_key");
  const root = getCrmVoicemailDropStorageRoot();
  const full = path.resolve(root, clean);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error("invalid_storage_key_scope");
  }
  return full;
}

function signingSecret(): string {
  return (
    process.env.CRM_VOICEMAIL_DROP_URL_SIGNING_SECRET ||
    process.env.PROMPT_URL_SIGNING_SECRET ||
    process.env.MOH_URL_SIGNING_SECRET ||
    process.env.CDR_INGEST_SECRET ||
    "dev-signing-secret"
  ).trim();
}

function safeExt(filename: string, mimeType?: string | null): string {
  const ext = path.extname(filename || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
  if (ext) return ext.slice(0, 12);
  if (mimeType?.includes("mpeg")) return ".mp3";
  if (mimeType?.includes("ogg")) return ".ogg";
  if (mimeType?.includes("mp4")) return ".m4a";
  return ".wav";
}

export function buildPbxFileBaseName(tenantId: string, dropId: string): string {
  const tenant = sanitizeTenantScope(tenantId).toLowerCase();
  const id = sanitizeBaseName(dropId).slice(0, 48);
  return `crm_vm_${tenant}_${id}`.slice(0, 120);
}

export async function writeCrmVoicemailDropAudio(input: {
  tenantId: string;
  dropId: string;
  originalFilename: string;
  originalMimeType?: string | null;
  buffer: Buffer;
}): Promise<{
  originalStorageKey: string;
  pbxStorageKey: string;
  pbxFileBaseName: string;
  pbxFormat: string;
  contentHash: string;
  sizeBytes: number;
  durationSeconds: number | null;
}> {
  if (!input.buffer?.length) throw new Error("empty_audio");
  const tenantScope = sanitizeTenantScope(input.tenantId);
  const dropScope = sanitizeBaseName(input.dropId);
  const dirKey = `tenants/${tenantScope}/${dropScope}`;
  const originalStorageKey = `${dirKey}/original${safeExt(input.originalFilename, input.originalMimeType)}`;
  const pbxStorageKey = `${dirKey}/pbx.wav`;
  const originalPath = resolveCrmVoicemailDropStoragePath(originalStorageKey);
  const pbxPath = resolveCrmVoicemailDropStoragePath(pbxStorageKey);

  await fs.promises.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.promises.writeFile(originalPath, input.buffer);

  const pbxBytes = await convertToPbxWav(input.buffer);
  await fs.promises.mkdir(path.dirname(pbxPath), { recursive: true });
  await fs.promises.writeFile(pbxPath, pbxBytes);

  const durationSeconds = await probeWavDurationSeconds(pbxBytes);
  return {
    originalStorageKey,
    pbxStorageKey,
    pbxFileBaseName: buildPbxFileBaseName(input.tenantId, input.dropId),
    pbxFormat: PBX_FORMAT,
    contentHash: crypto.createHash("sha256").update(pbxBytes).digest("hex"),
    sizeBytes: pbxBytes.length,
    durationSeconds,
  };
}

export async function readCrmVoicemailDropAudio(storageKey: string): Promise<Buffer> {
  return fs.promises.readFile(resolveCrmVoicemailDropStoragePath(storageKey));
}

export async function probeWavDurationSeconds(bytes: Buffer): Promise<number | null> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "crm-vm-drop-probe-"));
  const wavPath = path.join(tmpDir, "audio.wav");
  try {
    await fs.promises.writeFile(wavPath, bytes);
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", wavPath],
      { timeout: 15_000 },
    );
    const n = Number(String(stdout || "").trim());
    return Number.isFinite(n) ? Math.max(1, Math.round(n)) : null;
  } catch {
    return null;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function contentTypeForCrmVoicemailDrop(storageKey: string): string {
  return contentTypeForFilename(storageKey);
}

export function buildSignedCrmVoicemailDropUrl(
  publicBaseUrl: string,
  dropId: string,
  storageKey: string,
  expiresInSec = 600,
): string {
  const exp = Math.floor(Date.now() / 1000) + Math.max(10, expiresInSec);
  const sig = crypto
    .createHmac("sha256", signingSecret())
    .update(`${dropId}:${storageKey}:${exp}`)
    .digest("hex");
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/crm/voicemail-drops/${encodeURIComponent(dropId)}/stream?exp=${exp}&sig=${sig}`;
}

export function verifySignedCrmVoicemailDropUrl(
  dropId: string,
  storageKey: string,
  expRaw: string | undefined,
  sigRaw: string | undefined,
): { ok: true } | { ok: false; reason: "expired" | "invalid" } {
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };
  if (typeof sigRaw !== "string" || sigRaw.length !== 64) return { ok: false, reason: "invalid" };
  const expected = crypto
    .createHmac("sha256", signingSecret())
    .update(`${dropId}:${storageKey}:${exp}`)
    .digest("hex");
  const a = Buffer.from(sigRaw, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };
  return { ok: true };
}

/**
 * Agent chat → hold-music upload door (internal, shared-secret).
 *
 * The AI agent's chat widget lets clients upload MP3s (one track or a playlist)
 * to become hold music. The agent service forwards the assembled files here;
 * this door reuses the exact same pipeline as the portal Assets tab:
 * writeMohFile → ffmpeg transcode (playlist = per-track transcode + concat)
 * → MohAsset row → PBX pull via /voice/moh/sync-manifest.
 *
 * Unlike the portal flow, it ALSO auto-creates the MohProfile pointing at the
 * new connect_* class, because the chat flow's very next step is "set it as
 * the hold music" and profiles are what the M1/M2 capabilities select.
 *
 * This module holds the pure, unit-testable pieces; the route itself is
 * registered in server.ts (it needs the db + storage closures).
 */
import { z } from "zod";

export const AGENT_MOH_UPLOAD_MAX_FILES = 10;
/** Raw (decoded) bytes across all files. Base64 inflates ~4/3, so the route's
 *  bodyLimit must be at least this × 1.34 + JSON overhead. */
export const AGENT_MOH_UPLOAD_MAX_TOTAL_BYTES = 80 * 1024 * 1024;

export const AgentMohUploadRequest = z.object({
  /** Connect tenant id or vital tenant id — resolved server-side (resolveMohTenantId). */
  tenantId: z.string().min(1),
  /** Human profile/playlist name; uniquified server-side on collision. */
  name: z.string().min(1).max(60),
  /** Attribution, e.g. "agent:<conversationId>" or "user:<id>". */
  requestedBy: z.string().max(200).optional(),
  files: z
    .array(
      z.object({
        filename: z.string().min(1).max(200),
        dataBase64: z.string().min(8),
      }),
    )
    .min(1)
    .max(AGENT_MOH_UPLOAD_MAX_FILES),
});
export type AgentMohUploadRequest = z.infer<typeof AgentMohUploadRequest>;

/** Decode + size-guard the uploaded files. Throws on empty or oversized input. */
export function decodeAgentMohUploadFiles(
  files: Array<{ filename: string; dataBase64: string }>,
): Array<{ filename: string; buffer: Buffer }> {
  let total = 0;
  const out: Array<{ filename: string; buffer: Buffer }> = [];
  for (const f of files) {
    const buffer = Buffer.from(f.dataBase64.replace(/^data:[^,]+,/, ""), "base64");
    if (buffer.length < 128) throw new Error(`file_empty:${f.filename}`);
    total += buffer.length;
    if (total > AGENT_MOH_UPLOAD_MAX_TOTAL_BYTES) throw new Error("upload_too_large");
    out.push({ filename: f.filename, buffer });
  }
  return out;
}

/**
 * Pick a profile/class name that collides with nothing the tenant already has.
 * "Party Mix" → "Party Mix 2" → "Party Mix 3" … Comparison is case-insensitive
 * because buildMohClassName lowercases into the class slug anyway.
 */
export function uniquifyMohName(base: string, takenLower: Set<string>): string {
  const clean = base.trim().replace(/\s+/g, " ");
  if (!takenLower.has(clean.toLowerCase())) return clean;
  for (let i = 2; i < 100; i++) {
    const candidate = `${clean} ${i}`;
    if (!takenLower.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error("name_uniquify_exhausted");
}

/** Derive a human profile name from an uploaded filename: strip the extension
 *  and separators, keep it short. "my-holiday_jazz.v2.mp3" → "my holiday jazz v2". */
export function nameFromFilename(filename: string): string {
  const stem = String(filename || "").replace(/\.[a-z0-9]{1,5}$/i, "");
  const clean = stem.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  return (clean || "Uploaded music").slice(0, 60);
}

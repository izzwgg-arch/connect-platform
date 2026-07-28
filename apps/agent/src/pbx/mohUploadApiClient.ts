/**
 * Client for the api service's internal MOH-upload door
 * (POST /internal/agent/moh/upload-asset, shared-secret header, fail-closed).
 *
 * Reads the assembled chat-upload files from the agent's disk and forwards
 * them as base64 JSON (server-to-server inside the compose network — the
 * browser leg is chunked separately). The api side transcodes (playlist =
 * concat), creates the MohAsset AND the MohProfile, and returns the profile
 * so the chat flow can immediately offer "set it now" via pbx.M1/M2.
 */
import * as fs from "node:fs";
import { postInternalApi } from "./internalApiPost";

export interface MohUploadResult {
  profile: { id: string; name: string };
  mohClassName: string;
  tracks: number;
}

export interface MohUploadApiClient {
  upload(input: {
    tenantId: string;
    name: string;
    requestedBy: string;
    files: Array<{ path: string; filename: string }>;
  }): Promise<MohUploadResult>;
}

export function makeMohUploadApiClient(opts: { baseUrl?: string; secret?: string; timeoutMs?: number } = {}): MohUploadApiClient {
  const baseUrl = (opts.baseUrl ?? process.env.AGENT_API_BASE_URL ?? "http://api:3001").replace(/\/$/, "");
  // Generous timeout: multi-track ffmpeg transcode + concat on big files.
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return {
    async upload(input): Promise<MohUploadResult> {
      const secret = (opts.secret ?? process.env.AGENT_INTERNAL_SECRET ?? "").trim();
      if (!secret) throw new Error("moh_upload_secret_unset (AGENT_INTERNAL_SECRET) — fail-closed");
      const files = await Promise.all(
        input.files.map(async (f) => ({
          filename: f.filename,
          dataBase64: (await fs.promises.readFile(f.path)).toString("base64"),
        })),
      );
      const resp = await postInternalApi({
        url: `${baseUrl}/internal/agent/moh/upload-asset`,
        secret,
        body: { tenantId: input.tenantId, name: input.name, requestedBy: input.requestedBy, files },
        timeoutMs,
      });
      const json: any = await resp.json().catch(() => ({}));
      if (!resp.ok || json?.ok !== true) {
        throw new Error(`moh_upload_error status=${resp.status} ${JSON.stringify(json).slice(0, 300)}`);
      }
      return { profile: json.profile, mohClassName: json.mohClassName, tracks: json.tracks };
    },
  };
}

/**
 * pbxPromptPushClient
 *
 * Pushes a normalised IVR prompt audio file from Connect's API server to the
 * PBX-host route-helper service (`vitalpbx-inbound-route-helper.py`). The
 * helper writes the bytes to `/var/lib/asterisk/sounds/custom/<base>.wav`
 * atomically and (when configured) chowns to `asterisk:asterisk` so
 * `Background()` can play the file the next time a caller hits the IVR.
 *
 * Why this client exists:
 *  - All previously-shipped Connect ↔ PBX prompt sync scripts run
 *    PBX → Connect (so the portal can preview VitalPBX's existing
 *    System Recordings). There was no Connect → PBX channel for files
 *    uploaded *through* Connect's UI, so the dialplan's `STAT()` check
 *    always failed and the IVR fell back to the default prompt. This
 *    fixes that gap.
 *  - The helper already runs on every PBX, with auth + audit + atomic
 *    Asterisk writes. Reusing it avoids opening a new privileged daemon.
 *
 * Wire format choice — base64-encoded bytes inside JSON (not multipart):
 *  - The helper's Python http server only knows how to parse JSON bodies
 *    today; adding multipart support would pull in a parser and grow the
 *    attack surface for marginal bandwidth gain.
 *  - After PCM 16-bit 8 kHz mono WAV conversion, every prompt is small
 *    (a 30-second greeting is ~480 KB → ~640 KB base64). Easy to fit in
 *    a single request. The helper enforces a hard cap (16 MB) anyway.
 */

import type { PbxRouteHelperConfig } from "./pbxInboundRouteHelperClient";

export type PromptPushBody = {
  /**
   * Bare basename (no `custom/` prefix, no extension). This becomes
   * `/var/lib/asterisk/sounds/custom/<fileBaseName>.wav` on the PBX.
   */
  fileBaseName: string;
  /** sha256 of the WAV bytes the helper should land on disk. */
  sha256: string;
  /** sizeBytes of the WAV bytes (helper double-checks against decoded length). */
  sizeBytes: number;
  /** Optional context — the helper logs this in its audit trail. */
  tenantSlug?: string | null;
  /** Optional context — the helper logs this. */
  promptRef?: string | null;
  /** Optional context — the helper logs this. */
  requestedBy?: string | null;
};

export type PromptPushResponse = {
  ok: true;
  fileBaseName: string;
  pbxPath: string;
  sha256: string;
  sizeBytes: number;
  /** True when the helper detected a sha match and skipped the rewrite. */
  unchanged?: boolean;
};

export class PromptPushError extends Error {
  httpStatus: number;
  payload: unknown;
  constructor(message: string, httpStatus: number, payload: unknown) {
    super(message);
    this.name = "PromptPushError";
    this.httpStatus = httpStatus;
    this.payload = payload;
  }
}

/**
 * POST the converted WAV bytes to the route-helper. Returns the helper's
 * response (or throws PromptPushError on a 4xx/5xx). 25-second timeout
 * is generous for a sub-megabyte body over LAN.
 */
export async function pushPromptToHelper(
  cfg: PbxRouteHelperConfig,
  meta: PromptPushBody,
  bytes: Buffer,
): Promise<PromptPushResponse> {
  if (!bytes || bytes.length === 0) {
    throw new PromptPushError("empty_bytes", 0, null);
  }
  const body = {
    ...meta,
    bytesB64: bytes.toString("base64"),
  };
  const resp = await fetch(`${cfg.baseUrl}/upload-prompt`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-connect-pbx-helper-secret": cfg.secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await resp.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!resp.ok) {
    const detail = parsed?.error || parsed?.message || text || `HTTP ${resp.status}`;
    throw new PromptPushError(String(detail), resp.status, parsed);
  }
  return parsed as PromptPushResponse;
}

/**
 * Everything that happens to a generated greeting AFTER it exists.
 *
 * Synthesis is the only part that differs between voice providers. Once there
 * are WAV bytes, a greeting is a greeting: it gets a stable filename, is stored
 * tenant-scoped, gets a catalog row marked `source: "generated"`, and is pushed
 * to the PBX so the very next caller hears it. That tail was written once for
 * ElevenLabs and is shared from here rather than copied for Amazon Polly —
 * copying it would mean two versions of the tenant-slug rule, two versions of
 * "a failed push is not a failed generation", and eventually two behaviours.
 *
 * Every failure is returned, not thrown. An uncaught throw becomes Fastify's
 * default 500, whose message is the raw ORM error — and the IVR Studio renders
 * the server's `message` field verbatim to customers.
 */

import crypto from "node:crypto";
import type { Buffer } from "node:buffer";

export interface GeneratedPromptDeps {
  app: any;
  db: any;
  resolvePbxRouteHelperConfig: (pbxInstanceId?: string | null) => any;
  pushPromptToHelper: (cfg: any, body: any, bytes: Buffer) => Promise<unknown>;
  PromptPushError: any;
}

export interface GeneratedPromptInput {
  tenantId: string;
  /** The tenant's NAME — the catalog slug is always derived from it. */
  tenantName: string;
  displayName: string;
  category: string;
  wav: Buffer;
  /** 8000 means the bytes are already exactly what Asterisk wants. */
  sampleRate: number;
  seconds: number;
  /** For the helper's audit trail: "user:<sub>". */
  requestedBy: string;
  /** Which provider made it — logged, so a bad-sounding batch can be traced
   *  back to the source that produced it. */
  provider: string;
  /** Anything else worth putting in the one log line for this generation. */
  logContext?: Record<string, unknown>;
}

export type GeneratedPromptResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: number; error: string; message: string };

/** Mirror of server.ts `toIvrSlug`: catalog rows only line up with the rest of
 *  the prompt catalog (list scoping, PBX prefix matching) when every writer
 *  normalises the tenant name the same way. */
export function toTenantSlug(name: string): string | null {
  const slug = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : null;
}

export async function saveGeneratedPrompt(
  deps: GeneratedPromptDeps,
  input: GeneratedPromptInput,
): Promise<GeneratedPromptResult> {
  const { app, db, resolvePbxRouteHelperConfig, pushPromptToHelper, PromptPushError } = deps;
  const { sanitizeBaseName, writeAndNormalisePromptFile, writePromptFile, readPromptFile } = await import("../promptStorage");

  // 1) A stable, human-readable filename. Two greetings both called "Main" in
  //    one tenant must not fight over a single file on the PBX, so a random
  //    suffix keeps them apart while the name stays recognisable.
  const nameHint = sanitizeBaseName(input.displayName) || "greeting";
  const fileBaseName = `${nameHint}_${crypto.randomBytes(3).toString("hex")}`.slice(0, 60);
  const promptRef = `custom/${fileBaseName}`;

  // 2) Store. At 8 kHz the bytes are already exactly what Asterisk wants, so
  //    skip ffmpeg entirely; at anything else let it do the one downsample.
  let stored: { storageKey: string; sha256: string; sizeBytes: number; contentType: string };
  try {
    const args = {
      tenantScope: input.tenantId,
      baseName: fileBaseName,
      originalFilename: `${fileBaseName}.wav`,
      buffer: input.wav,
    };
    stored = input.sampleRate === 8000 ? await writePromptFile(args) : await writeAndNormalisePromptFile(args);
  } catch (err: any) {
    app.log.error({ err: err?.message, provider: input.provider }, "[GENERATED_PROMPT] storage write failed");
    return {
      ok: false,
      code: 500,
      error: "storage_write_failed",
      message: "The audio was generated but couldn't be saved. Try again.",
    };
  }

  // 3) Catalog row. `source: "generated"` is what tells the UI never to offer a
  //    download; `ownershipConfidence: "manual"` reflects that a person in this
  //    tenant deliberately created it.
  let row: any;
  try {
    row = await db.tenantPbxPrompt.create({
      data: {
        tenantId: input.tenantId,
        // Same normalisation the manual-upload path uses (toIvrSlug in
        // server.ts): the Tenant model has no slug column, so the catalog slug
        // is always derived from the tenant's name.
        tenantSlug: toTenantSlug(input.tenantName),
        promptRef,
        fileBaseName,
        relativePath: promptRef,
        displayName: input.displayName.trim(),
        category: input.category || "greeting",
        source: "generated",
        isActive: true,
        storageKey: stored.storageKey,
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        contentType: stored.contentType,
        syncedAt: new Date(),
        ownershipConfidence: "manual",
      },
    });
  } catch (err: any) {
    app.log.error(
      { err: err?.message, tenantId: input.tenantId, promptRef, provider: input.provider },
      "[GENERATED_PROMPT] catalog write failed",
    );
    return {
      ok: false,
      code: 500,
      error: "catalog_write_failed",
      message: "The audio was generated and saved, but couldn't be added to the recordings list. Try again.",
    };
  }

  // 4) Push to the PBX so the very next caller hears it. A failed push is not a
  //    failed generation — the cron catch-up retries, and the status returned
  //    lets the UI say "saved, installing" rather than "error".
  let pushStatus: "pushed" | "skipped_no_helper" | "failed" = "skipped_no_helper";
  let pushDetail: string | null = null;
  try {
    // Resolve the helper for THIS tenant's PBX instance — calling with none
    // silently falls back to the global helper, which is the wrong box once
    // per-instance helpers are configured.
    const link = await db.tenantPbxLink
      .findFirst({ where: { tenantId: input.tenantId }, select: { pbxInstanceId: true } })
      .catch(() => null);
    const helperCfg = resolvePbxRouteHelperConfig(link?.pbxInstanceId);
    if (helperCfg) {
      const wavBytes = await readPromptFile(stored.storageKey);
      await pushPromptToHelper(
        helperCfg,
        {
          fileBaseName,
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          tenantSlug: row.tenantSlug,
          promptRef,
          requestedBy: input.requestedBy,
        },
        wavBytes,
      );
      pushStatus = "pushed";
    } else {
      pushDetail = "PBX_ROUTE_HELPER_BASE_URL/SECRET not configured — audio will sync on the next cron tick.";
    }
  } catch (err: any) {
    pushStatus = "failed";
    pushDetail =
      err instanceof PromptPushError
        ? `helper_${err.httpStatus}: ${err.message}`
        : `push_error: ${err?.message || String(err)}`;
    app.log.warn({ promptRef, pushDetail, provider: input.provider }, "[GENERATED_PROMPT] PBX push failed; cron will retry");
  }

  app.log.info(
    {
      promptId: row.id,
      tenantId: input.tenantId,
      promptRef,
      provider: input.provider,
      seconds: input.seconds,
      pushStatus,
      ...(input.logContext ?? {}),
    },
    "[GENERATED_PROMPT] greeting generated",
  );

  return {
    ok: true,
    body: {
      ok: true,
      prompt: {
        id: row.id,
        promptRef: row.promptRef,
        displayName: row.displayName,
        category: row.category,
        source: row.source,
        seconds: input.seconds,
        sizeBytes: row.sizeBytes,
        /** The UI keys its download button off this. Generated audio: never. */
        downloadable: false,
        hasAudio: true,
      },
      pbxPush: { status: pushStatus, detail: pushDetail },
    },
  };
}

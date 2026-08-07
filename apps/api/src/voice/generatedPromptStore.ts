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
  /** How this was made, kept so it can be edited later instead of retyped.
   *  The voice fields matter as much as the text: reopening an edit without
   *  them would re-read the greeting in whatever voice happened to be selected,
   *  and callers notice a business changing voice mid-sentence. */
  sourceText?: string | null;
  voiceId?: string | null;
  voiceModel?: string | null;
  voiceSettings?: Record<string, unknown> | null;
  /** Set to REPLACE an existing generated recording rather than add a new one.
   *  The row keeps its id, its promptRef and its filename, so every menu key
   *  pointing at it keeps working and the new audio overwrites the old one on
   *  the PBX under the same name. That is what makes this an edit rather than
   *  "make another one and go re-point everything by hand". */
  replacePromptId?: string | null;
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

/**
 * Which customer a generated recording belongs to.
 *
 * ⛔ THE QUERY STRING IS WHERE IT ACTUALLY ARRIVES. The IVR Studio scopes every
 * call by appending `?tenantId=…` — it has never put the tenant in the body.
 * Both generate routes read the BODY only, so for a super-admin the tenant was
 * always undefined and silently fell back to their own tenant. On 2026-08-06
 * that filed 12 recordings made for a customer under the admin's own account:
 * the Studio, correctly scoped to the customer, showed nothing, and the
 * customer's owner reported them as deleted on reload. Nothing had been
 * deleted, and nothing errored — the greeting was simply made for the wrong
 * company. Read BOTH, and prefer the explicit one.
 *
 * A tenant admin is still pinned to their own tenant whatever they send.
 */
export async function resolveGeneratedPromptTenantId(
  db: any,
  opts: { isSuperAdmin: boolean; bodyTenantId?: string | null; queryTenantId?: string | null; userTenantId?: string | null },
): Promise<string | null> {
  if (!opts.isSuperAdmin) return opts.userTenantId || null;
  const asked = String(opts.bodyTenantId || opts.queryTenantId || "").trim();
  if (!asked) return opts.userTenantId || null;

  // The portal's tenant switcher identifies super-admin picks as `vpbx:<slug>`
  // (same form the prompt LIST accepts). Passing that straight to a findUnique
  // on Tenant.id answers "tenant not found", so resolve it the same way.
  if (asked.startsWith("vpbx:")) {
    const slug = asked.slice(5).toLowerCase();
    const dir = await db.pbxTenantDirectory
      .findFirst({ where: { tenantSlug: { equals: slug, mode: "insensitive" } }, select: { vitalTenantId: true, tenantCode: true } })
      .catch(() => null);
    if (dir) {
      const link = await db.tenantPbxLink
        .findFirst({
          where: { OR: [{ pbxTenantId: dir.vitalTenantId }, { pbxTenantCode: dir.tenantCode || "__never__" }] },
          select: { tenantId: true },
        })
        .catch(() => null);
      if (link?.tenantId) return link.tenantId;
    }
    const byName = await db.tenant
      .findFirst({ where: { name: { equals: slug.replace(/_/g, " "), mode: "insensitive" } }, select: { id: true } })
      .catch(() => null);
    return byName?.id ?? null;
  }
  return asked;
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

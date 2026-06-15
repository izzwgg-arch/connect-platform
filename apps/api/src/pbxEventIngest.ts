/**
 * PBX Observability — Phase 1, Step 1: internal event ingest (pure core).
 *
 * This module holds the *pure* (no-IO) validation, redaction, and dedupe-key
 * logic for the `/internal/pbx-event-ingest` endpoint, so it can be unit-tested
 * without booting Fastify or touching a database.
 *
 * Hard rules (see docs/pbx/connect-pbx-observability-phase1-blueprint.md):
 *  - READ-ONLY observability. This module never writes to the PBX/AstDB/ombutel.
 *  - Disabled unless PBX_EVENT_INGEST_ENABLED is explicitly truthy.
 *  - Secret-authenticated (PBX_EVENT_INGEST_SECRET), same pattern as cdr-ingest.
 *  - Redaction BEFORE persistence — never store SIP secrets, passwords, auth
 *    tokens, or raw credential payloads.
 *  - Idempotent: a deterministic eventKey lets the DB dedupe re-delivered events.
 */

import { createHash } from "crypto";
import { z } from "zod";
import { redactSecretsDeep } from "@connect/shared";

// ─── Configuration / limits ───────────────────────────────────────────────────

/** Env flag that must be truthy for the ingest endpoint to accept writes. */
export const PBX_EVENT_INGEST_FLAG = "PBX_EVENT_INGEST_ENABLED";
/** Env var holding the shared secret for the ingest endpoint. */
export const PBX_EVENT_INGEST_SECRET_ENV = "PBX_EVENT_INGEST_SECRET";

/** Bump when the redaction algorithm changes so stored rows are traceable. */
export const PBX_EVENT_REDACTION_VERSION = 1;

/** Max events accepted in a single batch POST. */
export const PBX_EVENT_MAX_BATCH = 500;
/** Max serialized size (bytes) of one event's redacted metadata before truncation. */
export const PBX_EVENT_MAX_METADATA_BYTES = 8 * 1024;
/** Defensive cap on short structured string fields. */
const MAX_SHORT = 256;
/** Defensive cap on number-ish fields. */
const MAX_NUM = 64;

/** Sources we accept. Phase 1 collectors emit "ami"/"ari"; "cdr"/"system" reserved. */
export const PBX_EVENT_SOURCES = ["ami", "ari", "cdr", "system"] as const;
export type PbxEventSource = (typeof PBX_EVENT_SOURCES)[number];

// ─── Schemas ──────────────────────────────────────────────────────────────────

const shortStr = (max = MAX_SHORT) => z.string().trim().min(1).max(max);

/**
 * One mapped PBX event as sent by the (future) collector. Unknown keys are
 * stripped by zod; arbitrary residual data must go in `metadata` (which is
 * redacted). `.strict()` is intentionally NOT used so collectors can evolve,
 * but every accepted top-level field is explicitly listed and length-capped.
 */
export const pbxEventSchema = z
  .object({
    source: z.enum(PBX_EVENT_SOURCES),
    eventType: shortStr(128),
    occurredAt: z.string().datetime(),
    linkedId: shortStr(MAX_SHORT).nullable().optional(),
    uniqueId: shortStr(MAX_SHORT).nullable().optional(),
    channel: shortStr(MAX_SHORT).nullable().optional(),
    bridgeId: shortStr(MAX_SHORT).nullable().optional(),
    tenantId: shortStr(MAX_SHORT).nullable().optional(),
    tenantSlug: shortStr(MAX_SHORT).nullable().optional(),
    extension: shortStr(MAX_NUM).nullable().optional(),
    did: shortStr(MAX_NUM).nullable().optional(),
    callerNumber: shortStr(MAX_NUM).nullable().optional(),
    calleeNumber: shortStr(MAX_NUM).nullable().optional(),
    pbxInstanceId: shortStr(MAX_SHORT).nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .strip()
  // Require at least one correlation key so events are joinable to a call.
  .refine((e) => !!(e.linkedId || e.uniqueId), {
    message: "at least one of linkedId or uniqueId is required",
  });

export type PbxEventInput = z.infer<typeof pbxEventSchema>;

export const pbxEventBatchSchema = z.object({
  events: z.array(pbxEventSchema).min(1).max(PBX_EVENT_MAX_BATCH),
});

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Returns true only when the ingest endpoint is explicitly enabled. */
export function isPbxEventIngestEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = String(env[PBX_EVENT_INGEST_FLAG] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Deterministic, idempotent dedupe key for an event. Re-delivery of the exact
 * same event (same source/type/correlation/time/channel) collapses to one row
 * via the unique index on PbxEvent.eventKey.
 */
export function computePbxEventKey(e: {
  source: string;
  eventType: string;
  linkedId?: string | null;
  uniqueId?: string | null;
  channel?: string | null;
  occurredAt: string;
}): string {
  const parts = [
    e.source,
    e.eventType,
    e.linkedId ?? "",
    e.uniqueId ?? "",
    e.channel ?? "",
    e.occurredAt,
  ].join("|");
  return createHash("sha256").update(parts).digest("hex");
}

/**
 * Redact arbitrary metadata before storage and cap its serialized size.
 * Uses the shared deep redactor (drops password/secret/token/auth/jwt keys and
 * masks bearer/JWT-like strings). If still too large, it is replaced with a
 * truncation marker rather than stored verbatim.
 */
export function redactPbxEventMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (metadata == null) return null;
  const redacted = redactSecretsDeep(metadata) as Record<string, unknown>;
  let serialized: string;
  try {
    serialized = JSON.stringify(redacted);
  } catch {
    return { _truncated: true, _reason: "unserializable" };
  }
  if (Buffer.byteLength(serialized, "utf8") > PBX_EVENT_MAX_METADATA_BYTES) {
    return {
      _truncated: true,
      _reason: "metadata_too_large",
      _bytes: Buffer.byteLength(serialized, "utf8"),
    };
  }
  return redacted;
}

/** The shape this module produces for DB insertion (matches Prisma PbxEvent). */
export interface NormalizedPbxEvent {
  eventKey: string;
  source: string;
  eventType: string;
  occurredAt: Date;
  linkedId: string | null;
  uniqueId: string | null;
  channel: string | null;
  bridgeId: string | null;
  tenantId: string | null;
  tenantSlug: string | null;
  extension: string | null;
  did: string | null;
  callerNumber: string | null;
  calleeNumber: string | null;
  metadata: Record<string, unknown> | null;
  redactionVersion: number;
  pbxInstanceId: string | null;
}

/**
 * Normalize a *validated* event into a redacted, DB-ready row. Pure: no IO.
 * Assumes the input already passed `pbxEventSchema`.
 */
export function normalizePbxEvent(input: PbxEventInput): NormalizedPbxEvent {
  const occurredAtIso = new Date(input.occurredAt).toISOString();
  return {
    eventKey: computePbxEventKey({
      source: input.source,
      eventType: input.eventType,
      linkedId: input.linkedId ?? null,
      uniqueId: input.uniqueId ?? null,
      channel: input.channel ?? null,
      occurredAt: occurredAtIso,
    }),
    source: input.source,
    eventType: input.eventType,
    occurredAt: new Date(occurredAtIso),
    linkedId: input.linkedId ?? null,
    uniqueId: input.uniqueId ?? null,
    channel: input.channel ?? null,
    bridgeId: input.bridgeId ?? null,
    tenantId: input.tenantId ?? null,
    tenantSlug: input.tenantSlug ?? null,
    extension: input.extension ?? null,
    did: input.did ?? null,
    callerNumber: input.callerNumber ?? null,
    calleeNumber: input.calleeNumber ?? null,
    metadata: redactPbxEventMetadata(input.metadata),
    redactionVersion: PBX_EVENT_REDACTION_VERSION,
    pbxInstanceId: input.pbxInstanceId ?? null,
  };
}

/**
 * Validate + normalize a raw batch body. Pure: returns either the normalized,
 * de-duplicated (by eventKey) rows or a structured error. No IO.
 */
export function normalizePbxEventBatch(
  body: unknown,
):
  | { ok: true; rows: NormalizedPbxEvent[]; received: number; deduped: number }
  | { ok: false; error: string; issues?: unknown } {
  const parsed = pbxEventBatchSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: "invalid_payload", issues: parsed.error.issues };
  }
  const normalized = parsed.data.events.map(normalizePbxEvent);
  // Collapse duplicates within the same batch by eventKey (DB also dedupes).
  const byKey = new Map<string, NormalizedPbxEvent>();
  for (const row of normalized) byKey.set(row.eventKey, row);
  const rows = [...byKey.values()];
  return {
    ok: true,
    rows,
    received: normalized.length,
    deduped: normalized.length - rows.length,
  };
}

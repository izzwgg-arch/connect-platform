/**
 * Telnyx mobile webhooks — POST /webhooks/telnyx/mobile
 *
 * Fail-closed signature verification, same contract as the SignalWire
 * webhook door: no stored public key = refuse, no signature header = refuse,
 * bad signature = refuse, stale timestamp = refuse. Not gated on NODE_ENV.
 *
 * Telnyx signs webhooks with the account's Ed25519 key: headers
 * `telnyx-timestamp` (unix seconds) and `telnyx-signature-ed25519`
 * (base64), signature over `${timestamp}|${rawBody}`. The public key is the
 * one stored beside the API key in AgentSecret `telnyx_credentials`
 * (portal → API Keys → Public Key).
 *
 * Idempotency: every event lands in MobileWebhookEvent first
 * (providerEventId unique — a redelivery becomes status "duplicate" and is
 * NOT reprocessed), then a best-effort state fold updates the SIM mirror.
 * A fold failure marks the row "failed" (Telnyx redelivers; the reconcile
 * sweep also converges state), and 5 failures park it as "dead_letter".
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { SIGNED_WEBHOOK_ROUTE_OPTIONS } from "../telnyx/rawBodyCapture";
import { resolveTelnyxCredentials } from "../telnyx/telnyxCredentials";

const TIMESTAMP_TOLERANCE_SEC = 5 * 60;
const MAX_ATTEMPTS = 5;

/** Wrap a raw 32-byte Ed25519 public key in SPKI DER so node:crypto accepts it. */
export function ed25519KeyFromBase64(publicKeyB64: string): ReturnType<typeof createPublicKey> | null {
  try {
    const raw = Buffer.from(publicKeyB64.trim(), "base64");
    if (raw.length !== 32) return null;
    const prefix = Buffer.from("302a300506032b6570032100", "hex");
    return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

export function verifyTelnyxSignature(input: {
  publicKeyB64: string;
  signatureB64: string;
  timestamp: string;
  rawBody: string | Buffer;
  nowMs?: number;
}): { ok: boolean; reason?: string } {
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
  const now = (input.nowMs ?? Date.now()) / 1000;
  if (Math.abs(now - ts) > TIMESTAMP_TOLERANCE_SEC) return { ok: false, reason: "stale_timestamp" };

  const key = ed25519KeyFromBase64(input.publicKeyB64);
  if (!key) return { ok: false, reason: "bad_public_key" };

  let sig: Buffer;
  try {
    sig = Buffer.from(input.signatureB64.trim(), "base64");
  } catch {
    return { ok: false, reason: "bad_signature_encoding" };
  }
  const body = typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody;
  const message = Buffer.concat([Buffer.from(`${input.timestamp}|`, "utf8"), body]);
  try {
    const ok = cryptoVerify(null, message, key, sig);
    return ok ? { ok: true } : { ok: false, reason: "signature_mismatch" };
  } catch {
    return { ok: false, reason: "verify_error" };
  }
}

/** Fold one verified event into local state. Kept small: the reconcile sweep is the safety net. */
export async function processMobileWebhookEvent(db: any, row: any): Promise<void> {
  const payload: any = row.payload ?? {};
  const data: any = payload?.data ?? payload;
  const inner: any = data?.payload ?? {};
  const simId: string | null = row.telnyxSimId ?? inner?.sim_card_id ?? (String(data?.event_type ?? "").startsWith("sim_card") ? inner?.id : null) ?? null;
  if (!simId) return;

  const patch: any = { lastSyncAt: new Date() };
  if (inner?.status?.value) patch.status = String(inner.status.value);
  if (typeof inner?.esim_installation_status === "string") patch.esimInstallationStatus = inner.esim_installation_status;
  if (typeof inner?.voice_enabled === "boolean") patch.voiceEnabled = inner.voice_enabled;
  if (inner?.msisdn) patch.msisdn = String(inner.msisdn);

  const sim = await db.mobileSim.findUnique({ where: { telnyxSimId: String(simId) }, include: { line: true } });
  if (!sim) return; // unknown SIM: the reconcile sweep imports it with full state
  await db.mobileSim.update({ where: { id: sim.id }, data: patch });

  // Activation detection: an enabled SIM on a pending line makes the line active.
  if (patch.status === "enabled" && sim.line && sim.line.status === "pending_activation") {
    await db.mobileLine.update({
      where: { id: sim.line.id },
      data: { status: "active", activatedAt: sim.line.activatedAt ?? new Date(), needsReconcile: false, reconcileReason: null },
    });
  }
}

export function registerMobileWebhookRoutes(deps: { app: any; db: any }): void {
  const { app, db } = deps;

  app.post("/webhooks/telnyx/mobile", SIGNED_WEBHOOK_ROUTE_OPTIONS, async (req: any, reply: any) => {
    const creds = await resolveTelnyxCredentials(db);
    if (!creds?.publicKey) return reply.code(401).send({ error: "unverifiable" }); // fail closed: no key, no entry

    const signature = String(req.headers["telnyx-signature-ed25519"] ?? "");
    const timestamp = String(req.headers["telnyx-timestamp"] ?? "");
    const rawBody: string | Buffer | undefined = (req as any).rawBody;
    if (!signature || !timestamp || rawBody == null) return reply.code(401).send({ error: "unsigned" });

    const verdict = verifyTelnyxSignature({ publicKeyB64: creds.publicKey, signatureB64: signature, timestamp, rawBody });
    if (!verdict.ok) return reply.code(401).send({ error: "bad_signature" });

    let payload: any = req.body;
    if (payload == null || typeof payload === "string") {
      try {
        payload = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
      } catch {
        return reply.code(400).send({ error: "bad_json" });
      }
    }
    const data: any = payload?.data ?? {};
    const eventId: string | null = data?.id ? String(data.id) : null;
    const eventType: string = String(data?.event_type ?? "unknown");
    const inner: any = data?.payload ?? {};
    const telnyxSimId: string | null = inner?.sim_card_id ?? (eventType.startsWith("sim_card") ? inner?.id ?? null : null);

    let row: any;
    try {
      row = await db.mobileWebhookEvent.create({
        data: {
          providerEventId: eventId,
          eventType,
          occurredAt: data?.occurred_at ? new Date(data.occurred_at) : null,
          payload,
          telnyxSimId: telnyxSimId ? String(telnyxSimId) : null,
          status: "received",
        },
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        // Exactly-once: this event id was already stored (and processed or in
        // flight). Acknowledge so Telnyx stops redelivering.
        await db.mobileWebhookEvent.updateMany({ where: { providerEventId: eventId ?? undefined, status: "received" }, data: {} }).catch(() => undefined);
        return reply.send({ ok: true, duplicate: true });
      }
      return reply.code(500).send({ error: "store_failed" });
    }

    try {
      await processMobileWebhookEvent(db, row);
      await db.mobileWebhookEvent.update({ where: { id: row.id }, data: { status: "processed", processedAt: new Date(), attempts: { increment: 1 } } });
    } catch (err: any) {
      const attempts = (row.attempts ?? 0) + 1;
      await db.mobileWebhookEvent.update({
        where: { id: row.id },
        data: {
          status: attempts >= MAX_ATTEMPTS ? "dead_letter" : "failed",
          error: String(err?.message || err).slice(0, 300),
          attempts: { increment: 1 },
        },
      }).catch(() => undefined);
      // Still 200: the event is stored; state converges via the reconcile
      // sweep. A 5xx would only make Telnyx hammer the door with the same
      // payload we already hold.
    }
    return reply.send({ ok: true });
  });
}

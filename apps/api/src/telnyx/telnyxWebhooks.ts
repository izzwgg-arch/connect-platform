/**
 * Telnyx MESSAGING webhooks → the ONE shared chat ingest (unified messaging
 * Phase 1, 2026-09-16). This is what wires Telnyx into Loopcom Chat — before
 * this file, Telnyx was a bench with zero chat wiring.
 *
 * ONE path, `/webhooks/telnyx/sms`, carries every messaging event of the
 * messaging profile it is configured on:
 *   - `message.received`  → inbound SMS/MMS into the shared ingest
 *     (smsInboundIngest.ts — the same door VoIP.ms and SignalWire use;
 *     providerMessageId arrives fully prefixed `telnyx:<uuid>` so dedupe
 *     against retries and the status stream stays exact).
 *   - `message.finalized` → the delivery receipt. FINAL states only:
 *     "delivered" promotes the message, the failed family stamps it failed.
 *     A late out-of-order `message.sent` must never downgrade a delivered —
 *     the SignalWire status-door rule, kept verbatim.
 *   - anything else       → acknowledged and ignored.
 *
 * AUTH — fail closed, the LoopCom-Mobile Telnyx door's exact contract
 * (loopcomMobile/mobileWebhookRoutes.ts): no stored Ed25519 public key = 401,
 * no signature/timestamp header = 401, bad signature = 401, stale timestamp =
 * 401. The public key lives with the bench credentials
 * (telnyxCredentials.ts, AgentSecret `telnyx_credentials`).
 *
 * ⛔ After auth, the answer is ALWAYS 200: a 5xx makes Telnyx redeliver, and
 * the ingest's own providerMessageId dedupe is what makes any redelivery
 * harmless. An ingest failure is recorded, never propagated.
 *
 * ⛔ The path must be in jwtPublicRouteBypass.ts or the JWT hook 401s before
 * this handler ever runs (403/handler-401 = you reached it; hook-401 = you
 * did not — the twice-shipped trap).
 */
import { getInboundSmsIngest } from "../smsInboundIngest";
import { verifyTelnyxSignature } from "../loopcomMobile/mobileWebhookRoutes";
import { resolveTelnyxCredentials } from "./telnyxCredentials";
import { SIGNED_WEBHOOK_ROUTE_OPTIONS } from "./rawBodyCapture";
import { recordTelnyxEvent } from "./telnyxRoutes";

export const TELNYX_INBOUND_SMS_PATH = "/webhooks/telnyx/sms";

/** Telnyx's per-recipient final failure statuses (message.finalized). */
const FINAL_FAILED = new Set(["sending_failed", "delivery_failed", "undelivered", "failed"]);

export function registerTelnyxWebhookRoutes(deps: { app: any; db: any }): void {
  const { app, db } = deps;

  app.post(TELNYX_INBOUND_SMS_PATH, SIGNED_WEBHOOK_ROUTE_OPTIONS, async (req: any, reply: any) => {
    const creds = await resolveTelnyxCredentials(db).catch(() => null);
    if (!creds?.publicKey) {
      // Fail closed: no key, no entry. (Not gated on NODE_ENV.)
      await recordTelnyxEvent(db, "webhook_refused", { kind: "sms", reason: "no_public_key" }, "system");
      return reply.code(401).send({ error: "unverifiable" });
    }
    const signature = String(req.headers["telnyx-signature-ed25519"] ?? "");
    const timestamp = String(req.headers["telnyx-timestamp"] ?? "");
    const rawBody: string | Buffer | undefined = (req as any).rawBody;
    if (!signature || !timestamp || rawBody == null) {
      await recordTelnyxEvent(db, "webhook_refused", { kind: "sms", reason: "unsigned" }, "system");
      return reply.code(401).send({ error: "unsigned" });
    }
    const verdict = verifyTelnyxSignature({ publicKeyB64: creds.publicKey, signatureB64: signature, timestamp, rawBody });
    if (!verdict.ok) {
      await recordTelnyxEvent(db, "webhook_refused", { kind: "sms", reason: verdict.reason }, "system");
      return reply.code(401).send({ error: "unauthorized", reason: verdict.reason });
    }

    let payload: any = {};
    try {
      payload = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
    } catch {
      // Verified but unparseable — acknowledge so Telnyx stops redelivering.
      return reply.send({ ok: true, note: "unparseable" });
    }
    const eventType = String(payload?.data?.event_type || "");
    const p = payload?.data?.payload ?? {};
    const messageId = p?.id ? String(p.id) : null;

    if (eventType === "message.received") {
      const rawFrom = String(p?.from?.phone_number ?? "");
      const rawTo = String(p?.to?.[0]?.phone_number ?? "");
      const media = Array.isArray(p?.media) ? p.media.map((m: any) => String(m?.url || "")).filter(Boolean) : [];
      let ingestOutcome: string = "no_ingest_registered";
      const ingest = getInboundSmsIngest();
      if (ingest && (rawFrom || rawTo)) {
        try {
          ingestOutcome = await ingest({
            rawFrom,
            rawTo,
            message: String(p?.text ?? ""),
            providerMessageId: messageId ? `telnyx:${messageId}` : null,
            mmsUrls: media,
            payload: p,
            log: req.log,
          });
        } catch (err: any) {
          ingestOutcome = "ingest_failed";
          req.log?.warn?.({ err: String(err?.message || err).slice(0, 300), id: messageId }, "telnyx inbound ingest failed");
        }
      }
      await recordTelnyxEvent(db, "inbound_sms", {
        from: rawFrom || null, to: rawTo || null, id: messageId,
        body: String(p?.text ?? "").slice(0, 1600), mediaCount: media.length, chat: ingestOutcome,
      }, "system");
      return reply.send({ ok: true });
    }

    if (eventType === "message.finalized" && messageId) {
      const status = String(p?.to?.[0]?.status ?? "").toLowerCase();
      const failed = FINAL_FAILED.has(status);
      const delivered = status === "delivered";
      if (delivered || failed) {
        const firstErrCode = Array.isArray(p?.errors) && p.errors[0]?.code != null
          ? `TELNYX_${p.errors[0].code}`
          : "TELNYX_UNDELIVERED";
        // Best-effort: a status write can never fail the webhook.
        await db.connectChatMessage.updateMany({
          where: { smsProviderMessageId: `telnyx:${messageId}`, direction: "OUTBOUND" },
          data: failed
            ? { deliveryStatus: "failed", deliveryError: firstErrCode }
            : { deliveryStatus: "delivered", deliveryError: null },
        }).catch(() => {});
      }
      await recordTelnyxEvent(db, "sms_status", { id: messageId, status }, "system");
      return reply.send({ ok: true });
    }

    // message.sent and every other event: acknowledged, never written.
    return reply.send({ ok: true });
  });
}

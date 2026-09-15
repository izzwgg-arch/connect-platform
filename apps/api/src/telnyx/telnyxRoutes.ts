/**
 * Telnyx evaluation console — the routes behind /apps/telnyx.
 *
 * Purpose (Izzy, 2026-09-15): "create a new page inside Loopcom called Telnyx
 * and wire the whole API in, so if we want to, I can switch between
 * SignalWire, [VoIP.ms], and Telnyx." The third carrier bench, built to the
 * same contract as /apps/signalwire: every carrier job has a panel here that
 * does it on Telnyx, so each can be proven with the result on record — before
 * onboarding, chat, billing SMS or the PBX trunk are pointed anywhere new.
 *
 * Why Telnyx matters for the pivot: SignalWire signs outbound at STIR/SHAKEN
 * attestation C until their vetting grants better (seen live 2026-08-18,
 * "carriers are filtering it"); Telnyx's documented behaviour is attestation A
 * for any number on the account (purchased or ported), automatically, and the
 * CDR carries the attestation each call actually got — which this bench reads
 * back (the Detail records panel).
 *
 * ⛔ Platform owner only (SUPER_ADMIN), every route. It spends real money
 * (buying a number, sending a text) against the platform's own account, and it
 * creates durable objects on that account. There is deliberately no permission
 * key that can grant it — same rule as SignalWire and IVR Migration.
 *
 * ⛔ Nothing here touches VoIP.ms, `GlobalVoipMsConfig`, `TenantSmsNumber`,
 * onboarding, the worker or the PBX. A number bought here lives on Telnyx and
 * in the event log; it is not assigned to any tenant and rings no PBX until a
 * person wires it.
 *
 * ⛔ Every mutating action is written to `AgentAuditLog` under `telnyx.*`
 * (never a module variable — the api restarts dozens of times a day, and the
 * point of a test bench is the record). The console's "Events" panel reads
 * them back. Secrets (the API key) are never written there.
 *
 * No public webhooks yet — Telnyx pushes state via Ed25519-signed webhooks,
 * but nothing subscribes until a webhook door is built with the same
 * fail-closed signature gate the SignalWire /webhooks/* paths have.
 *
 * Registered from server.ts, which passes in the pieces that live there.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  describeTelnyxCredentials,
  resolveTelnyxCredentials,
  storeTelnyxCredentials,
  validateTelnyxCredentials,
  type StoredTelnyxCredentials,
} from "./telnyxCredentials";
import {
  TelnyxError,
  checkConnection,
  checkPortability,
  createMeetingSession,
  createMessagingProfile,
  createPortingOrderDraft,
  getMeetingSession,
  listConnections,
  listEmailDomains,
  listMessagingProfiles,
  listNumbers,
  listOutboundProfiles,
  listPortingOrders,
  listRcsAgents,
  listVoiceDetailRecords,
  lookupNumber,
  orderNumber,
  releaseNumber,
  searchNumbers,
  sendEmail,
  sendMessage,
  sendRcsMessage,
  setCnamListing,
  updateNumber,
} from "./telnyxClient";

export interface TelnyxRouteDeps {
  app: any;
  db: any;
  /** Resolves the caller and enforces platform-owner access, or replies. */
  requireOwner: (req: any, reply: any) => Promise<any | undefined>;
}

/** Event names written to AgentAuditLog. The console filters on the prefix. */
export const TX_EVENT_PREFIX = "telnyx.";

const E164 = /^\+1\d{10}$/;

function toE164(v: unknown): string | null {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Audit row — the record of the evaluation. Never pass a secret in `payload`. */
export async function recordTelnyxEvent(db: any, event: string, payload: Record<string, unknown>, actor = "owner"): Promise<void> {
  const body = { actor, event: `${TX_EVENT_PREFIX}${event}`, ts: new Date().toISOString(), payload };
  try {
    await db.agentAuditLog.create({
      data: {
        actor: body.actor,
        event: body.event,
        payload: body.payload,
        hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      },
    });
  } catch {
    // The record must never fail the action it records.
  }
}

/** Route-level failure → plain English + the provider's own detail. */
function sendFailure(reply: any, err: unknown, fallback: string) {
  if (err instanceof TelnyxError) {
    return reply.code(err.status >= 400 && err.status < 600 ? err.status : 502).send({
      error: err.code,
      message: err.userMessage,
      detail: err.detail ?? null,
    });
  }
  const msg = String((err as any)?.message || err || fallback);
  return reply.code(500).send({ error: "telnyx_failed", message: `${fallback} (${msg.slice(0, 200)})` });
}

export function registerTelnyxRoutes(deps: TelnyxRouteDeps): void {
  const { app, db, requireOwner } = deps;

  async function requireCreds(reply: any): Promise<StoredTelnyxCredentials | null> {
    const creds = await resolveTelnyxCredentials(db);
    if (!creds) {
      reply.code(409).send({ error: "not_configured", message: "Telnyx isn't set up yet — save the API key first." });
      return null;
    }
    return creds;
  }

  // ── Status ────────────────────────────────────────────────────────────────
  app.get("/admin/apps/telnyx/status", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const described = await describeTelnyxCredentials(db);
    if (!described.configured) return reply.send({ ...described, connection: null });
    const creds = (await resolveTelnyxCredentials(db))!;
    const connection = await checkConnection(creds);
    return reply.send({ ...described, connection });
  });

  // ── Credentials ───────────────────────────────────────────────────────────
  app.put("/admin/apps/telnyx/credentials", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = z.object({
      apiKey: z.string().optional(),
      publicKey: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    // Blank API key = remove everything (the same "empty means clear"
    // convention the SignalWire / ElevenLabs / Polly credentials use).
    if (!String(body.data.apiKey ?? "").trim()) {
      try {
        await storeTelnyxCredentials(db, null, `user:${user.sub}`);
      } catch {
        return reply.code(500).send({ error: "clear_failed", message: "Couldn't remove the credentials. Try again." });
      }
      await recordTelnyxEvent(db, "credentials_cleared", {}, `user:${user.sub}`);
      return reply.send({ ok: true, cleared: true });
    }

    const checked = validateTelnyxCredentials(body.data);
    if (!checked.ok) return reply.code(400).send({ error: "invalid_credentials", message: checked.message });
    try {
      await storeTelnyxCredentials(db, checked.value, `user:${user.sub}`);
    } catch (err: any) {
      const missing = String(err?.message || "").includes("credentials_master_key_missing");
      return reply.code(500).send({
        error: "store_failed",
        message: missing
          ? "The credential store isn't available (CREDENTIALS_MASTER_KEY is not set on the api). The key was NOT saved."
          : "Couldn't save the credentials. Try again.",
      });
    }
    // Only a masked hint ever reaches the audit row — never the key itself.
    const keyHint = `…${checked.value.apiKey.slice(-4)}`;
    const publicKeySet = Boolean(checked.value.publicKey);
    await recordTelnyxEvent(db, "credentials_saved", { keyHint, publicKeySet }, `user:${user.sub}`);
    const connection = await checkConnection(checked.value);
    return reply.send({ ok: true, connection });
  });

  // ── Number search ─────────────────────────────────────────────────────────
  app.get("/admin/apps/telnyx/numbers/search", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const q = req.query ?? {};
    const areaCode = String(q.areaCode ?? "").replace(/\D/g, "").slice(0, 3) || undefined;
    const contains = String(q.contains ?? "").trim() || undefined;
    const locality = String(q.locality ?? "").trim() || undefined;
    const state = String(q.state ?? "").trim().toUpperCase().slice(0, 2) || undefined;
    const numberType = q.numberType === "toll_free" ? "toll_free" as const : "local" as const;
    try {
      const started = Date.now();
      const results = await searchNumbers(creds, { areaCode, contains, locality, state, numberType, limit: 20 });
      return reply.send({ ok: true, results, tookMs: Date.now() - started });
    } catch (err) {
      return sendFailure(reply, err, "The number search failed.");
    }
  });

  // ── Buying a number ⛔ real money, never retried ───────────────────────────
  app.post("/admin/apps/telnyx/numbers/order", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const number = toE164(req.body?.number);
    if (!number || !E164.test(number)) {
      return reply.code(400).send({ error: "invalid_number", message: "That doesn't look like a US number (+1 and 10 digits)." });
    }
    const connectionId = String(req.body?.connectionId ?? "").trim() || null;
    try {
      const result = await orderNumber(creds, number, connectionId);
      await recordTelnyxEvent(db, "number_ordered", { number, connectionId, orderId: result.orderId, status: result.status }, `user:${user.sub}`);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      await recordTelnyxEvent(db, "number_order_failed", { number, message: err instanceof TelnyxError ? err.userMessage : String(err) }, `user:${user.sub}`);
      return sendFailure(reply, err, "The purchase did not complete. If Telnyx timed out it MAY still have gone through — refresh the owned list before trying again.");
    }
  });

  // ── Owned numbers ─────────────────────────────────────────────────────────
  app.get("/admin/apps/telnyx/numbers", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      return reply.send({ ok: true, numbers: await listNumbers(creds) });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't list the account's numbers.");
    }
  });

  // Point a number at a SIP connection / stamp tags + customer reference.
  app.patch("/admin/apps/telnyx/numbers/:id", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const id = String(req.params?.id ?? "").trim();
    if (!id) return reply.code(400).send({ error: "invalid_id", message: "Missing number id." });
    const body = z.object({
      connectionId: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      customerReference: z.string().nullable().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    try {
      await updateNumber(creds, id, body.data);
      await recordTelnyxEvent(db, "number_updated", { id, ...body.data }, `user:${user.sub}`);
      return reply.send({ ok: true });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't update that number.");
    }
  });

  // Outbound CNAM listing (free; ≤15 chars; the per-customer name lever).
  app.put("/admin/apps/telnyx/numbers/:id/cnam", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const id = String(req.params?.id ?? "").trim();
    const enabled = Boolean(req.body?.enabled);
    const details = String(req.body?.details ?? "").trim();
    if (enabled && !/^[A-Za-z0-9 ]{1,15}$/.test(details)) {
      return reply.code(400).send({ error: "invalid_cnam", message: "The caller name must be 1–15 letters, digits or spaces (that is the CNAM limit)." });
    }
    try {
      await setCnamListing(creds, id, enabled, details || null);
      await recordTelnyxEvent(db, "cnam_updated", { id, enabled, details: enabled ? details.toUpperCase() : null }, `user:${user.sub}`);
      return reply.send({ ok: true });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't update the caller name listing.");
    }
  });

  // ⛔ Releases the number back to Telnyx.
  app.delete("/admin/apps/telnyx/numbers/:id", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const id = String(req.params?.id ?? "").trim();
    if (!id) return reply.code(400).send({ error: "invalid_id", message: "Missing number id." });
    try {
      await releaseNumber(creds, id);
      await recordTelnyxEvent(db, "number_released", { id }, `user:${user.sub}`);
      return reply.send({ ok: true });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't release that number.");
    }
  });

  // ── SIP connections + outbound profiles (read-only) ───────────────────────
  app.get("/admin/apps/telnyx/sip", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const [connections, profiles] = await Promise.all([
      listConnections(creds).then((v) => ({ ok: true as const, value: v })).catch((e) => ({ ok: false as const, error: e instanceof TelnyxError ? e.userMessage : String((e as any)?.message || e) })),
      listOutboundProfiles(creds).then((v) => ({ ok: true as const, value: v })).catch((e) => ({ ok: false as const, error: e instanceof TelnyxError ? e.userMessage : String((e as any)?.message || e) })),
    ]);
    return reply.send({ ok: true, connections, profiles });
  });

  // ── Portability check (free, no side effects at Telnyx) ───────────────────
  app.post("/admin/apps/telnyx/portability-check", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const raw: unknown[] = Array.isArray(req.body?.numbers) ? req.body.numbers : [req.body?.numbers];
    const numbers = raw.map(toE164).filter((n): n is string => Boolean(n)).slice(0, 20);
    if (!numbers.length) return reply.code(400).send({ error: "invalid_numbers", message: "Give at least one US number to check." });
    try {
      const results = await checkPortability(creds, numbers);
      await recordTelnyxEvent(db, "portability_checked", { numbers, results: results.map((r) => ({ n: r.number, portable: r.portable, fast: r.fastPortable, carrier: r.carrier })) }, `user:${user.sub}`);
      return reply.send({ ok: true, results });
    } catch (err) {
      return sendFailure(reply, err, "The portability check failed.");
    }
  });

  // ── SMS send ⛔ real money, never retried ─────────────────────────────────
  app.post("/admin/apps/telnyx/sms/send", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const from = toE164(req.body?.from);
    const to = toE164(req.body?.to);
    const text = String(req.body?.body ?? "").trim().slice(0, 1000);
    if (!from || !to || !text) {
      return reply.code(400).send({ error: "invalid_sms", message: "Need a From number on this account, a To number, and a message." });
    }
    try {
      const result = await sendMessage(creds, from, to, text);
      await recordTelnyxEvent(db, "sms_sent", { from, to, chars: text.length, messageId: result.id }, `user:${user.sub}`);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      await recordTelnyxEvent(db, "sms_send_failed", { from, to, message: err instanceof TelnyxError ? err.userMessage : String(err) }, `user:${user.sub}`);
      return sendFailure(reply, err, "The message did not send. An unregistered local number is usually 10DLC, not a bug.");
    }
  });

  // ── Detail records — the attestation proof ────────────────────────────────
  app.get("/admin/apps/telnyx/detail-records", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      return reply.send({ ok: true, records: await listVoiceDetailRecords(creds, Number(req.query?.limit ?? 20) || 20) });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't read the call records.");
    }
  });

  // ── Number lookup (pennies per query) ─────────────────────────────────────
  app.get("/admin/apps/telnyx/lookup", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const number = toE164(req.query?.number);
    if (!number) return reply.code(400).send({ error: "invalid_number", message: "Give a US number to look up." });
    try {
      const result = await lookupNumber(creds, number);
      await recordTelnyxEvent(db, "number_looked_up", { number, carrier: result.carrier, lineType: result.lineType }, `user:${user.sub}`);
      return reply.send({ ok: true, result });
    } catch (err) {
      return sendFailure(reply, err, "The lookup failed.");
    }
  });

  // ── Messaging profiles ────────────────────────────────────────────────────
  app.get("/admin/apps/telnyx/messaging-profiles", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      return reply.send({ ok: true, profiles: await listMessagingProfiles(creds) });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't list the messaging profiles.");
    }
  });

  app.post("/admin/apps/telnyx/messaging-profiles", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const name = String(req.body?.name ?? "").trim().slice(0, 80);
    if (!name) return reply.code(400).send({ error: "invalid_name", message: "Give the profile a name." });
    try {
      const result = await createMessagingProfile(creds, name);
      await recordTelnyxEvent(db, "messaging_profile_created", { name, id: result.id }, `user:${user.sub}`);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't create the messaging profile.");
    }
  });

  // ── RCS ───────────────────────────────────────────────────────────────────
  app.get("/admin/apps/telnyx/rcs/agents", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      return reply.send({ ok: true, agents: await listRcsAgents(creds) });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't list the RCS agents. (An account with no registered agent answers an empty list or 404 — registration comes first.)");
    }
  });

  // ⛔ Real money, never retried. Needs a LAUNCHED agent + a messaging profile.
  app.post("/admin/apps/telnyx/rcs/send", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const agentId = String(req.body?.agentId ?? "").trim();
    const messagingProfileId = String(req.body?.messagingProfileId ?? "").trim();
    const to = toE164(req.body?.to);
    const text = String(req.body?.body ?? "").trim().slice(0, 1000);
    const smsFallbackFrom = toE164(req.body?.smsFallbackFrom) || null;
    if (!agentId || !messagingProfileId || !to || !text) {
      return reply.code(400).send({ error: "invalid_rcs", message: "Need an RCS agent, a messaging profile, a To number and a message." });
    }
    try {
      const result = await sendRcsMessage(creds, { agentId, to, messagingProfileId, text, smsFallbackFrom });
      await recordTelnyxEvent(db, "rcs_sent", { agentId, to, chars: text.length, deliveredAs: result.deliveredAs, messageId: result.id }, `user:${user.sub}`);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      await recordTelnyxEvent(db, "rcs_send_failed", { agentId, to, message: err instanceof TelnyxError ? err.userMessage : String(err) }, `user:${user.sub}`);
      return sendFailure(reply, err, "The RCS message did not send. Until the agent is LAUNCHED with the carriers, only invited test devices can receive.");
    }
  });

  // ── Email ─────────────────────────────────────────────────────────────────
  app.get("/admin/apps/telnyx/email/domains", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      return reply.send({ ok: true, domains: await listEmailDomains(creds) });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't list the email sending domains.");
    }
  });

  // ⛔ Real money (fractions of a cent), never retried.
  app.post("/admin/apps/telnyx/email/send", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const from = String(req.body?.from ?? "").trim();
    const to = String(req.body?.to ?? "").trim();
    const subject = String(req.body?.subject ?? "").trim().slice(0, 200);
    const text = String(req.body?.body ?? "").trim().slice(0, 5000);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || !subject || !text) {
      return reply.code(400).send({ error: "invalid_email", message: "Need a From on a verified sending domain, a To, a subject and a body." });
    }
    try {
      const result = await sendEmail(creds, { from, to, subject, text });
      await recordTelnyxEvent(db, "email_sent", { from, to, subject: subject.slice(0, 80), messageId: result.id }, `user:${user.sub}`);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      return sendFailure(reply, err, "The email did not send. The From address must be on a verified sending domain (Email → domains).");
    }
  });

  // ── Porting orders ────────────────────────────────────────────────────────
  app.get("/admin/apps/telnyx/porting-orders", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      return reply.send({ ok: true, orders: await listPortingOrders(creds) });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't list the porting orders.");
    }
  });

  // Creates a DRAFT only — free, files nothing, moves nothing. ⛔ There is
  // deliberately NO submit route: submitting a port changes a customer's
  // carrier and stays an owner-in-the-dashboard act until Izzy asks otherwise.
  app.post("/admin/apps/telnyx/porting-orders", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const raw: unknown[] = Array.isArray(req.body?.numbers) ? req.body.numbers : [req.body?.numbers];
    const numbers = raw.map(toE164).filter((n): n is string => Boolean(n)).slice(0, 20);
    if (!numbers.length) return reply.code(400).send({ error: "invalid_numbers", message: "Give at least one US number for the draft." });
    const customerReference = String(req.body?.customerReference ?? "").trim().slice(0, 80) || null;
    try {
      const result = await createPortingOrderDraft(creds, numbers, customerReference);
      await recordTelnyxEvent(db, "porting_draft_created", { numbers, customerReference, orderIds: result.ids }, `user:${user.sub}`);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't create the draft porting order.");
    }
  });

  // ── Meeting API (beta) ⛔ costs ~$0.02/min while the bot is in the meeting ─
  app.post("/admin/apps/telnyx/meetings", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const meetingUrl = String(req.body?.meetingUrl ?? "").trim();
    if (!/^https:\/\/\S+$/.test(meetingUrl)) {
      return reply.code(400).send({ error: "invalid_meeting_url", message: "Give the meeting's https link (Zoom, Google Meet, Teams or Webex)." });
    }
    try {
      const result = await createMeetingSession(creds, meetingUrl);
      await recordTelnyxEvent(db, "meeting_bot_started", { meetingUrl, sessionId: result.id, status: result.status }, `user:${user.sub}`);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't send the meeting bot. The Meeting API is beta — a refusal here is Telnyx gating, not a bug.");
    }
  });

  app.get("/admin/apps/telnyx/meetings/:id", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      return reply.send({ ok: true, session: await getMeetingSession(creds, String(req.params?.id ?? "")) });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't read that meeting session.");
    }
  });

  // ── Events (the record of the evaluation) ─────────────────────────────────
  app.get("/admin/apps/telnyx/events", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const limit = Math.min(Math.max(Number(req.query?.limit ?? 50) || 50, 1), 200);
    const rows = await db.agentAuditLog.findMany({
      where: { event: { startsWith: TX_EVENT_PREFIX } },
      orderBy: { ts: "desc" },
      take: limit,
      select: { id: true, ts: true, actor: true, event: true, payload: true },
    });
    return reply.send({ events: rows.map((r: any) => ({ ...r, event: String(r.event).slice(TX_EVENT_PREFIX.length) })) });
  });
}

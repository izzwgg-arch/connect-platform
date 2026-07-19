/**
 * SMS / WhatsApp channel (PLAN.md §5). Inbound message → phone identity →
 * conversation engine (channel=sms|whatsapp) → reply via Twilio. Like email,
 * an unverified sender never gets a tenant guessed — it's declined.
 *
 * The Twilio transport (send + inbound signature verification) is a thin adapter
 * added when Twilio creds exist; this class processes an already-parsed inbound
 * message so it's fully unit-testable and transport-free.
 */
import type { ConversationEngine, ChatContext } from "../conversation/engine";
import type { IdentityResolver } from "./identity";
import type { AuditLog } from "../audit/audit";

export type MessagingChannel = "sms" | "whatsapp";

export interface InboundMessage {
  from: string; // E.164 phone (WhatsApp arrives as "whatsapp:+1..." — normalized by caller)
  text: string;
  channel: MessagingChannel;
  messageSid?: string;
}

export interface OutboundMessage {
  to: string;
  text: string;
  channel: MessagingChannel;
}

export interface MessagingTransport {
  send(msg: OutboundMessage): Promise<{ sent: boolean; reason?: string }>;
}

/** No-op transport used until Twilio creds are present. */
export class NullMessagingTransport implements MessagingTransport {
  async send(): Promise<{ sent: boolean; reason?: string }> {
    return { sent: false, reason: "twilio_not_configured" };
  }
}

export function normalizeWhatsAppFrom(raw: string): string {
  return raw.replace(/^whatsapp:/i, "").trim();
}

export class MessagingChannelHandler {
  constructor(
    private engine: ConversationEngine,
    private identity: IdentityResolver,
    private transport: MessagingTransport,
    private audit: AuditLog,
  ) {}

  async handleInbound(msg: InboundMessage): Promise<{ handled: boolean; reply?: OutboundMessage; reason?: string }> {
    const from = normalizeWhatsAppFrom(msg.from);
    const id = await this.identity.byPhone(from);
    if (!id) {
      await this.audit.record({ actor: "system", event: "messaging.unknown_sender", payload: { from, channel: msg.channel } });
      return { handled: false, reason: "unknown_sender" };
    }
    const ctx: ChatContext = { tenantId: id.tenantId, clientUserId: id.clientUserId, role: id.role, channel: msg.channel };
    const res = await this.engine.handleMessage(ctx, msg.text);
    await this.audit.record({ actor: id.role, event: "messaging.handled", tenantId: id.tenantId, conversationId: res.conversationId, payload: { channel: msg.channel, from } });

    const reply: OutboundMessage = { to: from, text: res.reply, channel: msg.channel };
    await this.transport.send(reply);
    return { handled: true, reply };
  }
}

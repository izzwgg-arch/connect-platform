/**
 * Email channel (PLAN.md §5). Inbound support email → identity resolution →
 * conversation engine (channel=email) → reply via SMTP. The IMAP transport is
 * a thin adapter added when mailbox creds exist; this class handles a single
 * already-parsed inbound message so it's fully unit-testable and transport-free.
 *
 * Unknown sender → we do NOT guess a tenant. We record and (optionally) send a
 * polite "we couldn't match your address" bounce; nothing is acted on.
 */
import type { ConversationEngine, ChatContext } from "../conversation/engine";
import type { IdentityResolver } from "./identity";
import type { Notifier } from "../notify/notifier";
import type { AuditLog } from "../audit/audit";

export interface InboundEmail {
  from: string;
  subject?: string;
  text: string;
  messageId?: string;
}

export interface EmailReply {
  to: string;
  subject: string;
  text: string;
}

export class EmailChannel {
  constructor(
    private engine: ConversationEngine,
    private identity: IdentityResolver,
    private notifier: Notifier,
    private audit: AuditLog,
  ) {}

  async handleInbound(mail: InboundEmail): Promise<{ handled: boolean; reply?: EmailReply; reason?: string }> {
    const id = await this.identity.byEmail(mail.from);
    if (!id) {
      await this.audit.record({ actor: "system", event: "email.unknown_sender", payload: { from: mail.from } });
      return { handled: false, reason: "unknown_sender" };
    }
    const ctx: ChatContext = { tenantId: id.tenantId, clientUserId: id.clientUserId, role: id.role, channel: "email" };
    const body = `${mail.subject ? mail.subject + "\n\n" : ""}${mail.text}`.trim();
    const res = await this.engine.handleMessage(ctx, body);
    await this.audit.record({ actor: id.role, event: "email.handled", tenantId: id.tenantId, conversationId: res.conversationId, payload: { from: mail.from, degraded: res.degraded } });

    const reply: EmailReply = {
      to: id.email ?? mail.from,
      subject: mail.subject ? `Re: ${mail.subject}` : "Re: your support request",
      text: `${res.reply}\n\n— Connect Support`,
    };
    // Send via the notifier's transport (best-effort; queues to audit if no SMTP).
    await this.notifier.send({ kind: "test", to: [reply.to], subject: reply.subject, text: reply.text });
    return { handled: true, reply };
  }
}

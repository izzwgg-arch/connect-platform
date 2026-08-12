/**
 * Notifier — email on every action, approval requests, escalations, digests
 * (PLAN.md §13). SMS (Twilio) hook lands in Phase 3.
 * Degrades gracefully: without SMTP creds it queues to the audit log only and
 * warns — it never blocks or crashes the caller.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { AgentConfig } from "../config";
import type { AuditLog } from "../audit/audit";

export type MailKind =
  | "action_executed"
  | "action_reverted"
  | "action_failed"
  | "approval_request"
  | "escalation"
  | "incident"
  | "daily_digest"
  | "voicemail"
  | "sms"
  | "test";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface Mail {
  kind: MailKind;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
  /** Reply-To address (e.g. SMS reply-back routing). */
  replyTo?: string;
  /** Extra headers — used for email threading (Message-ID / References / In-Reply-To). */
  headers?: Record<string, string>;
  /** Explicit Message-ID so a conversation's emails can reference each other. */
  messageId?: string;
}

export class Notifier {
  private transporter: Transporter | null = null;

  constructor(
    private cfg: AgentConfig,
    private audit: AuditLog,
  ) {
    if (cfg.smtp.host && cfg.smtp.user && cfg.smtp.pass) {
      this.transporter = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.port === 465,
        auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
      });
    }
  }

  get configured(): boolean {
    return this.transporter !== null;
  }

  async send(mail: Mail): Promise<{ sent: boolean; reason?: string }> {
    // Owner directive (2026-08-12): the alert inbox receives ONLY the
    // Assistant's escalation reports — and those are sent by the API's
    // dispatcher, never from here. So this notifier drops that recipient from
    // every mail (digests, incidents, action mails alike); if nobody is left,
    // the mail is recorded to audit and not sent. Muting at the SEND door, not
    // per call site, because call sites multiply — that lesson cost a full
    // day's Gmail quota (402 of 499 sends) on 2026-08-06.
    const muted = (process.env.AGENT_MUTED_ALERT_RECIPIENTS || "tod10950@gmail.com")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    const originalTo = mail.to;
    mail = { ...mail, to: mail.to.filter((t) => !muted.includes(String(t).trim().toLowerCase())) };
    if (mail.to.length === 0) {
      await this.audit.record({
        actor: "system",
        event: `notify.muted`,
        payload: { kind: mail.kind, to: originalTo, subject: mail.subject },
      });
      return { sent: false, reason: "recipient_muted" };
    }
    await this.audit.record({
      actor: "system",
      event: `notify.${mail.kind}`,
      payload: { to: mail.to, subject: mail.subject, configured: this.configured, attachments: mail.attachments?.length ?? 0 },
    });
    if (!this.transporter) {
      // eslint-disable-next-line no-console
      console.warn(`[notifier] SMTP not configured — mail "${mail.subject}" recorded to audit only`);
      return { sent: false, reason: "smtp_not_configured" };
    }
    const message = {
      from: this.cfg.smtp.from,
      to: mail.to.join(", "),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      ...(mail.messageId ? { messageId: mail.messageId } : {}),
      ...(mail.headers ? { headers: mail.headers } : {}),
      ...(mail.attachments ? { attachments: mail.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) } : {}),
    };
    try {
      await this.transporter.sendMail(message);
      return { sent: true };
    } catch (err) {
      // Retry once, then record failure — audit row already exists either way.
      try {
        await this.transporter.sendMail(message);
        return { sent: true };
      } catch (err2) {
        await this.audit.record({ actor: "system", event: "notify.failed", payload: { subject: mail.subject, error: String(err2) } });
        return { sent: false, reason: String(err2) };
      }
    }
  }

  /** Every executed action emails the owner — hard rule. */
  ownerRecipients(): string[] {
    return [this.cfg.ownerEmail, ...this.cfg.teamEmails];
  }
}

/**
 * SMS-to-email sender (agent poller).
 *
 * Mirrors the voicemail-email job: it polls the DB for fresh INBOUND texts and
 * emails a copy to every user on that conversation who has "SMS to Email" turned
 * on — styled to match the approved SMS mockups. Each text from the same phone
 * number is threaded into ONE email conversation via stable Message-ID /
 * References headers + a stable subject, so the inbox never fills with a separate
 * email per message.
 *
 * HARD BACKLOG GUARD — this can never blast the existing inbound-SMS history:
 *   • only rows with emailForwardedAt == null are considered (each stamped once), and
 *   • only rows whose createdAt is inside a short fresh window (default 30 min).
 * The whole existing backlog has old createdAt values, so it is out of scope the
 * moment this ships, regardless of the per-user toggle.
 *
 * Reply-to-text-back (Part 3) activates only when a reply domain is configured;
 * until then the email still arrives and the callout says replies are coming.
 */
import { createHmac } from "node:crypto";
import type { AuditLog } from "../audit/audit";
import type { Notifier } from "./notifier";
import { buildSmsEmail, formatSmsPhone, type SmsEmailMessage } from "./smsEmail";

export interface SmsEmailForwardJobDeps {
  prisma: any;
  audit: AuditLog;
  notifier: Notifier;
  /** Domain used to mint Message-ID / References header ids (threading). */
  messageIdDomain: () => string;
  /** Reply-back domain, e.g. "sms.connectcomunications.com". Null → replies not live yet. */
  replyDomain: () => string | null;
  /** Secret used to sign reply-to tokens (same one Part 3 verifies). */
  replySecret: () => string | null;
  brandName?: string;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");

const MAX_BATCH = 8;
const FRESH_WINDOW_MIN = Number(process.env.AGENT_SMS_EMAIL_FRESH_WINDOW_MIN || 30) || 30;
const CONTEXT_MESSAGES = 8;

export class SmsEmailForwardJob {
  private running = false;
  constructor(private deps: SmsEmailForwardJobDeps) {}

  /** One polling pass. Returns how many texts were emailed. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const since = new Date(Date.now() - FRESH_WINDOW_MIN * 60_000);
      const rows = await this.deps.prisma.connectChatMessage.findMany({
        where: {
          emailForwardedAt: null,
          direction: "INBOUND",
          type: { in: ["TEXT", "IMAGE"] },
          deletedForEveryoneAt: null,
          createdAt: { gte: since },
        },
        orderBy: { createdAt: "asc" },
        take: MAX_BATCH,
        select: { id: true, tenantId: true, threadId: true, body: true, createdAt: true, type: true },
      });

      let sent = 0;
      for (const m of rows) {
        try {
          if (await this.processOne(m)) sent++;
        } catch (err) {
          // Transient — leave the stamp null so it retries next cycle while still
          // inside the fresh window, then naturally drops out of scope.
          await this.deps.audit.record({
            actor: "system",
            event: "sms.email_failed",
            payload: { id: m.id, error: String(err).slice(0, 200) },
          });
        }
      }
      return sent;
    } finally {
      this.running = false;
    }
  }

  private async stamp(id: string, error: string | null): Promise<void> {
    await this.deps.prisma.connectChatMessage
      .update({ where: { id }, data: { emailForwardedAt: new Date(), emailForwardError: error } })
      .catch(() => {});
  }

  /** Signed reply token so Part 3 can route an email reply back to this thread. */
  private replyTo(threadId: string): string | null {
    const domain = this.deps.replyDomain();
    const secret = this.deps.replySecret();
    if (!domain || !secret) return null;
    const sig = b64url(createHmac("sha256", secret).update(threadId).digest()).slice(0, 24);
    return `sms+${threadId}.${sig}@${domain}`;
  }

  private async resolveContactName(tenantId: string, phoneE164: string | null): Promise<string | null> {
    if (!phoneE164) return null;
    const last10 = phoneE164.replace(/\D/g, "").slice(-10);
    if (last10.length < 7) return null;
    const match = await this.deps.prisma.contactPhone.findFirst({
      where: { contact: { tenantId }, numberNormalized: { endsWith: last10 } },
      select: { contact: { select: { displayName: true } } },
      orderBy: { isPrimary: "desc" },
    }).catch(() => null);
    const name = match?.contact?.displayName?.trim();
    return name || null;
  }

  /** True when an email was actually sent. */
  private async processOne(m: {
    id: string; tenantId: string; threadId: string; body: string; createdAt: Date; type: string;
  }): Promise<boolean> {
    const thread = await this.deps.prisma.connectChatThread.findUnique({
      where: { id: m.threadId },
      select: { id: true, type: true, tenantSmsE164: true, externalSmsE164: true, smsInboxOwnerUserId: true },
    });
    if (!thread || thread.type !== "SMS") {
      await this.stamp(m.id, "not_sms_thread");
      return false;
    }

    // Who on this conversation wants their texts emailed?
    const participants = await this.deps.prisma.connectChatParticipant.findMany({
      where: { threadId: thread.id, leftAt: null, userId: { not: null } },
      select: { userId: true },
    });
    const userIds = Array.from(new Set(participants.map((p: any) => p.userId).filter(Boolean)));
    if (userIds.length === 0) {
      await this.stamp(m.id, "no_users");
      return false;
    }
    const users = await this.deps.prisma.user.findMany({
      where: { id: { in: userIds }, smsEmailForwardEnabled: true, status: "ACTIVE" },
      select: { email: true },
    });
    const recipients = Array.from(
      new Set(users.map((u: any) => (u.email || "").trim().toLowerCase()).filter((e: string) => e.includes("@"))),
    ) as string[];
    if (recipients.length === 0) {
      await this.stamp(m.id, "no_opted_in_recipients");
      return false;
    }

    // Recent conversation for the bubbles.
    const recentRows = await this.deps.prisma.connectChatMessage.findMany({
      where: { threadId: thread.id, deletedForEveryoneAt: null, type: { in: ["TEXT", "IMAGE"] } },
      orderBy: { createdAt: "desc" },
      take: CONTEXT_MESSAGES,
      select: { direction: true, body: true, createdAt: true, type: true },
    });
    const messages: SmsEmailMessage[] = recentRows
      .reverse()
      .map((r: any) => ({
        direction: r.direction === "OUTBOUND" ? "OUT" : "IN",
        body: r.type === "IMAGE" && !r.body?.trim() ? "📷 Photo" : String(r.body || ""),
        at: new Date(r.createdAt),
      }));

    const contactName = await this.resolveContactName(m.tenantId, thread.externalSmsE164);
    const replyTo = this.replyTo(thread.id);
    const domain = this.deps.messageIdDomain();

    const { subject, html, text } = buildSmsEmail({
      contactName,
      contactNumber: thread.externalSmsE164 || "",
      yourNumber: thread.tenantSmsE164 || "",
      messages,
      replyEnabled: !!replyTo,
      brandName: this.deps.brandName,
    });

    // Threading: every email for this thread references the same synthetic root id,
    // so mail clients group them into ONE conversation (one thread per number).
    const rootId = `<sms-thread-${thread.id}@${domain}>`;
    const res = await this.deps.notifier.send({
      kind: "sms",
      to: recipients,
      subject,
      text,
      html,
      ...(replyTo ? { replyTo } : {}),
      messageId: `<sms-${m.id}@${domain}>`,
      headers: { "In-Reply-To": rootId, References: rootId },
    });

    if (!res.sent) return false; // SMTP down — retry next cycle within the window.

    await this.stamp(m.id, null);
    await this.deps.audit.record({
      actor: "system",
      event: "sms.emailed",
      payload: {
        id: m.id, threadId: thread.id, recipients: recipients.length,
        from: formatSmsPhone(thread.externalSmsE164), replyable: !!replyTo,
      },
    });
    return true;
  }
}

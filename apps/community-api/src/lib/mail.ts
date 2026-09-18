import nodemailer from "nodemailer";
import { env } from "../env.js";
import type { Db } from "../db.js";

export type MailInput = { to: string; subject: string; text: string; html?: string };

let transport: nodemailer.Transporter | null = null;

/**
 * mailbox mode writes to OutboundMail (dev/test — the web's /dev/mailbox reads
 * it); smtp mode sends for real. Nothing is ever silently dropped: "off" still
 * records the row so a missing email is visible.
 */
export async function sendMail(db: Db, input: MailInput): Promise<{ delivered: "smtp" | "mailbox" | "off" }> {
  const e = env();
  if (e.COMMUNITY_MAIL_MODE === "smtp" && e.SMTP_URL) {
    try {
      transport ??= nodemailer.createTransport(e.SMTP_URL);
      await transport.sendMail({ from: e.MAIL_FROM, to: input.to, subject: input.subject, text: input.text, html: input.html });
      return { delivered: "smtp" };
    } catch (err) {
      // Degrade, never drop: the row is kept as "email-failed" for the retry job
      // and the request that triggered it still succeeds (a signup must not
      // fail because the mail relay is down).
      await db.outboundMail.create({
        data: { to: input.to, subject: input.subject, text: input.text, html: input.html ?? null, channel: "email-failed" },
      });
      return { delivered: "off" };
    }
  }
  await db.outboundMail.create({
    data: { to: input.to, subject: input.subject, text: input.text, html: input.html ?? null, channel: "email" },
  });
  return { delivered: e.COMMUNITY_MAIL_MODE === "off" ? "off" : "mailbox" };
}

/** SMS goes through the same outbox in dev; a Telnyx/VoIP.ms sender plugs in here later. */
export async function sendSms(db: Db, to: string, text: string) {
  await db.outboundMail.create({ data: { to, subject: "sms", text, channel: "sms" } });
}

/** Retry job: re-sends rows the relay refused earlier; on success the row flips to "email". */
export async function retryFailedMail(db: Db) {
  const e = env();
  if (e.COMMUNITY_MAIL_MODE !== "smtp" || !e.SMTP_URL) return;
  const rows = await db.outboundMail.findMany({ where: { channel: "email-failed" }, orderBy: { createdAt: "asc" }, take: 50 });
  for (const r of rows) {
    try {
      transport ??= nodemailer.createTransport(e.SMTP_URL);
      await transport.sendMail({ from: e.MAIL_FROM, to: r.to, subject: r.subject, text: r.text, html: r.html ?? undefined });
      await db.outboundMail.update({ where: { id: r.id }, data: { channel: "email" } });
    } catch {
      return; // relay still down; try again next tick
    }
  }
}

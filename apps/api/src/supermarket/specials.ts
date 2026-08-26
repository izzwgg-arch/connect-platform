/**
 * Weekly specials — the email blast lane (supermarket plan Phase 6).
 *
 * ⛔ THE MARKETING LANE IS WALLED OFF FROM PLATFORM MAIL. Every platform email
 * (invoices, invites, voicemail) shares ONE mailbox with a 500/day allowance —
 * a blast through it would starve invoices (the 2026-08-06 outage class). So:
 *  - sending REFUSES loudly unless MARKETING_MAIL_ENABLED=1 (the dedicated
 *    sending service being configured is a deploy-day decision, not ours);
 *  - blast emails are EmailJob type MARKETING_SPECIAL — ⛔ never ADMIN_ALERT
 *    (muted) and never a customer-billing type;
 *  - every send checks MarketingUnsubscribe first, and every email carries a
 *    signed one-click unsubscribe link (legally required, and the signature is
 *    what stops one customer unsubscribing another).
 *
 * Recipients v1: the tenant's own Contact list's primary emails — the list a
 * supermarket already curates in Connect.
 */

import * as crypto from "node:crypto";
import { resolveUrlSigningKey } from "../urlSigningSecret";

export const MARKETING_EMAIL_TYPE = "MARKETING_SPECIAL";
export const MAX_BLAST_RECIPIENTS = 2_000;
export const MAX_BLASTS_PER_DAY = 3;

export function marketingLaneEnabled(): boolean {
  return String(process.env.MARKETING_MAIL_ENABLED ?? "").trim() === "1";
}

// ── unsubscribe tokens ───────────────────────────────────────────────────────

export function unsubscribeToken(tenantId: string, email: string): string {
  const key = resolveUrlSigningKey("marketing-unsubscribe");
  const payload = `${tenantId}:${email.toLowerCase()}`;
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url").slice(0, 24);
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): { tenantId: string; email: string } | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 2) return null;
  let payload: string;
  try {
    payload = Buffer.from(parts[0], "base64url").toString("utf8");
  } catch {
    return null;
  }
  const idx = payload.indexOf(":");
  if (idx <= 0) return null;
  const tenantId = payload.slice(0, idx);
  const email = payload.slice(idx + 1);
  if (!tenantId || !email || !email.includes("@")) return null;
  let expected: string;
  try {
    const key = resolveUrlSigningKey("marketing-unsubscribe");
    expected = crypto.createHmac("sha256", key).update(`${tenantId}:${email.toLowerCase()}`).digest("base64url").slice(0, 24);
  } catch {
    return null;
  }
  const got = parts[1];
  if (got.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return { tenantId, email: email.toLowerCase() };
}

// ── the blast ────────────────────────────────────────────────────────────────

export type BlastDeps = {
  db: any;
  /** Renders the branded shell (loopComShell at the call site). */
  renderShell: (opts: { headerTitle: string; body: string; organizationName?: string | null; preheaderText?: string }) => string;
  /** Public origin for the unsubscribe link. */
  publicOrigin: () => string;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void };
  now?: () => Date;
};

export type BlastResult =
  | { ok: true; recipients: number; skippedUnsubscribed: number }
  | { ok: false; code: string; message: string };

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function sendSpecialBlast(deps: BlastDeps, input: { tenantId: string; specialId: string }): Promise<BlastResult> {
  const { db } = deps;
  const log = deps.log ?? { info: () => {}, warn: () => {} };
  const now = deps.now ? deps.now() : new Date();

  if (!marketingLaneEnabled()) {
    return {
      ok: false,
      code: "marketing_lane_not_configured",
      message:
        "The marketing sending service is not set up yet. Specials never ride the platform mailbox — that allowance belongs to invoices and sign-ins.",
    };
  }

  const special = await db.supermarketSpecial.findFirst({ where: { id: input.specialId, tenantId: input.tenantId } });
  if (!special) return { ok: false, code: "not_found", message: "That special does not exist." };
  if (special.status === "SENT" || special.status === "SENDING") {
    return { ok: false, code: "already_sent", message: "That special has already gone out." };
  }

  // Per-day blast cap — a fat-fingered loop must not empty anyone's inbox.
  const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sentToday = await db.supermarketSpecial.count({
    where: { tenantId: input.tenantId, status: { in: ["SENDING", "SENT"] }, sentAt: { gte: dayStart } },
  });
  if (sentToday >= MAX_BLASTS_PER_DAY) {
    return { ok: false, code: "daily_blast_cap", message: `At most ${MAX_BLASTS_PER_DAY} blasts a day.` };
  }

  // CLAIM before building anything — two concurrent sends collapse to one.
  const claimed = await db.supermarketSpecial.updateMany({
    where: { id: special.id, status: { in: ["DRAFT", "FAILED"] } },
    data: { status: "SENDING", sentAt: now },
  });
  if (!claimed || claimed.count !== 1) {
    return { ok: false, code: "already_sent", message: "That special has already gone out." };
  }

  try {
    const contacts = await db.contact.findMany({
      where: { tenantId: input.tenantId, active: true },
      select: { displayName: true, emails: { select: { email: true, isPrimary: true } } },
      take: MAX_BLAST_RECIPIENTS * 2,
    });
    const unsubRows = await db.marketingUnsubscribe.findMany({
      where: { tenantId: input.tenantId },
      select: { email: true },
    });
    const unsubscribed = new Set(unsubRows.map((r: any) => String(r.email).toLowerCase()));

    const seen = new Set<string>();
    const recipients: Array<{ email: string; name: string }> = [];
    let skippedUnsubscribed = 0;
    for (const contact of contacts) {
      const emails: any[] = contact.emails ?? [];
      const primary = emails.find((e) => e.isPrimary) ?? emails[0];
      const email = String(primary?.email ?? "").trim().toLowerCase();
      if (!email || !email.includes("@") || seen.has(email)) continue;
      seen.add(email);
      if (unsubscribed.has(email)) {
        skippedUnsubscribed++;
        continue;
      }
      recipients.push({ email, name: String(contact.displayName ?? "") });
      if (recipients.length >= MAX_BLAST_RECIPIENTS) break;
    }

    if (recipients.length === 0) {
      await db.supermarketSpecial.update({
        where: { id: special.id },
        data: { status: "FAILED", recipientCount: 0 },
      });
      return { ok: false, code: "no_recipients", message: "Nobody on the contact list has an email address." };
    }

    const origin = deps.publicOrigin().replace(/\/+$/, "");
    let queued = 0;
    for (const r of recipients) {
      const unsubUrl = `${origin}/api/marketing/unsubscribe/${unsubscribeToken(input.tenantId, r.email)}`;
      const bodyHtml =
        `<div style="white-space:pre-wrap;">${escapeHtml(special.body)}</div>` +
        `<p style="margin-top:28px;font-size:12px;color:#6b7280;">Don't want these emails? ` +
        `<a href="${unsubUrl}" style="color:#2563eb;">Unsubscribe</a>.</p>`;
      const html = deps.renderShell({
        headerTitle: special.subject,
        preheaderText: special.subject,
        body: bodyHtml,
      });
      await db.emailJob.create({
        data: {
          type: MARKETING_EMAIL_TYPE,
          toEmail: r.email,
          subject: special.subject.slice(0, 200),
          htmlBody: html,
          textBody: `${special.subject}\n\n${special.body}\n\nUnsubscribe: ${unsubUrl}`,
          tenantId: input.tenantId,
        },
      });
      queued++;
    }

    await db.supermarketSpecial.update({
      where: { id: special.id },
      data: { status: "SENT", recipientCount: recipients.length, sentCount: queued },
    });
    log.info({ tenantId: input.tenantId, specialId: special.id, queued }, "special blast queued");
    return { ok: true, recipients: queued, skippedUnsubscribed };
  } catch (err: any) {
    await db.supermarketSpecial
      .update({ where: { id: special.id }, data: { status: "FAILED" } })
      .catch(() => {});
    log.warn({ specialId: special.id, err: String(err?.message ?? err) }, "special blast failed");
    return { ok: false, code: "blast_failed", message: "The blast could not be queued. Nothing was sent twice." };
  }
}

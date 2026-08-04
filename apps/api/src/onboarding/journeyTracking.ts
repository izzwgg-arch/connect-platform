import { db } from "@connect/db";

/**
 * Journey tracking: every meaningful thing a customer does between opening
 * their sign-up link and finishing (or abandoning) becomes a timeline event on
 * the submission — the raw material for making the wizard easier. The first
 * open of a link also emails the owner immediately, so he knows a customer is
 * in the wizard right now, hours before any finished/failed report.
 *
 * Events ride the existing STATUS_CHANGED type on purpose: adding a new enum
 * member needs a DB migration, and an invalid type silently killed the
 * paid-marker earlier today. Messages are written in plain English because
 * they feed the owner's report verbatim.
 */

const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";

function recipient(): string {
  return (process.env.ADMIN_ALERT_EMAIL || "tod10950@gmail.com").trim();
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function addEvent(submissionId: string, message: string): Promise<void> {
  try {
    await (db as any).onboardingEvent.create({
      data: { submissionId, type: "STATUS_CHANGED", message: message.slice(0, 480) },
    });
  } catch { /* telemetry must never break the wizard */ }
}

/** Runaway guard: a broken (or hostile) client must not fill the table. */
async function overEventBudget(submissionId: string): Promise<boolean> {
  try {
    const n = await (db as any).onboardingEvent.count({ where: { submissionId } });
    return n > 600;
  } catch {
    return true;
  }
}

const OPENED_MSG = "Customer opened the sign-up link";
const RETURNED_MSG = "Customer came back to the sign-up link";

/**
 * Called from GET /validate — i.e. every time the wizard page loads for this
 * token. First open: event + email. Later opens: an event, throttled so a
 * refresh-happy customer doesn't flood the timeline.
 */
export async function recordLinkOpened(row: any): Promise<void> {
  try {
    const events = await (db as any).onboardingEvent.findMany({
      where: { submissionId: row.id, message: { in: [OPENED_MSG, RETURNED_MSG] } },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    const last = events[0] ?? null;
    if (!last) {
      await addEvent(row.id, OPENED_MSG);
      await queueLinkOpenedEmail(row);
      return;
    }
    // Repeat visit: worth a timeline entry, but not more than once per 10 min.
    if (Date.now() - new Date(last.createdAt).getTime() > 10 * 60_000) {
      await addEvent(row.id, RETURNED_MSG);
    }
  } catch { /* never break validate */ }
}

async function queueLinkOpenedEmail(row: any): Promise<void> {
  try {
    const created = await (db as any).onboardingEvent.findFirst({
      where: { submissionId: row.id, type: "CREATED" },
      orderBy: { createdAt: "asc" },
    });
    const viaTestLink = /reusable test link/i.test(String(created?.message || ""));
    const who = String(row.companyName || row.mainEmail || "").trim();
    const linkDesc = String(created?.message || "a sign-up link")
      .replace(/^Admin-created link\s*/i, "the link you created")
      .replace(/^Spawned from reusable test link.*$/i, "the reusable test link");

    const lines = [
      who
        ? `${who} just opened their sign-up link and is in the wizard right now.`
        : "Someone just opened a sign-up link and is in the wizard right now.",
      "",
      `Which link: ${linkDesc}${viaTestLink ? " (a test run)" : ""}.`,
      "",
      "From here, every step they take — and anything they get stuck on — is being recorded.",
      "You'll get the full report when they finish (or if the setup fails).",
      "To watch live in the meantime: Admin → Onboarding, newest entry at the top.",
    ];
    await (db as any).emailJob.create({
      data: {
        tenantId: ADMIN_ALERT_TENANT_ID,
        invoiceId: null,
        type: "ADMIN_ALERT",
        toEmail: recipient(),
        subject: `[Connect] Sign-up link opened${who ? ` — ${who}` : ""}${viaTestLink ? " (test)" : ""}`,
        htmlBody: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${lines.map(escapeHtml).join("<br/>")}</div>`,
        textBody: lines.join("\n"),
      },
    });
  } catch { /* email is best-effort */ }
}

// ── Client-reported journey beacons ──────────────────────────────────────────

export type JourneyBeacon = {
  kind: "step_viewed" | "validation_blocked" | "number_search" | "portability" | "went_back";
  step?: string;
  fromStep?: string;
  seconds?: number;
  detail?: string;
  count?: number;
};

/** Turn a beacon into one plain-English timeline line. Returns null for junk. */
export function beaconMessage(b: JourneyBeacon): string | null {
  const clean = (v: unknown, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  switch (b.kind) {
    case "step_viewed": {
      const step = clean(b.step, 40);
      if (!step) return null;
      const from = clean(b.fromStep, 40);
      const secs = Number.isFinite(b.seconds) ? Math.max(0, Math.round(Number(b.seconds))) : null;
      return `Reached "${step}"${from && secs != null ? ` after ${secs}s on "${from}"` : ""}`;
    }
    case "went_back": {
      const step = clean(b.step, 40);
      const from = clean(b.fromStep, 40);
      return step ? `Went BACK to "${step}"${from ? ` from "${from}"` : ""}` : null;
    }
    case "validation_blocked": {
      const step = clean(b.step, 40);
      const msg = clean(b.detail);
      // The single most valuable line in the journey: the exact message that
      // stopped them, on the exact step.
      return msg ? `Stuck on "${step || "?"}" — the wizard said: ${msg}` : null;
    }
    case "number_search": {
      const q = clean(b.detail, 60);
      const n = Number.isFinite(b.count) ? Number(b.count) : null;
      if (!q) return null;
      if (n === -1) return `Searched numbers for "${q}" — the search FAILED`;
      return `Searched numbers for "${q}" — ${n ?? "?"} result${n === 1 ? "" : "s"}`;
    }
    case "portability": {
      const msg = clean(b.detail, 120);
      return msg ? `Number transfer check: ${msg}` : null;
    }
    default:
      return null;
  }
}

/** Record one beacon on a submission (called by POST /track). */
export async function recordJourneyBeacon(submissionId: string, b: JourneyBeacon): Promise<boolean> {
  const msg = beaconMessage(b);
  if (!msg) return false;
  if (await overEventBudget(submissionId)) return false;
  await addEvent(submissionId, msg);
  return true;
}

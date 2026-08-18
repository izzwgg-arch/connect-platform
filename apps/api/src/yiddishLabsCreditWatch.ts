/**
 * Yiddish Labs credit watch — texts the owner the moment Yiddish stops working.
 *
 * ⛔ WHY THIS EXISTS. On 2026-08-16 the Yiddish Labs account ran out of credits
 * and nobody was told for a day and a half. Every Yiddish chat since answered
 * with `fallbackReply("yi")` — a hard-coded Yiddish sentence saying "I've passed
 * it to the team" — so the customer got fluent Yiddish that answered nothing,
 * and it read as the assistant ignoring them. The refusal (`402
 * insufficient_credits`) was written to the agent's audit table and NOWHERE
 * else: no alert, no banner, no log line a human reads. It surfaced only when
 * the owner complained. The same outage a fortnight earlier was written up with
 * the WRONG root cause because the reason was equally invisible.
 *
 * ⛔ IT GROWS NO NEW DELIVERY PATH. Everything here ends at a QUEUED
 * `AgentEscalation` row. `agentEscalationDispatch.ts` already turns one into an
 * SMS to (562) 209-6644 + (845) 723-1213 and an AGENT_ESCALATION email — the one
 * mail category the platform-wide alert mute still lets through. ⛔ Do NOT give
 * this file its own `resolvePlatformSmsSender` or `emailJob.create`; a second
 * delivery path is a second thing to keep working and the first one to rot.
 * A test asserts that. (Same fence as `supportReport.ts`.)
 *
 * ⛔ AND IT MUST NOT BE AN `ADMIN_ALERT`. That whole category is muted at the
 * send door — it would build clean, log clean, and reach nobody, which is the
 * exact failure this file exists to end.
 *
 * ⛔ IT LIVES IN THE API, NOT THE AGENT, ON PURPOSE. The agent is a manual
 * container rebuild; the api redeploys through the queue. Same reasoning as the
 * escalation dispatcher itself.
 *
 * ── How it decides, cheapest signal first ─────────────────────────────────────
 * Yiddish Labs publishes NO balance endpoint (probed: /credits /balance /account
 * /usage /quota … all 404). The ONLY way to learn the balance is to be refused —
 * the 402 body carries it verbatim. So:
 *
 *   1. A fresh `insufficient_credits` in the agent's audit trail → OUT. Free,
 *      and it fires on the first customer-visible failure rather than waiting
 *      for the next probe.
 *   2. Else a fresh `AgentTranslation` row → OK. Free: one row is written per
 *      translation Yiddish Labs actually performed, so its existence is proof
 *      the wire works. This is why an account in daily use costs nothing to
 *      monitor.
 *   3. Else probe. ⛔ THE PROBE COSTS 1 CREDIT when the account is healthy and
 *      nothing when it is empty — so the bill is at most one credit per quiet
 *      interval, and a busy account never reaches this step. (For scale: one
 *      assistant reply costs 15-21.)
 *
 * ⛔ ONLY A 402 TEXTS HIM. A 401, a 500, a DNS blip or a timeout is recorded and
 * never texted: a provider hiccup at 3am must not ring the owner's phone, and
 * "unreachable" is not "out of money" (the same distinction the e911 work had to
 * make between an outage and an unregistered address).
 *
 * ⛔ EDGE-TRIGGERED, AND THE STATE IS IN THE DATABASE. It texts on the crossing
 * from working → out, once, and re-arms only after a check comes back healthy.
 * The state lives in `AgentAuditLog`, never in a module variable: an in-memory
 * cooldown is what let the alert emails re-arm on all 56 api restarts in one day
 * and text out one message every 25 minutes.
 */

import { createHash } from "node:crypto";
import { db } from "@connect/db";

/** Where the agent's own alerts are attributed. */
const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";

const YL_BASE = "https://app.yiddishlabs.com/api/v1";
const AUDIT_EVENT = "yiddishlabs.credit_check";

/** Quiet-period probe cadence. Only step 3 above ever costs a credit. */
export const CREDIT_CHECK_INTERVAL_MS = Math.max(
  5 * 60_000,
  Number(process.env.YIDDISHLABS_CREDIT_CHECK_INTERVAL_MS || 60 * 60_000),
);

const DISABLED = () => process.env.YIDDISHLABS_CREDIT_CHECK_DISABLED === "1";

/** How long a probe may hang before we call it "unknown" (never "out"). */
const PROBE_TIMEOUT_MS = 20_000;

/** Far enough after boot that the check never competes with startup work. */
const BOOT_CHECK_DELAY_MS = Math.max(
  10_000,
  Number(process.env.YIDDISHLABS_CREDIT_CHECK_BOOT_DELAY_MS || 120_000),
);

export type CreditState = "ok" | "out" | "unknown" | "unconfigured";

export interface CreditCheckOutcome {
  state: CreditState;
  /** Credits remaining, when Yiddish Labs told us. Negative is normal here. */
  balance: number | null;
  /** What the refused call would have cost, when Yiddish Labs told us. */
  required: number | null;
  /** How the verdict was reached — for the audit row and for humans. */
  via: "audit" | "translation" | "probe" | "none";
  detail?: string;
}

/**
 * Pull the numbers out of a Yiddish Labs refusal.
 *
 * The body reads: "This action requires 16 credits but you only have -3
 * available. Please purchase more credits to continue."
 *
 * ⛔ The balance is routinely NEGATIVE, so the sign is part of the number. A
 * pattern of `(\d+)` reads "-3" as 3 and turns an empty account into a
 * healthy-looking one.
 */
export function parseCreditFailure(body: string): { balance: number | null; required: number | null } {
  const required = /requires\s+(-?\d+(?:\.\d+)?)\s+credits?/i.exec(body || "");
  const balance = /have\s+(-?\d+(?:\.\d+)?)\s+available/i.exec(body || "");
  return {
    required: required ? Number(required[1]) : null,
    balance: balance ? Number(balance[1]) : null,
  };
}

/** Is this response Yiddish Labs refusing us for money, specifically? */
export function isCreditRefusal(status: number, body: string): boolean {
  if (status !== 402) return false;
  return /insufficient_credits/i.test(body || "");
}

/**
 * The key resolves DB-first, exactly as the agent's SecretStore does.
 *
 * ⛔ `YIDDISHLABS_API_KEY` in the environment is the literal `(paste…)`
 * placeholder on every container, so a naive env read finds a 34-character
 * string that is not a key. The placeholder test below is the agent's, kept
 * byte-compatible on purpose.
 */
export async function resolveYiddishLabsKey(deps: {
  db: any;
  decryptJson: (v: any) => any;
  hasMasterKey: () => boolean;
  env?: Record<string, string | undefined>;
}): Promise<string | null> {
  const env = deps.env ?? process.env;
  if (deps.hasMasterKey()) {
    try {
      const row = await deps.db.agentSecret.findUnique({ where: { key: "yiddishlabs_api_key" } });
      if (row?.valueEnc) {
        const val = deps.decryptJson(row.valueEnc);
        if (typeof val === "string" && val.trim()) return val.trim();
      }
    } catch {
      // fall through to env
    }
  }
  const raw = env.YIDDISHLABS_API_KEY;
  if (raw && raw.trim() && !/paste|your-?(new|real)?-?key|\.\.\./i.test(raw)) return raw.trim();
  return null;
}

/**
 * Decide whether this outcome should page the owner.
 *
 * ⛔ Pure, and tested directly, because the whole value of the feature is that it
 * fires EXACTLY once per outage: silent while it stays broken, and armed again
 * only after Yiddish Labs is proven working. "unknown" never alerts and never
 * re-arms — a blip must neither wake him nor reset the latch.
 */
export function shouldAlert(previous: CreditState | null, current: CreditState): boolean {
  if (current !== "out") return false;
  return previous !== "out";
}

/**
 * The text he actually receives.
 *
 * ⛔ Plain ASCII. One emoji flips the whole message to UCS-2 and cuts a segment
 * from 160 characters to 70, so a two-segment alert would arrive as five texts.
 * ⛔ Lines are capped individually and then joined — running the joined text
 * through a truncator collapses every newline into a space by design.
 */
export function buildCreditAlertSms(o: { balance: number | null }): string {
  const bal = o.balance == null ? "" : ` Balance ${o.balance}.`;
  return [
    "Loopcom alert - Yiddish Labs is out of credits.",
    `Yiddish replies in the assistant are failing now.${bal} Customers writing Yiddish get a canned "passed it to the team" message instead of an answer.`,
    "Yiddish voicemail still works - it falls back to the second engine.",
    "Fix: top up the account at yiddishlabs.com. It resumes on the next message, nothing to deploy.",
  ]
    .map((line) => (line.length > 300 ? `${line.slice(0, 299)}…`.replace(/…/, "...") : line))
    .join("\n");
}

/** The full report for the escalation email. */
export function buildCreditAlertReport(o: { balance: number | null; required: number | null; via: string }): string {
  return [
    "Yiddish Labs has run out of credits, so every Yiddish translation is being refused (HTTP 402 insufficient_credits).",
    "",
    `Balance reported by Yiddish Labs: ${o.balance == null ? "not stated" : o.balance}`,
    o.required == null ? "" : `Cost of the refused call: ${o.required} credits`,
    `Detected via: ${o.via}`,
    "",
    "WHAT IS BROKEN",
    "- The assistant's Yiddish chat. The customer gets a fixed Yiddish sentence saying the message was passed to the team, which reads as the assistant ignoring them.",
    "- Warming Yiddish for new screens. Untranslated wording renders in English, which is safe but incomplete.",
    "",
    "WHAT IS NOT BROKEN",
    "- Yiddish voicemail transcription. It tries Yiddish Labs first and falls back to ivrit.ai, so it keeps working on one engine instead of two.",
    "- Calls, billing and routing never touch Yiddish Labs.",
    "",
    "THE FIX",
    "Top up the Yiddish Labs account. The key is read live from the secret store, so Yiddish resumes on the next message with no restart, no rebuild and no deploy.",
    "Do NOT re-paste or rotate the API key: it authenticates fine. A dead key answers 401, an empty wallet answers 402.",
    "",
    "Background: docs/ai-context/AGENT_HANDOFF_IVR_YIDDISH_2026-08-04.md",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Read back the state of the previous check. Null when we have never run. */
async function lastRecordedState(database: any): Promise<{ state: CreditState; ts: Date } | null> {
  const row = await database.agentAuditLog.findFirst({
    where: { event: AUDIT_EVENT },
    orderBy: { ts: "desc" },
    select: { ts: true, payload: true },
  });
  if (!row) return null;
  const state = (row.payload as any)?.state;
  if (state !== "ok" && state !== "out" && state !== "unknown" && state !== "unconfigured") return null;
  return { state, ts: row.ts };
}

/**
 * Append the check to the agent's audit table.
 *
 * ⛔ The `hash` column has no default and the agent hashes the row body, so it
 * is computed the same way here — a row written without it fails the insert,
 * and a differently-shaped one is indistinguishable from tampering later.
 */
async function recordCheck(database: any, outcome: CreditCheckOutcome): Promise<void> {
  const body = {
    actor: "system",
    event: AUDIT_EVENT,
    ts: new Date().toISOString(),
    payload: {
      state: outcome.state,
      balance: outcome.balance,
      required: outcome.required,
      via: outcome.via,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    },
  };
  await database.agentAuditLog.create({
    data: {
      actor: body.actor,
      event: body.event,
      payload: body.payload,
      hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    },
  });
}

/** Has a customer-visible Yiddish failure already told us the answer, for free? */
async function creditFailureInAuditSince(database: any, since: Date): Promise<string | null> {
  const rows = await database.agentAuditLog.findMany({
    where: { ts: { gt: since }, event: { in: ["chat.bridge_out_failed", "chat.bridge_in_failed"] } },
    orderBy: { ts: "desc" },
    take: 20,
    select: { payload: true },
  });
  for (const r of rows) {
    const text = JSON.stringify(r.payload ?? {});
    if (/insufficient_credits/i.test(text)) return text;
  }
  return null;
}

/** Has Yiddish Labs demonstrably performed a translation since we last looked? */
async function translationSince(database: any, since: Date): Promise<boolean> {
  const row = await database.agentTranslation.findFirst({
    where: { createdAt: { gt: since } },
    select: { id: true },
  });
  return !!row;
}

/** The one call that costs money — and only when the account is healthy. */
export async function probeYiddishLabs(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CreditCheckOutcome> {
  try {
    const res = await fetchImpl(`${YL_BASE}/process/text`, {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text_content: "ok", action: "translate-yiddish" }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await res.text();
    if (isCreditRefusal(res.status, body)) {
      const { balance, required } = parseCreditFailure(body);
      return { state: "out", balance, required, via: "probe" };
    }
    if (res.ok) return { state: "ok", balance: null, required: null, via: "probe" };
    // 401 (dead key), 5xx, rate limits: real problems, but NOT this one. Recorded
    // so the history shows them; never texted.
    return { state: "unknown", balance: null, required: null, via: "probe", detail: `http_${res.status}` };
  } catch (err: any) {
    return {
      state: "unknown",
      balance: null,
      required: null,
      via: "probe",
      detail: String(err?.message || err).slice(0, 200),
    };
  }
}

/**
 * Raise the escalation. The dispatcher does the rest, within 30 seconds.
 *
 * ⛔ `fixActionId` stays null: this is information, not something to approve by
 * text, so the SMS must carry no one-time code.
 */
async function raiseEscalation(database: any, outcome: CreditCheckOutcome): Promise<void> {
  await database.agentEscalation.create({
    data: {
      tenantId: ADMIN_ALERT_TENANT_ID,
      tenantName: "Loopcom platform",
      clientUserId: null,
      userName: "Yiddish Labs monitor",
      userEmail: null,
      requestSummary: "Yiddish Labs is out of credits - Yiddish replies are failing.",
      smsBody: buildCreditAlertSms(outcome),
      report: buildCreditAlertReport(outcome),
      proposedFix: "Top up the Yiddish Labs account. No deploy needed - it resumes on the next message.",
      researchDegraded: false,
      status: "QUEUED",
    },
  });
}

export interface CreditWatchDeps {
  db?: any;
  fetchImpl?: typeof fetch;
  resolveKey?: () => Promise<string | null>;
  now?: () => Date;
  /**
   * Skip entirely when a check was already recorded this recently.
   *
   * ⛔ THIS IS WHAT MAKES THE BOOT RUN SAFE, AND THE BOOT RUN IS WHAT MAKES THE
   * WATCHER WORK AT ALL. On a timer alone the first check lands one interval
   * after boot, and every api deploy restarts the process and resets that
   * clock — on a busy day (44 deploys in one day, on the record) the check
   * would never once run, and the alert would look armed while being dead.
   * Running at boot fixes that; this skip stops a run of deploys from probing
   * (and paying a credit) every few minutes, and keeps the real cadence hourly
   * across restarts.
   */
  skipIfCheckedWithinMs?: number;
}

/**
 * One pass. Never throws — a monitor that can break the boot path or a sweep
 * timer is worse than no monitor.
 */
export async function runYiddishLabsCreditCheck(
  deps: CreditWatchDeps = {},
  log?: { info: (o: any, m: string) => void; warn: (o: any, m: string) => void },
): Promise<CreditCheckOutcome> {
  const database = deps.db ?? (db as any);
  const now = deps.now ?? (() => new Date());
  try {
    const previous = await lastRecordedState(database);

    // A restart moments after the last check has nothing new to learn.
    if (deps.skipIfCheckedWithinMs != null && previous) {
      const age = now().getTime() - previous.ts.getTime();
      if (age >= 0 && age < deps.skipIfCheckedWithinMs) {
        return { state: previous.state, balance: null, required: null, via: "none", detail: "skipped_recent" };
      }
    }

    // First run has no window to look back over; use one interval.
    const since = previous?.ts ?? new Date(now().getTime() - CREDIT_CHECK_INTERVAL_MS);

    let outcome: CreditCheckOutcome;
    const key = deps.resolveKey
      ? await deps.resolveKey()
      : await resolveYiddishLabsKey({
          db: database,
          decryptJson: (await import("@connect/security")).decryptJson as any,
          hasMasterKey: (await import("@connect/security")).hasCredentialsMasterKey as any,
        });

    if (!key) {
      // Yiddish Labs is not configured at all — nothing to alert about.
      outcome = { state: "unconfigured", balance: null, required: null, via: "none" };
    } else {
      const refusal = await creditFailureInAuditSince(database, since);
      if (refusal) {
        const { balance, required } = parseCreditFailure(refusal);
        outcome = { state: "out", balance, required, via: "audit" };
      } else if (await translationSince(database, since)) {
        outcome = { state: "ok", balance: null, required: null, via: "translation" };
      } else {
        outcome = await probeYiddishLabs(key, deps.fetchImpl);
      }
    }

    await recordCheck(database, outcome);

    if (shouldAlert(previous?.state ?? null, outcome.state)) {
      await raiseEscalation(database, outcome);
      log?.warn(
        { balance: outcome.balance, via: outcome.via },
        "[YIDDISH_CREDITS] out of credits — escalation queued, owner will be texted",
      );
    } else if (outcome.state === "out") {
      log?.info({ balance: outcome.balance }, "[YIDDISH_CREDITS] still out — already reported, not re-texting");
    }
    return outcome;
  } catch (err: any) {
    log?.warn({ err: String(err?.message || err) }, "[YIDDISH_CREDITS] check failed");
    return { state: "unknown", balance: null, required: null, via: "none", detail: "check_failed" };
  }
}

/**
 * Wired into the api's sweep block at boot.
 *
 * ⛔ The cast mirrors every other timer in `server.ts`: this project's tsconfig
 * resolves the DOM `setInterval`, which returns `number`, while the shutdown
 * registry wants a `NodeJS.Timeout`.
 */
export function startYiddishLabsCreditWatch(log?: any): NodeJS.Timeout | null {
  if (DISABLED()) return null;

  // ⛔ Check shortly after boot as well as on the interval — see
  // `skipIfCheckedWithinMs` for why a timer alone leaves this permanently dead
  // on a day with frequent deploys. Delayed so it never competes with boot.
  const first = setTimeout(() => {
    void runYiddishLabsCreditCheck({ skipIfCheckedWithinMs: CREDIT_CHECK_INTERVAL_MS }, log);
  }, BOOT_CHECK_DELAY_MS) as unknown as NodeJS.Timeout;
  (first as any).unref?.();

  const timer = setInterval(() => {
    void runYiddishLabsCreditCheck({}, log);
  }, CREDIT_CHECK_INTERVAL_MS) as unknown as NodeJS.Timeout;
  (timer as any).unref?.();
  return timer;
}

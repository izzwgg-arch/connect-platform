/**
 * portWatchdog — watches every filed port-in until it lands, then runs the
 * landing automatically (portLanding.ts).
 *
 * VoIP.ms has no webhook for ports (only SMS gets webhooks), so this polls.
 * Two independent signals, both cheap:
 *
 *   · getLNPStatus {portid}   — the order's own state. Transitions are logged
 *     to the sign-up timeline; a rejection emails the admin (paperwork always
 *     needs a human). "completed" is the gate that allows retiring the
 *     temporary number.
 *   · getDIDsInfo {did}       — whether the number EXISTS on the account yet.
 *     VoIP.ms adds it (routed to the master account) around FOC, before the
 *     order reads completed. The moment it appears we can already point it at
 *     the subaccount, wire texting, and book the menu switch — so completion
 *     day needs nothing.
 *
 * The sweep is deliberately boring: small result set (ports are rare), every
 * action inside runPortLanding is idempotent and persisted per-step, and a
 * landing that keeps failing alerts once instead of emailing forever.
 */
import { db as realDb } from "@connect/db";
import { loadMasterCreds, vms as realVms, type VmsCreds } from "./voipMsProvisioning";
import { defaultPortLandingDeps, runPortLanding, type PortLandingDeps } from "./portLanding";

const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";
const MAX_FAILURES_BEFORE_ALERT = 8;

function recipient(): string {
  return (process.env.ADMIN_ALERT_EMAIL || "tod10950@gmail.com").trim();
}

/**
 * ⛔ Bound anything the carrier says BEFORE it enters our database. These values
 * are free text from an upstream porting vendor, they are rewritten onto the
 * submission on every sweep (96×/day while a port is open), and they are read
 * back out by the assistant's `port_status` tool. The tool sanitises on read as
 * well — this is the other end of the same fence, so a hostile or buggy carrier
 * response cannot quietly grow a JSON column all week.
 */
function carrierField(v: unknown, max = 200): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function tenDigits(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type PortWatchdogDeps = PortLandingDeps & {
  loadCreds: () => Promise<VmsCreds | null>;
};

export function defaultPortWatchdogDeps(): PortWatchdogDeps {
  return { ...defaultPortLandingDeps(), loadCreds: loadMasterCreds };
}

async function logEvent(db: any, submissionId: string, message: string): Promise<void> {
  try {
    await db.onboardingEvent.create({
      data: { submissionId, type: "STATUS_CHANGED", message: message.slice(0, 480) },
    });
  } catch {
    /* best-effort */
  }
}

async function mergeProvisioning(db: any, row: any, patch: Record<string, any>): Promise<void> {
  const answers = { ...(row.answers || {}) };
  answers.provisioning = { ...(answers.provisioning || {}), ...patch };
  row.answers = answers;
  await db.onboardingSubmission.update({ where: { id: row.id }, data: { answers } });
}

async function queueAlert(db: any, subject: string, lines: string[]): Promise<void> {
  await db.emailJob
    .create({
      data: {
        tenantId: ADMIN_ALERT_TENANT_ID,
        invoiceId: null,
        type: "ADMIN_ALERT",
        toEmail: recipient(),
        subject,
        htmlBody: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${lines.map(escapeHtml).join("<br/>")}</div>`,
        textBody: lines.join("\n"),
      },
    })
    .catch(() => {
      /* alerting must never break the sweep */
    });
}

export type PortSweepSummary = {
  scanned: number;
  waitingForCarrier: number;
  landedOrProgressed: number;
  failed: number;
};

let sweepRunning = false;

export async function sweepOpenPorts(deps: PortWatchdogDeps = defaultPortWatchdogDeps()): Promise<PortSweepSummary> {
  const summary: PortSweepSummary = { scanned: 0, waitingForCarrier: 0, landedOrProgressed: 0, failed: 0 };
  if (sweepRunning) return summary;
  sweepRunning = true;
  try {
    const { db } = deps;
    const candidates = await db.onboardingSubmission.findMany({
      where: {
        paidAt: { not: null },
        status: { not: "CANCELED" },
        OR: [
          { phoneNumberChoice: "port" },
          { answers: { path: ["phone", "choice"], equals: "port" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    // A port is "open" once filed and until its landing has fully completed.
    const rows = candidates.filter((row: any) => {
      const prov: any = (row.answers || {}).provisioning || {};
      return !!prov.portFiled && !prov.portLanding?.completedAt;
    });
    summary.scanned = rows.length;
    if (!rows.length) return summary;

    const creds = await deps.loadCreds();
    if (!creds) return summary; // master account unconfigured — nothing to poll

    // ── One list read for the whole sweep ────────────────────────────────────
    // ⛔ `getLNPStatus {portid}` returns ONLY {post_status,
    // post_status_description} — it does NOT carry the FOC date. `getLNPList`
    // returns every order on the account WITH `foc_date`, in one call (both
    // shapes probed read-only against the live API 2026-08-21). The FOC date is
    // the one fact a customer actually asks for — "when does my number move?" —
    // so without this the port_status tool has nothing to tell them.
    // Best-effort by design: if the list call fails, every row below falls back
    // to the per-order status endpoint and behaves exactly as it did before.
    const orders = new Map<string, { port_status?: string; port_status_description?: string; foc_date?: string }>();
    try {
      const listed = await deps.vms(creds, "getLNPList", {});
      for (const o of Array.isArray(listed?.list) ? listed.list : []) {
        const id = String(o?.portid ?? "").trim();
        if (id) orders.set(id, o);
      }
    } catch {
      /* carrier hiccup — per-order fallback below still runs */
    }

    for (const row of rows) {
      const prov: any = (row.answers || {}).provisioning || {};
      const portedDid = tenDigits(row.answers?.phone?.details?.numbers);
      if (portedDid.length !== 10) continue;

      // ── The order's own status (also the retirement gate) ────────────────
      let portCompleted = false;
      if (prov.portId) {
        try {
          const candidate = orders.get(String(prov.portId));
          // ⛔ Use the list entry ONLY when it actually carries a status. An
          // entry that exists but whose status is blank/missing would otherwise
          // SHADOW the per-order call and resolve to "unknown" forever — and
          // "unknown" is never "completed", so the temporary number would never
          // retire and the customer would sit on it indefinitely. A malformed
          // list must degrade to the old behaviour, never suppress it.
          const listed =
            candidate && String(candidate.port_status || candidate.port_status_description || "").trim()
              ? candidate
              : undefined;
          let statusStr: string;
          let statusText = "";
          let focDate = "";
          if (listed) {
            statusStr = carrierField(listed.port_status || listed.port_status_description) || "unknown";
            statusText = carrierField(listed.port_status_description);
            focDate = carrierField(listed.foc_date, 32);
          } else {
            const r = await deps.vms(creds, "getLNPStatus", { portid: String(prov.portId) });
            statusStr = carrierField(r?.post_status || r?.post_status_description) || "unknown";
            statusText = carrierField(r?.post_status_description);
          }
          portCompleted = /complete/i.test(statusStr);
          // Stamped on EVERY successful read, not only on a change: the chat
          // tool tells the customer "as of <when>", and a status that has sat
          // unchanged for a week is not the same as one we stopped checking.
          // ⛔ Never clear a known FOC date with a blank — the per-order
          // fallback carries no date, so a sweep that misses the list must not
          // erase what the last list read told us.
          const always: Record<string, any> = {
            portStatus: statusStr,
            portStatusCheckedAt: new Date().toISOString(),
            ...(statusText ? { portStatusText: statusText } : {}),
            ...(focDate ? { portFocDate: focDate } : {}),
          };
          if (statusStr !== String(prov.lastPortStatus || "")) {
            await mergeProvisioning(db, row, { ...always, lastPortStatus: statusStr });
            await logEvent(db, row.id, `Port order ${prov.portId} status: ${statusStr}${focDate ? ` (transfer date ${focDate})` : ""}.`);
            if (/reject|cancel/i.test(statusStr)) {
              await queueAlert(db, `[Connect] Port needs attention: ${row.companyName || row.id} — ${statusStr}`, [
                `The port of ${portedDid} for ${row.companyName || "a customer"} now reads "${statusStr}" at VoIP.ms (order ${prov.portId}).`,
                "",
                "Rejections always need a human — usually the account number, PIN, or service address doesn't match the losing carrier's records. Open the VoIP.ms porting ticket, fix the paperwork, and the watchdog picks it back up on its own.",
              ]);
            }
          } else {
            // Unchanged status still refreshes when we last checked and the
            // transfer date — a date can be agreed (or moved) without the
            // status token changing at all.
            await mergeProvisioning(db, row, always);
          }
        } catch {
          /* status endpoint hiccup — the arrival check below still runs */
        }
      }

      // ── Has the number arrived on the account yet? ────────────────────────
      let arrived = !!prov.portLanding?.routedAt; // already landed at least step 1
      if (!arrived) {
        try {
          const info = await deps.vms(creds, "getDIDsInfo", { did: portedDid });
          arrived = Array.isArray(info?.dids) && info.dids.length > 0;
        } catch {
          arrived = false; // not on the account yet (VoIP.ms errors the lookup)
        }
      }
      if (!arrived) {
        summary.waitingForCarrier++;
        continue;
      }

      // ── Land it (idempotent, per-step persisted) ──────────────────────────
      try {
        const result = await runPortLanding(row, creds, portCompleted, deps);
        summary.landedOrProgressed++;
        if (result.stage === "switch_failed") {
          // The scheduler already retried for 30 minutes and alerted — make
          // the port timeline say it too, once per distinct error.
          // ⛔ Re-read the landing state: runPortLanding just persisted new
          // keys into row.answers, and spreading the pre-run snapshot here
          // would silently erase them.
          const fresh = ((row.answers || {}).provisioning || {}).portLanding || {};
          if (String(fresh.lastSwitchFailure || "") !== String(result.detail || "")) {
            await mergeProvisioning(db, row, {
              portLanding: { ...fresh, lastSwitchFailure: String(result.detail || "") },
            });
            await logEvent(db, row.id, `Ported number's menu switch failed: ${String(result.detail || "").slice(0, 200)}`);
          }
        }
      } catch (e: any) {
        summary.failed++;
        const fresh = ((row.answers || {}).provisioning || {}).portLanding || {};
        const failures = Number(fresh.failures || 0) + 1;
        await mergeProvisioning(db, row, {
          portLanding: {
            ...fresh,
            failures,
            lastError: String(e?.message || e).slice(0, 300),
          },
        });
        await logEvent(db, row.id, `Port landing hit a problem (attempt ${failures}): ${String(e?.message || e).slice(0, 200)}`);
        if (failures === MAX_FAILURES_BEFORE_ALERT) {
          await queueAlert(db, `[Connect] Port landing stuck: ${row.companyName || row.id}`, [
            `${row.companyName || "A customer"}'s ported number ${portedDid} arrived, but moving it over keeps failing.`,
            "",
            `Latest problem: ${String(e?.message || e).slice(0, 300)}`,
            "",
            "The watchdog keeps retrying on its own, but after this many attempts a human should look at the sign-up timeline.",
          ]);
        }
      }
    }
  } finally {
    sweepRunning = false;
  }
  return summary;
}

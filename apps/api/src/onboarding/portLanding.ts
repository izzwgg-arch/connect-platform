/**
 * portLanding — what happens when a ported number arrives from the old carrier.
 *
 * The build already prepared everything on the PBX (both numbers in the
 * tenant, an inbound route for each, the real number as outbound caller ID —
 * see pbxTenantBuild.ts). So landing a port is carrier + Connect work only:
 *
 *   arrival (number shows on the VoIP.ms account, at/after FOC):
 *     1. point the DID at the customer's subaccount  (setDIDRouting)
 *     2. turn SMS on at the carrier + claim the TenantSmsNumber row, copying
 *        whose inbox it is from the temporary number, and make the real
 *        number the one the company texts FROM
 *     3. register the number for routing (DidRouteMapping mirroring the
 *        temporary number's menu) and, when the temporary number is on
 *        Connect, book an immediate switch through DidSwitchSchedule — the
 *        scheduler drives the REAL switch-to-connect endpoint with its own
 *        retries and failure alerts
 *
 *   completion (the port order reads "completed" AND the switch has landed):
 *     4. retire the temporary number: route it back to the master account
 *        (it rejoins the spare pool), un-claim its texting row, cancel any
 *        pending switches and remove its mapping so a future customer can
 *        pick the number up cleanly
 *     5. one plain-English completion email to the admin
 *
 * Every step persists its success the moment it happens
 * (answers.provisioning.portLanding), so a retry never redoes an
 * irreversible step — the lesson from the 2026-08-05 subaccount-rotation
 * incident. All steps are idempotent; the sweep may call this as often as it
 * likes.
 *
 * ⛔ Retirement is gated on the port order reading COMPLETED, never on mere
 * arrival: the number can appear on the account at FOC, days before the old
 * carrier actually releases it. Cutting the temporary number then would
 * leave the customer with a real number that doesn't ring yet and a temp
 * number we just gave away.
 */
import { db as realDb } from "@connect/db";
import {
  enableSmsOnDid as realEnableSmsOnDid,
  readSubaccount,
  vms as realVms,
  type VmsCreds,
} from "./voipMsProvisioning";

export type PortLandingDeps = {
  db: any;
  vms: (creds: VmsCreds, method: string, params?: Record<string, string>) => Promise<any>;
  enableSmsOnDid: (creds: VmsCreds, did: string) => Promise<{ ok: boolean; detail: string }>;
};

export function defaultPortLandingDeps(): PortLandingDeps {
  return { db: realDb, vms: realVms, enableSmsOnDid: realEnableSmsOnDid };
}

export type PortLandingResult = {
  /** true once the whole landing (including temp retirement + email) is done. */
  done: boolean;
  /** Where the run got to — for the sweep's log line. */
  stage: string;
  detail?: string;
};

const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";

function recipient(): string {
  return (process.env.ADMIN_ALERT_EMAIL || "tod10950@gmail.com").trim();
}

function tenDigits(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

/** Merge into answers.provisioning.portLanding and keep the in-memory row current. */
async function mergeLanding(db: any, row: any, patch: Record<string, any>): Promise<void> {
  const answers = { ...(row.answers || {}) };
  const provisioning = { ...(answers.provisioning || {}) };
  provisioning.portLanding = { ...(provisioning.portLanding || {}), ...patch };
  answers.provisioning = provisioning;
  row.answers = answers;
  await db.onboardingSubmission.update({ where: { id: row.id }, data: { answers } });
}

/**
 * Land a ported number for one submission. `portCompleted` says whether the
 * port order itself reads completed (the retirement gate); the caller (the
 * port watchdog) reads that from getLNPStatus.
 */
export async function runPortLanding(
  row: any,
  creds: VmsCreds,
  portCompleted: boolean,
  deps: PortLandingDeps = defaultPortLandingDeps(),
): Promise<PortLandingResult> {
  const { db, vms, enableSmsOnDid } = deps;
  const answers: any = row.answers || {};
  const landing: any = (answers.provisioning || {}).portLanding || {};

  const portedDid = tenDigits(answers?.phone?.details?.numbers);
  const tempDid = tenDigits(row.provisionedDid);
  const tenantId = String(row.createdTenantId || "");
  const sub = readSubaccount(row);

  if (portedDid.length !== 10) return { done: false, stage: "blocked", detail: "ported number missing/garbled" };
  if (!sub) return { done: false, stage: "blocked", detail: "no stored subaccount credentials" };
  if (!tenantId) return { done: false, stage: "blocked", detail: "no Connect tenant on the submission" };

  const portedE164Plus1 = `+1${portedDid}`; // TenantSmsNumber format
  const portedE164 = `+${portedDid}`; //       DidRouteMapping format
  const tempE164Plus1 = tempDid ? `+1${tempDid}` : null;
  const tempE164 = tempDid ? `+${tempDid}` : null;

  // ── 1. Point the DID at the customer's subaccount ─────────────────────────
  if (!landing.routedAt) {
    await vms(creds, "setDIDRouting", { did: portedDid, routing: `account:${sub.username}` });
    // A success status is not a result — re-read before recording the step.
    const check = await vms(creds, "getDIDsInfo", { did: portedDid });
    const routing = String((check?.dids || [])[0]?.routing || "");
    if (routing !== `account:${sub.username}`) {
      throw new Error(`routing did not stick (reads "${routing}")`);
    }
    await mergeLanding(db, row, { routedAt: new Date().toISOString() });
    await logEvent(db, row.id, `Ported number ${portedDid} arrived — routed to ${sub.username}.`);
  }

  // ── 2. Texting on the real number ─────────────────────────────────────────
  // Only when this account texts at all (billing switch on, or the temp
  // number carries a claimed texting row).
  if (!landing.smsAt) {
    const [billing, tempSms] = await Promise.all([
      db.tenantBillingSettings.findUnique({ where: { tenantId }, select: { smsBillingEnabled: true } }),
      tempE164Plus1
        ? db.tenantSmsNumber.findUnique({ where: { phoneE164: tempE164Plus1 } })
        : Promise.resolve(null),
    ]);
    const tempClaimedHere = !!tempSms && tempSms.tenantId === tenantId;
    if (billing?.smsBillingEnabled || tempClaimedHere) {
      // Carrier side first (retries sms_wait_message internally). A carrier
      // refusal leaves this stage unfinished so the next sweep retries — the
      // flag can lag right after FOC.
      const carrier = await enableSmsOnDid(creds, portedDid);
      if (!carrier.ok) {
        await mergeLanding(db, row, { lastError: `carrier SMS enable: ${carrier.detail}` });
        return { done: false, stage: "sms_pending", detail: carrier.detail };
      }
      // Claim the inventory row, copying whose inbox it is from the temp
      // number, and make the real number the one the company texts FROM.
      const ported = await db.tenantSmsNumber.upsert({
        where: { phoneE164: portedE164Plus1 },
        create: {
          phoneE164: portedE164Plus1,
          phoneRaw: portedDid,
          voipmsDid: portedDid,
          smsCapable: true,
          mmsCapable: true,
          lastSyncedAt: new Date(),
        },
        update: { smsCapable: true, lastSyncedAt: new Date(), updatedAt: new Date() },
      });
      if (ported.tenantId && ported.tenantId !== tenantId) {
        throw new Error(`SMS number row for ${portedE164Plus1} is claimed by another tenant (${ported.tenantId})`);
      }
      await db.tenantSmsNumber.updateMany({
        where: { tenantId, isTenantDefault: true },
        data: { isTenantDefault: false },
      });
      await db.tenantSmsNumber.update({
        where: { id: ported.id },
        data: {
          tenantId,
          assignedUserId: tempClaimedHere ? tempSms.assignedUserId : null,
          assignedExtensionId: tempClaimedHere ? tempSms.assignedExtensionId : null,
          isTenantDefault: true,
          active: true,
          updatedAt: new Date(),
        },
      });
      // Multi-user inboxes ride a join table — copy those assignments too.
      if (tempClaimedHere) {
        const users = await db.tenantSmsNumberUser.findMany({ where: { tenantSmsNumberId: tempSms.id } });
        if (users.length) {
          await db.tenantSmsNumberUser.createMany({
            data: users.map((u: any) => ({
              tenantSmsNumberId: ported.id,
              userId: u.userId,
              inboxMode: u.inboxMode,
            })),
            skipDuplicates: true,
          });
        }
      }
      await logEvent(db, row.id, `Texting moved to the real number ${portedDid} (now the number the company texts from).`);
    } else {
      await logEvent(db, row.id, `Ported number ${portedDid}: texting not set up on this account — skipped.`);
    }
    await mergeLanding(db, row, { smsAt: new Date().toISOString(), lastError: null });
  }

  // ── 3. Register the number for routing, mirroring the temp number ─────────
  const tempMapping = tempE164
    ? await db.didRouteMapping.findUnique({ where: { e164: tempE164 } })
    : null;
  const tempOnConnect = !!tempMapping && tempMapping.tenantId === tenantId && tempMapping.routingMode === "connect";

  let portedMapping = await db.didRouteMapping.findUnique({ where: { e164: portedE164 } });
  if (portedMapping && portedMapping.tenantId !== tenantId) {
    throw new Error(`DID mapping for ${portedE164} belongs to another tenant (${portedMapping.tenantId})`);
  }
  if (!portedMapping) {
    const mirror = tempMapping && tempMapping.tenantId === tenantId ? tempMapping : null;
    portedMapping = await db.didRouteMapping.create({
      data: {
        tenantId,
        e164: portedE164,
        pbxInstanceId: mirror?.pbxInstanceId ?? null,
        ivrProfileId: mirror?.ivrProfileId ?? null,
        mohProfileId: mirror?.mohProfileId ?? null,
        holdAnnouncePromptRef: mirror?.holdAnnouncePromptRef ?? null,
        holdRepeatSec: mirror?.holdRepeatSec ?? 30,
        fallbackBehavior: mirror?.fallbackBehavior ?? "default_ivr",
        enabled: true,
        createdBy: "port-watchdog",
      },
    });
    await logEvent(db, row.id, `Ported number registered for routing${mirror?.ivrProfileId ? " with the same menu as the temporary number" : ""}.`);
  }

  // ── 4. Book the switch to Connect (when the temp number is on Connect) ────
  if (tempOnConnect && portedMapping.routingMode !== "connect" && !landing.switchScheduleId) {
    if (!portedMapping.ivrProfileId) {
      // DidSwitchSchedule requires a menu; without one there is nothing to
      // switch TO. Leave the number on its PBX inbound route (built at
      // sign-up) and say so.
      await logEvent(db, row.id, `Ported number has no menu to switch to — leaving it on the direct PBX route.`);
    } else {
      const sched = await db.didSwitchSchedule.create({
        data: {
          tenantId,
          mappingId: portedMapping.id,
          ivrProfileId: portedMapping.ivrProfileId,
          activateAt: new Date(),
          endAt: null,
          status: "pending",
          createdBy: "port-watchdog",
        },
      });
      await mergeLanding(db, row, { switchScheduleId: sched.id });
      await logEvent(db, row.id, `Booked the switch of ${portedDid} onto the menu (runs within a minute, retries on its own).`);
      landing.switchScheduleId = sched.id;
    }
  }

  // ── Gate: the switch must have landed before we touch the temp number ─────
  if (landing.switchScheduleId && portedMapping.routingMode !== "connect") {
    const sched = await db.didSwitchSchedule.findUnique({ where: { id: landing.switchScheduleId } });
    const status = String(sched?.status || "missing");
    if (status === "failed") {
      return { done: false, stage: "switch_failed", detail: String(sched?.lastError || "see DidSwitchSchedule") };
    }
    // pending/activated-but-not-reflected — check again next sweep.
    return { done: false, stage: "waiting_for_switch" };
  }

  // ── Gate: never retire the temp number before the port order is COMPLETED ─
  if (!portCompleted) {
    return { done: false, stage: "waiting_for_port_completion" };
  }

  // ── 5. Retire the temporary number ─────────────────────────────────────────
  if (!landing.tempRetiredAt && tempDid) {
    const master = sub.username.split("_")[0];
    await vms(creds, "setDIDRouting", { did: tempDid, routing: `account:${master}` });
    if (tempE164Plus1) {
      const tempSms = await db.tenantSmsNumber.findUnique({ where: { phoneE164: tempE164Plus1 } });
      if (tempSms && tempSms.tenantId === tenantId) {
        await db.tenantSmsNumberUser.deleteMany({ where: { tenantSmsNumberId: tempSms.id } });
        await db.tenantSmsNumber.update({
          where: { id: tempSms.id },
          data: {
            tenantId: null,
            assignedUserId: null,
            assignedExtensionId: null,
            isTenantDefault: false,
            updatedAt: new Date(),
          },
        });
      }
    }
    if (tempMapping && tempMapping.tenantId === tenantId) {
      // The number goes back to the spare pool — a future customer must be
      // able to claim it, and the unique e164 on DidRouteMapping would block
      // that. Cancel any booked switches first so the scheduler tick never
      // fires against a deleted mapping (switch logs cascade away with it).
      await db.didSwitchSchedule.updateMany({
        where: { mappingId: tempMapping.id, status: "pending" },
        data: { status: "canceled" },
      });
      await db.didRouteMapping.delete({ where: { id: tempMapping.id } }).catch(async () => {
        await db.didRouteMapping.update({ where: { id: tempMapping.id }, data: { enabled: false } });
      });
    }
    await mergeLanding(db, row, { tempRetiredAt: new Date().toISOString() });
    await logEvent(db, row.id, `Temporary number ${tempDid} retired — routed back to the master account (spare pool).`);
  }

  // ── 6. Completion email, once ──────────────────────────────────────────────
  if (!landing.completedAt) {
    const company = String(row.companyName || "a customer");
    const lines = [
      `${company}'s number port finished, and everything moved over automatically.`,
      "",
      `Their real number ${portedDid} now: rings their phone system (menu included), sends and receives their texts, and shows as their caller ID on outgoing calls.`,
      ...(tempDid
        ? [
            `The temporary number ${tempDid} was retired and returned to the spare pool at VoIP.ms.`,
            "",
            `One manual cleanup left (optional but it saves $3/month in E911 count): the old "Main" inbound route for ${tempDid} is still on the PBX tenant — delete it in the VitalPBX panel when convenient.`,
          ]
        : []),
    ];
    await db.emailJob.create({
      data: {
        tenantId: ADMIN_ALERT_TENANT_ID,
        invoiceId: null,
        type: "ADMIN_ALERT",
        toEmail: recipient(),
        subject: `[Connect] Port complete: ${company} — ${portedDid} is live`,
        htmlBody: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${lines.map(escapeHtml).join("<br/>")}</div>`,
        textBody: lines.join("\n"),
      },
    }).catch(() => { /* the completedAt stamp below still ends the loop */ });
    await mergeLanding(db, row, { completedAt: new Date().toISOString(), lastError: null });
    await logEvent(db, row.id, `Port landing complete — ${portedDid} fully live, admin emailed.`);
  }

  return { done: true, stage: "complete" };
}

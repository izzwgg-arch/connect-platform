/**
 * LoopCom Mobile — lifecycle orchestration between the local models
 * (MobileLine / MobileSim / …) and Telnyx wireless.
 *
 * Failure discipline (the distributed-system rules this product was ordered
 * with):
 *  - ⛔ A provider mutation is sent EXACTLY ONCE. A timeout is reported as
 *    "unknown — check the SIM list", never re-sent (a-creating-write rule).
 *  - Provider-succeeded-but-DB-failed is recovered by `importUnknownSims`:
 *    every Telnyx SIM the DB doesn't know gets a local row on the next
 *    reconcile pass, so nothing bought is ever lost.
 *  - Telnyx SIM actions are ASYNC (202 + an action object). Local status is
 *    set optimistically and `needsReconcile` marks the line until the sync
 *    job confirms the provider state matches.
 *  - eSIM activation codes are encrypted at rest (CREDENTIALS_MASTER_KEY) and
 *    only ever returned to the owning tenant.
 */

import type { StoredTelnyxCredentials } from "../telnyx/telnyxCredentials";
import {
  createSimCardGroup,
  disableSim,
  enableSim,
  getEsimActivationCode,
  getSimCard,
  listSimCardGroups,
  listSimCards,
  purchaseEsims,
  type WirelessSimCard,
} from "./telnyxWirelessClient";
import { writeMobileAuditSync } from "./mobileAudit";
import { esimReadyEmail, lineResumedEmail, lineSuspendedEmail, queueMobileEmail, resolveMobileRecipients } from "./mobileEmails";

/** Fire-and-forget customer email for a lifecycle event. Never throws. */
async function notifyLifecycle(db: any, line: any, kind: "esim_ready" | "line_suspended" | "line_resumed", extra?: { lost?: boolean; reason?: string | null; planName?: string | null }): Promise<void> {
  try {
    const sub = line.subscriberId ? await db.mobileSubscriber.findUnique({ where: { id: line.subscriberId } }) : null;
    const to = await resolveMobileRecipients(db, line.tenantId, sub?.notifyEmail ? sub?.email : null);
    if (!to.length) return;
    const email =
      kind === "esim_ready"
        ? esimReadyEmail({ subscriberName: sub ? `${sub.firstName} ${sub.lastName}`.trim() : null, lineLabel: line.label, phoneNumber: line.phoneNumber, planName: extra?.planName ?? null })
        : kind === "line_resumed"
          ? lineResumedEmail({ lineLabel: line.label, phoneNumber: line.phoneNumber })
          : lineSuspendedEmail({ lineLabel: line.label, phoneNumber: line.phoneNumber, lost: Boolean(extra?.lost), reason: extra?.reason ?? null });
    await queueMobileEmail(db, { tenantId: line.tenantId, kind, email, to, entityType: "MobileLine", entityId: line.id });
  } catch {
    /* notification must never fail the lifecycle action */
  }
}

export const LOOPCOM_SIM_GROUP_NAME = "LoopCom Mobile";
/** The SPN shown on the handset's carrier line for whitelabel eSIMs. */
export const LOOPCOM_ESIM_SPN = "LoopCom";

async function encryptSecret(value: string): Promise<string | null> {
  try {
    const sec = await import("@connect/security");
    if (!sec.hasCredentialsMasterKey()) return null;
    return sec.encryptJson({ v: value });
  } catch {
    return null;
  }
}

async function decryptSecret(enc: string): Promise<string | null> {
  try {
    const sec = await import("@connect/security");
    const out = sec.decryptJson<{ v: string }>(enc);
    return out?.v ?? null;
  } catch {
    return null;
  }
}

/** Find-or-create the platform's SIM card group (free; groups gate data limits + enable). */
export async function ensureLoopcomSimGroup(creds: StoredTelnyxCredentials): Promise<string | null> {
  const groups = await listSimCardGroups(creds);
  const existing = groups.find((g) => g.name === LOOPCOM_SIM_GROUP_NAME) ?? groups.find((g) => g.isDefault);
  if (existing) return existing.id;
  const created = await createSimCardGroup(creds, LOOPCOM_SIM_GROUP_NAME);
  return created.id;
}

/** Upsert the local mirror of one Telnyx SIM. Never overwrites tenant/line linkage. */
export async function upsertSimMirror(db: any, sim: WirelessSimCard, extras?: { tenantId?: string | null }): Promise<any> {
  const base = {
    iccid: sim.iccid,
    type: sim.type || "esim",
    status: sim.status,
    esimInstallationStatus: sim.esimInstallationStatus,
    eid: sim.eid,
    msisdn: sim.msisdn,
    voiceEnabled: sim.voiceEnabled,
    simCardGroupId: sim.simCardGroupId,
    dataLimitMb: sim.dataLimitMb,
    lastSyncAt: new Date(),
    raw: sim.raw ?? undefined,
  };
  return db.mobileSim.upsert({
    where: { telnyxSimId: sim.id },
    update: base,
    create: {
      telnyxSimId: sim.id,
      tenantId: extras?.tenantId ?? null,
      ...base,
    },
  });
}

/**
 * Fetch + store (encrypted) the eSIM activation code for a local SIM row that
 * doesn't have one yet. Physical SIMs and already-installed eSIMs have none.
 */
export async function ensureActivationCodeStored(db: any, creds: StoredTelnyxCredentials, simRowId: string): Promise<boolean> {
  const row = await db.mobileSim.findUnique({ where: { id: simRowId } });
  if (!row || row.type !== "esim" || row.activationCodeEnc) return Boolean(row?.activationCodeEnc);
  let code: string | null = null;
  try {
    code = await getEsimActivationCode(creds, row.telnyxSimId);
  } catch {
    return false; // installed/ineligible eSIMs answer an error; nothing to store
  }
  if (!code) return false;
  const enc = await encryptSecret(code);
  if (!enc) return false;
  await db.mobileSim.update({ where: { id: simRowId }, data: { activationCodeEnc: enc } });
  return true;
}

/** Decrypt the activation code for a tenant-owned SIM. Tenant check is the caller's job at the route. */
export async function readActivationCode(db: any, simRowId: string): Promise<string | null> {
  const row = await db.mobileSim.findUnique({ where: { id: simRowId } });
  if (!row?.activationCodeEnc) return null;
  return decryptSecret(row.activationCodeEnc);
}

/**
 * ⛔ REAL MONEY. Purchase ONE eSIM and attach it to a line. The purchase is
 * never retried; every step after it is recoverable (an eSIM that got bought
 * but not saved is picked up by importUnknownSims on the next reconcile).
 */
export async function provisionEsimForLine(db: any, creds: StoredTelnyxCredentials, input: {
  lineId: string;
  actorUserId?: string | null;
  whitelabel?: boolean;
}): Promise<{ ok: true; simRowId: string } | { ok: false; error: string }> {
  const line = await db.mobileLine.findUnique({ where: { id: input.lineId }, include: { sim: true } });
  if (!line) return { ok: false, error: "line_not_found" };
  if (line.sim && line.sim.status !== "deleted") return { ok: false, error: "line_already_has_sim" };
  if (line.status === "terminated") return { ok: false, error: "line_terminated" };

  const groupId = await ensureLoopcomSimGroup(creds);

  // The one non-retryable moment.
  const sims = await purchaseEsims(creds, {
    amount: 1,
    simCardGroupId: groupId,
    whitelabelName: input.whitelabel === false ? null : LOOPCOM_ESIM_SPN,
    status: "standby",
    tags: [`tenant:${line.tenantId}`, `line:${line.id}`],
  });
  const sim = sims[0];
  if (!sim) return { ok: false, error: "purchase_returned_no_sim" };

  let simRow: any;
  try {
    simRow = await upsertSimMirror(db, sim, { tenantId: line.tenantId });
    await db.mobileLine.update({
      where: { id: line.id },
      data: { simId: simRow.id, status: "pending_activation", needsReconcile: false, reconcileReason: null },
    });
  } catch (err: any) {
    // The eSIM EXISTS on Telnyx now. Flag the line; the reconcile pass will
    // import the SIM (tagged line:<id>) and re-attach.
    await db.mobileLine.update({
      where: { id: line.id },
      data: { needsReconcile: true, reconcileReason: `esim purchased (telnyx ${sim.id}) but local save failed: ${String(err?.message || err).slice(0, 160)}` },
    }).catch(() => undefined);
    return { ok: false, error: "purchased_but_not_saved" };
  }

  await ensureActivationCodeStored(db, creds, simRow.id).catch(() => undefined);
  await writeMobileAuditSync({
    tenantId: line.tenantId,
    action: "mobile.esim.provisioned",
    entityType: "MobileLine",
    entityId: line.id,
    actorUserId: input.actorUserId ?? null,
    metadata: { telnyxSimId: sim.id, iccid: sim.iccid, whitelabel: input.whitelabel !== false },
  });
  const planName = line.planId ? (await db.mobilePlan.findUnique({ where: { id: line.planId }, select: { name: true } }))?.name ?? null : null;
  await notifyLifecycle(db, line, "esim_ready", { planName });
  return { ok: true, simRowId: simRow.id };
}

/** Suspend = take the SIM off the network. Free, reversible, number preserved. */
export async function suspendLine(db: any, creds: StoredTelnyxCredentials, input: {
  lineId: string;
  tenantId?: string; // when set, the line must belong to this tenant (self-service path)
  reason: string;
  lost?: boolean;
  actorUserId?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const line = await db.mobileLine.findUnique({ where: { id: input.lineId }, include: { sim: true } });
  if (!line || (input.tenantId && line.tenantId !== input.tenantId)) return { ok: false, error: "line_not_found" };
  if (line.status === "terminated") return { ok: false, error: "line_terminated" };

  if (line.sim?.telnyxSimId) {
    await disableSim(creds, line.sim.telnyxSimId); // async on Telnyx's side; sync job confirms
  }
  await db.mobileLine.update({
    where: { id: line.id },
    data: {
      status: input.lost ? "lost" : "suspended",
      suspendedAt: new Date(),
      suspendReason: input.reason.slice(0, 300),
      needsReconcile: Boolean(line.sim?.telnyxSimId),
      reconcileReason: line.sim?.telnyxSimId ? "awaiting telnyx disable confirmation" : null,
    },
  });
  await writeMobileAuditSync({
    tenantId: line.tenantId,
    action: input.lost ? "mobile.line.reported_lost" : "mobile.line.suspend",
    entityType: "MobileLine",
    entityId: line.id,
    actorUserId: input.actorUserId ?? null,
    metadata: { reason: input.reason.slice(0, 300) },
  });
  await notifyLifecycle(db, line, "line_suspended", { lost: input.lost, reason: input.reason.slice(0, 300) });
  return { ok: true };
}

/** Resume a suspended/lost line: enable the SIM again. */
export async function resumeLine(db: any, creds: StoredTelnyxCredentials, input: {
  lineId: string;
  tenantId?: string;
  actorUserId?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const line = await db.mobileLine.findUnique({ where: { id: input.lineId }, include: { sim: true } });
  if (!line || (input.tenantId && line.tenantId !== input.tenantId)) return { ok: false, error: "line_not_found" };
  if (line.status !== "suspended" && line.status !== "lost") return { ok: false, error: "line_not_suspended" };
  if (!line.sim?.telnyxSimId) return { ok: false, error: "line_has_no_sim" };

  await enableSim(creds, line.sim.telnyxSimId);
  await db.mobileLine.update({
    where: { id: line.id },
    data: { status: "active", suspendedAt: null, suspendReason: null, needsReconcile: true, reconcileReason: "awaiting telnyx enable confirmation" },
  });
  await writeMobileAuditSync({
    tenantId: line.tenantId,
    action: "mobile.line.resume",
    entityType: "MobileLine",
    entityId: line.id,
    actorUserId: input.actorUserId ?? null,
  });
  await notifyLifecycle(db, line, "line_resumed");
  return { ok: true };
}

/**
 * Reconcile pass, safe to run repeatedly:
 *  1. every Telnyx SIM the DB doesn't know → local row (recovers
 *     purchased-but-not-saved, honors tenant:/line: tags);
 *  2. every known SIM → status refresh;
 *  3. lines whose optimistic status now matches the provider → clear
 *     needsReconcile; activation detected (enabled SIM on a
 *     pending_activation line) → line becomes active.
 */
export async function reconcileSimsWithTelnyx(db: any, creds: StoredTelnyxCredentials): Promise<{ imported: number; refreshed: number; activated: number }> {
  const providerSims = await listSimCards(creds);
  let imported = 0;
  let refreshed = 0;
  let activated = 0;

  for (const sim of providerSims) {
    const known = await db.mobileSim.findUnique({ where: { telnyxSimId: sim.id } });
    if (!known) {
      const tenantTag = sim.tags.find((t) => t.startsWith("tenant:"))?.slice("tenant:".length) ?? null;
      const lineTag = sim.tags.find((t) => t.startsWith("line:"))?.slice("line:".length) ?? null;
      const row = await upsertSimMirror(db, sim, { tenantId: tenantTag });
      imported += 1;
      if (lineTag) {
        const line = await db.mobileLine.findUnique({ where: { id: lineTag } });
        if (line && !line.simId) {
          await db.mobileLine.update({
            where: { id: line.id },
            data: { simId: row.id, status: line.status === "draft" ? "pending_activation" : line.status, needsReconcile: false, reconcileReason: null },
          });
        }
      }
      await ensureActivationCodeStored(db, creds, row.id).catch(() => undefined);
      continue;
    }

    await upsertSimMirror(db, sim);
    refreshed += 1;
  }

  // Line-state reconciliation.
  const pendingLines = await db.mobileLine.findMany({
    where: { OR: [{ needsReconcile: true }, { status: "pending_activation" }] },
    include: { sim: true },
  });
  for (const line of pendingLines) {
    if (!line.sim?.telnyxSimId) continue;
    const sim = providerSims.find((s) => s.id === line.sim.telnyxSimId) ?? (await getSimCard(creds, line.sim.telnyxSimId));
    if (!sim) continue;
    const simEnabled = sim.status === "enabled";
    const simDisabled = sim.status === "disabled" || sim.status === "standby";
    let update: any = null;
    if (line.status === "pending_activation" && simEnabled) {
      update = { status: "active", activatedAt: line.activatedAt ?? new Date(), needsReconcile: false, reconcileReason: null };
      activated += 1;
    } else if ((line.status === "suspended" || line.status === "lost") && simDisabled) {
      update = { needsReconcile: false, reconcileReason: null };
    } else if (line.status === "active" && simEnabled) {
      update = { needsReconcile: false, reconcileReason: null };
    }
    if (update) await db.mobileLine.update({ where: { id: line.id }, data: update });
  }

  return { imported, refreshed, activated };
}

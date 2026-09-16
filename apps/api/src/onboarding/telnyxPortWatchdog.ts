/**
 * The TELNYX sign-up sweep (2026-09-16): lands submitted Telnyx ports and
 * confirms Telnyx 911 activations. The Telnyx sibling of portWatchdog.ts,
 * which stays VoIP.ms-only (it selects `provisioning.portFiled`, a VoIP.ms
 * field no Telnyx submission writes — the two sweeps can never both act on
 * one row).
 *
 * Per paid submission with `portFiling.provider === "telnyx"`:
 *   • re-read every Telnyx porting order (status + FOC date onto the record);
 *   • a refused filing (`needs_attention`) is RE-TRIED by the filer once a
 *     person has fixed the paperwork in Telnyx — the filer is idempotent;
 *   • when EVERY order reads `ported` → the LANDING:
 *       1. the number is on the account: re-assert connection + messaging +
 *          customer reference, list the caller name;
 *       2. 911 onto the ported number at the SAME Telnyx address;
 *       3. the PBX: the ported number's inbound route takes the temporary
 *          number's destination (the VoIP.ms landing's own helper), and the
 *          outbound caller ID switches from the temporary number to the real
 *          one — ⛔ ONLY now, because Telnyx refuses an unowned caller ID
 *          outright (403 D51), so the build used the temporary number;
 *       4. texting: the ported number joins the tenant's inbox;
 *       5. the customer's "your number is live" email.
 *     ⛔ The temporary number is KEPT (not released): it is the tenant's
 *     registered 911 callback number on the emergency route, and releasing it
 *     would leave emergency calls presenting a number Telnyx refuses.
 *
 * Every landing step is recorded under portLanding.<step> and skipped once
 * done, so a sweep that dies half-way resumes where it stopped.
 */
import { db as realDb } from "@connect/db";
import { resolveTelnyxCredentials } from "../telnyx/telnyxCredentials";
import {
  configureOwnedNumber,
  enableEmergency,
  findOwnedNumber,
  getPortingOrder,
  setNumberCnam,
  telnyxErrorDetail,
} from "../telnyx/telnyxOnboardingClient";
import { PORT_COMPLETE_EMAIL_TYPE, buildPortCompleteEmail, resolvePortCompleteRecipient } from "./portCompleteEmail";

export type TelnyxSweepDeps = {
  db: any;
  resolveCreds: typeof resolveTelnyxCredentials;
  getPortingOrder: typeof getPortingOrder;
  findOwnedNumber: typeof findOwnedNumber;
  configureOwnedNumber: typeof configureOwnedNumber;
  setNumberCnam: typeof setNumberCnam;
  enableEmergency: typeof enableEmergency;
  refile: (row: any, portedDid: string) => Promise<void>;
  copyPbxDestination?: (db: any, tenantId: string, tempDid: string, portedDid: string) => Promise<{ copied: boolean; detail: string }>;
  switchOutboundCallerId?: (row: any, portedDid: string) => Promise<{ switched: boolean; detail: string }>;
  publishTenant?: (tenantId: string) => Promise<void>;
  queueE911Email?: (submissionId: string) => Promise<void>;
  /** Re-run the Telnyx 911 registration for a submission (telnyxProvisioning.applyTelnyxE911). */
  retryE911?: (row: any) => Promise<void>;
  raiseE911Alert?: (row: any) => Promise<void>;
};

async function logEvent(db: any, submissionId: string, message: string): Promise<void> {
  try {
    await db.onboardingEvent.create({ data: { submissionId, type: "STATUS_CHANGED", message: message.slice(0, 480) } });
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

const tenDigits = (v: unknown) => String(v ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/** The outbound caller-ID switch, wired to the real panel. Needs the route id the build stored. */
export async function defaultSwitchOutboundCallerId(row: any, portedDid: string): Promise<{ switched: boolean; detail: string }> {
  const routeId = String(row?.answers?.provisioning?.pbxOutboundRouteId || "");
  if (!routeId) return { switched: false, detail: "the build did not record its outbound route id" };
  const { loadPanelConfig, PanelSession } = await import("./panelClient");
  const { acquireAccount, releaseAccount } = await import("./setupOrchestrator");
  const { editOutboundRoute, applyAndRebake } = await import("../pbxConsole/pbxConsoleWrites");
  const cfg = loadPanelConfig();
  if (!cfg) return { switched: false, detail: "panel not configured" };
  const account = await acquireAccount(cfg);
  try {
    const s = await new PanelSession(cfg.baseUrl, account).login();
    await editOutboundRoute(s, cfg.mainTenant, routeId, { cidNumber: portedDid });
    const log = { info: () => {}, warn: () => {}, error: () => {} } as any;
    await applyAndRebake(s, cfg.mainTenant, { db: realDb, log, pbxInstanceId: null }, "telnyx-port-landing");
    return { switched: true, detail: `outbound route ${routeId} now presents ${portedDid}` };
  } finally {
    releaseAccount(account);
  }
}

export function defaultTelnyxSweepDeps(): TelnyxSweepDeps {
  return {
    db: realDb,
    resolveCreds: resolveTelnyxCredentials,
    getPortingOrder,
    findOwnedNumber,
    configureOwnedNumber,
    setNumberCnam,
    enableEmergency,
    refile: async (row, portedDid) => {
      const ctx = row?.answers?.provisioning?.telnyx;
      if (!ctx?.connectionId) return;
      const { fileTelnyxPortForSubmission } = await import("./telnyxPortFiling");
      const full = await realDb.onboardingSubmission.findUnique({ where: { id: row.id }, include: { uploadedFiles: true } } as any);
      await fileTelnyxPortForSubmission(full, portedDid, ctx);
    },
    copyPbxDestination: async (db, tenantId, tempDid, portedDid) => {
      const { defaultCopyPbxDestination } = await import("./portLanding");
      return defaultCopyPbxDestination(db, tenantId, tempDid, portedDid);
    },
    switchOutboundCallerId: defaultSwitchOutboundCallerId,
    retryE911: async (row) => {
      await retryTelnyxE911ForSubmission(row.id);
    },
    raiseE911Alert: async (row) => {
      const { raiseE911EscalationIfNeeded } = await import("./e911Escalation");
      await raiseE911EscalationIfNeeded(realDb, row);
    },
    queueE911Email: async (submissionId) => {
      const { queueE911ActivatedEmail } = await import("./e911ActivatedEmail");
      await queueE911ActivatedEmail({ db: realDb, submissionId, log: (m: string) => logEvent(realDb, submissionId, m) });
    },
  };
}

/**
 * Retry 911 for one Telnyx sign-up NOW — the sweep's retry and the admin
 * "retry 911" route share this one implementation.
 */
export async function retryTelnyxE911ForSubmission(submissionId: string): Promise<{ ok: boolean; status: string; detail: string }> {
  const row: any = await realDb.onboardingSubmission.findUnique({ where: { id: submissionId } });
  if (!row) return { ok: false, status: "not_found", detail: "no such sign-up" };
  if (String(row?.answers?.phone?.provider || "") !== "telnyx") return { ok: false, status: "unsupported", detail: "911 retry is built for Telnyx sign-ups only" };
  const did = tenDigits(row?.answers?.provisioning?.e911?.did || row.provisionedDid);
  if (did.length !== 10) return { ok: false, status: "no_number", detail: "the sign-up has no number yet" };
  const { realTelnyxDeps, applyTelnyxE911 } = await import("./telnyxProvisioning");
  const deps = realTelnyxDeps();
  const creds = await deps.resolveCreds(realDb as never).catch(() => null);
  if (!creds) return { ok: false, status: "unconfigured", detail: "Telnyx credentials missing" };
  const n = await deps.findOwnedNumber(creds, `+1${did}`);
  if (!n) return { ok: false, status: "number_not_on_account", detail: `+1${did} is not on the Telnyx account` };
  await applyTelnyxE911(creds, deps, row, did, n.id);
  const e911: any = row?.answers?.provisioning?.e911 || {};
  return { ok: e911.status === "provisioned" || e911.status === "pending_activation", status: String(e911.status || "unknown"), detail: String(e911.detail || "") };
}

export type TelnyxSweepSummary = { ports: number; landed: number; e911Confirmed: number; errors: number; e911Retried?: number };

/** Hourly for the first 6 tries, then every 6 hours — a manual validation at the carrier can take a day. */
export function e911RetryDue(e911: any, now = Date.now()): boolean {
  if (e911?.provider !== "telnyx" || e911?.status !== "failed") return false;
  const attempts = Number(e911.attempts || 1);
  const last = new Date(e911.lastTriedAt || e911.at || 0).getTime();
  const waitMs = attempts < 6 ? 60 * 60_000 : 6 * 60 * 60_000;
  return now - last >= waitMs;
}

async function retryFailedE911(deps: TelnyxSweepDeps, row: any, summary: TelnyxSweepSummary): Promise<void> {
  const e911: any = row?.answers?.provisioning?.e911;
  if (!deps.retryE911 || !e911RetryDue(e911)) return;
  await deps.retryE911(row);
  summary.e911Retried = (summary.e911Retried || 0) + 1;
  const fresh = await deps.db.onboardingSubmission.findUnique({ where: { id: row.id } });
  const now: any = fresh?.answers?.provisioning?.e911;
  if (now?.status === "provisioned") {
    await logEvent(deps.db, row.id, `911 is now registered on ${now.did} (automatic retry).`);
    if (fresh.pbxSetupStatus === "done" && deps.queueE911Email) await deps.queueE911Email(row.id);
  } else if (now?.status === "pending_activation") {
    await logEvent(deps.db, row.id, `911 accepted on ${now.did} (automatic retry) — waiting for the carrier to activate it.`);
  } else if (deps.raiseE911Alert && fresh?.pbxSetupStatus === "done") {
    await deps.raiseE911Alert(fresh);
  }
  if (fresh) row.answers = fresh.answers;
}

let running = false;

export async function sweepTelnyxSignups(deps: TelnyxSweepDeps = defaultTelnyxSweepDeps()): Promise<TelnyxSweepSummary> {
  const summary: TelnyxSweepSummary = { ports: 0, landed: 0, e911Confirmed: 0, errors: 0 };
  if (running) return summary;
  running = true;
  try {
    const { db } = deps;
    const rows: any[] = await db.onboardingSubmission.findMany({
      where: { paidAt: { not: null }, status: { not: "CANCELED" }, answers: { path: ["phone", "provider"], equals: "telnyx" } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const open = rows.filter((r) => {
      const p: any = r?.answers?.provisioning || {};
      const portOpen = p.portFiling?.provider === "telnyx" && !p.portLanding?.completedAt;
      const e911Pending = p.e911?.provider === "telnyx" && (p.e911?.status === "pending_activation" || p.e911?.status === "failed");
      return portOpen || e911Pending;
    });
    if (!open.length) return summary;
    const creds = await deps.resolveCreds(db).catch(() => null);
    if (!creds) return summary;

    for (const row of open) {
      try {
        await confirmPendingE911(deps, creds, row, summary);
        await retryFailedE911(deps, row, summary);
        const filing: any = row?.answers?.provisioning?.portFiling;
        if (filing?.provider !== "telnyx" || row?.answers?.provisioning?.portLanding?.completedAt) continue;
        summary.ports++;
        const portedDid = tenDigits(filing.portedDid || row?.answers?.phone?.details?.numbers);
        if (portedDid.length !== 10) continue;

        if (filing.status === "needs_attention" || filing.status === "filing") {
          // The filer is idempotent — a person may have fixed the paperwork.
          // ⛔ ONLY once the number stage has FINISHED: while it is still
          // running, its first filing may not have saved its order id yet, and
          // a concurrent re-file would open a SECOND port order on the
          // customer's number.
          if (row.numberStatus === "ready") await deps.refile(row, portedDid);
          continue;
        }
        const ids: string[] = Array.isArray(filing.orderIds) ? filing.orderIds : [];
        if (!ids.length) continue;
        const statuses: Record<string, string> = { ...(filing.telnyxStatus || {}) };
        let focDate: string | null = filing.focDate || null;
        const details: string[] = [];
        for (const id of ids) {
          const o = await deps.getPortingOrder(creds, id);
          const next = String(o.status || statuses[id] || "").toLowerCase();
          if (next && next !== statuses[id]) {
            await logEvent(db, row.id, `Port of ${portedDid}: Telnyx order ${id} is now "${next}"${o.focDate ? ` (date ${o.focDate})` : ""}${o.statusDetails.length ? ` — ${o.statusDetails.join("; ").slice(0, 200)}` : ""}.`);
          }
          statuses[id] = next;
          if (o.focDate) focDate = o.focDate;
          details.push(...o.statusDetails);
        }
        const allPorted = ids.every((id) => statuses[id] === "ported");
        const anyCancelled = ids.some((id) => statuses[id] === "cancelled");
        await mergeProvisioning(db, row, {
          portFiling: {
            ...filing,
            telnyxStatus: statuses,
            focDate,
            status: allPorted ? "ported" : anyCancelled ? "needs_attention" : filing.status,
            ...(anyCancelled ? { error: `Telnyx order cancelled${details.length ? `: ${details.join("; ").slice(0, 300)}` : ""}` } : {}),
          },
        });
        if (allPorted) {
          const done = await landTelnyxPort(deps, creds, row, portedDid);
          if (done) summary.landed++;
        }
      } catch (e) {
        summary.errors++;
        await logEvent(db, row.id, `Telnyx sweep hiccup: ${telnyxErrorDetail(e)} — retried next sweep.`);
      }
    }
    return summary;
  } finally {
    running = false;
  }
}

async function confirmPendingE911(deps: TelnyxSweepDeps, creds: any, row: any, summary: TelnyxSweepSummary): Promise<void> {
  const e911: any = row?.answers?.provisioning?.e911;
  if (e911?.provider !== "telnyx" || e911?.status !== "pending_activation") return;
  const did = tenDigits(e911.did);
  if (did.length !== 10) return;
  const n = await deps.findOwnedNumber(creds, `+1${did}`);
  if (String(n?.emergencyStatus || "").toLowerCase() !== "active") return;
  await mergeProvisioning(deps.db, row, { e911: { ...e911, status: "provisioned", detail: "telnyx:active", at: new Date().toISOString() } });
  await logEvent(deps.db, row.id, `911 is now ACTIVE on ${did} (Telnyx confirmed).`);
  summary.e911Confirmed++;
  // The "E911 is set" email waits for a finished build — the orchestrator
  // sends it at the end; this covers a build that finished before activation.
  if (row.pbxSetupStatus === "done" && deps.queueE911Email) await deps.queueE911Email(row.id);
}

/** Returns true once every landing step is done. Each step is recorded and skipped next time. */
export async function landTelnyxPort(deps: TelnyxSweepDeps, creds: any, row: any, portedDid: string): Promise<boolean> {
  const { db } = deps;
  const prov: any = row?.answers?.provisioning || {};
  const landing: any = { ...(prov.portLanding || {}) };
  const ctx: any = prov.telnyx || {};
  const e164 = `+1${portedDid}`;
  const save = async (patch: Record<string, any>) => {
    Object.assign(landing, patch);
    await mergeProvisioning(db, row, { portLanding: { ...landing } });
  };

  if (!landing.numberConfiguredAt) {
    const n = await deps.findOwnedNumber(creds, e164);
    if (!n) {
      await logEvent(db, row.id, `Port of ${portedDid} reads "ported" but the number is not on the account yet — checking again next sweep.`);
      return false;
    }
    if (ctx.connectionId) {
      await deps.configureOwnedNumber(creds, n.id, { connectionId: ctx.connectionId, messagingProfileId: ctx.messagingProfileId ?? null, customerReference: ctx.customerReference ?? null });
    }
    await deps.setNumberCnam(creds, n.id, String(row.companyName || "")).catch(() => {});
    await save({ numberConfiguredAt: new Date().toISOString(), portedNumberId: n.id });
    await logEvent(db, row.id, `${portedDid} is on Loopcom's carrier account — routed to the phone system.`);
  }

  if (!landing.e911At) {
    const addressId = String(prov.telnyxE911AddressId || "");
    if (addressId && landing.portedNumberId) {
      try {
        const r = await deps.enableEmergency(creds, landing.portedNumberId, addressId);
        await save({ e911At: new Date().toISOString(), e911Status: r.status || "requested" });
        await logEvent(db, row.id, `911 requested on ${portedDid} at the same address as the temporary number (${r.status || "activating"}).`);
      } catch (e) {
        await logEvent(db, row.id, `⛔ 911 on the ported number ${portedDid} FAILED (${telnyxErrorDetail(e)}) — calls work; 911 on this number needs a person.`);
        await save({ e911At: new Date().toISOString(), e911Status: "failed" });
      }
    } else {
      await save({ e911At: new Date().toISOString(), e911Status: "no_address_on_record" });
      await logEvent(db, row.id, `⛔ No Telnyx 911 address on record for this sign-up — 911 on ${portedDid} needs a person.`);
    }
  }

  const tenantId = String(row.createdTenantId || "");
  const tempDid = tenDigits(prov.temporaryDid || row.provisionedDid);
  // ⛔ The number already lived on our PBX in ANOTHER tenant before the port
  // (Loopcom's own 845-723-1213 → T35): it keeps ringing there by DID, so the
  // landing must not copy destinations, switch this tenant's caller ID to it, or
  // move its texting row to this tenant.
  const existingOwner = String(prov.portedDidExistingPbxTenant || "");
  if (existingOwner && (!landing.pbxDestinationAt || !landing.callerIdAt || !landing.textingAt)) {
    await save({
      pbxDestinationAt: landing.pbxDestinationAt || new Date().toISOString(),
      pbxDestination: `kept in existing PBX tenant ${existingOwner}`,
      callerIdAt: landing.callerIdAt || new Date().toISOString(),
      callerId: "unchanged (number belongs to another tenant)",
      textingAt: landing.textingAt || new Date().toISOString(),
    });
    await logEvent(db, row.id, `${portedDid} landed on the new carrier and keeps ringing PBX tenant ${existingOwner} — no PBX, caller-ID or texting change made.`);
  }

  if (!landing.pbxDestinationAt) {
    if (!tenantId || !deps.copyPbxDestination) {
      await save({ pbxDestinationAt: new Date().toISOString(), pbxDestination: "skipped (no tenant or no PBX helper)" });
    } else {
      const r = await deps.copyPbxDestination(db, tenantId, tempDid, portedDid).catch((e: any) => ({ copied: false, detail: String(e?.message || e) }));
      if (!r.copied && !/nothing to copy|no decodable/.test(r.detail)) {
        await logEvent(db, row.id, `The ported number's inbound route could not copy the temporary number's destination yet (${r.detail}) — retried next sweep.`);
        return false;
      }
      await save({ pbxDestinationAt: new Date().toISOString(), pbxDestination: r.detail });
      if (/Connect-owned/.test(r.detail)) {
        await logEvent(db, row.id, `⛔ The temporary number ${tempDid} runs a Loopcom menu — ${portedDid} still rings the build's first extension. Point it at the same menu in IVR Studio (needs a person).`);
      }
      if (deps.publishTenant) await deps.publishTenant(tenantId).catch(() => {});
    }
  }

  if (!landing.callerIdAt) {
    if (!deps.switchOutboundCallerId) {
      await save({ callerIdAt: new Date().toISOString(), callerId: "skipped" });
    } else {
      const r = await deps.switchOutboundCallerId(row, portedDid).catch((e: any) => ({ switched: false, detail: String(e?.message || e).slice(0, 200) }));
      if (!r.switched) {
        await logEvent(db, row.id, `⛔ Outbound caller ID still shows the temporary number (${r.detail}) — retried next sweep.`);
        return false;
      }
      await save({ callerIdAt: new Date().toISOString(), callerId: r.detail });
      await logEvent(db, row.id, `Outgoing calls now show ${portedDid}.`);
    }
  }

  if (!landing.textingAt) {
    if (tenantId && row.smsEnabled) {
      await db.tenantSmsNumber.upsert({
        where: { phoneE164: e164 },
        create: { tenantId, provider: "TELNYX", phoneE164: e164, phoneRaw: e164, smsCapable: true, mmsCapable: true, isTenantDefault: false, active: true, lastSyncedAt: new Date() },
        update: { tenantId, provider: "TELNYX", smsCapable: true, mmsCapable: true, active: true, lastSyncedAt: new Date() },
      });
      await logEvent(db, row.id, `${portedDid} added to the texting inbox (carrier texting follows the business registration).`);
    }
    await save({ textingAt: new Date().toISOString() });
  }

  if (!landing.emailedAt) {
    const to = await resolvePortCompleteRecipient(db, row, tenantId);
    if (to) {
      // ⛔ No tempDid: the temporary number stays ON (it is the 911 callback
      // number), so the "it is switched off" paragraph would be false.
      const mail = buildPortCompleteEmail({ portedDid });
      await db.emailJob.create({
        data: { tenantId: tenantId || null, invoiceId: null, type: PORT_COMPLETE_EMAIL_TYPE, toEmail: to.email, subject: mail.subject, htmlBody: mail.html, textBody: mail.text },
      }).catch(() => {});
      await logEvent(db, row.id, `Customer told their number is live — emailed ${to.email}.`);
    }
    await save({ emailedAt: new Date().toISOString() });
  }

  await save({ completedAt: new Date().toISOString() });
  await logEvent(db, row.id, `Port of ${portedDid} LANDED — calls, caller ID, 911 and texting are on the real number.`);
  return true;
}

/** Arm the sweep: boot kick beside the interval (the house timer rule), kill switch. */
export function startTelnyxSignupSweep(log: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void }, extra: Partial<TelnyxSweepDeps> = {}): { stop: () => void } {
  if (String(process.env.TELNYX_SIGNUP_SWEEP_DISABLED || "") === "1") {
    log.info({}, "TELNYX_SIGNUP_SWEEP disabled by env");
    return { stop: () => {} };
  }
  const everyMs = Number(process.env.TELNYX_SIGNUP_SWEEP_MS || 10 * 60_000);
  const run = () =>
    void sweepTelnyxSignups({ ...defaultTelnyxSweepDeps(), ...extra })
      .then((s) => {
        if (s.landed || s.e911Confirmed || s.errors) log.warn({ telnyxSignupSweep: s }, "telnyx signup sweep took action");
      })
      .catch(() => {});
  log.info({ everyMs }, "TELNYX_SIGNUP_SWEEP_ARMED");
  const kick = setTimeout(run, 90_000);
  (kick as any).unref?.();
  const timer = setInterval(run, everyMs);
  (timer as any).unref?.();
  return { stop: () => { clearTimeout(kick); clearInterval(timer); } };
}

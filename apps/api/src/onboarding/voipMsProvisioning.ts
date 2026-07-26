import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { db } from "@connect/db";
import { decryptJson, encryptJson } from "@connect/security";

/**
 * VoIP.ms number provisioning for an onboarding submission.
 *
 * Runs in the background as soon as the customer finishes the "Your number"
 * step (and is retried on final submit if it hasn't completed). The result —
 * DID + subaccount credentials — is what the VitalPBX build stage uses for
 * the tenant trunk.
 *
 *  Every path creates ONE subaccount named after the company (BobsPlumbing1):
 *    username + generated password, device type "Asterisk/IP-PBX", CallerID
 *    left to the device ("I have my own CallerID"), nothing more.
 *
 *  New number  → order the selected DID (or just route it if it already sits
 *                unassigned in our master account), point it at the subaccount,
 *                POP New York 1, SMS on when requested.
 *  Port        → submit the port-in (addLNPPort) + attach LOA/bill, AND give
 *                the customer a TEMPORARY number right away: pick a spare DID
 *                already in the account (not routed to any subaccount), or buy
 *                one if none is spare. Marked didIsTemporary until the port
 *                completes.
 *
 * SAFETY GATE: nothing is charged and no port is filed unless
 * VOIPMS_AUTO_PROVISION="on". With the gate off (default) this is a SIMULATED
 * run — it logs exactly what it would do as submission events, generates the
 * subaccount credentials locally, and marks the submission ready so the rest
 * of the pipeline (PBX build, sync, invites) can be exercised end-to-end.
 */

const VMS_BASE_DEFAULT = "https://voip.ms/api/v1/rest.php";
/** SIP host the tenant trunk registers to (recorded flow). */
export const VOIPMS_TRUNK_SERVER = "newyork1.voip.ms";

export type VmsCreds = { username: string; password: string; apiBaseUrl?: string };
export type ProvisionedSubaccount = { username: string; password: string; server: string };
export type ProvisionResult = { ok: boolean; live: boolean; detail: string };

function liveEnabled(): boolean {
  return String(process.env.VOIPMS_AUTO_PROVISION || "").toLowerCase() === "on";
}

async function loadMasterCreds(): Promise<VmsCreds | null> {
  const row = await (db as any).globalVoipMsConfig.findUnique({ where: { id: "default" } });
  if (!row?.credentialsEncrypted) return null;
  try {
    const c = decryptJson<any>(row.credentialsEncrypted);
    if (!c?.username || !c?.password) return null;
    return { username: c.username, password: c.password, apiBaseUrl: row.apiBaseUrl || c.apiBaseUrl };
  } catch {
    return null;
  }
}

/** One VoIP.ms REST call. Throws with VoIP.ms's own status text on failure. */
async function vms(creds: VmsCreds, method: string, params: Record<string, string> = {}): Promise<any> {
  const base = (creds.apiBaseUrl || VMS_BASE_DEFAULT).replace(/\/$/, "");
  const url = new URL(base);
  url.searchParams.set("api_username", creds.username);
  url.searchParams.set("api_password", creds.password);
  url.searchParams.set("method", method);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { method: "GET" });
  const json: any = await res.json().catch(() => ({}));
  if (String(json?.status || "").toLowerCase() !== "success") {
    throw new Error(`voipms ${method} failed: ${json?.status || "no_response"}`);
  }
  return json;
}

/** VoIP.ms subaccount name = sanitized company name + index (BobsPlumbing1). */
export function subAccountName(company: string, index = 1): string {
  const clean = String(company || "account").replace(/[^A-Za-z0-9]+/g, "").slice(0, 18) || "account";
  return `${clean}${index}`;
}

function generatePassword(): string {
  // Strong, symbol-free (VoIP.ms subaccount passwords are alphanumeric-safe).
  return randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 18) + "9a";
}

function tenDigits(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

async function logEvent(submissionId: string, message: string): Promise<void> {
  try {
    await (db as any).onboardingEvent.create({ data: { submissionId, type: "STATUS_CHANGED", message: message.slice(0, 480) } });
  } catch {
    /* event logging is best-effort */
  }
}

/** Find the VoIP.ms POP id for New York 1 (falls back to a blank/default POP). */
async function resolveNewYorkPop(creds: VmsCreds): Promise<string> {
  try {
    const r = await vms(creds, "getServersInfo");
    const servers: any[] = Array.isArray(r?.servers) ? r.servers : [];
    const ny = servers.find((s) => /new\s*york\s*1?/i.test(String(s?.server_name || s?.server_shortname || "")));
    return String(ny?.server_pop ?? ny?.pop ?? "");
  } catch {
    return "";
  }
}

function onboardingStorageRoot(): string {
  return (process.env.ONBOARDING_STORAGE_DIR || path.resolve(process.cwd(), "data/onboarding-files")).replace(/\\/g, "/");
}

/** Read the stored subaccount credentials for a submission (used by the PBX build). */
export function readSubaccount(row: any): ProvisionedSubaccount | null {
  if (!row?.voipmsSubaccountEncrypted) return null;
  try {
    const c = decryptJson<any>(row.voipmsSubaccountEncrypted);
    if (!c?.username || !c?.password) return null;
    return { username: c.username, password: c.password, server: c.server || VOIPMS_TRUNK_SERVER };
  } catch {
    return null;
  }
}

// ── Subaccount ────────────────────────────────────────────────────────────────

/**
 * Create (or find) the per-company subaccount. Returns full SIP username
 * ("<master>_<CompanyName1>") + password + server. Only the settings Izzy
 * specified are sent: username, password, Asterisk/IP-PBX device type; the
 * CallerID number is deliberately left unset so the device's own CallerID is
 * used ("I have my own CallerID"), everything else stays at VoIP.ms defaults.
 */
async function ensureSubaccount(
  creds: VmsCreds,
  submissionId: string,
  company: string,
  live: boolean,
): Promise<ProvisionedSubaccount> {
  const subName = subAccountName(company, 1);
  const password = generatePassword();

  if (!live) {
    await logEvent(submissionId, `[dry-run] Create subaccount ${subName} (Asterisk/IP-PBX, own device CallerID) → <account>_${subName}.`);
    return { username: `${creds.username}_${subName}`, password, server: VOIPMS_TRUNK_SERVER };
  }

  // Idempotent: reuse the subaccount if a previous run already created it.
  // VoIP.ms names subaccounts "<accountNumber>_<subName>" and the account
  // number is NOT the API username (that's the login email) — match on the
  // "_<subName>" suffix and take the provider's own account string.
  try {
    const existing = await vms(creds, "getSubAccounts");
    const list: any[] = Array.isArray(existing?.accounts) ? existing.accounts : [];
    const hit = list.find((a) => String(a?.account || "").toLowerCase().endsWith(`_${subName.toLowerCase()}`));
    if (hit) {
      // We can't read the old password back — rotate it so the trunk config works.
      await vms(creds, "setSubAccount", { id: String(hit.id), password });
      await logEvent(submissionId, `Subaccount ${hit.account} already existed — password rotated.`);
      return { username: String(hit.account), password, server: VOIPMS_TRUNK_SERVER };
    }
  } catch {
    /* fall through to create */
  }

  const r = await vms(creds, "createSubAccount", {
    username: subName,
    password,
    protocol: "1",     // SIP
    auth_type: "1",    // username/password
    device_type: "2",  // Asterisk, IP PBX, Gateway or VoIP Switch
    lock_international: "1",
    international_route: "1",
    music_on_hold: "default",
    allowed_codecs: "ulaw;g729",
    dtmf_mode: "auto",
    nat: "yes",
  });
  const account = String(r?.account || "");
  if (!account) throw new Error("voipms createSubAccount returned no account name");
  await logEvent(submissionId, `Subaccount ${account} created (Asterisk/IP-PBX, own device CallerID).`);
  return { username: account, password, server: VOIPMS_TRUNK_SERVER };
}

// ── DIDs ──────────────────────────────────────────────────────────────────────

/** True when this DID already exists in the master account. Returns its info row. */
async function findAccountDid(creds: VmsCreds, did: string): Promise<any | null> {
  try {
    const r = await vms(creds, "getDIDsInfo", { did });
    const rows: any[] = Array.isArray(r?.dids) ? r.dids : [];
    return rows.find((d) => tenDigits(d?.did) === did) || null;
  } catch {
    return null;
  }
}

/**
 * Pick a spare DID for a port-in customer: any DID in the master account not
 * routed to a subaccount (subaccount routings contain "_"). Returns "" when
 * nothing spare is available.
 */
async function findSpareDid(creds: VmsCreds): Promise<string> {
  try {
    const r = await vms(creds, "getDIDsInfo");
    const rows: any[] = Array.isArray(r?.dids) ? r.dids : [];
    const spare = rows.find((d) => {
      const routing = String(d?.routing || "");
      return routing.startsWith("account:") && !routing.includes("_");
    });
    return spare ? tenDigits(spare.did) : "";
  } catch {
    return "";
  }
}

/** Order a brand-new DID routed straight to the subaccount, POP New York 1. */
async function orderDid(creds: VmsCreds, submissionId: string, did: string, subUsername: string): Promise<void> {
  const pop = await resolveNewYorkPop(creds);
  await vms(creds, "orderDID", {
    did,
    routing: `account:${subUsername}`,
    pop,
    dialtime: "60",
    cnam: "1",
    billing_type: "1",
  });
  await logEvent(submissionId, `DID ${did} ordered → routed to ${subUsername} (POP New York 1).`);
}

/** Point an already-owned DID at the subaccount. */
async function routeDid(creds: VmsCreds, submissionId: string, did: string, subUsername: string): Promise<void> {
  await vms(creds, "setDIDRouting", { did, routing: `account:${subUsername}` });
  await logEvent(submissionId, `DID ${did} routed to ${subUsername}.`);
}

/** Turn SMS on for a DID (best-effort — logged, never fatal). */
async function enableSms(creds: VmsCreds, submissionId: string, did: string, live: boolean): Promise<void> {
  if (!live) {
    await logEvent(submissionId, `[dry-run] Enable SMS on ${did}.`);
    return;
  }
  // VoIP.ms answers "sms_wait_message" on freshly-ordered DIDs — retry with a
  // pause before giving up (SMS is best-effort and never fails the stage).
  const retryMs = Number(process.env.ONBOARDING_RETRY_BASE_MS || 3000);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await vms(creds, "setSMS", { did, enable: "1" });
      await logEvent(submissionId, `SMS enabled on ${did}.`);
      return;
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/sms_wait_message/i.test(msg) && attempt < 4) {
        await new Promise((r) => setTimeout(r, retryMs * attempt * 3));
        continue;
      }
      await logEvent(submissionId, `SMS enable on ${did} failed: ${msg.slice(0, 160)}`);
      return;
    }
  }
}

// ── Port-in ───────────────────────────────────────────────────────────────────

async function submitPortIn(creds: VmsCreds, row: any, live: boolean): Promise<void> {
  const submissionId = row.id;
  const answers: any = row.answers || {};
  const port = answers?.phone?.details || {};
  const did = tenDigits(port.numbers);
  if (did.length !== 10) throw new Error("port_number_invalid");

  const files: any[] = row.uploadedFiles || [];
  if (!live) {
    await logEvent(submissionId, `[dry-run] Submit port-in for ${did} (carrier ${port.carrier || "?"}, account ${port.accountNumber || "?"}); attach ${files.length} document(s).`);
    return;
  }

  const submit = await vms(creds, "addLNPPort", {
    did,
    carrier: String(port.carrier || ""),
    account_number: String(port.accountNumber || ""),
    pin: String(port.portPin || ""),
    name: String(port.nameOnAccount || row.companyName || ""),
    service_address: String(port.serviceAddress || ""),
  });
  const portId = String(submit?.portid ?? submit?.port_id ?? "");
  await logEvent(submissionId, `Port-in submitted for ${did} (id ${portId || "?"}).`);

  // Attach LOA + bill (addLNPFile expects base64 file content).
  for (const f of files) {
    try {
      const full = path.resolve(onboardingStorageRoot(), String(f.storageKey || ""));
      const b64 = fs.readFileSync(full).toString("base64");
      await vms(creds, "addLNPFile", { portid: portId, file: b64, filename: String(f.filename || "document") });
      await logEvent(submissionId, `Attached ${f.kind === "PORTING_LOA" ? "authorization" : "bill"} (${f.filename}) to port ${portId || "?"}.`);
    } catch (e: any) {
      await logEvent(submissionId, `Could not attach ${f.filename}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Provision the number + subaccount for a submission. Idempotent: safe to call
 * again (e.g. retried on final submit); it skips when already ready and won't
 * double-run while another call is in flight.
 */
export async function applyOnboardingNumber(submissionId: string): Promise<ProvisionResult> {
  const live = liveEnabled();

  const row = await (db as any).onboardingSubmission.findUnique({
    where: { id: submissionId },
    include: { uploadedFiles: true },
  } as any);
  if (!row) return { ok: false, live, detail: "submission_not_found" };
  if (row.numberStatus === "ready") return { ok: true, live, detail: "already_ready" };
  // A previous DRY run doesn't count once the gate is on — redo it for real.
  if (row.numberStatus === "ready_dryrun" && !live) return { ok: true, live, detail: "already_ready" };
  if (row.numberStatus === "provisioning") return { ok: false, live, detail: "already_running" };

  await (db as any).onboardingSubmission.update({ where: { id: submissionId }, data: { numberStatus: "provisioning" } });

  const creds = await loadMasterCreds();
  if (!creds) {
    await (db as any).onboardingSubmission.update({ where: { id: submissionId }, data: { numberStatus: "failed", setupError: "provider_unconfigured" } });
    await logEvent(submissionId, "VoIP.ms provisioning skipped — master account not configured.");
    return { ok: false, live, detail: "provider_unconfigured" };
  }

  const answers: any = row.answers || {};
  const company: string = row.companyName || answers?.company?.companyName || answers?.submit?.companyName || "account";
  const choice = String(row.phoneNumberChoice || answers?.phone?.choice || "new");
  const smsEnabled = !!(row.smsEnabled || answers?.addons?.smsEnabled);

  try {
    const sub = await ensureSubaccount(creds, submissionId, company, live);

    let did = "";
    let temporary = false;

    if (choice === "port") {
      // File the port, then hand out a temporary number immediately.
      await submitPortIn(creds, row, live);
      temporary = true;
      if (live) {
        did = await findSpareDid(creds);
        if (did) {
          await logEvent(submissionId, `Using spare number ${did} as temporary number until the port completes.`);
          await routeDid(creds, submissionId, did, sub.username);
        } else {
          const search = await vms(creds, "searchDIDsUSA", { type: "starts", query: "" }).catch(() => null);
          const first = Array.isArray(search?.dids) ? tenDigits(search.dids[0]?.did) : "";
          if (!first) throw new Error("no_temporary_did_available");
          did = first;
          await logEvent(submissionId, `No spare number in the account — buying ${did} as temporary number.`);
          await orderDid(creds, submissionId, did, sub.username);
        }
      } else {
        did = tenDigits(answers?.phone?.details?.numbers) || "8450000000";
        await logEvent(submissionId, `[dry-run] Assign a temporary number (spare or newly bought) → route to ${sub.username}.`);
      }
    } else {
      did = tenDigits(answers?.phone?.selectedNumber);
      if (did.length !== 10) throw new Error("no_number_selected");
      if (live) {
        const owned = await findAccountDid(creds, did);
        if (owned) {
          // Already ours (spare in the master account) — no purchase, just point it.
          await routeDid(creds, submissionId, did, sub.username);
        } else {
          await orderDid(creds, submissionId, did, sub.username);
        }
      } else {
        await logEvent(submissionId, `[dry-run] Order/route DID ${did} → ${sub.username} (POP New York 1).`);
      }
    }

    if (smsEnabled && did) await enableSms(creds, submissionId, did, live);

    await (db as any).onboardingSubmission.update({
      where: { id: submissionId },
      data: {
        numberStatus: live ? "ready" : "ready_dryrun",
        provisionedDid: did || null,
        didIsTemporary: temporary,
        voipmsSubaccountEncrypted: encryptJson(sub),
        setupError: null,
      },
    });
    await logEvent(submissionId, `${live ? "" : "[dry-run] "}Number stage ready — ${did}${temporary ? " (temporary until port completes)" : ""} on ${sub.username}.`);
    return { ok: true, live, detail: choice === "port" ? "port_submitted_temp_assigned" : "number_ready" };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    await (db as any).onboardingSubmission.update({
      where: { id: submissionId },
      data: { numberStatus: "failed", setupError: msg },
    });
    await logEvent(submissionId, `VoIP.ms provisioning error: ${msg}`);
    return { ok: false, live, detail: "error" };
  }
}

/** Turn SMS on after the fact (the add-ons step comes after the number step). */
export async function syncOnboardingSms(submissionId: string): Promise<void> {
  const row = await (db as any).onboardingSubmission.findUnique({ where: { id: submissionId } });
  if (!row?.smsEnabled || !row?.provisionedDid) return;
  const creds = await loadMasterCreds();
  if (!creds) return;
  await enableSms(creds, submissionId, row.provisionedDid, liveEnabled());
}

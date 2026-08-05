import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { db } from "@connect/db";
import { decryptJson, encryptJson } from "@connect/security";
import { ensureProvisioningIdentity, subAccountName } from "./provisioningIdentity";

export { subAccountName };

/**
 * VoIP.ms number provisioning for an onboarding submission.
 *
 * Runs in the background as soon as the customer finishes the "Your number"
 * step (and is retried on final submit if it hasn't completed). The result —
 * DID + subaccount credentials — is what the VitalPBX build stage uses for
 * the tenant trunk.
 *
 *  Every path creates ONE subaccount per SUBMISSION (company + submission tag,
 *    e.g. BobsPlumk3f9a2 — see provisioningIdentity.ts; never the company name
 *    alone, so two same-named customers can never collide): username +
 *    generated password, device type "Asterisk/IP-PBX", CallerID left to the
 *    device ("I have my own CallerID"), nothing more.
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

/**
 * One VoIP.ms REST call. Throws with VoIP.ms's own status text on failure.
 *
 * Hardened: every request carries a 30s timeout (a hung call here pins the
 * whole number stage), and transport failures — timeouts, connection errors,
 * and the HTML error pages Cloudflare serves during VoIP.ms outages (521/522,
 * body starts with "<" so it isn't JSON) — are retried up to 3 times with
 * exponential backoff. A real API answer with a non-success status is NOT
 * retried; that's VoIP.ms saying no, not an outage.
 */
async function vms(creds: VmsCreds, method: string, params: Record<string, string> = {}, timeoutMs = 30_000): Promise<any> {
  const base = (creds.apiBaseUrl || VMS_BASE_DEFAULT).replace(/\/$/, "");
  const url = new URL(base);
  url.searchParams.set("api_username", creds.username);
  url.searchParams.set("api_password", creds.password);
  url.searchParams.set("method", method);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const attempts = 3;
  const backoffBase = Number(process.env.VOIPMS_RETRY_BASE_MS || 1000);
  let lastTransport = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let json: any = null;
    try {
      const res = await fetch(url.toString(), { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
      json = await res.json();
    } catch (e: any) {
      // Timeout, connection failure, or a non-JSON (HTML) body — all outages.
      lastTransport = String(e?.name === "TimeoutError" ? "timeout" : e?.message || e).slice(0, 120);
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, backoffBase * 2 ** (attempt - 1)));
        continue;
      }
      throw new Error(`voipms ${method} failed: provider_unreachable (${lastTransport})`);
    }
    if (String(json?.status || "").toLowerCase() !== "success") {
      const status = String(json?.status || "no_response").trim();
      const detail = [json?.error, json?.message, json?.description, json?.reason]
        .map((v) => String(v || "").replace(/\s+/g, " ").trim())
        .find((v) => v && v.toLowerCase() !== status.toLowerCase());
      throw new Error(`voipms ${method} failed: ${status}${detail ? ` (${detail.slice(0, 160)})` : ""}`);
    }
    return json;
  }
  throw new Error(`voipms ${method} failed: provider_unreachable (${lastTransport})`);
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

/**
 * Durable per-submission provisioning state, kept inside the answers JSON
 * (answers.provisioning). This is what makes retries safe: the port id and
 * the temporary DID survive a crash, so a re-run reuses them instead of
 * filing a second port or buying a second number.
 */
async function mergeProvisioningState(row: any, patch: Record<string, any>): Promise<void> {
  const answers = { ...(row.answers || {}) };
  answers.provisioning = { ...(answers.provisioning || {}), ...patch };
  row.answers = answers;
  await (db as any).onboardingSubmission.update({ where: { id: row.id }, data: { answers } });
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
 * Create (or find) the per-submission subaccount. Returns full SIP username
 * ("<master>_<subName>") + password + server. subName is the submission's
 * stored provisioning identity (unique per submission — see
 * provisioningIdentity.ts), so the reuse path below can only ever touch THIS
 * submission's own subaccount, never another customer's. Only the settings
 * Izzy specified are sent: username, password, Asterisk/IP-PBX device type;
 * the CallerID number is deliberately left unset so the device's own CallerID
 * is used ("I have my own CallerID"), everything else stays at VoIP.ms
 * defaults.
 */
async function ensureSubaccount(
  creds: VmsCreds,
  submissionId: string,
  subName: string,
  live: boolean,
): Promise<ProvisionedSubaccount> {
  const password = generatePassword();

  if (!live) {
    await logEvent(submissionId, `[dry-run] Create subaccount ${subName} (Asterisk/IP-PBX, own device CallerID) → <account>_${subName}.`);
    return { username: `${creds.username}_${subName}`, password, server: VOIPMS_TRUNK_SERVER };
  }

  // Idempotent: reuse the subaccount if a previous run already created it.
  // VoIP.ms names subaccounts "<accountNumber>_<subName>" and the account
  // number is NOT the API username (that's the login email) — match on the
  // "_<subName>" suffix and take the provider's own account string.
  // A transient lookup failure must NOT abort — createSubAccount below
  // self-heals on used_username by re-looking-up and reusing.
  let hit: any = null;
  try {
    hit = await findExistingSubaccount(creds, subName);
  } catch {
    /* transient — fall through to create, which self-heals */
  }
  if (hit) return await reuseSubaccount(creds, submissionId, hit, password);

  try {
    const r = await vms(creds, "createSubAccount", {
      username: subName,
      password,
      protocol: "1",     // SIP
      auth_type: "1",    // username/password
      device_type: "1",  // Asterisk, IP PBX, Gateway or VoIP Switch (2 = ATA/IP phone — verified via getDeviceTypes)
      lock_international: "1",
      international_route: "1",
      music_on_hold: "default",
      allowed_codecs: "ulaw;g729",
      dtmf_mode: "auto",
      nat: "yes",
    }, 120_000);
    const account = String(r?.account || "");
    if (!account) throw new Error("voipms createSubAccount returned no account name");
    await logEvent(submissionId, `Subaccount ${account} created (Asterisk/IP-PBX, own device CallerID).`);
    return { username: account, password, server: VOIPMS_TRUNK_SERVER };
  } catch (e: any) {
    // used_username = it already exists (e.g. an earlier interrupted run made
    // it while VoIP.ms was flaky and our pre-lookup missed it). Reuse it.
    // Live 2026-07-27: "Ezra Store 1" failed three times in a row on exactly
    // this, permanently blocking the submission.
    if (String(e?.message || "").includes("used_username")) {
      const again = await findExistingSubaccount(creds, subName);
      if (again) return await reuseSubaccount(creds, submissionId, again, password);
    }
    throw e;
  }
}

async function findExistingSubaccount(creds: VmsCreds, subName: string): Promise<any | null> {
  const existing = await vms(creds, "getSubAccounts");
  const list: any[] = Array.isArray(existing?.accounts) ? existing.accounts : [];
  return list.find((a) => String(a?.account || "").toLowerCase().endsWith(`_${subName.toLowerCase()}`)) || null;
}

/**
 * Reuse an existing subaccount: we can't read its password back, so rotate it.
 * Rotation is safe ONLY because subaccount names are unique per submission —
 * the account being rotated is this submission's own earlier creation, never
 * another customer's live trunk (rotating that would kill their dial tone).
 * VoIP.ms setSubAccount is a full update — resend the account's own current
 * settings (from getSubAccounts) alongside the new password, otherwise the
 * call fails and the old code swallowed that and died on used_username.
 */
async function reuseSubaccount(
  creds: VmsCreds,
  submissionId: string,
  hit: any,
  password: string,
): Promise<ProvisionedSubaccount> {
  await vms(creds, "setSubAccount", {
    id: String(hit.id),
    password,
    auth_type: String(hit.auth_type || "1"),
    protocol: String(hit.protocol || "1"),
    device_type: String(hit.device_type || "1"),
    lock_international: String(hit.lock_international || "1"),
    international_route: String(hit.international_route || "1"),
    music_on_hold: String(hit.music_on_hold || "default"),
    allowed_codecs: String(hit.allowed_codecs || "ulaw;g729"),
    dtmf_mode: String(hit.dtmf_mode || "auto"),
    nat: String(hit.nat || "yes"),
    ...(hit.internal_extension ? { internal_extension: String(hit.internal_extension) } : {}),
    ...(hit.description ? { description: String(hit.description) } : {}),
    // 120s: setSubAccount is VoIP.ms's slowest write — under their 2026-08-05
    // degradation it kept blowing the default 30s while eventually completing
    // server-side (aborting the request does not cancel their operation).
  }, 120_000);
  await logEvent(submissionId, `Subaccount ${hit.account} already existed — password rotated.`);
  return { username: String(hit.account), password, server: VOIPMS_TRUNK_SERVER };
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

export type SpareDid = { did: string; location: string; sms: boolean };

/**
 * All SPARE DIDs in the master account: already purchased but not routed to
 * any subaccount (subaccount routings contain "_"). These are the numbers we
 * want to hand out FIRST — use up stock before buying new ones.
 */
export async function listSpareDids(creds: VmsCreds): Promise<SpareDid[]> {
  try {
    const r = await vms(creds, "getDIDsInfo");
    const rows: any[] = Array.isArray(r?.dids) ? r.dids : [];
    return rows
      .filter((d) => {
        const routing = String(d?.routing || "");
        return routing.startsWith("account:") && !routing.includes("_");
      })
      .map((d) => ({
        did: tenDigits(d.did),
        location: [d?.ratecenter, d?.state].filter(Boolean).join(", "),
        sms: d?.sms == null || String(d.sms) === "1",
      }))
      .filter((d) => d.did.length === 10);
  } catch {
    return [];
  }
}

/**
 * Pick a spare DID, preferring the customer's own area code so a Monsey
 * business doesn't end up on a Texas number. Returns "" when nothing spare
 * is available.
 */
async function findSpareDid(creds: VmsCreds, areaCode = ""): Promise<string> {
  const spares = await listSpareDids(creds);
  const local = areaCode ? spares.find((s) => s.did.startsWith(areaCode)) : undefined;
  return (local || spares[0])?.did || "";
}

/**
 * The area code new/temporary numbers should be bought in: the number being
 * ported, falling back to the company's main phone. An unseeded searchDIDsUSA
 * returns the first DID anywhere in the US — that's how a customer porting a
 * 212 number could be handed a random out-of-state temporary.
 */
function preferredAreaCode(row: any): string {
  const ported = tenDigits(row?.answers?.phone?.details?.numbers);
  if (ported.length === 10) return ported.slice(0, 3);
  const main = tenDigits(row?.mainPhone);
  return main.length === 10 ? main.slice(0, 3) : "";
}

/**
 * Buy a new DID for the subaccount: search the preferred area code first,
 * fall back to a nationwide search only when that area code has no stock.
 */
async function searchAndOrderDid(
  creds: VmsCreds,
  submissionId: string,
  areaCode: string,
  subUsername: string,
  failCode: string,
): Promise<string> {
  const queries = areaCode ? [areaCode, ""] : [""];
  for (const q of queries) {
    const search = await vms(creds, "searchDIDsUSA", { type: "starts", query: q }).catch(() => null);
    const first = Array.isArray(search?.dids) ? tenDigits(search.dids[0]?.did) : "";
    if (!first) continue;
    if (q && q !== first.slice(0, 3)) continue; // provider ignored the seed — don't trust it
    await orderDid(creds, submissionId, first, subUsername);
    return first;
  }
  throw new Error(failCode);
}

/**
 * Temporary number for a port-in customer: reuse the one a previous run
 * already assigned (persisted in answers.provisioning), else route a spare,
 * else buy one in the customer's area code.
 */
async function ensureTemporaryDid(creds: VmsCreds, submissionId: string, row: any, subUsername: string): Promise<string> {
  const persisted = tenDigits(row?.answers?.provisioning?.tempDid);
  if (persisted.length === 10) {
    await logEvent(submissionId, `Reusing temporary number ${persisted} from the earlier run.`);
    await routeDid(creds, submissionId, persisted, subUsername);
    return persisted;
  }
  const areaCode = preferredAreaCode(row);
  const spare = await findSpareDid(creds, areaCode);
  let did: string;
  if (spare) {
    await logEvent(submissionId, `Using spare number ${spare} as temporary number until the port completes.`);
    await routeDid(creds, submissionId, spare, subUsername);
    did = spare;
  } else {
    did = await searchAndOrderDid(creds, submissionId, areaCode, subUsername, "no_temporary_did_available");
    await logEvent(submissionId, `No spare number in the account — bought ${did} as temporary number.`);
  }
  await mergeProvisioningState(row, { tempDid: did });
  return did;
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

  // A port for this number may already be on file from an earlier run that
  // died later in the stage — filing again would open a SECOND port on the
  // customer's live number. The filed flag + port id persist in
  // answers.provisioning, so a retry only picks up what's left (attachments).
  const prov: any = answers?.provisioning || {};
  let portId = String(prov.portId || "");
  if (prov.portFiled) {
    await mergeProvisioningState(row, { portSubmissionFailure: null, portSubmissionFailedAt: null });
    await logEvent(submissionId, `Port-in for ${did} already on file (id ${portId || "?"}) — not filing a second one.`);
  } else {
    const submit = await vms(creds, "addLNPPort", {
      did,
      carrier: String(port.carrier || ""),
      account_number: String(port.accountNumber || ""),
      pin: String(port.portPin || ""),
      name: String(port.nameOnAccount || row.companyName || ""),
      service_address: String(port.serviceAddress || ""),
    });
    portId = String(submit?.portid ?? submit?.port_id ?? "");
    await mergeProvisioningState(row, {
      portFiled: true,
      portId,
      portSubmissionFailure: null,
      portSubmissionFailedAt: null,
    });
    await logEvent(submissionId, `Port-in submitted for ${did} (id ${portId || "?"}).`);
  }

  // Attach LOA + bill (addLNPFile expects base64 file content). Successful
  // attachments are remembered so a retry doesn't re-send them; failures are
  // flagged so the owner's sign-up report says to chase the documents.
  const attached: string[] = Array.isArray(prov.attachedFileIds) ? [...prov.attachedFileIds] : [];
  const attachFailures: string[] = [];
  for (const f of files) {
    const fileKey = String(f.id ?? f.storageKey ?? f.filename ?? "");
    if (fileKey && attached.includes(fileKey)) continue;
    try {
      const full = path.resolve(onboardingStorageRoot(), String(f.storageKey || ""));
      const b64 = fs.readFileSync(full).toString("base64");
      await vms(creds, "addLNPFile", { portid: portId, file: b64, filename: String(f.filename || "document") });
      if (fileKey) attached.push(fileKey);
      await logEvent(submissionId, `Attached ${f.kind === "PORTING_LOA" ? "authorization" : "bill"} (${f.filename}) to port ${portId || "?"}.`);
    } catch (e: any) {
      attachFailures.push(String(f.filename || "document"));
      await logEvent(submissionId, `Could not attach ${f.filename}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  await mergeProvisioningState(row, { attachedFileIds: attached, portDocAttachFailures: attachFailures });
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
  if (row.numberStatus === "provisioning") {
    // In flight (apply-number background task). But if the API died mid-run
    // the row would stay "provisioning" forever — rows untouched beyond the
    // stale window are resumed instead (every step below is idempotent).
    const staleMs = Number(process.env.ONBOARDING_NUMBER_STALE_MS || 10 * 60_000);
    const age = Date.now() - new Date(row.updatedAt || 0).getTime();
    if (age < staleMs) return { ok: false, live, detail: "already_running" };
  }

  await (db as any).onboardingSubmission.update({ where: { id: submissionId }, data: { numberStatus: "provisioning" } });

  const creds = await loadMasterCreds();
  if (!creds) {
    await (db as any).onboardingSubmission.update({ where: { id: submissionId }, data: { numberStatus: "failed", setupError: "provider_unconfigured" } });
    await logEvent(submissionId, "VoIP.ms provisioning skipped — master account not configured.");
    return { ok: false, live, detail: "provider_unconfigured" };
  }

  const answers: any = row.answers || {};
  const choice = String(row.phoneNumberChoice || answers?.phone?.choice || "new");
  const smsEnabled = !!(row.smsEnabled || answers?.addons?.smsEnabled);

  try {
    // The names this submission provisions under — stored on the submission,
    // so retries always match what an earlier attempt created, and two
    // customers with the same company name can never share a subaccount.
    const identity = await ensureProvisioningIdentity(row);
    // Reuse credentials from an earlier partial run instead of rotating the
    // password again: rotation goes through setSubAccount, and when VoIP.ms's
    // write path degrades (2026-08-05: every setSubAccount timed out for 40+
    // minutes while reads answered in 2s) re-rotating on every retry blocks
    // the whole build for no gain. Stored creds are per-submission and only
    // ever written after a successful create/rotate of this submission's own
    // subaccount, so they can't belong to another customer.
    let sub = live ? readSubaccount(row) : null;
    if (sub) {
      await logEvent(submissionId, `Reusing subaccount ${sub.username} from the earlier run — password already set.`);
    } else {
      sub = await ensureSubaccount(creds, submissionId, identity.voipmsSubName, live);
      if (live) {
        // Persist immediately — losing a successful rotation because a LATER
        // step failed is what forced every retry back through setSubAccount.
        await (db as any).onboardingSubmission.update({
          where: { id: submissionId },
          data: { voipmsSubaccountEncrypted: encryptJson(sub) },
        });
      }
    }

    let did = "";
    let temporary = false;
    let portNeedsFollowUp = false;

    if (choice === "port") {
      // Temporary number FIRST, port second. The port is the irreversible
      // half — if it were filed first and the temporary-number step failed,
      // the retry would file a SECOND port on the customer's live number.
      temporary = true;
      if (live) {
        did = await ensureTemporaryDid(creds, submissionId, row, sub.username);
        try {
          await submitPortIn(creds, row, live);
        } catch (e: any) {
          // A carrier/API rejection must not strand a paid customer. Their
          // temporary DID is already live, so finish the phone-system build
          // and surface the port as an explicit operator follow-up.
          portNeedsFollowUp = true;
          const portError = String(e?.message || e).slice(0, 300);
          await mergeProvisioningState(row, {
            portSubmissionFailure: portError,
            portSubmissionFailedAt: new Date().toISOString(),
          });
          await logEvent(
            submissionId,
            `Port-in needs manual follow-up: ${portError}. Continuing setup on temporary number ${did}.`,
          );
        }
      } else {
        did = tenDigits(answers?.phone?.details?.numbers) || "8450000000";
        await logEvent(submissionId, `[dry-run] Assign a temporary number (spare or newly bought) → route to ${sub.username}.`);
        await submitPortIn(creds, row, live);
      }
    } else {
      did = tenDigits(answers?.phone?.selectedNumber);
      if (did.length !== 10) throw new Error("no_number_selected");
      if (live) {
        const owned = await findAccountDid(creds, did);
        if (owned) {
          // Already ours (spare in the master account) — no purchase, just
          // point it. But NEVER steal a number that another subaccount is
          // already using (two customers can pick the same spare from a
          // cached search). Exact account match — a substring test let
          // "Acme1" claim a number routed to "Acme10".
          const routing = String(owned.routing || "");
          const routedAccount = routing.startsWith("account:") ? routing.slice("account:".length) : "";
          if (routedAccount.includes("_") && routedAccount !== sub.username) {
            // The customer already PAID — don't dead-end the build over a
            // stale search result. Hand them the next best number in the
            // same area code and say so in the timeline.
            const areaCode = did.slice(0, 3);
            await logEvent(submissionId, `Number ${did} was taken by another customer meanwhile — picking a replacement in area code ${areaCode}.`);
            const spare = await findSpareDid(creds, areaCode);
            if (spare) {
              await routeDid(creds, submissionId, spare, sub.username);
              did = spare;
            } else {
              did = await searchAndOrderDid(creds, submissionId, areaCode, sub.username, "no_replacement_did_available");
            }
            await logEvent(submissionId, `Replacement number ${did} assigned instead of the taken one.`);
          } else {
            await routeDid(creds, submissionId, did, sub.username);
          }
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
    return {
      ok: true,
      live,
      detail: choice === "port"
        ? (portNeedsFollowUp ? "port_follow_up_temp_assigned" : "port_submitted_temp_assigned")
        : "number_ready",
    };
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

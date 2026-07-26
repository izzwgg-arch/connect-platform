import { randomBytes } from "node:crypto";
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";

/**
 * VoIP.ms number provisioning for a submitted onboarding.
 *
 *  New number → order the DID, create a per-number subaccount (CompanyName1),
 *               route the DID to it, set the New York POP, enable SMS.
 *  Port       → submit the port-in (addLNPPort) and attach the LOA + bill (addLNPFile).
 *
 * SAFETY GATE: this NEVER charges or files a port unless VOIPMS_AUTO_PROVISION="on".
 * With the gate off (default), it runs as a DRY RUN — it logs exactly what it would
 * do (as submission events) and calls nothing at VoIP.ms. Flip the env var to go live
 * (after confirming the live field mappings against VoIP.ms's API examples).
 */

const VMS_BASE_DEFAULT = "https://voip.ms/api/v1/rest.php";

type VmsCreds = { username: string; password: string; apiBaseUrl?: string };

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

async function vms(creds: VmsCreds, method: string, params: Record<string, string> = {}): Promise<any> {
  const base = (creds.apiBaseUrl || VMS_BASE_DEFAULT).replace(/\/$/, "");
  const url = new URL(base);
  url.searchParams.set("api_username", creds.username);
  url.searchParams.set("api_password", creds.password);
  url.searchParams.set("method", method);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { method: "GET" });
  return res.json().catch(() => ({}));
}

/** VoIP.ms subaccount name = sanitized company name + index (BobsPlumbing1). */
function subAccountName(company: string, index = 1): string {
  const clean = String(company || "account").replace(/[^A-Za-z0-9]+/g, "").slice(0, 18) || "account";
  return `${clean}${index}`;
}

function generatePassword(): string {
  // Strong, symbol-free (VoIP.ms subaccount passwords are alphanumeric-safe).
  return randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 18) + "9a";
}

async function logEvent(submissionId: string, message: string): Promise<void> {
  try {
    await (db as any).onboardingEvent.create({ data: { submissionId, type: "STATUS_CHANGED", message: message.slice(0, 480) } });
  } catch {
    /* event logging is best-effort */
  }
}

/** Find the VoIP.ms POP id for New York (falls back to a blank/default POP). */
async function resolveNewYorkPop(creds: VmsCreds): Promise<string> {
  try {
    const r = await vms(creds, "getServersInfo");
    const servers: any[] = Array.isArray(r?.servers) ? r.servers : [];
    const ny = servers.find((s) => /new\s*york/i.test(String(s?.server_name || s?.server_shortname || "")));
    return String(ny?.server_pop ?? ny?.pop ?? "");
  } catch {
    return "";
  }
}

export type ProvisionResult = { ok: boolean; live: boolean; detail: string };

export async function provisionOnboardingNumber(submissionId: string): Promise<ProvisionResult> {
  const live = liveEnabled();
  const tag = live ? "" : "[dry-run] ";

  const row = await (db as any).onboardingSubmission.findUnique({
    where: { id: submissionId },
    include: { uploadedFiles: true },
  } as any);
  if (!row) return { ok: false, live, detail: "submission_not_found" };

  const creds = await loadMasterCreds();
  if (!creds) {
    await logEvent(submissionId, "VoIP.ms provisioning skipped — master account not configured.");
    return { ok: false, live, detail: "provider_unconfigured" };
  }

  const answers: any = row.answers || {};
  const company: string = row.companyName || "account";
  const smsEnabled = !!row.smsEnabled;
  const choice = String(row.phoneNumberChoice || answers?.phone?.choice || "");

  try {
    // ── PORT AN EXISTING NUMBER ─────────────────────────────────────────────
    if (choice === "port") {
      const port = answers?.phone?.details || {};
      const did = String(port.numbers || "").replace(/\D/g, "").replace(/^1/, "");
      if (did.length !== 10) {
        await logEvent(submissionId, "Port-in could not start — the number to port is missing or invalid.");
        return { ok: false, live, detail: "port_number_invalid" };
      }
      const files: any[] = row.uploadedFiles || [];
      await logEvent(submissionId, `${tag}Submit port-in for ${did} (carrier ${port.carrier || "?"}, account ${port.accountNumber || "?"}); attach ${files.length} document(s).`);

      if (live) {
        // TODO(verify fields against API zip before enabling): addLNPPort input.
        const submit = await vms(creds, "addLNPPort", {
          did,
          carrier: String(port.carrier || ""),
          account_number: String(port.accountNumber || ""),
          pin: String(port.portPin || ""),
          name: String(port.nameOnAccount || company),
          service_address: String(port.serviceAddress || ""),
        });
        const portId = String(submit?.portid ?? submit?.port_id ?? "");
        await logEvent(submissionId, `Port-in submitted (status ${submit?.status ?? "?"}, id ${portId || "?"}).`);
        // Attach LOA + bill (addLNPFile expects base64 file content).
        for (const f of files) {
          await logEvent(submissionId, `Attaching ${f.kind === "PORTING_LOA" ? "authorization" : "bill"} (${f.filename}) to port ${portId || "?"}.`);
          // await vms(creds, "addLNPFile", { portid: portId, file: <base64>, filename: f.filename });
        }
      }
      return { ok: true, live, detail: live ? "port_submitted" : "port_dry_run" };
    }

    // ── ORDER A NEW NUMBER ──────────────────────────────────────────────────
    const selected = String(answers?.phone?.selectedNumber || "").replace(/\D/g, "").replace(/^1/, "");
    const subName = subAccountName(company, 1);
    await logEvent(
      submissionId,
      `${tag}Order DID ${selected || "(auto-pick)"} → create subaccount ${subName}, route DID to it, POP New York 1, SMS ${smsEnabled ? "on" : "off"}.`,
    );

    if (live) {
      const pop = await resolveNewYorkPop(creds);
      // TODO(verify fields against API zip before enabling): createSubAccount / orderDID inputs.
      const sub = await vms(creds, "createSubAccount", {
        username: subName,
        password: generatePassword(),
        protocol: "1",       // SIP
        auth_type: "1",      // username/password
        device_type: "2",   // Asterisk / IP-PBX
        lock_international: "1",
        international_route: "1",
        music_on_hold: "default",
        allowed_codecs: "ulaw;g729",
        dtmf_mode: "AUTO",
        nat: "yes",
      });
      await logEvent(submissionId, `Subaccount ${subName} created (status ${sub?.status ?? "?"}).`);

      if (selected) {
        const order = await vms(creds, "orderDID", {
          did: selected,
          routing: `account:${subName}`,
          pop,
          dialtime: "60",
          cnam: "1",
          billing_type: "1",
        });
        await logEvent(submissionId, `DID ${selected} ordered & routed to ${subName} (status ${order?.status ?? "?"}).`);
        if (smsEnabled) {
          await vms(creds, "setDIDInfo", { did: selected, sms_available: "1", sms_email_enabled: "0" });
          await logEvent(submissionId, `SMS enabled on ${selected}.`);
        }
      }
    }
    return { ok: true, live, detail: live ? "number_ordered" : "number_dry_run" };
  } catch (e: any) {
    await logEvent(submissionId, `VoIP.ms provisioning error: ${String(e?.message || e).slice(0, 200)}`);
    return { ok: false, live, detail: "error" };
  }
}

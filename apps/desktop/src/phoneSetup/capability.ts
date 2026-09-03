/**
 * The fence around everything the desktop app may do to a phone.
 *
 * ⛔⛔ THIS FILE IS THE SECURITY BOUNDARY. Everything above it — the server, the AI,
 * the wizard — can only ever ask for one of the operations named here, with a shape
 * this file validates. There is no "send this request", no "run this command", and
 * the ONE URL-shaped argument that exists (`set_provisioning.url`) is fenced to a
 * Loopcom provisioning folder by `isLoopcomProvisioningUrl` before anything reads
 * it. That narrowness is the whole point: a compromised Loopcom account must not
 * become a way to reach arbitrary things on a customer's network.
 *
 * ⛔ The server decides WHAT to do. This decides whether it is allowed AT ALL, and
 * then does exactly that and nothing else. A dumb hands, a smart head — so that
 * losing the head does not cost the customer their network.
 */

import { scanLan, type ScanResult } from "./lanScan";
import { sipOptionsProbe, type SipProbeResult } from "./sipProbe";
import {
  buildStatusRequest, fingerprintFromResponse, isLoopcomProvisioningUrl, isPrivateIpv4, requestWithSchemeFallback, sendAction, testCredentials,
  YEALINK_DEFAULT_CREDENTIALS, type DeviceFingerprint, type HttpTransport, type YealinkCredentials,
} from "./yealink";
import { normalizeMac } from "./pnp";
import { createPnpResident, PNP_RESIDENT_MAX_MACS, type PnpResident } from "./pnpResident";

/** Every operation that exists. Adding one is a deliberate act with its own test. */
export const PHONE_OPERATIONS = [
  "discover",
  "fingerprint",
  "test_credentials",
  "reboot",
  "trigger_autop",
  // 2026-09-02: hand a factory-reset phone its provisioning folder over PnP.
  // The URL it takes is fenced to a Loopcom PBX folder — see isLoopcomProvisioningUrl.
  "set_provisioning",
  // 2026-09-02 (same evening): the STANDING responder. `arm_pnp` hands the resident
  // listener the customer's folder + their own phones' hardware addresses; from then
  // on any of those phones that boots on this network is told its folder, wizard or
  // no wizard. `disarm_pnp` is sign-out. Both take the same fenced URL and nothing else.
  "arm_pnp",
  "disarm_pnp",
] as const;

export type PhoneOperation = (typeof PHONE_OPERATIONS)[number];

export type OperationRequest =
  | { op: "discover"; subnet?: string }
  | { op: "fingerprint"; ip: string; credentialRef?: string | null }
  | { op: "test_credentials"; ip: string; credentialRef?: string | null; useDefault?: boolean }
  | { op: "reboot"; ip: string; credentialRef?: string | null }
  | { op: "trigger_autop"; ip: string; credentialRef?: string | null }
  | { op: "arm_pnp"; url: string; macs: string[] }
  | { op: "disarm_pnp" }
  | {
      op: "set_provisioning"; ip: string; mac: string; url: string; credentialRef?: string | null;
      /** Restart the phone so it asks (PnP fires once per boot). Default true. */
      reboot?: boolean;
      waitMs?: number;
    };

export type OperationResult =
  | { ok: true; op: "discover"; scan: ScanResult }
  | { ok: true; op: "fingerprint"; fingerprint: DeviceFingerprint }
  | { ok: true; op: "test_credentials"; accepted: boolean; reason?: string }
  | { ok: true; op: "reboot" | "trigger_autop" }
  | {
      ok: true; op: "set_provisioning";
      /** The resident listener is bound and armed for this phone. */
      listening: true;
      /** The restart request was accepted by the phone's web interface. */
      rebooted: boolean; rebootRefused?: string;
      /** The phone asked and was told the folder (now, or earlier while armed). */
      delivered: boolean;
      /** The phone answered our NOTIFY (confirmation, not a requirement). */
      acknowledged: boolean;
      deliveredAt: number | null;
    }
  | { ok: true; op: "arm_pnp"; listening: boolean; macs: number; deliveries: number }
  | { ok: true; op: "disarm_pnp" }
  | { ok: false; refused: string };

/**
 * ⛔⛔ CREDENTIALS ARE NEVER PASSED IN. The caller hands over a REFERENCE — a name
 * for something already held in the operating system's own credential protection —
 * and this module resolves it locally. So a password never crosses the process
 * boundary, never appears in an IPC message, and cannot be read out of one.
 *
 * The single exception is the documented factory default, which is public knowledge
 * and is requested by a boolean rather than by value.
 */
export type CredentialResolver = (ref: string) => Promise<YealinkCredentials | null>;

export type CapabilityDeps = {
  http: HttpTransport;
  resolveCredential: CredentialResolver;
  scan?: (opts: { subnet?: string }) => Promise<ScanResult>;
  now?: () => number;
  /** The SIP identity probe, injectable for tests. Read-only: one OPTIONS packet. */
  sipProbe?: (ip: string) => Promise<SipProbeResult>;
  /** The standing PnP responder, injectable for tests. */
  pnpResident?: PnpResident;
};

/** How long `set_provisioning` waits for the phone to ask before answering the wizard. */
export const SET_PROVISIONING_DEFAULT_WAIT_MS = 3_000;
export const SET_PROVISIONING_MAX_WAIT_MS = 15_000;

/**
 * ⛔ Rate limits are here rather than on the server because the server is the thing
 * that might be compromised. A caller that has been told to reboot the same phone
 * two hundred times gets refused locally, on the customer's own machine.
 */
const MIN_MS_BETWEEN_ACTIONS_PER_PHONE = 5_000;
const MAX_ACTIONS_PER_MINUTE = 30;
/** A scan sweeps 254 addresses; there is no reason to do it more than this. */
const MIN_MS_BETWEEN_SCANS = 15_000;

type Gate = { lastActionAt: Map<string, number>; actionTimes: number[]; lastScanAt: number };

export function createPhoneCapability(deps: CapabilityDeps) {
  const resident: PnpResident = deps.pnpResident ?? createPnpResident();
  const now = deps.now ?? (() => Date.now());
  const gate: Gate = { lastActionAt: new Map(), actionTimes: [], lastScanAt: 0 };

  async function run(req: OperationRequest): Promise<OperationResult> {
    // ⛔ The operation name is checked against the list before anything else looks
    // at the request. An unknown op is refused without its arguments being read.
    if (!req || !(PHONE_OPERATIONS as readonly string[]).includes((req as any).op)) {
      return { ok: false, refused: "unknown_operation" };
    }

    if (req.op === "discover") {
      const t = now();
      if (t - gate.lastScanAt < MIN_MS_BETWEEN_SCANS) return { ok: false, refused: "too_soon" };
      gate.lastScanAt = t;
      const scan = await (deps.scan ?? ((o) => scanLan(o)))({ subnet: req.subnet });
      return { ok: true, op: "discover", scan };
    }

    if (req.op === "arm_pnp") {
      // ⛔ The same fence as set_provisioning; the list is the customer's OWN phones
      // as the PBX records them, and it is capped. The resident answers nothing else.
      const url = (req as any).url;
      if (!isLoopcomProvisioningUrl(url)) return { ok: false, refused: "not_a_loopcom_provisioning_url" };
      const list = Array.isArray((req as any).macs) ? (req as any).macs : [];
      if (list.length > PNP_RESIDENT_MAX_MACS) return { ok: false, refused: "too_many_hardware_addresses" };
      const macs = list.map(normalizeMac).filter((m: string | null): m is string => Boolean(m));
      const listening = await resident.arm({ url, macs });
      const st = resident.status();
      return { ok: true, op: "arm_pnp", listening, macs: st.macs, deliveries: st.deliveries.length };
    }
    if (req.op === "disarm_pnp") {
      resident.disarm();
      return { ok: true, op: "disarm_pnp" };
    }

    // Everything else targets one phone, and the address is checked here rather than
    // trusted from the caller.
    const ip = (req as any).ip;
    if (!isPrivateIpv4(ip)) return { ok: false, refused: "not_a_private_address" };

    const t = now();
    gate.actionTimes = gate.actionTimes.filter((ts) => t - ts < 60_000);
    if (gate.actionTimes.length >= MAX_ACTIONS_PER_MINUTE) return { ok: false, refused: "rate_limited" };
    const last = gate.lastActionAt.get(ip) ?? 0;
    // ⛔ Reads are cheap and safe; only things that CHANGE a phone are spaced out.
    // set_provisioning only changes the phone when it is asked to restart it; a
    // listen-and-check call is a read and rides the wizard's 4-second tick.
    const mutating = req.op === "reboot" || req.op === "trigger_autop"
      || (req.op === "set_provisioning" && (req as any).reboot !== false);
    if (mutating && t - last < MIN_MS_BETWEEN_ACTIONS_PER_PHONE) {
      return { ok: false, refused: "too_soon_for_this_phone" };
    }

    let creds: YealinkCredentials | null = null;
    if (req.op === "test_credentials" && req.useDefault) {
      creds = YEALINK_DEFAULT_CREDENTIALS;
    } else if ((req as any).credentialRef) {
      creds = await deps.resolveCredential(String((req as any).credentialRef));
      // ⛔ A reference that resolves to nothing is a refusal, never a silent
      // unauthenticated attempt: "we tried without a password" and "we tried with the
      // wrong one" are different answers and the wizard acts on them differently.
      if (!creds) return { ok: false, refused: "credential_not_available" };
    }

    gate.actionTimes.push(t);
    if (mutating) gate.lastActionAt.set(ip, t);

    switch (req.op) {
      case "fingerprint": {
        // ⛔ HTTP first, SIP second, and the SIP answer fills only what HTTP could
        // not. On the first customer run every device's web page was locked, so
        // the HTTP fingerprint said "unknown" about hardware that announces its
        // own make and model to anyone who asks over SIP (2026-08-25).
        const probeSip = deps.sipProbe ?? sipOptionsProbe;
        let http: DeviceFingerprint | null = null;
        try {
          const res = await requestWithSchemeFallback(deps.http, buildStatusRequest(ip, creds), () => buildStatusRequest(ip, creds, { https: true }));
          http = res ? fingerprintFromResponse(res) : null;
        } catch { http = null; }
        if (http && http.model && http.vendor !== "unknown") {
          return { ok: true, op: "fingerprint", fingerprint: http };
        }
        const sip = await probeSip(ip).catch(() => null);
        if (sip) {
          const merged: DeviceFingerprint = {
            vendor: http && http.vendor !== "unknown" ? http.vendor : sip.fingerprint.vendor,
            model: http?.model ?? sip.fingerprint.model,
            firmware: http?.firmware ?? sip.fingerprint.firmware,
            confidence: sip.fingerprint.confidence === "none" && http ? http.confidence : sip.fingerprint.confidence,
          };
          return { ok: true, op: "fingerprint", fingerprint: merged };
        }
        if (http) return { ok: true, op: "fingerprint", fingerprint: http };
        return { ok: false, refused: "unreachable" };
      }
      case "test_credentials": {
        const r = await testCredentials(deps.http, ip, creds);
        return { ok: true, op: "test_credentials", accepted: r.ok, reason: r.ok ? undefined : r.reason };
      }
      case "reboot":
      case "trigger_autop": {
        const action = req.op === "reboot" ? "reboot" : "autop";
        const r = await sendAction(deps.http, ip, action, creds);
        if (!r.ok) return { ok: false, refused: r.reason };
        return { ok: true, op: req.op };
      }
      case "set_provisioning": {
        // ⛔⛔ THE URL FENCE, before a socket exists. Only a Loopcom PBX folder.
        const url = (req as any).url;
        if (!isLoopcomProvisioningUrl(url)) return { ok: false, refused: "not_a_loopcom_provisioning_url" };
        const mac = normalizeMac((req as any).mac);
        if (!mac) return { ok: false, refused: "bad_hardware_address" };
        const waitMs = Math.min(SET_PROVISIONING_MAX_WAIT_MS, Math.max(0, Number((req as any).waitMs) || SET_PROVISIONING_DEFAULT_WAIT_MS));
        // ⛔ LISTEN FIRST, THEN RESTART. The resident listener is armed (or re-armed)
        // for this folder + this phone BEFORE any restart is asked for; PnP fires
        // once per boot and a responder that starts late misses a fast phone.
        const since = t;
        const already = resident.deliveryFor(mac, 0);
        const listening = await resident.arm({ url, macs: [mac] });
        if (!listening) return { ok: false, refused: "cannot_listen" };
        let rebooted = false;
        let rebootRefused: string | undefined;
        if ((req as any).reboot !== false) {
          // A reset phone is on the documented default; a phone the customer gave us
          // a password for uses that. Either way the restart is the same one verb.
          const r = await sendAction(deps.http, ip, "reboot", creds ?? YEALINK_DEFAULT_CREDENTIALS);
          rebooted = r.ok;
          if (!r.ok) rebootRefused = r.reason;
        }
        // A delivery that already happened (the phone booted while the resident was
        // armed by the app itself, before the wizard asked) counts — that is the point.
        const d = already ?? (await resident.waitForDelivery(mac, waitMs, since));
        return {
          ok: true, op: "set_provisioning", listening: true, rebooted, ...(rebootRefused ? { rebootRefused } : {}),
          delivered: Boolean(d), acknowledged: Boolean(d?.acknowledged), deliveredAt: d ? d.at : null,
        };
      }
      default:
        return { ok: false, refused: "unknown_operation" };
    }
  }

  return { run, operations: PHONE_OPERATIONS };
}

/**
 * ⛔⛔ FACTORY RESET IS NOT IN THIS FILE, AND THAT IS THE DESIGN.
 *
 * The reset a phone actually needs goes over SIP, from the PBX, to a handset that is
 * registered to us — no office access and no password. The local path only exists
 * for a phone that has never spoken to us, and wiring it here would mean the most
 * destructive operation in the product sat behind the same door as "what model is
 * this". It gets its own door, its own authorization record and its own audit row on
 * the server before anything local is asked to do anything.
 */
export const RESET_IS_NOT_A_LOCAL_CAPABILITY = true;

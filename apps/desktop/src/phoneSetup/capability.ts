/**
 * The fence around everything the desktop app may do to a phone.
 *
 * ⛔⛔ THIS FILE IS THE SECURITY BOUNDARY. Everything above it — the server, the AI,
 * the wizard — can only ever ask for one of the operations named here, with a shape
 * this file validates. There is no "send this request", no "run this command", no
 * URL parameter. That absence is the whole point: a compromised Loopcom account must
 * not become a way to reach arbitrary things on a customer's network.
 *
 * ⛔ The server decides WHAT to do. This decides whether it is allowed AT ALL, and
 * then does exactly that and nothing else. A dumb hands, a smart head — so that
 * losing the head does not cost the customer their network.
 */

import { scanLan, type ScanResult } from "./lanScan";
import {
  buildStatusRequest, fingerprintFromResponse, isPrivateIpv4, sendAction, testCredentials,
  YEALINK_DEFAULT_CREDENTIALS, type DeviceFingerprint, type HttpTransport, type YealinkCredentials,
} from "./yealink";

/** Every operation that exists. Adding one is a deliberate act with its own test. */
export const PHONE_OPERATIONS = [
  "discover",
  "fingerprint",
  "test_credentials",
  "reboot",
  "trigger_autop",
] as const;

export type PhoneOperation = (typeof PHONE_OPERATIONS)[number];

export type OperationRequest =
  | { op: "discover"; subnet?: string }
  | { op: "fingerprint"; ip: string; credentialRef?: string | null }
  | { op: "test_credentials"; ip: string; credentialRef?: string | null; useDefault?: boolean }
  | { op: "reboot"; ip: string; credentialRef?: string | null }
  | { op: "trigger_autop"; ip: string; credentialRef?: string | null };

export type OperationResult =
  | { ok: true; op: "discover"; scan: ScanResult }
  | { ok: true; op: "fingerprint"; fingerprint: DeviceFingerprint }
  | { ok: true; op: "test_credentials"; accepted: boolean; reason?: string }
  | { ok: true; op: "reboot" | "trigger_autop" }
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
};

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

    // Everything else targets one phone, and the address is checked here rather than
    // trusted from the caller.
    const ip = (req as any).ip;
    if (!isPrivateIpv4(ip)) return { ok: false, refused: "not_a_private_address" };

    const t = now();
    gate.actionTimes = gate.actionTimes.filter((ts) => t - ts < 60_000);
    if (gate.actionTimes.length >= MAX_ACTIONS_PER_MINUTE) return { ok: false, refused: "rate_limited" };
    const last = gate.lastActionAt.get(ip) ?? 0;
    // ⛔ Reads are cheap and safe; only things that CHANGE a phone are spaced out.
    const mutating = req.op === "reboot" || req.op === "trigger_autop";
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
        try {
          const res = await deps.http(buildStatusRequest(ip, creds));
          return { ok: true, op: "fingerprint", fingerprint: fingerprintFromResponse(res) };
        } catch {
          return { ok: false, refused: "unreachable" };
        }
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

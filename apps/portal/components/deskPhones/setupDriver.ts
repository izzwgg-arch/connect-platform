/**
 * The loop between the head and the hands.
 *
 * ⛔⛔ FOUND ON THE 2026-08-22 REVIEW PASS: the wizard's live step only POLLED. The
 * api's `advance` route decided what should happen next, the desktop's capability
 * layer could do it — and nothing connected them, so "Set Up My Phones" would have
 * sat on "Setting up your office" forever. This module is that connection: each tick
 * it asks the server what each phone needs, performs the ones the office machine can
 * perform, records what it observed, and reports back. The server stays the only
 * thing that decides; this only ever executes a named instruction it was given.
 *
 * ⛔ Pure by injection — the api, the desktop bridge and the clock all arrive as
 * arguments, so every ordering can be proven without a phone on a desk.
 *
 * ⛔ Observations live in the driver, per phone, because they are what the office
 * machine SAW (a refused password, a completed autop) and the server's advance route
 * deliberately does not trust the caller for anything destructive — these facts only
 * feed the gentle branches.
 */

import { vendorSupportsLocalActions } from "@connect/shared";

export type DriverApi = {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
};

export type DriverBridge = {
  run: (req: Record<string, unknown>) => Promise<any>;
} | null;

export type DiagnosticPhone = {
  id: string;
  status: string;
  state: string;
  /** The raw hardware address (the diagnostics view carries it unformatted). */
  mac?: string | null;
  ip: string | null;
  vendor: string | null;
  extNumber: string | null;
  displayName: string | null;
  attempts: number;
  resetCount: number;
  /** False when the person left this phone unticked on the found screen. */
  selected?: boolean;
};

/** What the wizard must put in front of a person before anything continues. */
export type NeedsPerson =
  | { kind: "reset_authorization"; phoneIds: string[]; message: string }
  | { kind: "password"; phoneId: string; label: string; message: string };

export type TickResult = {
  finished: boolean;
  summary: any;
  phones: any[];
  needs: NeedsPerson[];
  /** Actions performed this tick, for diagnostics and for tests. */
  performed: Array<{ phoneId: string; action: string }>;
  /** One plain-English line per phone about what this machine is doing for it right now. */
  hints: Record<string, string>;
};

type PhoneMemo = {
  defaultCredentialsTried: boolean;
  locked: boolean;
  haveCustomerCredentials: boolean;
  credentialRef: string | null;
  /** The person said they do not have this device's password. A complete answer. */
  passwordUnavailable: boolean;
  /** The person chose not to clear this device. Also a complete answer. */
  resetDeclined: boolean;
  /** How many consecutive ticks produced the same non-executable action. */
  stalledOn: string | null;
  stalledCount: number;
  /** PnP hand-offs attempted for this phone (each one may restart the phone). */
  provisioningAttempts: number;
  /** We gave up handing this phone its folder; the server ends its setup kindly. */
  provisioningHandoffFailed: boolean;
};

const TERMINAL = new Set(["REGISTERED", "NEEDS_ATTENTION", "FAILED"]);

/**
 * ⛔ A phone whose instruction this machine cannot perform (a PBX-side reset, a
 * registration wait) is advanced a bounded number of times and then left for the
 * next tick's fresh look — never hammered. The server is idempotent about it, but
 * forty identical advances a minute is noise in the audit trail and load for nothing.
 */
const MAX_CONSECUTIVE_STALLS = 3;

/**
 * ⛔ A PnP hand-off may restart the phone. Only the first two attempts restart it
 * from here; every later one ONLY listens and asks the person to power-cycle it —
 * so the bounded thing is the RESTART, not the listening. Listening costs nothing,
 * and the first live run (2026-09-02) showed a reset phone refusing the restart
 * command outright, so the whole job rests on somebody walking over to unplug it,
 * which can take a while. Each listen-only attempt is ~90 s; forty of them is about
 * an hour, after which the driver tells the server, which ends that phone's setup
 * with a hand-off to Loopcom rather than listening all night.
 */
export const MAX_PROVISIONING_HANDOFF_ATTEMPTS = 40;
export const PROVISIONING_REBOOT_ATTEMPTS = 2;

export const HINT_HANDED_OFF =
  "Told this phone where Loopcom is. It is fetching its settings and will restart on its own.";
export const HINT_RESTARTING =
  "This phone is restarting. We are listening for it to ask for its settings.";
export const HINT_POWER_CYCLE =
  "Unplug this phone's power (or its network cable) and plug it back in — we are listening for it. " +
  "If Windows asks whether to allow Loopcom on your network, choose Allow.";
export const HINT_CANNOT_LISTEN =
  "This computer could not listen for the phone. If Windows asked whether to allow Loopcom on your network, choose Allow, then try again.";
// ⛔ The office machine's Loopcom app predates this step (its allowlist answers
// `unknown_operation`). That is not a failed attempt and must never spend one —
// the first live run (2026-09-02, Loopcom/0.1.16) burned all five on it in twenty
// seconds and told the person "could not listen", which was false.
export const HINT_APP_TOO_OLD =
  "This computer's Loopcom app is older than this step. Update Loopcom on this computer, then come back here — the setup continues by itself.";
export const HINT_REFUSED =
  "This computer could not hand the phone its settings just now. We will try again shortly.";

export function createSetupDriver(runId: string, api: DriverApi, bridge: DriverBridge) {
  const memos = new Map<string, PhoneMemo>();

  const memo = (id: string): PhoneMemo => {
    let m = memos.get(id);
    if (!m) {
      m = {
        defaultCredentialsTried: false, locked: false, haveCustomerCredentials: false,
        credentialRef: null, passwordUnavailable: false, resetDeclined: false,
        stalledOn: null, stalledCount: 0,
        provisioningAttempts: 0, provisioningHandoffFailed: false,
      };
      memos.set(id, m);
    }
    return m;
  };

  /** The wizard calls this when a person typed a phone's password into the app. */
  function credentialStored(phoneId: string, credentialRef: string) {
    const m = memo(phoneId);
    m.haveCustomerCredentials = true;
    m.credentialRef = credentialRef;
    m.locked = false;
    m.passwordUnavailable = false;
    m.stalledOn = null;
    m.stalledCount = 0;
  }

  /**
   * The person pressed "I don't know the password". ⛔ A complete answer — the next
   * advance carries it and the server ends that device's setup kindly instead of
   * asking again forever, which was the wall Izzy called out.
   */
  function passwordUnknown(phoneId: string) {
    const m = memo(phoneId);
    m.passwordUnavailable = true;
    m.stalledOn = null;
    m.stalledCount = 0;
  }

  /** The person left this device unticked on the clearing screen. A deliberate no. */
  function declineReset(phoneIds: string[]) {
    for (const id of phoneIds) {
      const m = memo(id);
      m.resetDeclined = true;
      m.stalledOn = null;
      m.stalledCount = 0;
    }
  }

  async function tick(): Promise<TickResult> {
    const out = await api.get<{ phones: any[]; summary: any }>(`/desk-phones/runs/${runId}?view=diagnostics`);
    const needs: NeedsPerson[] = [];
    const performed: Array<{ phoneId: string; action: string }> = [];
    const resetWanted: Array<{ id: string; message: string }> = [];
    const hints: Record<string, string> = {};

    for (const phone of out.phones as DiagnosticPhone[]) {
      // Unassigned phones were left blank on purpose; terminal phones are done;
      // ⛔ an UNTICKED phone (selected === false) is one the person chose to leave
      // exactly as it is — never advanced, so never reset (2026-09-02).
      if (!phone.extNumber || phone.selected === false || TERMINAL.has(phone.state)) continue;
      const m = memo(phone.id);

      const decision = await api.post<any>(`/desk-phones/runs/${runId}/phones/${phone.id}/advance`, {
        locked: m.locked,
        defaultCredentialsTried: m.defaultCredentialsTried,
        haveCustomerCredentials: m.haveCustomerCredentials,
        passwordUnavailable: m.passwordUnavailable,
        resetDeclined: m.resetDeclined,
        provisioningHandoffFailed: m.provisioningHandoffFailed,
        reachableOnLan: Boolean(phone.ip),
      }).catch(() => null);
      if (!decision?.ok) continue;

      const action = String(decision.action ?? "do_nothing");

      // ── things a person has to do ──────────────────────────────────────────
      if (action === "request_reset_authorization") {
        resetWanted.push({
          id: phone.id,
          message: decision.customerMessage || "This phone still holds settings from your previous phone system.",
        });
        continue;
      }
      if (action === "ask_for_password") {
        needs.push({
          kind: "password",
          phoneId: phone.id,
          label: phone.displayName || phone.extNumber || "this phone",
          message: decision.customerMessage || "Your old provider set a password on this phone.",
        });
        continue;
      }

      // ── things this machine can do ─────────────────────────────────────────
      if (!bridge || !phone.ip) { markStall(m, action); continue; }
      // ⛔ The local adapter speaks Yealink's documented mechanisms. Sending those
      // at a Grandstream HT or a Fanvil speaker is not "worth a try" — another
      // vendor's device gets configured SERVER-side, and locally we wait.
      if (!vendorSupportsLocalActions(phone.vendor)) { markStall(m, action); continue; }

      if (action === "try_default_credentials") {
        const r = await bridge.run({ op: "test_credentials", ip: phone.ip, useDefault: true }).catch(() => null);
        m.defaultCredentialsTried = true;
        // ⛔ accepted=false with reason "locked" is a WRONG password; anything else
        // (unreachable, refused) is not knowledge about the lock and must not set it.
        if (r?.ok) m.locked = r.accepted === false && r.reason === "locked";
        performed.push({ phoneId: phone.id, action });
        clearStall(m);
        continue;
      }
      if (action === "trigger_autop" || action === "check_sync") {
        // check_sync's real form is a PBX-side NOTIFY; from the office machine the
        // equivalent nudge is an autop fetch, which is the same "re-read your
        // settings now" said locally.
        const r = await bridge.run({
          op: "trigger_autop", ip: phone.ip,
          ...(m.credentialRef ? { credentialRef: m.credentialRef } : {}),
        }).catch(() => null);
        if (r?.ok) { performed.push({ phoneId: phone.id, action }); clearStall(m); }
        else markStall(m, action);
        continue;
      }
      if (action === "set_provisioning") {
        // ⛔ The folder URL comes from the SERVER (it knows the tenant's PBX folder);
        // the desktop fences it to a Loopcom PBX before a byte goes out. No URL,
        // nothing to do — wait for the next tick rather than invent one.
        const url = typeof decision.provisioningUrl === "string" ? decision.provisioningUrl : null;
        if (!url || !phone.mac) { markStall(m, action); continue; }
        // ⛔ Once we have given up, we have given up — the server ends the phone's
        // setup on the next advance, and no further restart is ever sent.
        if (m.provisioningHandoffFailed) { markStall(m, action); continue; }
        const reboot = m.provisioningAttempts < PROVISIONING_REBOOT_ATTEMPTS;
        const r = await bridge.run({
          op: "set_provisioning", ip: phone.ip, mac: phone.mac, url, reboot,
          ...(m.credentialRef ? { credentialRef: m.credentialRef } : {}),
        }).catch(() => null);
        if (!r?.ok) {
          // ⛔ A REFUSAL is not an attempt: nothing listened and nothing restarted.
          // Counting it would give up on a phone that was never tried — an old app
          // answers `unknown_operation`, a blocked firewall `cannot_listen`.
          hints[phone.id] = r?.refused === "unknown_operation" ? HINT_APP_TOO_OLD
            : r?.refused === "cannot_listen" ? HINT_CANNOT_LISTEN
            : HINT_REFUSED;
          markStall(m, action);
          continue;
        }
        // The op ran (listened, maybe restarted the phone): that is an attempt.
        m.provisioningAttempts += 1;
        if (r.delivered) {
          // The phone now knows the folder. Tell the server the same way a scan
          // would — the record is what `advance` reads, never this memory.
          await api.post(`/desk-phones/runs/${runId}/discovered`, {
            phones: [{ mac: phone.mac, ip: phone.ip, provisioningUrl: url }],
          }).catch(() => null);
          performed.push({ phoneId: phone.id, action });
          hints[phone.id] = HINT_HANDED_OFF;
          clearStall(m);
          continue;
        }
        hints[phone.id] = r.rebooted ? HINT_RESTARTING : HINT_POWER_CYCLE;
        if (m.provisioningAttempts >= MAX_PROVISIONING_HANDOFF_ATTEMPTS) m.provisioningHandoffFailed = true;
        markStall(m, action);
        continue;
      }
      if (action === "rediscover") {
        const scan = await bridge.run({ op: "discover" }).catch(() => null);
        if (scan?.ok) {
          const hosts = (scan.scan?.hosts ?? []).map((h: any) => ({ mac: h.mac, ip: h.ip }));
          // The server re-matches by hardware id, so a phone that came back on a new
          // address is found again without anyone tracking addresses.
          await api.post(`/desk-phones/runs/${runId}/discovered`, {
            subnet: scan.scan?.subnet ?? undefined, phones: hosts,
          }).catch(() => null);
          performed.push({ phoneId: phone.id, action });
          clearStall(m);
        } else markStall(m, action);
        continue;
      }

      // Everything else — reset_over_sip, generate_template,
      // verify_registration, do_nothing, halt — is the server's or the PBX's to do,
      // or is a wait. The next tick looks again.
      markStall(m, action);
    }

    // ⛔ ONE approval for the whole batch. Ten phones needing a wipe is one decision
    // for a person, not ten dialogs — and the server records exactly which phones
    // the approval covered.
    if (resetWanted.length) {
      needs.push({
        kind: "reset_authorization",
        phoneIds: resetWanted.map((r) => r.id),
        message: resetWanted[0].message,
      });
    }

    const fresh = await api.get<{ phones: any[]; summary: any }>(`/desk-phones/runs/${runId}`);
    return {
      finished: Boolean(fresh.summary?.finished),
      summary: fresh.summary,
      phones: fresh.phones,
      needs,
      performed,
      hints,
    };
  }

  function markStall(m: PhoneMemo, action: string) {
    if (m.stalledOn === action) m.stalledCount += 1;
    else { m.stalledOn = action; m.stalledCount = 1; }
  }
  function clearStall(m: PhoneMemo) { m.stalledOn = null; m.stalledCount = 0; }

  /** Should the wizard keep ticking this fast, or drop to a slow patience poll? */
  function everythingStalled(): boolean {
    const all = [...memos.values()];
    return all.length > 0 && all.every((m) => m.stalledCount >= MAX_CONSECUTIVE_STALLS);
  }

  return { tick, credentialStored, passwordUnknown, declineReset, everythingStalled };
}

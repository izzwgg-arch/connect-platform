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

import { vendorSupportsHttpActions, vendorSupportsPnpHandoff } from "@connect/shared";

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
  /** The make/model the person picked, when the phone itself will not say. */
  model?: string | null;
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
  | { kind: "password"; phoneId: string; label: string; message: string }
  /** The maker's cloud will only take this phone with the serial number off its label. */
  | { kind: "serial"; phoneId: string; label: string; message: string };

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
  /** PnP hand-offs attempted for this phone (only the first two may restart it). */
  provisioningAttempts: number;
  /** When this phone was first asked to take its folder, for the "waiting since" line. */
  provisioningFirstAskedAt: number | null;
  /** Consecutive refusals where this machine could not open the listening socket. */
  cannotListenCount: number;
  /**
   * This machine genuinely cannot hand the phone its folder, so the server ends the
   * setup kindly. ⛔ Set ONLY by repeated `cannot_listen` — never by elapsed time.
   */
  provisioningHandoffFailed: boolean;
  /**
   * This machine would not wipe the phone (its own fence: an adapter, a cordless base,
   * a phone that may be on Wi-Fi, an unknown model — or an app too old for the step).
   * Travels on every advance so the server hands the phone its folder instead.
   */
  resetRefusedLocally: boolean;
  /** When this machine last asked the server to run a maker-cloud step, to pace GDMS calls. */
  cloudAskedAt: number | null;
  /** Restarts the maker's cloud accepted for this phone (bounded like every restart). */
  cloudRestarts: number;
  cloudRestartAt: number | null;
  /**
   * The maker's cloud cannot do this phone (no serial, another account holds it, a refusal
   * that will not change). The phone continues exactly as it would without a cloud.
   */
  cloudUnavailable: boolean;
  /**
   * The last thing we told the person about this phone. ⛔ Kept so a WAIT never blanks the
   * row: most ticks perform nothing (the phone is restarting, or registering), and a row
   * that goes empty while work is genuinely under way reads as the wizard having stopped.
   */
  lastHint: string | null;
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
 * ⛔⛔ THERE IS NO LONGER A CLOCK ON THE HAND-OFF, AND REMOVING IT WAS THE POINT.
 *
 * Until 2026-09-11 the driver gave up an hour after first asking, and the server
 * turned that into "We could not point this phone at Loopcom from your computer —
 * Support can finish this one." That sentence was FALSE by the time it shipped: the
 * desktop responder is STANDING (it stays armed after this window closes, wizard or
 * no wizard), so a phone power-cycled at any point — this afternoon, or tomorrow
 * morning — is provisioned the moment it asks. Telling a customer we had given up,
 * while the machine on their desk was still listening and would still finish the
 * job, was the most misleading thing this wizard said. It is what put the Landau
 * Home Yealink into "Needs attention" on 2026-09-10 while nothing was wrong.
 *
 * So the only genuine give-up left is the one that is TRUE: this computer cannot
 * listen at all, so nothing will ever arrive however long we wait. Everything else
 * stays in "waiting for you to unplug it", which is what is actually happening.
 *
 * What the driver still bounds is how often it asks a phone to RESTART — twice,
 * ever, from here — because a restart is something we do TO somebody's phone.
 */
export const PROVISIONING_REBOOT_ATTEMPTS = 2;
/** Consecutive `cannot_listen` refusals before we admit this machine cannot do it. */
export const MAX_CANNOT_LISTEN_ATTEMPTS = 3;
/**
 * ⛔ The maker's cloud is asked at most this often per phone. Every ask is a round trip to the
 * maker (a lookup at least), and the wizard ticks every four seconds.
 */
export const CLOUD_ASK_INTERVAL_MS = 30_000;
/** A restart the maker's cloud accepted is given this long to bring the phone back before another. */
export const CLOUD_RESTART_WAIT_MS = 180_000;

export const HINT_HANDED_OFF =
  "Told this phone where Loopcom is. It is fetching its settings and will restart on its own.";
export const HINT_RESTARTING =
  "This phone is restarting. We are listening for it to ask for its settings.";
export const HINT_POWER_CYCLE =
  "Plug this phone in now (or unplug it and plug it back in) — this computer is listening for it, " +
  "and keeps listening after you close this window. If Windows asks whether to allow Loopcom on your network, choose Allow.";
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
export const HINT_RESET_SENT =
  "This phone is clearing its old settings and restarting. We are listening for it to come back.";
export const HINT_RESET_SKIPPED =
  "Loopcom can't clear this make of phone from your computer yet, so we are sending it its settings without clearing it.";
export const HINT_LOCKED =
  "This phone has a password on it, so it can't be cleared yet. We need that password once.";
export const HINT_CLOUD_CLEARING = "Asking the phone maker’s cloud to clear this phone…";
export const HINT_CLOUD_RESTART = "Asking the phone maker’s cloud to restart this phone so it picks up its settings…";
export const HINT_NEEDS_SERIAL = "Waiting for this phone’s serial number.";

/*
  ⛔⛔ EVERY STEP IS SAID BEFORE IT IS DONE (Izzy, 2026-09-14: "everything the wizard is doing,
  the user should be able to see live as it's doing it"). A factory reset takes seconds of
  silence on the wire; a row that only changes AFTER the step finished shows nothing while it
  matters most. These are pushed through `onProgress` the moment a step starts.
*/
export const HINT_CHECKING = "Checking this phone…";
export const HINT_CLEARING = "Clearing this phone’s old settings…";
export const HINT_SENDING = "Sending this phone its Loopcom settings…";
export const HINT_FINDING = "Looking for this phone on your network…";
export const HINT_WAITING_APPROVAL = "Waiting for you to approve clearing this phone.";
export const HINT_WAITING_PASSWORD = "Waiting for this phone’s password.";
export const HINT_WAITING_REGISTER = "Settings are on the phone. Waiting for it to connect to Loopcom…";
export const HINT_CONNECTED = "Connected — ready to make calls.";

/**
 * What a factory-reset request's answer means for the count.
 *
 *   • `sent`    — the wipe left this machine, or may have reached the phone. Counted.
 *   • `refused` — this machine's own fence stopped it before anything was sent. Never
 *                 counted; the phone gets the non-destructive hand-off instead.
 *   • `wait`    — nothing was sent and asking again later is right.
 *
 * ⛔⛔ THE ASYMMETRY IS THE POLICY. A refusal the desktop names as a fence is known to
 * have sent nothing. Anything else after the fence — a timeout, an unreachable phone, an
 * HTTP error — may have reached the handset, and a phone told to wipe itself stops
 * answering precisely BECAUSE it is doing it. Counting those is how one wipe never
 * becomes two. `already_reset_this_session` means an earlier request DID leave.
 */
export function classifyResetAnswer(r: any): "sent" | "refused" | "wait" | "locked" {
  if (!r) return "wait"; // the call never reached the app, so nothing left it
  if (r.ok === true) return r.sent === true ? "sent" : "wait";
  const why = String(r.refused ?? "");
  // ⛔⛔ The phone refused our password: nothing was wiped. Never counted (2026-09-14) —
  // it sends the phone to the password step, which is what unlocks the reset.
  if (why === "locked") return "locked";
  if (why === "already_reset_this_session") return "sent";
  if (why === "reset_not_authorized" || why === "too_soon_for_this_phone") return "wait";
  if (why === "unknown_operation" || why === "not_a_private_address" || why.startsWith("reset_unsafe:")) return "refused";
  return "sent";
}

export function createSetupDriver(
  runId: string,
  api: DriverApi,
  bridge: DriverBridge,
  now: () => number = () => Date.now(),
  /** Called the moment a step STARTS, so the screen shows it while it is happening. */
  onProgress?: (phoneId: string, text: string) => void,
) {
  const memos = new Map<string, PhoneMemo>();

  const memo = (id: string): PhoneMemo => {
    let m = memos.get(id);
    if (!m) {
      m = {
        defaultCredentialsTried: false, locked: false, haveCustomerCredentials: false,
        credentialRef: null, passwordUnavailable: false, resetDeclined: false,
        stalledOn: null, stalledCount: 0,
        provisioningAttempts: 0, provisioningFirstAskedAt: null,
        cannotListenCount: 0, provisioningHandoffFailed: false,
        resetRefusedLocally: false,
        cloudAskedAt: null, cloudRestarts: 0, cloudRestartAt: null, cloudUnavailable: false,
        lastHint: null,
      };
      memos.set(id, m);
    }
    return m;
  };

  /** Tell the person, now, what is happening to this phone. A listener that throws never stops setup. */
  const say = (phoneId: string, text: string) => {
    memo(phoneId).lastHint = text;
    try { onProgress?.(phoneId, text); } catch { /* the screen is not the setup */ }
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

  /** The serial number was saved for this phone: ask the maker's cloud again on the next tick. */
  function serialProvided(phoneId: string) {
    const m = memo(phoneId);
    m.cloudAskedAt = null;
    m.stalledOn = null;
    m.stalledCount = 0;
  }

  /**
   * The person does not have the serial number. ⛔ A complete answer: the maker's cloud is
   * not asked again for this phone, and it continues the way it would without a cloud.
   */
  function serialUnavailable(phoneId: string) {
    const m = memo(phoneId);
    m.cloudUnavailable = true;
    m.stalledOn = null;
    m.stalledCount = 0;
  }

  /**
   * Ask the server to run this phone's maker-cloud step (register, then clear — or restart).
   *
   * ⛔ The server decides and performs it through `/prepare`, which spends the one reset
   * atomically before the maker is called; this machine only asks, paces the asking, and puts
   * what came back in front of the person. It never retries a step the server reports sent.
   */
  async function askMakerCloud(
    phone: DiagnosticPhone, m: PhoneMemo, purpose: "reset" | "restart",
    needs: NeedsPerson[], hints: Record<string, string>, performed: Array<{ phoneId: string; action: string }>,
  ): Promise<void> {
    const t = now();
    if (m.cloudAskedAt !== null && t - m.cloudAskedAt < CLOUD_ASK_INTERVAL_MS) {
      markStall(m, `cloud_${purpose}`);
      return;
    }
    m.cloudAskedAt = t;
    say(phone.id, purpose === "reset" ? HINT_CLOUD_CLEARING : HINT_CLOUD_RESTART);
    const res = await api.post<any>(`/desk-phones/runs/${runId}/phones/${phone.id}/prepare`, {})
      .catch((err: any) => err?.body ?? null);
    if (!res || res.ok !== true) {
      if (res?.message) hints[phone.id] = String(res.message);
      markStall(m, `cloud_${purpose}`);
      return;
    }
    const manual = res.plan?.manualAction;
    if (manual?.code === "serial_required") {
      needs.push({
        kind: "serial",
        phoneId: phone.id,
        label: phone.displayName || phone.extNumber || "this phone",
        message: String(manual.message || "The phone maker needs this phone’s serial number."),
      });
      hints[phone.id] = HINT_NEEDS_SERIAL;
      markStall(m, `cloud_${purpose}`);
      return;
    }
    const step = purpose === "reset" ? "factory_reset" : "reboot";
    const done = (res.ran ?? []).find((r: any) => r?.step === step);
    if (done?.ok) {
      if (purpose === "restart") { m.cloudRestarts += 1; m.cloudRestartAt = t; }
      performed.push({ phoneId: phone.id, action: purpose === "reset" ? "reset_via_cloud" : "restart_via_cloud" });
      hints[phone.id] = purpose === "reset" ? HINT_RESET_SENT : HINT_RESTARTING;
      clearStall(m);
      return;
    }
    const failed = (res.ran ?? []).find((r: any) => r && r.ok === false);
    if (failed) {
      if (failed.message) hints[phone.id] = String(failed.message);
      // ⛔ Only a refusal that will not change ends the cloud for this phone. A retryable one
      // (the maker busy, a timeout) is asked again after the pacing interval.
      if (!failed.retryable) m.cloudUnavailable = true;
      markStall(m, `cloud_${purpose}`);
      return;
    }
    if (manual) {
      // Another account holds it, the model is unknown, nothing can clear it: said plainly, and
      // the phone continues the way it would without a cloud.
      hints[phone.id] = String(manual.message || "");
      if (manual.code !== "reset_authorization_required") m.cloudUnavailable = true;
    }
    markStall(m, `cloud_${purpose}`);
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
        resetRefusedLocally: m.resetRefusedLocally,
        reachableOnLan: Boolean(phone.ip),
      }).catch(() => null);
      if (!decision?.ok) continue;

      const action = String(decision.action ?? "do_nothing");

      // ── things a person has to do ──────────────────────────────────────────
      if (action === "request_reset_authorization") {
        say(phone.id, HINT_WAITING_APPROVAL);
        resetWanted.push({
          id: phone.id,
          message: decision.customerMessage || "This phone still holds settings from your previous phone system.",
        });
        continue;
      }
      if (action === "ask_for_password") {
        say(phone.id, HINT_WAITING_PASSWORD);
        needs.push({
          kind: "password",
          phoneId: phone.id,
          label: phone.displayName || phone.extNumber || "this phone",
          message: decision.customerMessage || "Your old provider set a password on this phone.",
        });
        continue;
      }

      // ── things this machine can do ─────────────────────────────────────────
      if (!bridge) { markStall(m, action); continue; }

      // ⛔ A rediscover is a sweep of the NETWORK, not a request aimed at this
      // phone. It needs no vendor permission and no address — and gating it behind
      // both (as the single old gate did) meant a phone that came back on a new
      // address after a restart was never looked for again unless it was a Yealink.
      if (action === "rediscover") {
        say(phone.id, HINT_FINDING);
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

      if (!phone.ip) { markStall(m, action); continue; }

      // ⛔⛔ THE GATE IS PER ACTION, NOT PER PHONE, AND THAT IS THE WHOLE FIX.
      // Until 2026-09-11 one check — `vendor === "yealink"` — stood in front of
      // everything, so a Grandstream, a Polycom or a Snom was refused even the
      // passive step and sat on "Preparing" until somebody gave up. Two questions:
      //   • may we ANSWER this phone when it asks us for its settings? Plain RFC
      //     6080 SIP; ten brands and 369 of the PBX's 427 models send exactly that
      //     shape, and an unidentified device is included because listening at one
      //     costs nothing and it may be precisely the phone this wizard is for.
      //   • may we SEND an HTTP request AT it? Vendor-specific, and Yealink's alone
      //     until another brand's executor ships.
      const canPnp = vendorSupportsPnpHandoff(phone.vendor);
      const canHttp = vendorSupportsHttpActions(phone.vendor);

      if (action === "reset_over_lan") {
        // ⛔ Only ever reached after a person ticked this phone on the clearing screen
        // and the server confirmed the approval names it.
        // ⛔⛔ THE SERVER NAMED THE MECHANISM. A brand whose maker cloud can clear it (a
        // Grandstream with GDMS connected) is cleared THROUGH that cloud — the office machine
        // never sends it a wipe. Listen first, so the phone's own start-up request after the
        // wipe is answered, then ask the server to run the cloud step.
        if (decision.via === "vendor_cloud" && !m.cloudUnavailable) {
          const url = typeof decision.provisioningUrl === "string" ? decision.provisioningUrl : null;
          if (url && phone.mac && canPnp) {
            const armed = await bridge.run({ op: "set_provisioning", ip: phone.ip, mac: phone.mac, url, reboot: false })
              .catch(() => null);
            if (!armed?.ok) {
              // ⛔ Nothing is cleared while this machine cannot listen: a wiped phone would ask
              // into silence. An old app or a blocked port is said plainly; the next tick retries.
              hints[phone.id] = armed?.refused === "unknown_operation" ? HINT_APP_TOO_OLD
                : armed?.refused === "cannot_listen" ? HINT_CANNOT_LISTEN
                  : HINT_REFUSED;
              markStall(m, action);
              continue;
            }
          }
          await askMakerCloud(phone, m, "reset", needs, hints, performed);
          continue;
        }
        const authorizationId = typeof decision.resetAuthorizationId === "string" ? decision.resetAuthorizationId : "";
        if (!authorizationId) { markStall(m, action); continue; }
        // ⛔ Only a brand we hold the documented reset shape for is ever asked. Every
        // other phone takes the hand-off, which needs no reset at all.
        if (!canHttp) {
          m.resetRefusedLocally = true;
          hints[phone.id] = HINT_RESET_SKIPPED;
          clearStall(m);
          continue;
        }
        // The model is what the PHONE says right now, and — when a locked web page says
        // nothing — the make and model the person picked. ⛔ Without that fallback a locked
        // phone reported no model, the fence refused "model_unknown", and reset-first was
        // silently skipped on exactly the phones that need it (Izzy's Yealink, 2026-09-14).
        say(phone.id, HINT_CLEARING);
        const fp = await bridge.run({
          op: "fingerprint", ip: phone.ip,
          ...(m.credentialRef ? { credentialRef: m.credentialRef } : {}),
        }).catch(() => null);
        const model = (fp?.ok && typeof fp.fingerprint?.model === "string" && fp.fingerprint.model
          ? fp.fingerprint.model : null) || phone.model || null;
        const r = await bridge.run({
          op: "factory_reset", ip: phone.ip, model, link: "unknown", authorizationId, vendor: phone.vendor,
          ...(m.credentialRef ? { credentialRef: m.credentialRef } : {}),
        }).catch(() => null);
        const outcome = classifyResetAnswer(r);
        if (outcome === "locked") {
          // The phone has a password. A stored customer password that was refused is wrong,
          // so forget it; otherwise the default was the password just refused.
          m.locked = true;
          if (m.credentialRef) { m.credentialRef = null; m.haveCustomerCredentials = false; }
          else m.defaultCredentialsTried = true;
          hints[phone.id] = HINT_LOCKED;
          clearStall(m);
          continue;
        }
        if (outcome === "refused") {
          m.resetRefusedLocally = true;
          hints[phone.id] = r?.refused === "unknown_operation" ? HINT_APP_TOO_OLD : HINT_RESET_SKIPPED;
          clearStall(m);
          continue;
        }
        if (outcome === "wait") { markStall(m, action); continue; }
        // Counted on the server. Retried a little: if every report is lost, the next
        // tick's advance asks again, this machine answers already_reset_this_session,
        // and the report goes out then — never a second wipe.
        for (let i = 0; i < 3; i += 1) {
          const ack = await api.post<any>(`/desk-phones/runs/${runId}/phones/${phone.id}/reset-sent`, { authorizationId })
            .catch(() => null);
          if (ack?.ok) break;
        }
        performed.push({ phoneId: phone.id, action });
        hints[phone.id] = HINT_RESET_SENT;
        clearStall(m);
        continue;
      }

      if (action === "try_default_credentials") {
        if (!canHttp) { markStall(m, action); continue; }
        say(phone.id, HINT_CHECKING);
        const r = await bridge.run({ op: "test_credentials", ip: phone.ip, useDefault: true, vendor: phone.vendor }).catch(() => null);
        m.defaultCredentialsTried = true;
        // ⛔ accepted=false with reason "locked" is a WRONG password; anything else
        // (unreachable, refused) is not knowledge about the lock and must not set it.
        if (r?.ok) m.locked = r.accepted === false && r.reason === "locked";
        performed.push({ phoneId: phone.id, action });
        clearStall(m);
        continue;
      }
      if (action === "trigger_autop" || action === "check_sync") {
        if (!canHttp) { markStall(m, action); continue; }
        // check_sync's real form is a PBX-side NOTIFY; from the office machine the
        // equivalent nudge is an autop fetch, which is the same "re-read your
        // settings now" said locally.
        say(phone.id, HINT_SENDING);
        const r = await bridge.run({
          op: "trigger_autop", ip: phone.ip, vendor: phone.vendor,
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
        // ⛔ A brand with no PnP and no HTTP cannot be pointed from this machine at
        // all. We do not poke it and we do not spin: the server gives it a terminal
        // "somebody has to do this by hand" state on its next advance.
        if (!canPnp) { markStall(m, action); continue; }
        if (m.provisioningFirstAskedAt === null) m.provisioningFirstAskedAt = now();
        // ⛔ The RESTART is the vendor-specific half. For a brand whose HTTP shapes
        // we do not hold we arm the listener and ask the person to power-cycle —
        // which is the documented mechanism for a factory-reset phone anyway, since
        // one on defaults asks at the handset before obeying a remote restart.
        // ⛔ When the server says the maker's cloud restarts this brand, the office machine only
        // LISTENS; the restart is asked of the cloud below, after the listener is armed.
        const viaCloud = decision.via === "vendor_cloud" && !m.cloudUnavailable;
        const reboot = !viaCloud && canHttp && m.provisioningAttempts < PROVISIONING_REBOOT_ATTEMPTS;
        say(phone.id, HINT_SENDING);
        const r = await bridge.run({
          op: "set_provisioning", ip: phone.ip, mac: phone.mac, url, reboot, vendor: phone.vendor,
          ...(m.credentialRef ? { credentialRef: m.credentialRef } : {}),
        }).catch(() => null);
        if (!r?.ok) {
          // ⛔ A REFUSAL is not an attempt: nothing listened and nothing restarted.
          // Counting it would give up on a phone that was never tried — an old app
          // answers `unknown_operation`, a blocked firewall `cannot_listen`.
          hints[phone.id] = r?.refused === "unknown_operation" ? HINT_APP_TOO_OLD
            : r?.refused === "cannot_listen" ? HINT_CANNOT_LISTEN
            : HINT_REFUSED;
          // ⛔ The ONE true give-up: the socket could not be opened, so no amount of
          // waiting or power-cycling will ever produce a request for us to answer.
          // Counted CONSECUTIVELY — a single refusal can be the port momentarily
          // held by something else, and giving up on the first would be as wrong as
          // the clock was.
          if (r?.refused === "cannot_listen") {
            m.cannotListenCount += 1;
            if (m.cannotListenCount >= MAX_CANNOT_LISTEN_ATTEMPTS) m.provisioningHandoffFailed = true;
          } else m.cannotListenCount = 0;
          markStall(m, action);
          continue;
        }
        m.cannotListenCount = 0;
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
        // ⛔ Listening now: have the maker's cloud restart the phone so it asks. Twice at most,
        // and never again while an accepted restart still has time to bring the phone back.
        if (viaCloud) {
          const due = m.cloudRestartAt === null || now() - m.cloudRestartAt >= CLOUD_RESTART_WAIT_MS;
          if (m.cloudRestarts < PROVISIONING_REBOOT_ATTEMPTS && due) {
            await askMakerCloud(phone, m, "restart", needs, hints, performed);
            continue;
          }
          if (!due) { hints[phone.id] = HINT_RESTARTING; markStall(m, action); continue; }
        }
        // ⛔ NO CLOCK HERE. The listener is armed and stays armed; the honest line
        // is what the person has to do, for as long as it takes them to do it.
        hints[phone.id] = r.rebooted ? HINT_RESTARTING : HINT_POWER_CYCLE;
        markStall(m, action);
        continue;
      }
      if (action === "verify_registration") say(phone.id, HINT_WAITING_REGISTER);
      // Everything else — reset_over_sip (no executor exists, and the ladder cannot
      // reach it: a phone registered to us returns at rung 0 or 5 first), generate_template,
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

    // What each phone's row says after this tick. A step's outcome wins; a phone that only
    // waited keeps the last thing it was told; a registered phone says it can make calls.
    for (const [id, text] of Object.entries(hints)) say(id, text);
    for (const p of (fresh.phones ?? []) as any[]) {
      if (p.state === "REGISTERED") { hints[p.id] = HINT_CONNECTED; continue; }
      const last = memos.get(p.id)?.lastHint;
      if (!hints[p.id] && last && !TERMINAL.has(p.state)) hints[p.id] = last;
    }

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

  return { tick, credentialStored, passwordUnknown, declineReset, serialProvided, serialUnavailable, everythingStalled };
}
